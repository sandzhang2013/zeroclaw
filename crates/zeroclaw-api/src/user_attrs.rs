//! Frozen per-connection identity for the trusted-proxy (BFF) path.
//!
//! Canonical source is the BFF `X-User-*` headers after secret verification.
//! Tools and MCP read this only via [`crate::TOOL_LOOP_USER_ATTRS`].

use serde::{Deserialize, Serialize};

/// Platform roles carried on `X-User-Role`.
pub const ROLE_NORMAL: &str = "普通用户";
pub const ROLE_ADVANCED: &str = "高级用户";
pub const ROLE_OPS: &str = "运维";

/// Identity keys the model must never supply (stripped from MCP tool args).
pub const MODEL_IDENTITY_ARG_KEYS: &[&str] = &[
    "user_id",
    "region",
    "role",
    "org",
    "organization",
    "_zeroclaw_user",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UserIdError {
    Empty,
    Unsafe,
}

impl std::fmt::Display for UserIdError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Empty => write!(f, "user_id must not be empty"),
            Self::Unsafe => write!(f, "user_id contains forbidden path characters"),
        }
    }
}

impl std::error::Error for UserIdError {}

/// Normalize a BFF `X-User-Id` before it enters paths or session keys.
pub fn normalize_user_id(raw: &str) -> Result<String, UserIdError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(UserIdError::Empty);
    }
    if trimmed.contains(['/', '\\', '\0'])
        || trimmed.contains("..")
        || trimmed.chars().any(|c| c.is_control())
    {
        return Err(UserIdError::Unsafe);
    }
    Ok(trimmed.to_string())
}

/// Frozen user attributes for one gateway connection / tool-loop turn.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserAttrs {
    pub user_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub organization: Option<String>,
}

impl UserAttrs {
    #[must_use]
    pub fn new(user_id: impl Into<String>) -> Self {
        Self {
            user_id: user_id.into(),
            role: None,
            region: None,
            organization: None,
        }
    }

    #[must_use]
    pub fn with_role(mut self, role: impl Into<String>) -> Self {
        let role = role.into();
        self.role = (!role.is_empty()).then_some(role);
        self
    }

    #[must_use]
    pub fn with_region(mut self, region: impl Into<String>) -> Self {
        let region = region.into();
        self.region = (!region.is_empty()).then_some(region);
        self
    }

    #[must_use]
    pub fn with_organization(mut self, organization: impl Into<String>) -> Self {
        let organization = organization.into();
        self.organization = (!organization.is_empty()).then_some(organization);
        self
    }

    #[must_use]
    pub fn is_ops(&self) -> bool {
        self.role.as_deref() == Some(ROLE_OPS)
    }

    #[must_use]
    pub fn is_advanced(&self) -> bool {
        self.role.as_deref() == Some(ROLE_ADVANCED)
    }

    /// Drop model-supplied identity keys from a JSON object (in place).
    pub fn strip_identity_args(args: &mut serde_json::Value) {
        if let serde_json::Value::Object(map) = args {
            for key in MODEL_IDENTITY_ARG_KEYS {
                map.remove(*key);
            }
        }
    }

    /// Transport-only identity object. Never merge into model-visible tool args.
    #[must_use]
    pub fn transport_json(&self) -> serde_json::Value {
        serde_json::json!({
            "user_id": self.user_id,
            "role": self.role,
            "region": self.region,
            "org": self.organization,
        })
    }
}

/// Identity for MCP / memory when a tool-loop turn is running.
///
/// - `Ok(None)` — task-local was never scoped (legacy pairing).
/// - `Err(_)` — scoped empty; callers must fail closed.
/// - `Ok(Some(attrs))` — frozen BFF identity.
pub fn mcp_identity() -> Result<Option<UserAttrs>, &'static str> {
    match current_user_attrs() {
        None => Ok(None),
        Some(None) => Err("MCP call refused: missing frozen user identity"),
        Some(Some(attrs)) => Ok(Some(attrs)),
    }
}

/// Current turn identity.
///
/// - `None` — task-local was never scoped (legacy pairing / non-BFF path).
/// - `Some(None)` — scoped empty; MCP must fail closed.
/// - `Some(Some(attrs))` — frozen BFF identity.
#[must_use]
pub fn current_user_attrs() -> Option<Option<UserAttrs>> {
    crate::TOOL_LOOP_USER_ATTRS
        .try_with(std::clone::Clone::clone)
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_user_id_accepts_plain_ids() {
        assert_eq!(normalize_user_id("alice").unwrap(), "alice");
        assert_eq!(normalize_user_id("  bob  ").unwrap(), "bob");
    }

    #[test]
    fn normalize_user_id_rejects_empty() {
        assert!(matches!(normalize_user_id(""), Err(UserIdError::Empty)));
        assert!(matches!(normalize_user_id("   "), Err(UserIdError::Empty)));
    }

    #[test]
    fn normalize_user_id_rejects_path_escape() {
        assert!(matches!(
            normalize_user_id("../alice"),
            Err(UserIdError::Unsafe)
        ));
        assert!(matches!(normalize_user_id("a/b"), Err(UserIdError::Unsafe)));
        assert!(matches!(
            normalize_user_id("a\\b"),
            Err(UserIdError::Unsafe)
        ));
    }

    #[test]
    fn strip_identity_args_removes_model_keys() {
        let mut args = serde_json::json!({
            "user_id": "bob",
            "region": "北京",
            "query": "flu"
        });
        UserAttrs::strip_identity_args(&mut args);
        assert_eq!(args["query"], "flu");
        assert!(args.get("user_id").is_none());
        assert!(args.get("region").is_none());
    }

    #[test]
    fn mcp_identity_unscoped_is_legacy_passthrough() {
        assert!(mcp_identity().unwrap().is_none());
    }

    #[tokio::test]
    async fn mcp_identity_scoped_empty_fails_closed() {
        crate::TOOL_LOOP_USER_ATTRS
            .scope(None, async {
                assert!(mcp_identity().is_err());
            })
            .await;
    }

    #[tokio::test]
    async fn mcp_identity_scoped_attrs_round_trip() {
        crate::TOOL_LOOP_USER_ATTRS
            .scope(Some(UserAttrs::new("alice").with_region("武汉")), async {
                let attrs = mcp_identity().unwrap().unwrap();
                assert_eq!(attrs.user_id, "alice");
                assert_eq!(attrs.region.as_deref(), Some("武汉"));
                let json = attrs.transport_json();
                assert_eq!(json["user_id"], "alice");
                assert_eq!(json["region"], "武汉");
            })
            .await;
    }

    #[test]
    fn role_helpers_match_canonical_chinese_names_only() {
        assert!(UserAttrs::new("ops").with_role(ROLE_OPS).is_ops());
        assert!(UserAttrs::new("liu").with_role(ROLE_ADVANCED).is_advanced());
        assert!(
            !UserAttrs::new("ops").with_role("ops").is_ops(),
            "English aliases are frontend-only; BFF must send 运维"
        );
        assert!(!UserAttrs::new("liu").with_role("advanced").is_advanced());
        assert!(!UserAttrs::new("chen").with_role(ROLE_NORMAL).is_ops());
        assert!(!UserAttrs::new("chen").with_role(ROLE_NORMAL).is_advanced());
        assert!(!UserAttrs::new("anon").is_ops());
        assert!(!UserAttrs::new("anon").is_advanced());
    }

    #[test]
    fn normalize_user_id_allows_colon_but_rejects_control_chars() {
        assert_eq!(normalize_user_id("liu:yang").unwrap(), "liu:yang");
        assert_eq!(
            normalize_user_id("alice\n").unwrap(),
            "alice",
            "trim strips a trailing newline before the control-char check"
        );
        assert!(matches!(
            normalize_user_id("ali\nce"),
            Err(UserIdError::Unsafe)
        ));
        assert!(matches!(
            normalize_user_id("alice\0"),
            Err(UserIdError::Unsafe)
        ));
    }
}
