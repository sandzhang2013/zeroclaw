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
pub const ROLE_OPS: &str = "运维";

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
}
