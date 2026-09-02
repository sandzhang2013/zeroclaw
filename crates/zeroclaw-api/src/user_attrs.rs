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
pub const MODEL_IDENTITY_ARG_KEYS: &[&str] =
    &["user_id", "role", "org", "organization", "_zeroclaw_user"];

/// Geographic args bound from frozen BFF identity for non-ops MCP calls.
/// Also stripped from model args for non-ops before the frozen region is written.
pub const GEO_ARG_KEYS: &[&str] = &["region", "city", "cities"];

/// Default geography for ops MCP calls when the user did not name a city.
pub const DEFAULT_OPS_GEO: &str = "全省";

/// Longer aliases first so `武汉市` wins over `武汉`.
const HUBEI_CITY_ALIASES: &[(&str, &str)] = &[
    ("神农架林区", "神农架林区"),
    ("神农架", "神农架林区"),
    ("武汉市", "武汉市"),
    ("黄冈市", "黄冈市"),
    ("黄石市", "黄石市"),
    ("荆州市", "荆州市"),
    ("荆门市", "荆门市"),
    ("襄阳市", "襄阳市"),
    ("十堰市", "十堰市"),
    ("宜昌市", "宜昌市"),
    ("孝感市", "孝感市"),
    ("鄂州市", "鄂州市"),
    ("随州市", "随州市"),
    ("咸宁市", "咸宁市"),
    ("仙桃市", "仙桃市"),
    ("潜江市", "潜江市"),
    ("天门市", "天门市"),
    ("恩施州", "恩施州"),
    ("恩施", "恩施州"),
    ("武汉", "武汉市"),
    ("黄冈", "黄冈市"),
    ("黄石", "黄石市"),
    ("荆州", "荆州市"),
    ("荆门", "荆门市"),
    ("襄阳", "襄阳市"),
    ("十堰", "十堰市"),
    ("宜昌", "宜昌市"),
    ("孝感", "孝感市"),
    ("鄂州", "鄂州市"),
    ("随州", "随州市"),
    ("咸宁", "咸宁市"),
    ("仙桃", "仙桃市"),
    ("潜江", "潜江市"),
    ("天门", "天门市"),
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

    /// Schema property names that carry geography (`region`, `city`).
    #[must_use]
    pub fn geo_keys_from_schema(schema: &serde_json::Value) -> Vec<String> {
        let Some(props) = schema.get("properties").and_then(|p| p.as_object()) else {
            return Vec::new();
        };
        GEO_ARG_KEYS
            .iter()
            .filter(|key| props.contains_key(**key))
            .map(|key| (*key).to_string())
            .collect()
    }

    /// After stripping model identity, bind MCP geo args from frozen identity.
    ///
    /// - Ops: geography follows the **user turn text**, not the model.
    ///   No named city → [`DEFAULT_OPS_GEO`] (`全省`). An explicit city
    ///   (e.g. 武汉 / 武汉市) → that canonical city. Model-chosen cities that
    ///   the user never named are discarded (common when asking about 湖北省).
    /// - Non-ops: overwrite geo keys with the frozen region. Missing frozen
    ///   region fails closed.
    /// - Legacy pairing (`mcp_identity() == Ok(None)`) is unchanged.
    pub fn bind_mcp_tool_args(
        args: &mut serde_json::Value,
        geo_schema_keys: &[String],
    ) -> Result<(), &'static str> {
        Self::strip_identity_args(args);
        match mcp_identity() {
            Err(msg) => Err(msg),
            Ok(None) => Ok(()),
            Ok(Some(attrs)) => {
                if attrs.is_ops() {
                    let geo = ops_geo_from_turn(current_turn_user_text().as_deref());
                    if let serde_json::Value::Object(map) = args {
                        for key in GEO_ARG_KEYS {
                            map.remove(*key);
                        }
                        for key in geo_schema_keys {
                            let value = if key == "cities" {
                                geo.cities_arg()
                            } else {
                                geo.city_arg()
                            };
                            map.insert(key.clone(), serde_json::Value::String(value));
                        }
                    }
                    return Ok(());
                }
                if let serde_json::Value::Object(map) = args {
                    for key in GEO_ARG_KEYS {
                        map.remove(*key);
                    }
                }
                let region = attrs
                    .region
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty());
                let Some(region) = region else {
                    return Err("MCP call refused: missing frozen user region");
                };
                if let serde_json::Value::Object(map) = args {
                    for key in geo_schema_keys {
                        map.insert(key.clone(), serde_json::Value::String(region.to_string()));
                    }
                }
                Ok(())
            }
        }
    }

    /// System-prompt block so the model treats workbench isolation as
    /// canonical and does not parrot upstream 「全省=武汉哨点」 footnotes.
    #[must_use]
    pub fn data_scope_prompt(&self) -> String {
        let role = self.role.as_deref().unwrap_or(ROLE_NORMAL);
        let region = self
            .region
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(if self.is_ops() {
                DEFAULT_OPS_GEO
            } else {
                "（未绑定）"
            });
        if self.is_ops() {
            format!(
                "## Data scope (workbench)\n\n\
                 Logged-in role: {role}. Default geography: {region}.\n\n\
                 Disease-report geography is bound by the runtime from the user text, \
                 not by you. No named city → `{DEFAULT_OPS_GEO}`; a named city \
                 (武汉 / 宜昌) → that city.\n\n\
                 If a tool says `{DEFAULT_OPS_GEO}` actually resolves to 武汉市监测数据 \
                 (全省核心哨点口径), that is the upstream API's note for a province-wide \
                 query. You may mention that 口径 when the user asked for {DEFAULT_OPS_GEO}. \
                 Do not use it to explain why a city-level login only sees its own city."
            )
        } else {
            format!(
                "## Data scope (workbench)\n\n\
                 Logged-in role: {role}. Visible region: {region}.\n\n\
                 This workbench isolates data by login region. Tool city/region \
                 arguments are overwritten to `{region}` (武汉用户=武汉市, \
                 宜昌用户=宜昌市). Do not widen the query to `{DEFAULT_OPS_GEO}` \
                 even if the user says 全省.\n\n\
                 If a tool result says `{DEFAULT_OPS_GEO}` is actually 武汉市监测数据 \
                 or 全省核心哨点口径, ignore it for this user. That note describes \
                 the upstream API's province-wide mapping, not this login. \
                 Present the numbers as `{region}` data. Do not tell the user \
                 that 全省 is secretly Wuhan sentinel data."
            )
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

/// Current turn's raw user text when the gateway scoped it.
#[must_use]
pub fn current_turn_user_text() -> Option<String> {
    crate::TOOL_LOOP_TURN_USER_TEXT
        .try_with(std::clone::Clone::clone)
        .ok()
        .flatten()
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct OpsGeo {
    cities: Vec<String>,
}

impl OpsGeo {
    fn province() -> Self {
        Self {
            cities: vec![DEFAULT_OPS_GEO.to_string()],
        }
    }

    fn city_arg(&self) -> String {
        self.cities
            .first()
            .cloned()
            .unwrap_or_else(|| DEFAULT_OPS_GEO.to_string())
    }

    fn cities_arg(&self) -> String {
        self.cities.join(",")
    }
}

/// Cities the user named in the turn. Empty → treat as province-wide.
fn cities_named_in_turn(text: &str) -> Vec<String> {
    let mut found = Vec::new();
    for &(alias, canonical) in HUBEI_CITY_ALIASES {
        if text.contains(alias) && !found.iter().any(|c| c == canonical) {
            found.push(canonical.to_string());
        }
    }
    found
}

fn ops_geo_from_turn(text: Option<&str>) -> OpsGeo {
    let Some(text) = text.map(str::trim).filter(|s| !s.is_empty()) else {
        return OpsGeo::province();
    };
    let named = cities_named_in_turn(text);
    if named.is_empty() {
        OpsGeo::province()
    } else {
        OpsGeo { cities: named }
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

/// Prompt block for the current frozen identity, if a BFF turn is scoped.
#[must_use]
pub fn current_data_scope_prompt() -> Option<String> {
    match current_user_attrs() {
        Some(Some(attrs)) => Some(attrs.data_scope_prompt()),
        _ => None,
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
    fn geo_keys_from_schema_includes_cities() {
        let schema = serde_json::json!({
            "properties": { "cities": { "type": "string" }, "year": { "type": "integer" } }
        });
        assert_eq!(
            UserAttrs::geo_keys_from_schema(&schema),
            vec!["cities".to_string()]
        );
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
        assert_eq!(args["region"], "北京");
        assert!(args.get("user_id").is_none());
    }

    #[tokio::test]
    async fn bind_mcp_tool_args_forces_frozen_region_for_normal_user() {
        crate::TOOL_LOOP_USER_ATTRS
            .scope(
                Some(
                    UserAttrs::new("chenmin")
                        .with_role(ROLE_NORMAL)
                        .with_region("武汉市"),
                ),
                async {
                    let mut args = serde_json::json!({
                        "region": "宜昌市",
                        "city": "宜昌市",
                        "cities": "宜昌市,孝感市",
                        "start_date": "2022-01-01"
                    });
                    let keys = vec![
                        "region".to_string(),
                        "city".to_string(),
                        "cities".to_string(),
                    ];
                    UserAttrs::bind_mcp_tool_args(&mut args, &keys).unwrap();
                    assert_eq!(args["region"], "武汉市");
                    assert_eq!(args["city"], "武汉市");
                    assert_eq!(args["cities"], "武汉市");
                    assert_eq!(args["start_date"], "2022-01-01");
                },
            )
            .await;
    }

    #[tokio::test]
    async fn bind_mcp_tool_args_refuses_normal_user_without_region() {
        crate::TOOL_LOOP_USER_ATTRS
            .scope(
                Some(UserAttrs::new("chenmin").with_role(ROLE_NORMAL)),
                async {
                    let mut args = serde_json::json!({ "region": "宜昌市" });
                    let keys = vec!["region".to_string()];
                    let err = UserAttrs::bind_mcp_tool_args(&mut args, &keys).unwrap_err();
                    assert!(err.contains("missing frozen user region"));
                },
            )
            .await;
    }

    #[tokio::test]
    async fn bind_mcp_tool_args_ops_defaults_province_when_user_omits_city() {
        crate::TOOL_LOOP_USER_ATTRS
            .scope(
                Some(UserAttrs::new("ops").with_role(ROLE_OPS)),
                crate::TOOL_LOOP_TURN_USER_TEXT.scope(
                    Some("湖北省近期流感情况如何".into()),
                    async {
                        let mut args = serde_json::json!({
                            "city": "武汉市",
                            "region": "武汉市",
                            "cities": "武汉市,宜昌市",
                            "disease": "流感"
                        });
                        let keys = vec![
                            "region".to_string(),
                            "city".to_string(),
                            "cities".to_string(),
                        ];
                        UserAttrs::bind_mcp_tool_args(&mut args, &keys).unwrap();
                        assert_eq!(args["region"], DEFAULT_OPS_GEO);
                        assert_eq!(args["city"], DEFAULT_OPS_GEO);
                        assert_eq!(args["cities"], DEFAULT_OPS_GEO);
                        assert_eq!(args["disease"], "流感");
                    },
                ),
            )
            .await;
    }

    #[tokio::test]
    async fn bind_mcp_tool_args_ops_uses_explicit_wuhan_from_user_text() {
        crate::TOOL_LOOP_USER_ATTRS
            .scope(
                Some(UserAttrs::new("ops").with_role(ROLE_OPS)),
                crate::TOOL_LOOP_TURN_USER_TEXT.scope(
                    Some("武汉的流感怎么样".into()),
                    async {
                        let mut args = serde_json::json!({ "city": "宜昌市" });
                        let keys = vec!["city".to_string()];
                        UserAttrs::bind_mcp_tool_args(&mut args, &keys).unwrap();
                        assert_eq!(args["city"], "武汉市");
                    },
                ),
            )
            .await;
    }

    #[tokio::test]
    async fn bind_mcp_tool_args_ops_keeps_multiple_named_cities() {
        crate::TOOL_LOOP_USER_ATTRS
            .scope(
                Some(UserAttrs::new("ops").with_role(ROLE_OPS)),
                crate::TOOL_LOOP_TURN_USER_TEXT.scope(
                    Some("对比武汉和宜昌的流感".into()),
                    async {
                        let mut args = serde_json::json!({ "cities": "十堰市" });
                        let keys = vec!["cities".to_string(), "city".to_string()];
                        UserAttrs::bind_mcp_tool_args(&mut args, &keys).unwrap();
                        assert_eq!(args["cities"], "武汉市,宜昌市");
                        assert_eq!(args["city"], "武汉市");
                    },
                ),
            )
            .await;
    }

    #[test]
    fn cities_named_in_turn_ignores_province_words() {
        assert!(cities_named_in_turn("全省法定传染病概况").is_empty());
        assert!(cities_named_in_turn("湖北省流感").is_empty());
        assert_eq!(cities_named_in_turn("看看武汉市"), vec!["武汉市".to_string()]);
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

    #[test]
    fn data_scope_prompt_tells_city_users_to_ignore_province_sentinel_note() {
        let text = UserAttrs::new("chenmin")
            .with_role(ROLE_NORMAL)
            .with_region("武汉市")
            .data_scope_prompt();
        assert!(text.contains("武汉市"));
        assert!(text.contains("ignore"));
        assert!(text.contains("全省核心哨点口径"));
        assert!(!text.contains("You may mention that"));
    }

    #[test]
    fn data_scope_prompt_lets_ops_mention_province_api_note() {
        let text = UserAttrs::new("ops")
            .with_role(ROLE_OPS)
            .with_region("全省")
            .data_scope_prompt();
        assert!(text.contains(ROLE_OPS));
        assert!(text.contains("You may mention that"));
        assert!(text.contains(DEFAULT_OPS_GEO));
    }
}
