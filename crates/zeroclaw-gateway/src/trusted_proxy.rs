//! BFF trusted-proxy identity for the business chat / session APIs.
//!
//! Pairing (`require_auth`) stays on the ops dashboard. When
//! `gateway.trusted_proxy` is on, user-facing routes require `X-Auth-Secret`
//! plus `X-User-Id` and freeze a [`Principal`] + [`UserAttrs`].

use axum::Json;
use axum::http::{HeaderMap, StatusCode};
use zeroclaw_api::principal::{AuthMethod, Principal};
use zeroclaw_api::{ROLE_OPS, UserAttrs, UserIdError, normalize_user_id};
use zeroclaw_config::pairing::constant_time_eq;

use super::AppState;
use super::api::require_auth;

pub const HEADER_AUTH_SECRET: &str = "x-auth-secret";
pub const HEADER_USER_ID: &str = "x-user-id";
pub const HEADER_USER_ROLE: &str = "x-user-role";
pub const HEADER_USER_REGION: &str = "x-user-region";
pub const HEADER_USER_ORG: &str = "x-user-org";

pub type AuthError = (StatusCode, Json<serde_json::Value>);

fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    // BFF identity headers may contain UTF-8 (roles/regions like `普通用户` /
    // `武汉`). `HeaderValue::to_str()` only accepts visible ASCII and would
    // drop them, so decode the opaque bytes as UTF-8 instead.
    headers
        .get(name)
        .and_then(|v| std::str::from_utf8(v.as_bytes()).ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn json_err(status: StatusCode, message: &str) -> AuthError {
    (status, Json(serde_json::json!({ "error": message })))
}

#[must_use]
pub fn trusted_proxy_enabled(state: &AppState) -> bool {
    state.config.read().gateway.trusted_proxy
}

/// Verify BFF secret + identity headers. Ignores query/body identity.
pub fn require_trusted_proxy(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(Principal, UserAttrs), AuthError> {
    let cfg = state.config.read();
    if !cfg.gateway.trusted_proxy {
        return Err(json_err(
            StatusCode::UNAUTHORIZED,
            "trusted_proxy is not enabled",
        ));
    }
    let expected = cfg
        .gateway
        .trusted_proxy_secret
        .as_deref()
        .map(str::trim)
        .unwrap_or("");
    if expected.is_empty() {
        return Err(json_err(
            StatusCode::UNAUTHORIZED,
            "trusted_proxy_secret is not configured",
        ));
    }
    let provided = header_str(headers, HEADER_AUTH_SECRET).unwrap_or("");
    if provided.is_empty() || !constant_time_eq(provided, expected) {
        return Err(json_err(
            StatusCode::UNAUTHORIZED,
            "Unauthorized — provide X-Auth-Secret from the platform BFF",
        ));
    }
    let raw_id = header_str(headers, HEADER_USER_ID).unwrap_or("");
    let user_id = match normalize_user_id(raw_id) {
        Ok(id) => id,
        Err(UserIdError::Empty) => {
            return Err(json_err(
                StatusCode::UNAUTHORIZED,
                "Unauthorized — X-User-Id is required (query user_id is ignored)",
            ));
        }
        Err(UserIdError::Unsafe) => {
            return Err(json_err(
                StatusCode::BAD_REQUEST,
                "X-User-Id contains forbidden characters",
            ));
        }
    };
    let role = header_str(headers, HEADER_USER_ROLE).filter(|s| !s.is_empty());
    let region = header_str(headers, HEADER_USER_REGION).filter(|s| !s.is_empty());
    let organization = header_str(headers, HEADER_USER_ORG).filter(|s| !s.is_empty());
    let mut attrs = UserAttrs::new(user_id.clone());
    if let Some(role) = role {
        attrs = attrs.with_role(role);
    }
    if let Some(region) = region {
        attrs = attrs.with_region(region);
    }
    if let Some(organization) = organization {
        attrs = attrs.with_organization(organization);
    }
    let roles = attrs.role.clone().into_iter().collect::<Vec<_>>();
    let principal = Principal::new(user_id.clone(), user_id, AuthMethod::Native).with_roles(roles);
    Ok((principal, attrs))
}

/// User-facing session / chat APIs.
pub fn require_user_principal(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(Principal, Option<UserAttrs>), AuthError> {
    if trusted_proxy_enabled(state) {
        let (principal, attrs) = require_trusted_proxy(state, headers)?;
        Ok((principal, Some(attrs)))
    } else {
        require_auth(state, headers)?;
        Ok((Principal::shared_operator(), None))
    }
}

/// Config / logs / org-skill writes. Pairing still works; BFF 运维 also works.
pub fn require_ops_auth(state: &AppState, headers: &HeaderMap) -> Result<(), AuthError> {
    if trusted_proxy_enabled(state) && header_str(headers, HEADER_AUTH_SECRET).is_some() {
        let (principal, _) = require_trusted_proxy(state, headers)?;
        if principal.roles.iter().any(|r| r == ROLE_OPS) {
            return Ok(());
        }
        return Err(json_err(
            StatusCode::FORBIDDEN,
            "Forbidden — ops surface requires X-User-Role: 运维",
        ));
    }
    require_auth(state, headers)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::test_state;
    use axum::http::{HeaderName, HeaderValue};
    use zeroclaw_api::{ROLE_ADVANCED, ROLE_NORMAL};

    fn bff_state(secret: &str) -> AppState {
        let mut config = zeroclaw_config::schema::Config::default();
        config.gateway.trusted_proxy = true;
        config.gateway.trusted_proxy_secret = Some(secret.to_string());
        test_state(config)
    }

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(
                HeaderName::from_bytes(k.as_bytes()).unwrap(),
                HeaderValue::from_str(v).unwrap(),
            );
        }
        h
    }

    #[test]
    fn rejects_missing_secret() {
        let state = bff_state("s3cret");
        let err =
            require_trusted_proxy(&state, &headers(&[(HEADER_USER_ID, "alice")])).unwrap_err();
        assert_eq!(err.0, StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn rejects_wrong_secret() {
        let state = bff_state("s3cret");
        let err = require_trusted_proxy(
            &state,
            &headers(&[(HEADER_AUTH_SECRET, "nope"), (HEADER_USER_ID, "alice")]),
        )
        .unwrap_err();
        assert_eq!(err.0, StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn rejects_missing_user_id_even_with_secret() {
        let state = bff_state("s3cret");
        let err =
            require_trusted_proxy(&state, &headers(&[(HEADER_AUTH_SECRET, "s3cret")])).unwrap_err();
        assert_eq!(err.0, StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn rejects_unsafe_user_id() {
        let state = bff_state("s3cret");
        let err = require_trusted_proxy(
            &state,
            &headers(&[(HEADER_AUTH_SECRET, "s3cret"), (HEADER_USER_ID, "../alice")]),
        )
        .unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn accepts_bff_headers() {
        let state = bff_state("s3cret");
        let (principal, attrs) = require_trusted_proxy(
            &state,
            &headers(&[
                (HEADER_AUTH_SECRET, "s3cret"),
                (HEADER_USER_ID, "alice"),
                (HEADER_USER_ROLE, ROLE_NORMAL),
                (HEADER_USER_REGION, "武汉"),
            ]),
        )
        .unwrap();
        assert_eq!(principal.user_id, "alice");
        assert_eq!(attrs.user_id, "alice");
        assert_eq!(attrs.role.as_deref(), Some(ROLE_NORMAL));
        assert_eq!(attrs.region.as_deref(), Some("武汉"));
    }

    #[test]
    fn normal_user_cannot_hit_ops() {
        let state = bff_state("s3cret");
        let err = require_ops_auth(
            &state,
            &headers(&[
                (HEADER_AUTH_SECRET, "s3cret"),
                (HEADER_USER_ID, "alice"),
                (HEADER_USER_ROLE, ROLE_NORMAL),
            ]),
        )
        .unwrap_err();
        assert_eq!(err.0, StatusCode::FORBIDDEN);
    }

    #[test]
    fn ops_role_can_hit_ops() {
        let state = bff_state("s3cret");
        require_ops_auth(
            &state,
            &headers(&[
                (HEADER_AUTH_SECRET, "s3cret"),
                (HEADER_USER_ID, "ops"),
                (HEADER_USER_ROLE, ROLE_OPS),
            ]),
        )
        .unwrap();
    }

    #[test]
    fn simulates_advanced_user_and_wuhan_city_user() {
        let state = bff_state("s3cret");
        let (_, advanced) = require_trusted_proxy(
            &state,
            &headers(&[
                (HEADER_AUTH_SECRET, "s3cret"),
                (HEADER_USER_ID, "adv-1"),
                (HEADER_USER_ROLE, ROLE_ADVANCED),
            ]),
        )
        .unwrap();
        assert!(advanced.is_advanced());
        assert!(advanced.region.is_none());

        let (_, wuhan) = require_trusted_proxy(
            &state,
            &headers(&[
                (HEADER_AUTH_SECRET, "s3cret"),
                (HEADER_USER_ID, "wh-1"),
                (HEADER_USER_ROLE, ROLE_NORMAL),
                (HEADER_USER_REGION, "武汉"),
            ]),
        )
        .unwrap();
        assert!(!wuhan.is_advanced());
        assert_eq!(wuhan.region.as_deref(), Some("武汉"));
        assert_ne!(advanced.user_id, wuhan.user_id);
        assert_eq!(wuhan.transport_json()["region"], "武汉");
    }
}
