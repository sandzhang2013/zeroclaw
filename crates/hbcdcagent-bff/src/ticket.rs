//! 智能预警加密票据验票。密钥只来自环境变量，不进 daemon。

use crate::identity::{Identity, map_role, normalize_user_id};
use aes_gcm::Aes256Gcm;
use aes_gcm::aead::{Aead, Payload as AeadPayload};
use aes_gcm::{KeyInit, Nonce};
use anyhow::{Context, Result, bail};
use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE, URL_SAFE_NO_PAD};
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::fmt;
use std::time::{Duration, Instant};

pub const CODE_OK: i32 = 0;
pub const CODE_CLIENT: i32 = 40001;
pub const CODE_EXPIRED: i32 = 40002;
pub const CODE_DECRYPT: i32 = 40003;
pub const CODE_REPLAY: i32 = 40004;
pub const CODE_FORMAT: i32 = 40005;
pub const CODE_RATE: i32 = 40006;

pub const MSG_OK: &str = "ok";
pub const MSG_CLIENT: &str = "接入未授权，请联系管理员";
pub const MSG_EXPIRED: &str = "链接已过期，请从智能预警系统重新进入";
pub const MSG_DECRYPT: &str = "凭证无效，请从智能预警系统重新进入";
pub const MSG_REPLAY: &str = "链接已失效，请重新进入";
pub const MSG_FORMAT: &str = "参数错误";
pub const MSG_RATE: &str = "操作过于频繁，请稍后再试";

const IV_LEN: usize = 12;
const TAG_LEN: usize = 16;
const SKEW_MS: i64 = 60_000;
const NONCE_TTL: Duration = Duration::from_secs(400);
const RATE_WINDOW: Duration = Duration::from_secs(60);

/// 联调/生产密钥。`Debug` 不打印密钥字节。
#[derive(Clone)]
pub struct TicketSso {
    pub client_id: String,
    pub key: [u8; 32],
    pub key_version: u8,
    pub rate_per_minute: u32,
}

impl fmt::Debug for TicketSso {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TicketSso")
            .field("client_id", &self.client_id)
            .field("key", &"<redacted>")
            .field("key_version", &self.key_version)
            .field("rate_per_minute", &self.rate_per_minute)
            .finish()
    }
}

impl TicketSso {
    /// 两者都空则关闭验票。只配一个则启动失败，避免静默拒票。
    pub fn from_env() -> Result<Option<Self>> {
        let client_id = std::env::var("HBCDCAGENT_SSO_CLIENT_ID")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let key_b64 = std::env::var("HBCDCAGENT_SSO_KEY_B64")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        match (client_id, key_b64) {
            (None, None) => return Ok(None),
            (None, Some(_)) => {
                bail!("HBCDCAGENT_SSO_KEY_B64 is set but HBCDCAGENT_SSO_CLIENT_ID is empty")
            }
            (Some(_), None) => {
                bail!("HBCDCAGENT_SSO_CLIENT_ID is set but HBCDCAGENT_SSO_KEY_B64 is empty")
            }
            (Some(client_id), Some(key_b64)) => {
                let key = decode_key(&key_b64)?;
                let key_version = match std::env::var("HBCDCAGENT_SSO_KEY_VERSION") {
                    Ok(raw) if !raw.trim().is_empty() => raw
                        .trim()
                        .parse::<u16>()
                        .context("HBCDCAGENT_SSO_KEY_VERSION")
                        .and_then(|n| {
                            u8::try_from(n).map_err(|_| {
                                anyhow::Error::msg("HBCDCAGENT_SSO_KEY_VERSION must be 1..=255")
                            })
                        })?,
                    _ => 1,
                };
                if key_version == 0 {
                    bail!("HBCDCAGENT_SSO_KEY_VERSION must be 1..=255");
                }
                let rate_per_minute = std::env::var("HBCDCAGENT_SSO_RATE_PER_MIN")
                    .ok()
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.parse::<u32>().context("HBCDCAGENT_SSO_RATE_PER_MIN"))
                    .transpose()?
                    .unwrap_or(60);
                if rate_per_minute == 0 {
                    bail!("HBCDCAGENT_SSO_RATE_PER_MIN must be >= 1");
                }
                Ok(Some(Self {
                    client_id,
                    key,
                    key_version,
                    rate_per_minute,
                }))
            }
        }
    }
}

fn decode_key(raw: &str) -> Result<[u8; 32]> {
    let bytes = STANDARD
        .decode(raw)
        .or_else(|_| URL_SAFE.decode(raw))
        .or_else(|_| URL_SAFE_NO_PAD.decode(raw))
        .context("HBCDCAGENT_SSO_KEY_B64 is not Base64")?;
    let key: [u8; 32] = bytes.try_into().map_err(|v: Vec<u8>| {
        anyhow::Error::msg(format!("AES-256 key must be 32 bytes, got {}", v.len()))
    })?;
    Ok(key)
}

#[derive(Default)]
pub struct NonceStore {
    inner: Mutex<HashMap<String, Instant>>,
}

impl NonceStore {
    /// 第一次占位返回 true。已过期的记录会清掉后再占。
    pub fn claim(&self, nonce: &str, ttl: Duration) -> bool {
        let mut map = self.inner.lock();
        let now = Instant::now();
        map.retain(|_, exp| *exp > now);
        if map.contains_key(nonce) {
            return false;
        }
        map.insert(nonce.to_string(), now + ttl);
        true
    }
}

#[derive(Default)]
pub struct RateWindow {
    inner: Mutex<HashMap<String, Vec<Instant>>>,
}

impl RateWindow {
    pub fn allow(&self, key: &str, limit: u32, window: Duration) -> bool {
        let mut map = self.inner.lock();
        let now = Instant::now();
        let hits = map.entry(key.to_string()).or_default();
        hits.retain(|t| now.duration_since(*t) < window);
        if hits.len() >= limit as usize {
            return false;
        }
        hits.push(now);
        true
    }
}

#[derive(Debug)]
pub struct TicketOutcome {
    pub code: i32,
    pub msg: &'static str,
    pub identity: Option<Identity>,
}

/// 解密并校验。nonce 在时效通过之后才占位。已有会话的重放返回成功，方便刷新。
pub fn verify_ticket(
    sso: Option<&TicketSso>,
    client_id: &str,
    verify_data: &str,
    now_ms: i64,
    ops_user_ids: &[String],
    nonces: &NonceStore,
    has_session: bool,
) -> TicketOutcome {
    let Some(sso) = sso else {
        return fail(CODE_CLIENT, MSG_CLIENT);
    };
    let client_id = client_id.trim();
    let verify_data = verify_data.trim();
    if client_id.is_empty() || verify_data.is_empty() {
        return fail(CODE_FORMAT, MSG_FORMAT);
    }
    if client_id != sso.client_id {
        return fail(CODE_CLIENT, MSG_CLIENT);
    }
    let (version, plain) = match open(&sso.key, verify_data, client_id.as_bytes()) {
        Ok(v) => v,
        Err(OpenError::Format) => return fail(CODE_FORMAT, MSG_FORMAT),
        Err(OpenError::Decrypt) => return fail(CODE_DECRYPT, MSG_DECRYPT),
    };
    if version != sso.key_version {
        return fail(CODE_DECRYPT, MSG_DECRYPT);
    }
    let payload: TicketClaims = match serde_json::from_str(&plain) {
        Ok(p) => p,
        Err(_) => return fail(CODE_FORMAT, MSG_FORMAT),
    };
    if let Err(outcome) = check_time(payload.timestamp, payload.expire_at, now_ms) {
        return outcome;
    }
    let nonce = payload.nonce.trim();
    if nonce.is_empty() {
        return fail(CODE_FORMAT, MSG_FORMAT);
    }
    if !nonces.claim(nonce, NONCE_TTL) {
        if has_session {
            return TicketOutcome {
                code: CODE_OK,
                msg: MSG_OK,
                identity: None,
            };
        }
        return fail(CODE_REPLAY, MSG_REPLAY);
    }
    match identity_from_payload(&payload, ops_user_ids) {
        Ok(identity) => TicketOutcome {
            code: CODE_OK,
            msg: MSG_OK,
            identity: Some(identity),
        },
        Err(()) => fail(CODE_FORMAT, MSG_FORMAT),
    }
}

fn fail(code: i32, msg: &'static str) -> TicketOutcome {
    TicketOutcome {
        code,
        msg,
        identity: None,
    }
}

fn check_time(timestamp: i64, expire_at: i64, now_ms: i64) -> Result<(), TicketOutcome> {
    if timestamp > now_ms + SKEW_MS || now_ms > expire_at + SKEW_MS {
        Err(fail(CODE_EXPIRED, MSG_EXPIRED))
    } else {
        Ok(())
    }
}

#[derive(Deserialize)]
struct TicketClaims {
    #[serde(rename = "userId")]
    user_id: String,
    #[serde(rename = "userName")]
    user_name: Option<String>,
    #[serde(rename = "nickName")]
    nick_name: Option<String>,
    #[serde(rename = "tenantName")]
    tenant_name: Option<String>,
    #[serde(rename = "regionCode")]
    region_code: Option<String>,
    #[serde(rename = "regionName")]
    region_name: Option<String>,
    timestamp: i64,
    #[serde(rename = "expireAt")]
    expire_at: i64,
    nonce: String,
}

fn identity_from_payload(payload: &TicketClaims, ops_user_ids: &[String]) -> Result<Identity, ()> {
    let user_id = normalize_user_id(&payload.user_id).map_err(|_| ())?;
    let nick = nonempty(payload.nick_name.as_deref());
    let name = nonempty(payload.user_name.as_deref());
    let display_name = nick.or(name).map(str::to_string);
    let region = nonempty(payload.region_name.as_deref())
        .or_else(|| nonempty(payload.region_code.as_deref()))
        .map(str::to_string);
    let org = nonempty(payload.tenant_name.as_deref()).map(str::to_string);
    Ok(Identity {
        user_id: user_id.clone(),
        display_name,
        role: map_role(&user_id, ops_user_ids),
        region,
        org,
    })
}

fn nonempty(raw: Option<&str>) -> Option<&str> {
    raw.map(str::trim).filter(|s| !s.is_empty())
}

enum OpenError {
    Format,
    Decrypt,
}

/// `verifyData` = Base64URL( keyVersion(1) ‖ IV(12) ‖ ciphertext ‖ tag(16) )，AAD = clientId。
fn open(key: &[u8; 32], verify_data: &str, aad: &[u8]) -> Result<(u8, String), OpenError> {
    let bytes = URL_SAFE_NO_PAD
        .decode(verify_data.trim())
        .or_else(|_| URL_SAFE.decode(verify_data.trim()))
        .map_err(|_| OpenError::Format)?;
    if bytes.len() < 1 + IV_LEN + TAG_LEN {
        return Err(OpenError::Format);
    }
    let version = bytes[0];
    let iv = &bytes[1..1 + IV_LEN];
    let ct = &bytes[1 + IV_LEN..];
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| OpenError::Decrypt)?;
    let nonce = Nonce::from_slice(iv);
    let plain = cipher
        .decrypt(nonce, AeadPayload { msg: ct, aad })
        .map_err(|_| OpenError::Decrypt)?;
    let text = String::from_utf8(plain).map_err(|_| OpenError::Decrypt)?;
    Ok((version, text))
}

#[cfg(test)]
pub(crate) fn seal(
    key: &[u8; 32],
    version: u8,
    iv: &[u8; 12],
    payload: &str,
    aad: &[u8],
) -> String {
    let cipher = Aes256Gcm::new_from_slice(key).expect("key");
    let ct = cipher
        .encrypt(
            Nonce::from_slice(iv),
            AeadPayload {
                msg: payload.as_bytes(),
                aad,
            },
        )
        .expect("encrypt");
    let mut raw = Vec::with_capacity(1 + IV_LEN + ct.len());
    raw.push(version);
    raw.extend_from_slice(iv);
    raw.extend_from_slice(&ct);
    URL_SAFE_NO_PAD.encode(raw)
}

/// 成功响应里的用户摘要。不回传 nonce。
pub fn public_user(identity: &Identity) -> Value {
    serde_json::json!({
        "userId": identity.user_id,
        "userName": identity.display_name.as_deref().unwrap_or(""),
        "nickName": identity.display_name.as_deref().unwrap_or(""),
        "tenantName": identity.org.as_deref().unwrap_or(""),
        "regionCode": "",
        "regionName": identity.region.as_deref().unwrap_or(""),
    })
}

pub fn rate_ok(window: &RateWindow, sso: &TicketSso, client_key: &str) -> bool {
    window.allow(client_key, sso.rate_per_minute, RATE_WINDOW)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::ROLE_OPS;

    /// Test fixture only. Not the joint-debug or production key.
    const KEY_B64: &str = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";

    fn sso() -> TicketSso {
        TicketSso {
            client_id: "CDSS-B-ZJJK-001".into(),
            key: decode_key(KEY_B64).expect("key"),
            key_version: 1,
            rate_per_minute: 60,
        }
    }

    fn payload(now: i64, nonce: &str) -> String {
        serde_json::json!({
            "userId": "U10001",
            "userName": "张三",
            "nickName": "预警小张",
            "tenantId": "T001",
            "tenantCode": "HUBEI_CDC",
            "tenantName": "湖北省疾控中心",
            "regionCode": "420000",
            "regionName": "湖北省",
            "timestamp": now,
            "expireAt": now + 300_000,
            "nonce": nonce
        })
        .to_string()
    }

    fn ticket(sso: &TicketSso, json: &str) -> String {
        seal(
            &sso.key,
            sso.key_version,
            b"0123456789ab",
            json,
            sso.client_id.as_bytes(),
        )
    }

    #[test]
    fn roundtrip_sets_identity() {
        let sso = sso();
        let now = 1_756_641_000_000;
        let data = ticket(&sso, &payload(now, "nonce-1"));
        let out = verify_ticket(
            Some(&sso),
            &sso.client_id,
            &data,
            now,
            &[],
            &NonceStore::default(),
            false,
        );
        assert_eq!(out.code, CODE_OK);
        let id = out.identity.expect("id");
        assert_eq!(id.user_id, "U10001");
        assert_eq!(id.display_name.as_deref(), Some("预警小张"));
        assert_eq!(id.region.as_deref(), Some("湖北省"));
        assert_eq!(id.org.as_deref(), Some("湖北省疾控中心"));
        assert_eq!(id.role, "普通用户");
    }

    #[test]
    fn ops_allowlist_and_replay() {
        let sso = sso();
        let now = 1_756_641_000_000;
        let data = ticket(&sso, &payload(now, "nonce-ops"));
        let nonces = NonceStore::default();
        let ops = vec!["U10001".into()];
        let first = verify_ticket(Some(&sso), &sso.client_id, &data, now, &ops, &nonces, false);
        assert_eq!(first.identity.expect("id").role, ROLE_OPS);
        let second = verify_ticket(Some(&sso), &sso.client_id, &data, now, &ops, &nonces, false);
        assert_eq!(second.code, CODE_REPLAY);
        let refresh = verify_ticket(Some(&sso), &sso.client_id, &data, now, &ops, &nonces, true);
        assert_eq!(refresh.code, CODE_OK);
        assert!(refresh.identity.is_none());
    }

    #[test]
    fn rejects_bad_client_tamper_and_clock() {
        let sso = sso();
        let now = 1_756_641_000_000;
        let data = ticket(&sso, &payload(now, "nonce-x"));
        let nonces = NonceStore::default();
        assert_eq!(
            verify_ticket(Some(&sso), "other", &data, now, &[], &nonces, false).code,
            CODE_CLIENT
        );
        assert_eq!(
            verify_ticket(None, &sso.client_id, &data, now, &[], &nonces, false).code,
            CODE_CLIENT
        );
        let mut flipped = data.clone();
        flipped.pop();
        flipped.push('A');
        assert_eq!(
            verify_ticket(
                Some(&sso),
                &sso.client_id,
                &flipped,
                now,
                &[],
                &nonces,
                false
            )
            .code,
            CODE_DECRYPT
        );
        assert_eq!(
            verify_ticket(Some(&sso), &sso.client_id, "@@@", now, &[], &nonces, false).code,
            CODE_FORMAT
        );
        let expired = ticket(&sso, &payload(now - 600_000, "nonce-old"));
        assert_eq!(
            verify_ticket(
                Some(&sso),
                &sso.client_id,
                &expired,
                now,
                &[],
                &nonces,
                false
            )
            .code,
            CODE_EXPIRED
        );
        let future = ticket(&sso, &payload(now + 600_000, "nonce-future"));
        assert_eq!(
            verify_ticket(
                Some(&sso),
                &sso.client_id,
                &future,
                now,
                &[],
                &nonces,
                false
            )
            .code,
            CODE_EXPIRED
        );
    }

    #[test]
    fn debug_hides_key() {
        let text = format!("{:?}", sso());
        assert!(!text.contains("MDEyMzQ1"));
        assert!(text.contains("<redacted>"));
    }

    #[tokio::test]
    async fn http_verify_sets_session_cookie() {
        use crate::config::Config;
        use crate::router;
        use crate::session::COOKIE_NAME;
        use axum::body::Body;
        use axum::http::Request;
        use tower::ServiceExt;

        let mut cfg = Config::for_test("http://127.0.0.1:9", "http://127.0.0.1:9");
        let sso = sso();
        let now = chrono::Utc::now().timestamp_millis();
        let data = ticket(&sso, &payload(now, "nonce-http"));
        cfg.ticket_sso = Some(sso);
        let app = router(cfg).expect("router");
        let req = Request::builder()
            .method("POST")
            .uri("/hbcdcagent/sso/auth/verify")
            .header("content-type", "application/json")
            .body(Body::from(format!(
                r#"{{"clientId":"CDSS-B-ZJJK-001","verifyData":"{data}"}}"#
            )))
            .expect("req");
        let resp = app.clone().oneshot(req).await.expect("resp");
        assert_eq!(resp.status(), axum::http::StatusCode::OK);
        let cookie = resp
            .headers()
            .get("set-cookie")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        assert!(cookie.contains(COOKIE_NAME));
        let again = Request::builder()
            .method("POST")
            .uri("/sso/auth/verify")
            .header("content-type", "application/json")
            .body(Body::from(format!(
                r#"{{"clientId":"CDSS-B-ZJJK-001","verifyData":"{data}"}}"#
            )))
            .expect("req");
        let replay = app.oneshot(again).await.expect("resp");
        assert_eq!(replay.status(), axum::http::StatusCode::BAD_REQUEST);
        let bytes = axum::body::to_bytes(replay.into_body(), usize::MAX)
            .await
            .expect("body");
        let json: serde_json::Value = serde_json::from_slice(&bytes).expect("json");
        assert_eq!(json["code"], CODE_REPLAY);
        let body: serde_json::Value = serde_json::from_slice(
            &axum::body::to_bytes(resp.into_body(), usize::MAX)
                .await
                .expect("body"),
        )
        .expect("json");
        assert!(body["data"].get("sessionId").is_none());
    }

    #[tokio::test]
    async fn http_verify_returns_session_id_for_embed() {
        use crate::config::Config;
        use crate::router;
        use crate::session::EMBED_REQUEST_HEADER;
        use axum::body::Body;
        use axum::http::{HeaderName, Request};
        use tower::ServiceExt;

        let mut cfg = Config::for_test("http://127.0.0.1:9", "http://127.0.0.1:9");
        let sso = sso();
        let now = chrono::Utc::now().timestamp_millis();
        let data = ticket(&sso, &payload(now, "nonce-embed"));
        cfg.ticket_sso = Some(sso);
        let app = router(cfg).expect("router");
        let req = Request::builder()
            .method("POST")
            .uri("/hbcdcagent/sso/auth/verify")
            .header("content-type", "application/json")
            .header(HeaderName::from_static(EMBED_REQUEST_HEADER), "1")
            .body(Body::from(format!(
                r#"{{"clientId":"CDSS-B-ZJJK-001","verifyData":"{data}"}}"#
            )))
            .expect("req");
        let resp = app.oneshot(req).await.expect("resp");
        assert_eq!(resp.status(), axum::http::StatusCode::OK);
        let body: serde_json::Value = serde_json::from_slice(
            &axum::body::to_bytes(resp.into_body(), usize::MAX)
                .await
                .expect("body"),
        )
        .expect("json");
        let sid = body["data"]["sessionId"].as_str().expect("session id");
        assert_eq!(sid.len(), 36);
    }

    #[test]
    fn rate_window_blocks_the_third_hit() {
        let window = RateWindow::default();
        assert!(window.allow("ip", 2, RATE_WINDOW));
        assert!(window.allow("ip", 2, RATE_WINDOW));
        assert!(!window.allow("ip", 2, RATE_WINDOW));
    }
}
