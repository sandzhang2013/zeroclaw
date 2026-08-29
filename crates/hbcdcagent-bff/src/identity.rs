//! Identity mapped onto ZeroClaw trusted-proxy headers.

pub const HEADER_AUTH_SECRET: &str = "x-auth-secret";
pub const HEADER_USER_ID: &str = "x-user-id";
pub const HEADER_USER_ROLE: &str = "x-user-role";
pub const HEADER_USER_REGION: &str = "x-user-region";
pub const HEADER_USER_ORG: &str = "x-user-org";

pub const IDENTITY_HEADERS: &[&str] = &[
    HEADER_AUTH_SECRET,
    HEADER_USER_ID,
    HEADER_USER_ROLE,
    HEADER_USER_REGION,
    HEADER_USER_ORG,
];

pub const ROLE_NORMAL: &str = "普通用户";
pub const ROLE_ADVANCED: &str = "高级用户";
pub const ROLE_OPS: &str = "运维";

/// Local demo mode: cookie carrying an impersonated user id.
pub const MOCK_COOKIE_NAME: &str = "zeroclaw_mock_user";

#[derive(Clone, Copy, Debug)]
pub struct MockUser {
    pub user_id: &'static str,
    pub display_name: &'static str,
    pub role: &'static str,
    pub region: &'static str,
    pub org: &'static str,
}

pub const MOCK_USERS: &[MockUser] = &[
    MockUser {
        user_id: "chenmin",
        display_name: "陈敏",
        role: ROLE_NORMAL,
        region: "武汉市",
        org: "武汉市疾病预防控制中心",
    },
    MockUser {
        user_id: "liuyang",
        display_name: "刘洋",
        role: ROLE_ADVANCED,
        region: "武汉市",
        org: "武汉市疾病预防控制中心",
    },
    MockUser {
        user_id: "zhoujing",
        display_name: "周静",
        role: ROLE_NORMAL,
        region: "宜昌市",
        org: "宜昌市疾病预防控制中心",
    },
    MockUser {
        user_id: "ops",
        display_name: "系统运维",
        role: ROLE_OPS,
        region: "全省",
        org: "湖北省疾病预防控制中心",
    },
];

pub fn mock_user(user_id: &str) -> Option<&'static MockUser> {
    MOCK_USERS.iter().find(|u| u.user_id == user_id)
}

/// Browser-visible cookie (not HttpOnly) so the workbench picker can overwrite it.
pub fn mock_user_cookie_header(user_id: &str) -> String {
    format!(
        "{MOCK_COOKIE_NAME}={user_id}; Path={}; SameSite=Lax",
        crate::config::Config::PATH_PREFIX
    )
}

pub fn clear_mock_cookie_header(secure: bool) -> String {
    let mut v = format!(
        "{MOCK_COOKIE_NAME}=; Path={}; SameSite=Lax; Max-Age=0",
        crate::config::Config::PATH_PREFIX
    );
    if secure {
        v.push_str("; Secure");
    }
    v
}

#[derive(Clone, Debug)]
pub struct UserIdError;

pub fn normalize_user_id(raw: &str) -> Result<String, UserIdError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(UserIdError);
    }
    if trimmed.contains(['/', '\\', '\0'])
        || trimmed.contains("..")
        || trimmed.chars().any(|c| c.is_control())
    {
        return Err(UserIdError);
    }
    Ok(trimmed.to_string())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Identity {
    pub user_id: String,
    /// UI label only. Not a trusted-proxy header; HTML injection uses this.
    pub display_name: Option<String>,
    pub role: String,
    pub region: Option<String>,
    pub org: Option<String>,
}

impl Identity {
    /// Non-empty label for the workbench. Falls back to `user_id`.
    pub fn display_label(&self) -> &str {
        self.display_name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(self.user_id.as_str())
    }
}

pub fn map_role(user_id: &str, ops_user_ids: &[String]) -> String {
    if ops_user_ids.iter().any(|id| id == user_id) {
        ROLE_OPS.to_string()
    } else {
        ROLE_NORMAL.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_path_escape() {
        assert!(normalize_user_id("../x").is_err());
        assert!(normalize_user_id("a/b").is_err());
        assert!(normalize_user_id("").is_err());
        assert!(normalize_user_id("a\\b").is_err());
        assert!(normalize_user_id("a\nb").is_err());
        assert_eq!(normalize_user_id(" alice ").expect("id"), "alice");
    }

    #[test]
    fn ops_allowlist() {
        assert_eq!(map_role("u1", &["u1".into()]), ROLE_OPS);
        assert_eq!(map_role("u2", &["u1".into()]), ROLE_NORMAL);
    }

    #[test]
    fn mock_catalog_matches_picker_ids() {
        assert_eq!(MOCK_USERS.len(), 4);
        for user in MOCK_USERS {
            assert_eq!(
                mock_user(user.user_id).expect("catalog").user_id,
                user.user_id
            );
        }
        assert!(mock_user("evil").is_none());
        assert_eq!(mock_user("ops").expect("ops").role, ROLE_OPS);
        assert_eq!(mock_user("liuyang").expect("adv").role, ROLE_ADVANCED);
        assert_eq!(
            mock_user_cookie_header("chenmin"),
            "zeroclaw_mock_user=chenmin; Path=/hbcdcagent; SameSite=Lax"
        );
    }
}
