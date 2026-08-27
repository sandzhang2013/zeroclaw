use anyhow::{Context, Result, bail};
use std::env;
use std::net::SocketAddr;
use std::time::Duration;

#[derive(Clone, Debug)]
pub struct Config {
    pub listen: SocketAddr,
    pub upstream: String,
    pub public_origin: String,
    pub cookie_secure: bool,
    pub session_ttl: Duration,
    pub trusted_proxy_secret: String,
    pub user_center_base_url: String,
    pub app_id: String,
    pub app_key: String,
    pub app_secret: String,
    pub sign_type: String,
    pub login_url: Option<String>,
    pub client_id: Option<String>,
    pub realm: Option<String>,
    pub terminal: String,
    pub ops_user_ids: Vec<String>,
    /// Local demo mode: skip SSO and derive identity from the
    /// `zeroclaw_mock_user` cookie (validated against a fixed allowlist).
    pub local_mock: bool,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let listen: SocketAddr = env_or("HBCDCAGENT_BFF_LISTEN", "0.0.0.0:50001")
            .parse()
            .context("HBCDCAGENT_BFF_LISTEN")?;
        let sign_type = env_or("USER_CENTER_SIGN_TYPE", "MD5").to_uppercase();
        if sign_type != "MD5" && sign_type != "SM3" {
            bail!("USER_CENTER_SIGN_TYPE must be MD5 or SM3");
        }
        let ttl_secs: u64 = env_or("HBCDCAGENT_BFF_SESSION_TTL_SECS", "28800")
            .parse()
            .context("HBCDCAGENT_BFF_SESSION_TTL_SECS")?;
        Ok(Self {
            listen,
            upstream: trim_slash(&required("HBCDCAGENT_BFF_UPSTREAM")?),
            public_origin: trim_slash(&required("HBCDCAGENT_BFF_PUBLIC_ORIGIN")?),
            cookie_secure: env_flag("HBCDCAGENT_BFF_COOKIE_SECURE", false),
            session_ttl: Duration::from_secs(ttl_secs),
            trusted_proxy_secret: first_required(&[
                "ZEROCLAW_gateway__trusted_proxy_secret",
                "HBCDCAGENT_BFF_TRUSTED_PROXY_SECRET",
            ])?,
            user_center_base_url: trim_slash(&required("USER_CENTER_BASE_URL")?),
            app_id: required("USER_CENTER_APP_ID")?,
            app_key: required("USER_CENTER_APP_KEY")?,
            app_secret: required("USER_CENTER_APP_SECRET")?,
            sign_type,
            login_url: optional("USER_CENTER_LOGIN_URL"),
            client_id: optional("USER_CENTER_CLIENT_ID"),
            realm: optional("USER_CENTER_REALM"),
            terminal: env_or("USER_CENTER_TERMINAL", "Web"),
            ops_user_ids: env::var("HBCDCAGENT_BFF_OPS_USER_IDS")
                .unwrap_or_default()
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect(),
            local_mock: env_flag("HBCDCAGENT_BFF_LOCAL_MOCK", false),
        })
    }

    pub fn workbench_path() -> &'static str {
        "/hbcdcagent/workbench"
    }

    #[cfg(test)]
    pub fn for_test(user_center: &str, upstream: &str) -> Self {
        Self {
            listen: "127.0.0.1:0".parse().expect("addr"),
            upstream: trim_slash(upstream),
            public_origin: "http://88.8.130.150:50001".into(),
            cookie_secure: false,
            session_ttl: Duration::from_secs(60),
            trusted_proxy_secret: "bff-secret".into(),
            user_center_base_url: trim_slash(user_center),
            app_id: "app-id".into(),
            app_key: "app-key".into(),
            app_secret: "00112233445566778899aabbccddeeff".into(),
            sign_type: "MD5".into(),
            login_url: Some("http://sso/login".into()),
            client_id: Some("cid".into()),
            realm: Some("B".into()),
            terminal: "Web".into(),
            ops_user_ids: vec!["ops-user".into()],
            local_mock: false,
        }
    }

    pub fn login_redirect(&self) -> Option<String> {
        let login = self.login_url.as_deref()?;
        let client_id = self.client_id.as_deref()?;
        let realm = self.realm.as_deref()?;
        let redirect = format!("{}/auth/callback", self.public_origin);
        Some(format!(
            "{login}?clientId={}&realm={}&terminal={}&redirectUrl={}",
            urlencoding_minimal(client_id),
            urlencoding_minimal(realm),
            urlencoding_minimal(&self.terminal),
            urlencoding_minimal(&redirect)
        ))
    }
}

fn required(name: &str) -> Result<String> {
    env::var(name)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .with_context(|| format!("missing {name}"))
}

fn first_required(names: &[&str]) -> Result<String> {
    for name in names {
        if let Ok(value) = required(name) {
            return Ok(value);
        }
    }
    bail!("missing {}", names.join(" or "))
}

fn optional(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn env_or(name: &str, default: &str) -> String {
    optional(name).unwrap_or_else(|| default.to_string())
}

fn env_flag(name: &str, default: bool) -> bool {
    match optional(name) {
        None => default,
        Some(v) => matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes"),
    }
}

fn trim_slash(s: &str) -> String {
    s.trim().trim_end_matches('/').to_string()
}

fn urlencoding_minimal(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_redirect_encodes_callback() {
        let cfg = Config {
            listen: "127.0.0.1:1".parse().expect("addr"),
            upstream: "http://127.0.0.1:42617".into(),
            public_origin: "http://88.8.130.150:50001".into(),
            cookie_secure: false,
            session_ttl: Duration::from_secs(60),
            trusted_proxy_secret: "s".into(),
            user_center_base_url: "http://uc".into(),
            app_id: "a".into(),
            app_key: "k".into(),
            app_secret: "00112233445566778899aabbccddeeff".into(),
            sign_type: "MD5".into(),
            login_url: Some("http://sso/login".into()),
            client_id: Some("cid".into()),
            realm: Some("B".into()),
            terminal: "Web".into(),
            ops_user_ids: vec![],
            local_mock: false,
        };
        let url = cfg.login_redirect().expect("url");
        assert!(url.contains("redirectUrl=http%3A%2F%2F88.8.130.150%3A50001%2Fauth%2Fcallback"));
        assert!(url.contains("clientId=cid"));
    }

    #[test]
    fn login_redirect_absent_without_sso() {
        let mut cfg = Config::for_test("http://uc", "http://127.0.0.1:42617");
        cfg.login_url = None;
        assert!(cfg.login_redirect().is_none());
        cfg.login_url = Some("http://sso/login".into());
        cfg.client_id = None;
        assert!(cfg.login_redirect().is_none());
    }
}
