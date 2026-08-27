use crate::identity::Identity;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::time::{Duration, Instant};
use uuid::Uuid;

pub const COOKIE_NAME: &str = "hbcdcagent_session";

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
        "{COOKIE_NAME}={sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age={}",
        max_age.as_secs()
    );
    if secure {
        v.push_str("; Secure");
    }
    v
}

pub fn clear_cookie_header(secure: bool) -> String {
    let mut v = format!("{COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
    if secure {
        v.push_str("; Secure");
    }
    v
}

pub fn sid_from_cookie_header(header: Option<&str>) -> Option<String> {
    let header = header?;
    for part in header.split(';') {
        let part = part.trim();
        if let Some(v) = part.strip_prefix(&format!("{COOKIE_NAME}="))
            && !v.is_empty()
        {
            return Some(v.to_string());
        }
    }
    None
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
    fn cookie_flags() {
        let plain = cookie_header("sid", Duration::from_secs(60), false);
        assert!(plain.contains("HttpOnly"));
        assert!(plain.contains("SameSite=Lax"));
        assert!(plain.contains("Max-Age=60"));
        assert!(!plain.contains("Secure"));
        let secure = cookie_header("sid", Duration::from_secs(60), true);
        assert!(secure.contains("Secure"));
        assert!(clear_cookie_header(false).contains("Max-Age=0"));
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
}
