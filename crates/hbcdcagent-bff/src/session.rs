use crate::config::Config;
use crate::identity::Identity;
use axum::http::{HeaderMap, HeaderName, HeaderValue, header};
use axum::response::Response;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::time::{Duration, Instant};
use uuid::Uuid;

pub const COOKIE_NAME: &str = "hbcdcagent_session";
pub const STATE_COOKIE_NAME: &str = "hbcdcagent_sso_state";
pub const STATE_TTL: Duration = Duration::from_secs(600);
/// In-memory session for a cross-site iframe. Not a cookie.
pub const EMBED_SESSION_HEADER: &str = "x-hbcdcagent-session";
/// `1` asks verify to return the session id in JSON for that iframe.
pub const EMBED_REQUEST_HEADER: &str = "x-hbcdcagent-embed";
pub const EMBED_WS_PROTOCOL_PREFIX: &str = "hbcs.";

#[derive(Clone, Debug)]
struct Entry {
    identity: Identity,
    expires: Instant,
}

#[derive(Default)]
pub struct SessionStore {
    inner: Mutex<HashMap<String, Entry>>,
}

impl SessionStore {
    pub fn insert(&self, identity: Identity, ttl: Duration) -> String {
        let id = Uuid::new_v4().to_string();
        self.inner.lock().insert(
            id.clone(),
            Entry {
                identity,
                expires: Instant::now() + ttl,
            },
        );
        id
    }

    pub fn get(&self, sid: &str) -> Option<Identity> {
        let mut map = self.inner.lock();
        let now = Instant::now();
        map.retain(|_, e| e.expires > now);
        map.get(sid).map(|e| e.identity.clone())
    }

    pub fn remove(&self, sid: &str) {
        self.inner.lock().remove(sid);
    }
}

pub fn cookie_header(sid: &str, max_age: Duration, secure: bool) -> String {
    let mut v = format!(
        "{COOKIE_NAME}={sid}; Path={}; HttpOnly; SameSite=Lax; Max-Age={}",
        Config::PATH_PREFIX,
        max_age.as_secs()
    );
    if secure {
        v.push_str("; Secure");
    }
    v
}

pub fn clear_cookie_header(secure: bool) -> String {
    let mut v = format!(
        "{COOKIE_NAME}=; Path={}; HttpOnly; SameSite=Lax; Max-Age=0",
        Config::PATH_PREFIX
    );
    if secure {
        v.push_str("; Secure");
    }
    v
}

pub fn sid_from_cookie_header(header: Option<&str>) -> Option<String> {
    cookie_value(header, COOKIE_NAME)
}

pub fn accept_session_id(raw: &str) -> Option<&str> {
    let sid = raw.trim();
    if sid.len() == 36 && sid.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
        Some(sid)
    } else {
        None
    }
}

pub fn session_id_from_headers(headers: &HeaderMap) -> Option<String> {
    let cookie = headers.get(header::COOKIE).and_then(|v| v.to_str().ok());
    if let Some(sid) = sid_from_cookie_header(cookie) {
        return Some(sid);
    }
    if let Some(sid) = headers
        .get(HeaderName::from_static(EMBED_SESSION_HEADER))
        .and_then(|v| v.to_str().ok())
        .and_then(accept_session_id)
    {
        return Some(sid.to_string());
    }
    headers
        .get(header::SEC_WEBSOCKET_PROTOCOL)
        .and_then(|v| v.to_str().ok())
        .and_then(session_id_from_protocols)
}

pub fn wants_embed_session(headers: &HeaderMap) -> bool {
    headers
        .get(HeaderName::from_static(EMBED_REQUEST_HEADER))
        .and_then(|v| v.to_str().ok())
        .is_some_and(|value| value == "1")
}

/// Drop the iframe session from the upstream request after the BFF has read it.
pub fn strip_embed_credentials(headers: &mut HeaderMap) {
    headers.remove(HeaderName::from_static(EMBED_SESSION_HEADER));
    let Some(raw) = headers
        .get(header::SEC_WEBSOCKET_PROTOCOL)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
    else {
        return;
    };
    if !raw
        .split(',')
        .any(|part| part.trim().starts_with(EMBED_WS_PROTOCOL_PREFIX))
    {
        return;
    }
    let kept: Vec<&str> = raw
        .split(',')
        .map(str::trim)
        .filter(|part| !part.is_empty() && !part.starts_with(EMBED_WS_PROTOCOL_PREFIX))
        .collect();
    if kept.is_empty() {
        headers.remove(header::SEC_WEBSOCKET_PROTOCOL);
        return;
    }
    if let Ok(value) = HeaderValue::from_str(&kept.join(", ")) {
        headers.insert(header::SEC_WEBSOCKET_PROTOCOL, value);
    }
}

fn session_id_from_protocols(raw: &str) -> Option<String> {
    raw.split(',')
        .filter_map(|part| part.trim().strip_prefix(EMBED_WS_PROTOCOL_PREFIX))
        .find_map(|sid| accept_session_id(sid).map(str::to_string))
}

pub fn state_cookie_header(state: &str, max_age: Duration, secure: bool) -> String {
    cookie_pair(STATE_COOKIE_NAME, state, max_age, secure)
}

pub fn clear_state_cookie_header(secure: bool) -> String {
    cookie_pair(STATE_COOKIE_NAME, "", Duration::ZERO, secure)
}

fn cookie_pair(name: &str, value: &str, max_age: Duration, secure: bool) -> String {
    let mut v = format!(
        "{name}={value}; Path={}; HttpOnly; SameSite=Lax; Max-Age={}",
        Config::PATH_PREFIX,
        max_age.as_secs()
    );
    if secure {
        v.push_str("; Secure");
    }
    v
}

pub fn append_set_cookie(response: &mut Response, raw: &str) {
    if let Ok(value) = HeaderValue::from_str(raw) {
        response.headers_mut().append(header::SET_COOKIE, value);
    }
}

/// Portal jumps have neither cookie nor query `state`. BFF-initiated SSO
/// sets both; they must match. Query without cookie is rejected.
pub fn sso_state_matches(cookie_header: Option<&str>, query_state: Option<&str>) -> bool {
    let cookie = cookie_value(cookie_header, STATE_COOKIE_NAME)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let query = query_state
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    if cookie.as_ref().is_some_and(|s| s.len() > 128)
        || query.as_ref().is_some_and(|s| s.len() > 128)
    {
        return false;
    }
    match (cookie.as_deref(), query.as_deref()) {
        (None, None) => true,
        (Some(_), None) => false,
        (None, Some(_)) => false,
        (Some(c), Some(q)) => c == q,
    }
}

pub fn cookie_value(header: Option<&str>, name: &str) -> Option<String> {
    let header = header?;
    let prefix = format!("{name}=");
    let mut found = None;
    for part in header.split(';') {
        let part = part.trim();
        if let Some(v) = part.strip_prefix(&prefix)
            && !v.is_empty()
        {
            found = Some(v.to_string());
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::{Identity, ROLE_NORMAL};
    use std::time::Duration;

    #[test]
    fn roundtrip_and_expiry() {
        let store = SessionStore::default();
        let id = Identity {
            user_id: "u1".into(),
            display_name: None,
            role: ROLE_NORMAL.into(),
            region: None,
            org: Some("org".into()),
        };
        let sid = store.insert(id.clone(), Duration::from_secs(60));
        assert_eq!(store.get(&sid).expect("hit").user_id, "u1");
        store.remove(&sid);
        assert!(store.get(&sid).is_none());
    }

    #[test]
    fn parse_cookie() {
        let raw = format!("a=1; {COOKIE_NAME}=abc; b=2");
        assert_eq!(sid_from_cookie_header(Some(&raw)).as_deref(), Some("abc"));
        assert!(sid_from_cookie_header(None).is_none());
        assert!(sid_from_cookie_header(Some("other=1")).is_none());
    }

    #[test]
    fn cookie_value_extracts_named_cookie() {
        let raw = "a=1; zeroclaw_mock_user=chenmin; b=2";
        assert_eq!(
            cookie_value(Some(raw), "zeroclaw_mock_user").as_deref(),
            Some("chenmin")
        );
        assert_eq!(
            cookie_value(
                Some("zeroclaw_mock_user=chenmin; zeroclaw_mock_user=ops"),
                "zeroclaw_mock_user"
            )
            .as_deref(),
            Some("ops"),
            "duplicate cookies: last value wins (Path=/hbcdcagent after Path=/)"
        );
        assert!(cookie_value(Some(raw), "nope").is_none());
    }

    #[test]
    fn cookie_flags() {
        let plain = cookie_header("sid", Duration::from_secs(60), false);
        assert!(plain.contains("HttpOnly"));
        assert!(plain.contains("Path=/hbcdcagent"));
        assert!(plain.contains("SameSite=Lax"));
        assert!(plain.contains("Max-Age=60"));
        assert!(!plain.contains("Secure"));
        let secure = cookie_header("sid", Duration::from_secs(60), true);
        assert!(secure.contains("Secure"));
        assert!(clear_cookie_header(false).contains("Max-Age=0"));
        assert!(
            state_cookie_header("abc", Duration::from_secs(600), false).contains(STATE_COOKIE_NAME)
        );
        assert!(sso_state_matches(None, None));
        assert!(!sso_state_matches(Some("hbcdcagent_sso_state=a"), None));
        assert!(!sso_state_matches(None, Some("a")));
        assert!(sso_state_matches(Some("hbcdcagent_sso_state=a"), Some("a")));
        assert!(!sso_state_matches(
            Some("hbcdcagent_sso_state=a"),
            Some("b")
        ));
    }

    #[test]
    fn expired_session_is_gone() {
        let store = SessionStore::default();
        let id = Identity {
            user_id: "u1".into(),
            display_name: None,
            role: ROLE_NORMAL.into(),
            region: None,
            org: None,
        };
        let sid = store.insert(id, Duration::from_millis(1));
        std::thread::sleep(Duration::from_millis(5));
        assert!(store.get(&sid).is_none());
    }

    #[test]
    fn embed_header_and_ws_protocol_carry_the_session() {
        let sid = "e34fe452-a307-4a82-ad9e-5d64d9146714";
        let mut headers = HeaderMap::new();
        headers.insert(
            HeaderName::from_static(EMBED_SESSION_HEADER),
            HeaderValue::from_str(sid).unwrap(),
        );
        assert_eq!(session_id_from_headers(&headers).as_deref(), Some(sid));
        headers.insert(
            header::SEC_WEBSOCKET_PROTOCOL,
            HeaderValue::from_str(&format!("zeroclaw.v1, {EMBED_WS_PROTOCOL_PREFIX}{sid}"))
                .unwrap(),
        );
        strip_embed_credentials(&mut headers);
        assert!(
            headers
                .get(HeaderName::from_static(EMBED_SESSION_HEADER))
                .is_none()
        );
        assert_eq!(
            headers
                .get(header::SEC_WEBSOCKET_PROTOCOL)
                .unwrap()
                .to_str()
                .unwrap(),
            "zeroclaw.v1"
        );
        assert!(accept_session_id("not-a-session").is_none());
    }
}
