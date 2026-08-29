use crate::config::Config;
use crate::error_page::{LoginErrorKind, login_error_response};
use crate::identity::{
    HEADER_AUTH_SECRET, HEADER_USER_ID, HEADER_USER_ORG, HEADER_USER_REGION, HEADER_USER_ROLE,
    IDENTITY_HEADERS, Identity, MOCK_COOKIE_NAME, mock_user, normalize_user_id,
};
use crate::session::{
    STATE_TTL, SessionStore, append_set_cookie, cookie_value, sid_from_cookie_header,
    state_cookie_header,
};
use crate::user_center::UserCenter;
use anyhow::Result;
use axum::body::{Body, to_bytes};
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode, Uri, header};
use axum::response::{IntoResponse, Redirect, Response};
use hyper::upgrade::OnUpgrade;
use hyper_util::client::legacy::Client;
use hyper_util::rt::{TokioExecutor, TokioIo};
use serde::Serialize;
use std::sync::Arc;
use tokio::io::copy_bidirectional;
use tokio::net::TcpStream;

const MAX_HTML_INJECT_BYTES: usize = 2 * 1024 * 1024;

pub type HttpClient = Client<hyper_util::client::legacy::connect::HttpConnector, Body>;

/// HTTP-only. `Config::from_env` rejects `https` upstreams so this is not a silent TLS miss.
pub fn http_client() -> HttpClient {
    Client::builder(TokioExecutor::new()).build_http()
}

#[derive(Clone)]
pub struct AppState {
    pub cfg: Config,
    pub sessions: Arc<SessionStore>,
    pub http: HttpClient,
    pub user_center: Arc<UserCenter>,
}

pub fn identity_from_request(state: &AppState, headers: &HeaderMap) -> Option<Identity> {
    let cookie = headers
        .get(axum::http::header::COOKIE)
        .and_then(|v| v.to_str().ok());
    if let Some(sid) = sid_from_cookie_header(cookie)
        && let Some(id) = state.sessions.get(&sid)
    {
        return Some(id);
    }
    mock_identity(&state.cfg, cookie)
}

/// Local demo mode: derive identity from the `zeroclaw_mock_user` cookie
/// instead of requiring an SSO session, validated against a fixed allowlist.
fn mock_identity(cfg: &Config, cookie: Option<&str>) -> Option<Identity> {
    if !cfg.local_mock {
        return None;
    }
    let user_id = normalize_user_id(&cookie_value(cookie, MOCK_COOKIE_NAME)?).ok()?;
    let spec = mock_user(&user_id)?;
    Some(Identity {
        user_id: spec.user_id.to_string(),
        display_name: Some(spec.display_name.to_string()),
        role: spec.role.to_string(),
        region: Some(spec.region.to_string()),
        org: Some(spec.org.to_string()),
    })
}

pub async fn fallback(State(state): State<Arc<AppState>>, req: Request) -> Response {
    if is_websocket(&req) {
        proxy_ws(state, req).await
    } else {
        match proxy_http(state, req).await {
            Ok(resp) => resp,
            Err(resp) => resp,
        }
    }
}

fn is_websocket(req: &Request) -> bool {
    req.headers()
        .get(axum::http::header::UPGRADE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.eq_ignore_ascii_case("websocket"))
        .unwrap_or(false)
}

fn requires_login(path: &str) -> bool {
    path.contains("/api") || path.contains("/ws") || path.contains("/admin")
}

/// Daemon public snapshot. Nginx only forwards `/hbcdcagent`, so this must
/// not require a BFF session and must not be answered by the BFF itself.
fn is_public_upstream(path: &str) -> bool {
    path == "/hbcdcagent/health" || path == "/health"
}

async fn proxy_http(state: Arc<AppState>, mut req: Request) -> Result<Response, Response> {
    let identity = identity_from_request(&state, req.headers());
    strip_identity(req.headers_mut());
    match identity {
        Some(identity) => {
            inject_identity(
                req.headers_mut(),
                &state.cfg.trusted_proxy_secret,
                &identity,
            );
            forward_http(&state, req, Some(&identity)).await
        }
        None if is_public_upstream(req.uri().path())
            || (state.cfg.local_mock && !requires_login(req.uri().path())) =>
        {
            // SPA + static assets must load so the mock picker can set the cookie.
            forward_http(&state, req, None).await
        }
        None => Err(unauthenticated(&state.cfg, req.uri().path())),
    }
}

async fn forward_http(
    state: &AppState,
    mut req: Request,
    identity: Option<&Identity>,
) -> Result<Response, Response> {
    let target = rewrite_uri(&state.cfg.upstream, req.uri())
        .map_err(|_| (StatusCode::BAD_GATEWAY, "bad upstream URI").into_response())?;
    *req.uri_mut() = target;
    if let Ok(host) = HeaderValue::from_str(&state.cfg.upstream_host) {
        req.headers_mut().insert(axum::http::header::HOST, host);
    }
    remove_hop_by_hop(req.headers_mut(), false);
    match state.http.request(req).await {
        Ok(resp) => {
            let resp = resp.map(Body::new).into_response();
            if let Some(identity) = identity {
                Ok(inject_platform_user(resp, identity).await)
            } else {
                Ok(resp)
            }
        }
        Err(err) => {
            tracing::warn!(error = %err, "upstream request failed");
            Err((StatusCode::BAD_GATEWAY, "upstream failed").into_response())
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlatformUserPayload<'a> {
    user_id: &'a str,
    display_name: &'a str,
    role: &'a str,
    region: &'a str,
    org: &'a str,
}

fn should_inject_html(headers: &HeaderMap) -> bool {
    let html = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|ct| {
            ct.split(';')
                .next()
                .map(str::trim)
                .is_some_and(|mime| mime.eq_ignore_ascii_case("text/html"))
        });
    if !html {
        return false;
    }
    let encoded = headers
        .get(header::CONTENT_ENCODING)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|enc| {
            let enc = enc.trim();
            !enc.is_empty() && !enc.eq_ignore_ascii_case("identity")
        });
    if encoded {
        return false;
    }
    let too_large = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<usize>().ok())
        .is_some_and(|n| n > MAX_HTML_INJECT_BYTES);
    !too_large
}

fn platform_user_script(identity: &Identity) -> Option<String> {
    let payload = PlatformUserPayload {
        user_id: &identity.user_id,
        display_name: identity.display_label(),
        role: &identity.role,
        region: identity.region.as_deref().unwrap_or(""),
        org: identity.org.as_deref().unwrap_or(""),
    };
    let mut json = serde_json::to_string(&payload).ok()?;
    json = json.replace('<', r"\u003c");
    Some(format!(
        "<script>window.__ZEROCLAW_PLATFORM_USER__={json};</script>"
    ))
}

fn inject_script_into_html(html: &str, script: &str) -> String {
    let lower = html.to_ascii_lowercase();
    if let Some(pos) = lower.find("<head>") {
        let insert_at = pos + "<head>".len();
        let mut out = String::with_capacity(html.len() + script.len());
        out.push_str(&html[..insert_at]);
        out.push_str(script);
        out.push_str(&html[insert_at..]);
        out
    } else {
        format!("{script}{html}")
    }
}

async fn inject_platform_user(resp: Response, identity: &Identity) -> Response {
    if !should_inject_html(resp.headers()) {
        return resp;
    }
    let Some(script) = platform_user_script(identity) else {
        return resp;
    };
    let (mut parts, body) = resp.into_parts();
    let bytes = match to_bytes(body, MAX_HTML_INJECT_BYTES).await {
        Ok(b) => b,
        Err(err) => {
            tracing::warn!(error = %err, "html inject body exceeded limit");
            return (StatusCode::BAD_GATEWAY, "upstream body").into_response();
        }
    };
    let Ok(html) = std::str::from_utf8(&bytes) else {
        parts.headers.remove(header::CONTENT_LENGTH);
        return Response::from_parts(parts, Body::from(bytes));
    };
    let injected = inject_script_into_html(html, &script);
    parts.headers.remove(header::TRANSFER_ENCODING);
    if let Ok(len) = HeaderValue::from_str(&injected.len().to_string()) {
        parts.headers.insert(header::CONTENT_LENGTH, len);
    } else {
        parts.headers.remove(header::CONTENT_LENGTH);
    }
    Response::from_parts(parts, Body::from(injected))
}

async fn proxy_ws(state: Arc<AppState>, mut req: Request) -> Response {
    let Some(identity) = identity_from_request(&state, req.headers()) else {
        return unauthenticated(&state.cfg, req.uri().path());
    };
    let target = match rewrite_uri(&state.cfg.upstream, req.uri()) {
        Ok(u) => u,
        Err(_) => return (StatusCode::BAD_GATEWAY, "bad upstream URI").into_response(),
    };
    let host = state.cfg.upstream_host.as_str();
    let client_upgrade = req.extensions_mut().remove::<OnUpgrade>();
    strip_identity(req.headers_mut());
    inject_identity(
        req.headers_mut(),
        &state.cfg.trusted_proxy_secret,
        &identity,
    );
    if let Ok(value) = HeaderValue::from_str(host) {
        req.headers_mut().insert(header::HOST, value);
    }
    remove_hop_by_hop(req.headers_mut(), true);
    let path = target.path_and_query().map(|pq| pq.as_str()).unwrap_or("/");
    *req.uri_mut() = match path.parse() {
        Ok(uri) => uri,
        Err(_) => return (StatusCode::BAD_GATEWAY, "bad upstream URI").into_response(),
    };
    match splice_upstream_ws(host, req, client_upgrade).await {
        Ok(resp) => resp,
        Err(err) => {
            tracing::warn!(error = %err, "upstream websocket failed");
            (StatusCode::BAD_GATEWAY, err).into_response()
        }
    }
}

/// Byte-splice the HTTP upgrade. Do not terminate WebSocket in the BFF:
/// re-encoding frames and `HeaderValue::to_str()` on Chinese identity
/// headers both produced browser close code 1006.
async fn splice_upstream_ws(
    host: &str,
    req: Request,
    client_upgrade: Option<OnUpgrade>,
) -> std::result::Result<Response, String> {
    let stream = TcpStream::connect(host)
        .await
        .map_err(|err| format!("tcp {host}: {err}"))?;
    let _ = stream.set_nodelay(true);
    let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .map_err(|err| format!("http handshake: {err}"))?;
    tokio::spawn(async move {
        if let Err(err) = conn.with_upgrades().await {
            tracing::debug!(error = %err, "upstream ws http conn closed");
        }
    });
    let mut res = sender
        .send_request(req)
        .await
        .map_err(|err| format!("ws send: {err}"))?;
    if res.status() != StatusCode::SWITCHING_PROTOCOLS {
        return Ok(res.map(Body::new).into_response());
    }
    let upstream_upgrade = hyper::upgrade::on(&mut res);
    if let Some(client_upgrade) = client_upgrade {
        tokio::spawn(async move {
            match tokio::join!(client_upgrade, upstream_upgrade) {
                (Ok(client), Ok(upstream)) => {
                    let mut client = TokioIo::new(client);
                    let mut upstream = TokioIo::new(upstream);
                    let _ = copy_bidirectional(&mut client, &mut upstream).await;
                }
                (Err(err), _) => {
                    tracing::debug!(error = %err, "client ws upgrade failed");
                }
                (_, Err(err)) => {
                    tracing::debug!(error = %err, "upstream ws upgrade failed");
                }
            }
        });
    }
    Ok(res.map(Body::new).into_response())
}

fn unauthenticated(cfg: &Config, path: &str) -> Response {
    if requires_login(path) {
        return (StatusCode::UNAUTHORIZED, "login required").into_response();
    }
    let state = uuid::Uuid::new_v4().to_string();
    match cfg.login_redirect_with_state(Some(&state)) {
        Some(url) => {
            let mut response = Redirect::temporary(&url).into_response();
            append_set_cookie(
                &mut response,
                &state_cookie_header(&state, STATE_TTL, cfg.cookie_secure),
            );
            response
        }
        None => login_error_response(StatusCode::UNAUTHORIZED, cfg, LoginErrorKind::NoLoginEntry),
    }
}

pub fn strip_identity(headers: &mut HeaderMap) {
    for name in IDENTITY_HEADERS {
        headers.remove(*name);
    }
}

pub fn inject_identity(headers: &mut HeaderMap, secret: &str, identity: &Identity) {
    headers.insert(HEADER_AUTH_SECRET, header_utf8(secret));
    headers.insert(HEADER_USER_ID, header_utf8(&identity.user_id));
    headers.insert(HEADER_USER_ROLE, header_utf8(&identity.role));
    if let Some(region) = &identity.region {
        headers.insert(HEADER_USER_REGION, header_utf8(region));
    }
    if let Some(org) = &identity.org {
        headers.insert(HEADER_USER_ORG, header_utf8(org));
    }
}

fn header_utf8(value: &str) -> HeaderValue {
    HeaderValue::from_bytes(value.as_bytes())
        .unwrap_or_else(|_| HeaderValue::from_static("invalid"))
}

pub(crate) fn rewrite_uri(upstream: &str, incoming: &Uri) -> Result<Uri, ()> {
    let path_and_query = incoming
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or("/");
    format!("{upstream}{path_and_query}")
        .parse()
        .map_err(|_| ())
}

#[cfg(test)]
fn ws_upstream_url(upstream: &str, incoming: &Uri) -> std::result::Result<String, ()> {
    let http_uri = rewrite_uri(upstream, incoming)?;
    let raw = http_uri.to_string();
    if let Some(rest) = raw.strip_prefix("https://") {
        Ok(format!("wss://{rest}"))
    } else if let Some(rest) = raw.strip_prefix("http://") {
        Ok(format!("ws://{rest}"))
    } else {
        Ok(raw)
    }
}

fn remove_hop_by_hop(headers: &mut HeaderMap, keep_upgrade: bool) {
    const HOP: &[&str] = &[
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailers",
        "transfer-encoding",
    ];
    for name in HOP {
        if keep_upgrade && *name == "connection" {
            continue;
        }
        if let Ok(n) = HeaderName::from_bytes(name.as_bytes()) {
            headers.remove(n);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::{Identity, ROLE_NORMAL};

    #[test]
    fn rewrite_keeps_prefix() {
        let uri: Uri = "/hbcdcagent/api/status?x=1".parse().expect("uri");
        let out = rewrite_uri("http://127.0.0.1:42617", &uri).expect("rewrite");
        assert_eq!(
            out.to_string(),
            "http://127.0.0.1:42617/hbcdcagent/api/status?x=1"
        );
    }

    #[test]
    fn inject_strips_forged_headers() {
        let mut headers = HeaderMap::new();
        headers.insert(HEADER_USER_ID, HeaderValue::from_static("forged"));
        strip_identity(&mut headers);
        let id = Identity {
            user_id: "real".into(),
            display_name: None,
            role: ROLE_NORMAL.into(),
            region: Some("武汉市".into()),
            org: None,
        };
        inject_identity(&mut headers, "secret", &id);
        assert_eq!(headers.get(HEADER_USER_ID).unwrap().as_bytes(), b"real");
        assert_eq!(
            headers.get(HEADER_USER_REGION).unwrap().as_bytes(),
            "武汉市".as_bytes()
        );
    }

    #[test]
    fn chinese_identity_header_is_opaque_not_visible_ascii() {
        // tungstenite connect_async uses HeaderValue::to_str() and yields
        // "UTF-8 encoding error" for these values.
        let role = header_utf8("普通用户");
        assert!(role.to_str().is_err());
        assert_eq!(
            std::str::from_utf8(role.as_bytes()).expect("utf8"),
            "普通用户"
        );
    }

    #[test]
    fn ws_url_rewrites_http_scheme() {
        let uri: Uri = "/hbcdcagent/ws/chat".parse().expect("uri");
        let out = ws_upstream_url("http://127.0.0.1:42617", &uri).expect("ws");
        assert_eq!(out, "ws://127.0.0.1:42617/hbcdcagent/ws/chat");
    }

    fn sample_identity() -> Identity {
        Identity {
            user_id: "chenmin".into(),
            display_name: Some("陈敏".into()),
            role: ROLE_NORMAL.into(),
            region: Some("武汉市".into()),
            org: Some("武汉疾控".into()),
        }
    }

    #[test]
    fn html_injects_camel_case_platform_user() {
        let script = platform_user_script(&sample_identity()).expect("script");
        let html = inject_script_into_html("<html><head></head><body></body></html>", &script);
        assert!(html.contains("<head><script>window.__ZEROCLAW_PLATFORM_USER__="));
        assert!(html.contains(r#""userId":"chenmin""#));
        assert!(html.contains(r#""displayName":"陈敏""#));
        assert!(html.contains(r#""role":"普通用户""#));
        assert!(!html.contains("user_id"));
        assert!(!html.contains("display_name"));
    }

    #[test]
    fn html_inject_falls_back_to_user_id() {
        let id = Identity {
            user_id: "alice".into(),
            display_name: Some("  ".into()),
            role: ROLE_NORMAL.into(),
            region: None,
            org: None,
        };
        let script = platform_user_script(&id).expect("script");
        assert!(script.contains(r#""displayName":"alice""#));
    }

    #[test]
    fn html_inject_escapes_script_breakout() {
        let id = Identity {
            user_id: "u1".into(),
            display_name: Some("</script><script>alert(1)".into()),
            role: ROLE_NORMAL.into(),
            region: None,
            org: None,
        };
        let script = platform_user_script(&id).expect("script");
        assert!(!script.contains("</script><script>"));
        assert!(script.contains(r"\u003c/script>"));
    }

    #[test]
    fn non_html_and_gzip_are_not_injected() {
        let mut html = HeaderMap::new();
        html.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/html; charset=utf-8"),
        );
        assert!(should_inject_html(&html));

        let mut json = HeaderMap::new();
        json.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        assert!(!should_inject_html(&json));

        let mut gzip = HeaderMap::new();
        gzip.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html"));
        gzip.insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
        assert!(!should_inject_html(&gzip));
    }

    #[test]
    fn mock_identity_gates_on_flag_and_allowlist() {
        let mut cfg = crate::config::Config::for_test("http://uc", "http://127.0.0.1:42617");
        cfg.local_mock = false;
        assert!(mock_identity(&cfg, Some("zeroclaw_mock_user=chenmin")).is_none());

        cfg.local_mock = true;
        let id = mock_identity(&cfg, Some("zeroclaw_mock_user=chenmin")).expect("mock");
        assert_eq!(id.user_id, "chenmin");
        assert_eq!(id.display_name.as_deref(), Some("陈敏"));
        assert_eq!(id.role, ROLE_NORMAL);

        let advanced = mock_identity(&cfg, Some("zeroclaw_mock_user=liuyang")).expect("adv");
        assert_eq!(advanced.role, crate::identity::ROLE_ADVANCED);

        let ops = mock_identity(&cfg, Some("zeroclaw_mock_user=ops")).expect("ops");
        assert_eq!(ops.role, crate::identity::ROLE_OPS);

        assert!(mock_identity(&cfg, Some("zeroclaw_mock_user=evil")).is_none());
        assert!(mock_identity(&cfg, Some("hbcdcagent_session=abc")).is_none());
        assert!(mock_identity(&cfg, None).is_none());
    }
}
