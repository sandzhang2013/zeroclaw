use crate::config::Config;
use crate::crypto::{decrypt_data, encrypt_data, sign};
use anyhow::{Context, Result, bail};
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::time::{Duration, Instant};
use uuid::Uuid;

const REFRESH_AFTER: Duration = Duration::from_secs(10 * 60);

#[derive(Clone, Debug)]
struct Ticket {
    ticket: String,
    ticket_secret: String,
    refresh_ticket: String,
    at: Instant,
}

#[derive(Clone, Debug)]
pub struct TokenUserInfo {
    pub user_id: String,
    pub display_name: Option<String>,
    pub tenant_name: Option<String>,
}

pub struct UserCenter {
    cfg: Config,
    http: reqwest::Client,
    ticket: Mutex<Option<Ticket>>,
}

impl UserCenter {
    pub fn new(cfg: Config) -> Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .connect_timeout(Duration::from_secs(10))
            .build()
            .context("user-center HTTP client")?;
        Ok(Self {
            cfg,
            http,
            ticket: Mutex::new(None),
        })
    }

    pub async fn user_info_by_verify_code(&self, verify_code: &str) -> Result<TokenUserInfo> {
        let data = self
            .invoke_biz(
                "/sso/code/userInfo",
                json!({ "verifyCode": verify_code }),
                true,
            )
            .await?;
        parse_user_info(&data)
    }

    async fn ensure_ticket(&self) -> Result<Ticket> {
        {
            let guard = self.ticket.lock();
            if let Some(t) = guard.as_ref()
                && t.at.elapsed() < REFRESH_AFTER
            {
                return Ok(t.clone());
            }
        }
        self.refresh_or_fetch().await
    }

    async fn refresh_or_fetch(&self) -> Result<Ticket> {
        let current = self.ticket.lock().clone();
        if let Some(t) = current {
            match self.refresh(&t.refresh_ticket).await {
                Ok(()) => {
                    let mut g = self.ticket.lock();
                    if let Some(stored) = g.as_mut() {
                        stored.at = Instant::now();
                        return Ok(stored.clone());
                    }
                }
                Err(err) if is_code(&err, "GW0007") => {
                    tracing::warn!("refreshTicket expired, fetching a new ticket");
                }
                Err(err) => return Err(err),
            }
        }
        self.fetch_new().await
    }

    async fn fetch_new(&self) -> Result<Ticket> {
        let body = json!({
            "appId": self.cfg.app_id,
            "appSecret": self.cfg.app_secret,
        });
        let root = self
            .post_json(
                &format!("{}/auth/ticket", self.cfg.user_center_base_url),
                &body,
            )
            .await?;
        assert_gateway_ok(&root)?;
        let plain = unwrap_data(&self.cfg.app_secret, &root["data"])?;
        let ticket = Ticket {
            ticket: required_str(&plain, "ticket")?,
            ticket_secret: required_str(&plain, "ticketSecret")?,
            refresh_ticket: required_str(&plain, "refreshTicket")?,
            at: Instant::now(),
        };
        *self.ticket.lock() = Some(ticket.clone());
        tracing::info!("fetched user-center ticket");
        Ok(ticket)
    }

    async fn refresh(&self, refresh_ticket: &str) -> Result<()> {
        let body = json!({ "refreshTicket": refresh_ticket });
        let root = self
            .post_json(
                &format!("{}/auth/refresh", self.cfg.user_center_base_url),
                &body,
            )
            .await?;
        assert_gateway_ok(&root)?;
        if let Some(Value::String(cipher)) = root.get("data")
            && !cipher.is_empty()
        {
            let plain = unwrap_data(&self.cfg.app_secret, &Value::String(cipher.clone()))?;
            if let (Some(ticket), Some(secret), Some(refresh)) = (
                plain.get("ticket").and_then(Value::as_str),
                plain.get("ticketSecret").and_then(Value::as_str),
                plain.get("refreshTicket").and_then(Value::as_str),
            ) {
                *self.ticket.lock() = Some(Ticket {
                    ticket: ticket.to_string(),
                    ticket_secret: secret.to_string(),
                    refresh_ticket: refresh.to_string(),
                    at: Instant::now(),
                });
                return Ok(());
            }
        }
        Ok(())
    }

    async fn invoke_biz(&self, path: &str, biz: Value, retry: bool) -> Result<Value> {
        let ticket = self.ensure_ticket().await?;
        let encode_data = encrypt_data(&self.cfg.app_secret, &biz.to_string())?;
        let time_stamp = chrono::Utc::now().timestamp_millis().to_string();
        let request_id = Uuid::new_v4().simple().to_string();
        let sign = sign(
            &self.cfg.sign_type,
            &[
                &self.cfg.app_id,
                &ticket.ticket,
                &ticket.ticket_secret,
                &time_stamp,
                &self.cfg.app_secret,
                &self.cfg.app_key,
            ],
        )?;
        let url = format!("{}{path}", self.cfg.user_center_base_url);
        let response = self
            .http
            .post(&url)
            .header("Content-Type", "application/json; charset=UTF-8")
            .header("appId", &self.cfg.app_id)
            .header("sign", &sign)
            .header("signType", &self.cfg.sign_type)
            .header("ticket", &ticket.ticket)
            .header("requestId", request_id)
            .header("timeStamp", &time_stamp)
            .header("timestamp", &time_stamp)
            .json(&json!({ "encodeData": encode_data }))
            .send()
            .await
            .with_context(|| format!("POST {path}"))?;
        let root: Value = response.json().await.context("user-center JSON")?;
        let code = ret_code(&root);
        if code == "GW0003" && retry {
            tracing::warn!("ticket expired, retrying {path}");
            self.ticket.lock().take();
            self.fetch_new().await?;
            return Box::pin(self.invoke_biz(path, biz, false)).await;
        }
        assert_gateway_ok(&root)?;
        unwrap_data(&self.cfg.app_secret, &root["data"])
    }

    async fn post_json(&self, url: &str, body: &Value) -> Result<Value> {
        let response = self
            .http
            .post(url)
            .header("Content-Type", "application/json; charset=UTF-8")
            .header("appId", &self.cfg.app_id)
            .json(body)
            .send()
            .await
            .with_context(|| format!("POST {url}"))?;
        response.json().await.context("user-center JSON")
    }
}

fn parse_user_info(data: &Value) -> Result<TokenUserInfo> {
    let user = data
        .get("userInfo")
        .with_context(|| "userInfo missing from /sso/code/userInfo")?;
    let user_id = user
        .get("userId")
        .and_then(Value::as_str)
        .context("userInfo.userId missing")?;
    Ok(TokenUserInfo {
        user_id: user_id.to_string(),
        display_name: first_nonempty_str(user, &["realName", "nickName", "accountName"]),
        tenant_name: user
            .get("tenantName")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

fn first_nonempty_str(user: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        user.get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    })
}

pub fn unwrap_data(app_secret: &str, data: &Value) -> Result<Value> {
    match data {
        Value::Null => bail!("empty data"),
        Value::Object(_) | Value::Array(_) => Ok(data.clone()),
        Value::String(s) if s.is_empty() => bail!("empty data"),
        Value::String(s) => {
            let plain = decrypt_data(app_secret, s)?;
            serde_json::from_str(&plain).context("decrypted data is not JSON")
        }
        other => Ok(other.clone()),
    }
}

pub fn assert_gateway_ok(root: &Value) -> Result<()> {
    let code = ret_code(root);
    let ok = root
        .get("success")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || code.eq_ignore_ascii_case("SUCCESS")
        || code == "999999";
    if ok {
        return Ok(());
    }
    let msg = root
        .get("retMsg")
        .and_then(Value::as_str)
        .unwrap_or("user-center error");
    bail!("user-center {code}: {msg}")
}

fn ret_code(root: &Value) -> String {
    match root.get("retCode") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

fn required_str(v: &Value, key: &str) -> Result<String> {
    v.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .with_context(|| format!("missing {key}"))
}

fn is_code(err: &anyhow::Error, code: &str) -> bool {
    err.to_string().contains(code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn success_codes() {
        assert!(assert_gateway_ok(&json!({"success": true, "retCode": "x"})).is_ok());
        assert!(assert_gateway_ok(&json!({"success": false, "retCode": "999999"})).is_ok());
        assert!(assert_gateway_ok(&json!({"success": false, "retCode": 999999})).is_ok());
        assert!(
            assert_gateway_ok(&json!({"success": false, "retCode": "GW0003", "retMsg": "expired"}))
                .is_err()
        );
    }

    #[test]
    fn unwrap_plaintext_object() {
        let v = json!({"userInfo": {"userId": "u1"}});
        let out = unwrap_data("00", &v).expect("obj");
        assert_eq!(out["userInfo"]["userId"], "u1");
    }

    #[test]
    fn parse_user() {
        let data = json!({
            "accessToken": "t",
            "userInfo": {
                "userId": "u1",
                "tenantName": "疾控"
            }
        });
        let u = parse_user_info(&data).expect("user");
        assert_eq!(u.user_id, "u1");
        assert_eq!(u.display_name, None);
        assert_eq!(u.tenant_name.as_deref(), Some("疾控"));
    }

    #[test]
    fn parse_user_prefers_real_name() {
        let u = parse_user_info(&json!({
            "userInfo": {
                "userId": "u1",
                "realName": "陈敏",
                "nickName": "min",
                "accountName": "chenmin"
            }
        }))
        .expect("user");
        assert_eq!(u.display_name.as_deref(), Some("陈敏"));
    }

    #[test]
    fn parse_user_falls_back_to_account_name() {
        let u = parse_user_info(&json!({
            "userInfo": {
                "userId": "u1",
                "realName": "  ",
                "accountName": "chenmin"
            }
        }))
        .expect("user");
        assert_eq!(u.display_name.as_deref(), Some("chenmin"));
    }

    #[test]
    fn unwrap_decrypts_string_data() {
        let secret = "00112233445566778899aabbccddeeff";
        let cipher = crate::crypto::encrypt_data(secret, r#"{"ticket":"T"}"#).expect("enc");
        let out = unwrap_data(secret, &Value::String(cipher)).expect("dec");
        assert_eq!(out["ticket"], "T");
    }

    #[test]
    fn unwrap_rejects_empty_data() {
        assert!(unwrap_data("00", &Value::Null).is_err());
        assert!(unwrap_data("00", &Value::String(String::new())).is_err());
    }

    #[test]
    fn parse_user_requires_user_id() {
        assert!(parse_user_info(&json!({"userInfo": {"accountName": "a"}})).is_err());
        assert!(parse_user_info(&json!({"accessToken": "t"})).is_err());
    }
}
