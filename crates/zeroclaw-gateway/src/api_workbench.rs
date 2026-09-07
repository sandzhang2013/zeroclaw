//! Workbench homepage catalog (`GET /api/workbench/home`).
//!
//! Any authenticated workbench user may read the resolved tab/chip list.
//! Writes stay on ops-only `/api/config` (`workbench.home.caps`).

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use serde::Deserialize;
use zeroclaw_config::workbench::resolve_home_catalog;

use super::AppState;

#[derive(Debug, Deserialize)]
pub struct HomeQuery {
    #[serde(default)]
    pub locale: Option<String>,
}

/// GET /api/workbench/home — resolved homepage tabs for the current locale.
pub async fn handle_workbench_home(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<HomeQuery>,
) -> impl IntoResponse {
    if let Err(e) = crate::trusted_proxy::require_user_principal(&state, &headers) {
        return e.into_response();
    }

    let config = state.config.read();
    let locale = query
        .locale
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| {
            config
                .locale
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "zh".to_string());
    let catalog = resolve_home_catalog(&config.workbench.home.caps, &locale);
    (StatusCode::OK, axum::Json(catalog)).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::test_state;
    use axum::http::HeaderValue;
    use http_body_util::BodyExt;
    use zeroclaw_config::workbench::WorkbenchHomeCap;
    use zeroclaw_runtime::security::pairing::PairingGuard;

    fn pairing_on_bff_state(tmp: &tempfile::TempDir) -> AppState {
        let mut config = zeroclaw_config::schema::Config {
            data_dir: tmp.path().join("data"),
            config_path: tmp.path().join("config.toml"),
            ..zeroclaw_config::schema::Config::default()
        };
        config.gateway.trusted_proxy = true;
        config.gateway.trusted_proxy_secret = Some("s3cret".into());
        let mut state = test_state(config);
        state.pairing = std::sync::Arc::new(PairingGuard::new(true, &[]));
        state
    }

    fn bff_headers(user: &str, role: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert("x-auth-secret", HeaderValue::from_static("s3cret"));
        h.insert("x-user-id", HeaderValue::from_str(user).unwrap());
        h.insert(
            "x-user-role",
            HeaderValue::from_bytes(role.as_bytes()).unwrap(),
        );
        h
    }

    async fn body_json(response: axum::response::Response) -> serde_json::Value {
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn home_accepts_bff_normal_user() {
        let tmp = tempfile::TempDir::new().unwrap();
        let state = pairing_on_bff_state(&tmp);
        let response = handle_workbench_home(
            State(state),
            bff_headers("alice", "普通用户"),
            Query(HomeQuery {
                locale: Some("zh".into()),
            }),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        let json = body_json(response).await;
        assert_eq!(json["tabs"][0]["label"], "数据查询");
        assert_eq!(json["tabs"].as_array().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn home_rejects_missing_identity() {
        let tmp = tempfile::TempDir::new().unwrap();
        let state = pairing_on_bff_state(&tmp);
        let response = handle_workbench_home(
            State(state),
            HeaderMap::new(),
            Query(HomeQuery { locale: None }),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn home_empty_caps_fall_back_to_builtin() {
        let tmp = tempfile::TempDir::new().unwrap();
        let state = pairing_on_bff_state(&tmp);
        state.config.write().workbench.home.caps.clear();
        let response = handle_workbench_home(
            State(state),
            bff_headers("alice", "普通用户"),
            Query(HomeQuery {
                locale: Some("zh".into()),
            }),
        )
        .await
        .into_response();
        let json = body_json(response).await;
        assert_eq!(json["source"], "builtin");
        assert_eq!(json["tabs"][0]["caps"][0]["label"], "疫情概况");
    }

    #[tokio::test]
    async fn home_uses_configured_caps() {
        let tmp = tempfile::TempDir::new().unwrap();
        let state = pairing_on_bff_state(&tmp);
        state.config.write().workbench.home.caps = vec![WorkbenchHomeCap {
            id: "hello".into(),
            tab: "query".into(),
            tab_label_zh: "问数".into(),
            icon: "search".into(),
            kind: "chat".into(),
            label_zh: "问好".into(),
            prompt_zh: "你好".into(),
            ..Default::default()
        }];
        let response = handle_workbench_home(
            State(state),
            bff_headers("alice", "普通用户"),
            Query(HomeQuery {
                locale: Some("zh".into()),
            }),
        )
        .await
        .into_response();
        let json = body_json(response).await;
        assert_eq!(json["source"], "config");
        assert_eq!(json["tabs"].as_array().unwrap().len(), 1);
        assert_eq!(json["tabs"][0]["label"], "问数");
        assert_eq!(json["tabs"][0]["caps"][0]["prompt"], "你好");
    }
}
