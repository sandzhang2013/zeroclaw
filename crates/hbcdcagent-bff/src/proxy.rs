use crate::config::Config;
use crate::error_page::{LoginErrorKind, login_error_response};
use crate::identity::{
    HEADER_AUTH_SECRET, HEADER_USER_ID, HEADER_USER_ORG, HEADER_USER_REGION, HEADER_USER_ROLE,
    IDENTITY_HEADERS, Identity, MOCK_COOKIE_NAME, ROLE_OPS, mock_user, normalize_user_id,
};
use crate::session::{
    STATE_TTL, SessionStore, append_clear_mock_cookies, append_set_cookie, cookie_header,
    cookie_value, session_id_from_headers, state_cookie_header, strip_embed_credentials,
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
use std::time::Instant;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
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
    pub nonces: Arc<crate::ticket::NonceStore>,
    pub ticket_rate: Arc<crate::ticket::RateWindow>,
}

pub fn identity_from_request(state: &AppState, headers: &HeaderMap) -> Option<Identity> {
    if let Some(sid) = session_id_from_headers(headers)
        && let Some(id) = state.sessions.get(&sid)
    {
        return Some(id);
    }
    let cookie = headers
        .get(axum::http::header::COOKIE)
        .and_then(|v| v.to_str().ok());
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
    if mcp_tools_match(req.uri().path()).is_some() {
        return match proxy_mcp_tools(state, req).await {
            Ok(resp) => resp,
            Err(resp) => resp,
        };
    }
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
    strip_embed_credentials(req.headers_mut());
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
        None => {
            // Leave clientId and verifyData on the document. The page verifies
            // and then removes them. A redirect here drops those parameters
            // before that, and a cross-site iframe cannot keep the cookie.
            if is_ticket_document(&req) || is_anonymous_asset(req.uri().path()) {
                return forward_http(&state, req, None).await;
            }
            if let Some(resp) = alert_ticket_link(&state, &req) {
                return Err(resp);
            }
            Err(unauthenticated(&state.cfg, req.uri().path()))
        }
    }
}

async fn forward_http(
    state: &AppState,
    mut req: Request,
    identity: Option<&Identity>,
) -> Result<Response, Response> {
    // The document may still carry the previous user's session. A ticket in
    // the URL names who this open is for; paint that person, and leave the
    // nonce for the page verify that actually switches the session.
    let shown = html_user(state, &req, identity);
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
            Ok(inject_workbench_html(resp, shown.as_ref(), &state.cfg).await)
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

fn path_prefix_script() -> String {
    let json = serde_json::to_string(Config::PATH_PREFIX)
        .unwrap_or_else(|_| "\"/hbcdcagent\"".to_string());
    format!(
        "<script>window.__ZEROCLAW_BASE__={json};</script>\
         <script>try{{var k='zeroclaw-locale';if(!localStorage.getItem(k))localStorage.setItem(k,'zh');}}catch(_e){{}}</script>"
    )
}

fn workbench_head_script(identity: Option<&Identity>, local_mock: bool) -> String {
    let mut script = path_prefix_script();
    if !local_mock {
        script.push_str("<script>window.__ZEROCLAW_LOCAL_MOCK__=false;</script>");
    }
    if let Some(identity) = identity
        && let Some(user) = platform_user_script(identity)
    {
        script.push_str(&user);
    }
    script
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

pub(crate) fn apply_frame_policy(headers: &mut HeaderMap, ancestors: &[String]) {
    if ancestors.is_empty() {
        return;
    }
    headers.remove(header::X_FRAME_OPTIONS);
    headers.insert(
        HeaderName::from_static("cross-origin-resource-policy"),
        HeaderValue::from_static("cross-origin"),
    );
    let allow = format!("frame-ancestors 'self' {}", ancestors.join(" "));
    let Some(existing) = headers
        .get(header::CONTENT_SECURITY_POLICY)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
    else {
        if let Ok(value) = HeaderValue::from_str(&allow) {
            headers.insert(header::CONTENT_SECURITY_POLICY, value);
        }
        return;
    };
    let next = if existing.contains("frame-ancestors 'none'") {
        existing.replace("frame-ancestors 'none'", &allow)
    } else if existing.contains("frame-ancestors") {
        existing
    } else {
        format!("{existing}; {allow}")
    };
    if let Ok(value) = HeaderValue::from_str(&next) {
        headers.insert(header::CONTENT_SECURITY_POLICY, value);
    }
}

async fn inject_workbench_html(
    resp: Response,
    identity: Option<&Identity>,
    cfg: &Config,
) -> Response {
    if !should_inject_html(resp.headers()) {
        return resp;
    }
    let script = workbench_head_script(identity, cfg.local_mock);
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
        apply_frame_policy(&mut parts.headers, &cfg.frame_ancestors);
        return Response::from_parts(parts, Body::from(bytes));
    };
    let injected = inject_script_into_html(html, &script);
    apply_frame_policy(&mut parts.headers, &cfg.frame_ancestors);
    parts.headers.remove(header::TRANSFER_ENCODING);
    if let Ok(len) = HeaderValue::from_str(&injected.len().to_string()) {
        parts.headers.insert(header::CONTENT_LENGTH, len);
    } else {
        parts.headers.remove(header::CONTENT_LENGTH);
    }
    let mut response = Response::from_parts(parts, Body::from(injected));
    // SSO has no mock login. Expire a leftover local cookie before page script
    // runs, or the picker treats this visit as local mode.
    if !cfg.local_mock {
        append_clear_mock_cookies(&mut response, cfg.cookie_secure);
    }
    response
}

/// Ticket URL wins over the session cookie for the injected label.
fn html_user(state: &AppState, req: &Request, session: Option<&Identity>) -> Option<Identity> {
    if let Some((client_id, verify_data)) = ticket_query(req.uri()) {
        return crate::ticket::preview_identity(
            state.cfg.ticket_sso.as_ref(),
            &client_id,
            &verify_data,
            chrono::Utc::now().timestamp_millis(),
            &state.cfg.ops_user_ids,
        );
    }
    session.cloned()
}

async fn proxy_ws(state: Arc<AppState>, mut req: Request) -> Response {
    let Some(identity) = identity_from_request(&state, req.headers()) else {
        return unauthenticated(&state.cfg, req.uri().path());
    };
    strip_embed_credentials(req.headers_mut());
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
                    let started = Instant::now();
                    let end = splice_until_one_side_closes(&mut client, &mut upstream).await;
                    log_ws_splice_end(started.elapsed(), &end);
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

enum DirectionEnd {
    Eof,
    ReadError(String),
    WriteError(String),
}

struct WsSpliceClose {
    closed_by: &'static str,
    cause: &'static str,
    error: Option<String>,
}

/// `read_peer` is the socket this copy reads. A write error is the other socket.
fn classify_ws_splice_close(read_peer: &'static str, end: DirectionEnd) -> WsSpliceClose {
    let write_peer = if read_peer == "browser" {
        "daemon"
    } else {
        "browser"
    };
    match end {
        DirectionEnd::Eof => WsSpliceClose {
            closed_by: read_peer,
            cause: "eof",
            error: None,
        },
        DirectionEnd::ReadError(error) => WsSpliceClose {
            closed_by: read_peer,
            cause: "read_error",
            error: Some(error),
        },
        DirectionEnd::WriteError(error) => WsSpliceClose {
            closed_by: write_peer,
            cause: "write_error",
            error: Some(error),
        },
    }
}

async fn copy_one_way<R, W>(read: &mut R, write: &mut W) -> DirectionEnd
where
    R: AsyncRead + Unpin + ?Sized,
    W: AsyncWrite + Unpin + ?Sized,
{
    let mut buf = [0u8; 16 * 1024];
    loop {
        let n = match read.read(&mut buf).await {
            Ok(0) => return DirectionEnd::Eof,
            Ok(n) => n,
            Err(err) => return DirectionEnd::ReadError(err.to_string()),
        };
        if let Err(err) = write.write_all(&buf[..n]).await {
            return DirectionEnd::WriteError(err.to_string());
        }
    }
}

async fn splice_until_one_side_closes<C, U>(client: &mut C, upstream: &mut U) -> WsSpliceClose
where
    C: AsyncRead + AsyncWrite + Unpin,
    U: AsyncRead + AsyncWrite + Unpin,
{
    let (mut client_read, mut client_write) = tokio::io::split(client);
    let (mut upstream_read, mut upstream_write) = tokio::io::split(upstream);
    let browser_to_daemon = copy_one_way(&mut client_read, &mut upstream_write);
    let daemon_to_browser = copy_one_way(&mut upstream_read, &mut client_write);
    tokio::pin!(browser_to_daemon);
    tokio::pin!(daemon_to_browser);
    tokio::select! {
        end = &mut browser_to_daemon => classify_ws_splice_close("browser", end),
        end = &mut daemon_to_browser => classify_ws_splice_close("daemon", end),
    }
}

fn log_ws_splice_end(elapsed: std::time::Duration, end: &WsSpliceClose) {
    let duration_ms = u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX);
    match &end.error {
        Some(error) => {
            tracing::info!(
                duration_ms,
                closed_by = end.closed_by,
                cause = end.cause,
                error = %error,
                "websocket splice ended"
            );
        }
        None => {
            tracing::info!(
                duration_ms,
                closed_by = end.closed_by,
                cause = end.cause,
                "websocket splice ended"
            );
        }
    }
}

/// 工作台页面不走这里，票据要留给页面自己验。只有需要登录的地址才会在这里验票后跳转。
fn alert_ticket_link(state: &AppState, req: &Request) -> Option<Response> {
    if req.method() != axum::http::Method::GET || state.cfg.ticket_sso.is_none() {
        return None;
    }
    let (client_id, verify_data) = ticket_query(req.uri())?;
    let sso = state.cfg.ticket_sso.as_ref()?;
    if !crate::ticket::rate_ok(&state.ticket_rate, sso, &ticket_caller(req)) {
        return Some(ticket_rejected(
            StatusCode::TOO_MANY_REQUESTS,
            crate::ticket::MSG_RATE,
        ));
    }
    let now_ms = chrono::Utc::now().timestamp_millis();
    let outcome = crate::ticket::verify_ticket(
        Some(sso),
        &client_id,
        &verify_data,
        now_ms,
        &state.cfg.ops_user_ids,
        &state.nonces,
        false,
    );
    let Some(identity) = outcome.identity else {
        if outcome.code == crate::ticket::CODE_DECRYPT || outcome.code == crate::ticket::CODE_REPLAY
        {
            tracing::warn!(code = outcome.code, client_id = %client_id, "alert ticket link rejected");
        } else {
            tracing::info!(code = outcome.code, client_id = %client_id, "alert ticket link rejected");
        }
        let status = if outcome.code == crate::ticket::CODE_RATE {
            StatusCode::TOO_MANY_REQUESTS
        } else {
            StatusCode::BAD_REQUEST
        };
        return Some(ticket_rejected(status, outcome.msg));
    };
    tracing::info!(user_id = %identity.user_id, "alert ticket session created from workbench link");
    let sid = state.sessions.insert(identity, state.cfg.session_ttl);
    let mut response = ticket_landing_page(&location_without_ticket(req.uri()));
    append_set_cookie(
        &mut response,
        &cookie_header(&sid, state.cfg.session_ttl, state.cfg.cookie_secure),
    );
    Some(response)
}

/// Document on this host, then a same-origin navigation. The session cookie
/// is committed before the next request, so SameSite=Lax is sent.
fn ticket_landing_page(next: &str) -> Response {
    let html = format!(
        "<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta http-equiv=\"refresh\" content=\"0;url={}\"><title>正在进入工作台</title></head><body><script>location.replace({})</script></body></html>",
        html_attr(next),
        js_string(next),
    );
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        html,
    )
        .into_response()
}

fn html_attr(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(ch),
        }
    }
    out
}

fn js_string(value: &str) -> String {
    let mut out = String::from("\"");
    for ch in value.chars() {
        match ch {
            '\\' | '"' => {
                out.push('\\');
                out.push(ch);
            }
            c if c.is_control() => out.push_str(&format!("\\u{:04x}", u32::from(c))),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Workbench HTML that still has `clientId` and `verifyData`. Do not spend
/// the ticket or redirect: the next request would lose the parameters.
fn is_ticket_document(req: &Request) -> bool {
    if req.method() != axum::http::Method::GET || requires_login(req.uri().path()) {
        return false;
    }
    ticket_query(req.uri()).is_some()
}

/// Script and style requests from the framed page have no session yet.
fn is_anonymous_asset(path: &str) -> bool {
    path.contains("/_app/") || path.ends_with("/favicon.ico")
}

fn ticket_caller(req: &Request) -> String {
    req.headers()
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(',').next())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("direct")
        .to_string()
}

fn ticket_query(uri: &Uri) -> Option<(String, String)> {
    let query = uri.query()?;
    let mut client_id = None;
    let mut verify_data = None;
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        match key {
            "clientId" => client_id = Some(percent_decode(value)),
            "verifyData" => verify_data = Some(percent_decode(value)),
            _ => {}
        }
    }
    let client_id = client_id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())?;
    let verify_data = verify_data
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())?;
    Some((client_id, verify_data))
}

fn location_without_ticket(uri: &Uri) -> String {
    let path = uri.path();
    let rest: Vec<&str> = uri
        .query()
        .unwrap_or("")
        .split('&')
        .filter(|pair| {
            let key = pair.split_once('=').map(|(key, _)| key).unwrap_or(pair);
            !pair.is_empty() && key != "clientId" && key != "verifyData"
        })
        .collect();
    if rest.is_empty() {
        path.to_string()
    } else {
        format!("{path}?{}", rest.join("&"))
    }
}

fn percent_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or("");
            if let Ok(value) = u8::from_str_radix(hex, 16) {
                out.push(value);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn ticket_rejected(status: StatusCode, msg: &str) -> Response {
    let html = format!(
        "<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><title>无法进入工作台</title></head><body><h1>无法进入工作台</h1><p>{msg}</p></body></html>"
    );
    (
        status,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        html,
    )
        .into_response()
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
            if !cfg.local_mock {
                append_clear_mock_cookies(&mut response, cfg.cookie_secure);
            }
            response
        }
        None => {
            let mut response =
                login_error_response(StatusCode::UNAUTHORIZED, cfg, LoginErrorKind::NoLoginEntry);
            if !cfg.local_mock {
                append_clear_mock_cookies(&mut response, cfg.cookie_secure);
            }
            response
        }
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

#[derive(Debug)]
enum McpToolsMatch {
    /// `/hbcdcagent/mcp-tools` without the trailing slash. The page derives its
    /// API prefix from the directory of the current URL, so the slash is required.
    Redirect,
    /// Path on the loopback service, always starting with `/`.
    Forward(String),
}

fn mcp_tools_match(path: &str) -> Option<McpToolsMatch> {
    const PREFIX: &str = Config::MCP_TOOLS_PREFIX;
    if path == PREFIX {
        return Some(McpToolsMatch::Redirect);
    }
    let rest = path.strip_prefix(PREFIX)?;
    if !rest.starts_with('/') {
        return None;
    }
    Some(McpToolsMatch::Forward(rest.to_string()))
}

async fn proxy_mcp_tools(state: Arc<AppState>, mut req: Request) -> Result<Response, Response> {
    let route = mcp_tools_match(req.uri().path()).expect("caller checked mcp tools path");
    let identity = identity_from_request(&state, req.headers());
    strip_embed_credentials(req.headers_mut());
    strip_identity(req.headers_mut());
    let Some(identity) = identity else {
        return Err(unauthenticated(&state.cfg, req.uri().path()));
    };
    if identity.role != ROLE_OPS {
        return Err((StatusCode::FORBIDDEN, "forbidden").into_response());
    }
    let McpToolsMatch::Forward(suffix) = route else {
        let loc = format!("{}/", Config::MCP_TOOLS_PREFIX);
        return Ok(Redirect::temporary(&loc).into_response());
    };
    let query = req.uri().query().map(str::to_string);
    let target = mcp_tools_upstream_uri(&state.cfg.mcp_tools_upstream, &suffix, query.as_deref())
        .map_err(|_| (StatusCode::BAD_GATEWAY, "bad upstream URI").into_response())?;
    *req.uri_mut() = target;
    if let Ok(host) = HeaderValue::from_str(&state.cfg.mcp_tools_host) {
        req.headers_mut().insert(axum::http::header::HOST, host);
    }
    remove_hop_by_hop(req.headers_mut(), false);
    match state.http.request(req).await {
        Ok(resp) => Ok(resp.map(Body::new).into_response()),
        Err(err) => {
            tracing::warn!(error = %err, "mcp tools upstream failed");
            Err((StatusCode::BAD_GATEWAY, "upstream failed").into_response())
        }
    }
}

fn mcp_tools_upstream_uri(upstream: &str, suffix: &str, query: Option<&str>) -> Result<Uri, ()> {
    let query = query.map(|q| format!("?{q}")).unwrap_or_default();
    format!("{upstream}{suffix}{query}").parse().map_err(|_| ())
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
    fn splice_close_names_the_peer_that_stopped_reading() {
        let end = classify_ws_splice_close("browser", DirectionEnd::Eof);
        assert_eq!(end.closed_by, "browser");
        assert_eq!(end.cause, "eof");
        assert!(end.error.is_none());

        let end = classify_ws_splice_close("daemon", DirectionEnd::ReadError("reset".into()));
        assert_eq!(end.closed_by, "daemon");
        assert_eq!(end.cause, "read_error");
        assert_eq!(end.error.as_deref(), Some("reset"));
    }

    #[test]
    fn splice_write_error_names_the_peer_being_written() {
        let end =
            classify_ws_splice_close("browser", DirectionEnd::WriteError("broken pipe".into()));
        assert_eq!(end.closed_by, "daemon");
        assert_eq!(end.cause, "write_error");

        let end = classify_ws_splice_close("daemon", DirectionEnd::WriteError("reset".into()));
        assert_eq!(end.closed_by, "browser");
        assert_eq!(end.cause, "write_error");
    }

    #[test]
    fn mcp_tools_prefix_strips_to_the_loopback_path() {
        match mcp_tools_match("/hbcdcagent/mcp-tools/api/tools") {
            Some(McpToolsMatch::Forward(suffix)) => assert_eq!(suffix, "/api/tools"),
            other => panic!("expected forward, got {other:?}"),
        }
        match mcp_tools_match("/hbcdcagent/mcp-tools/") {
            Some(McpToolsMatch::Forward(suffix)) => assert_eq!(suffix, "/"),
            other => panic!("expected forward, got {other:?}"),
        }
        assert!(matches!(
            mcp_tools_match("/hbcdcagent/mcp-tools"),
            Some(McpToolsMatch::Redirect)
        ));
        assert!(mcp_tools_match("/hbcdcagent/mcp-tools-extra").is_none());
        assert!(mcp_tools_match("/hbcdcagent/mcp-config").is_none());
        let uri = mcp_tools_upstream_uri("http://127.0.0.1:9100", "/api/prompt", Some("x=1"))
            .expect("uri");
        assert_eq!(uri.to_string(), "http://127.0.0.1:9100/api/prompt?x=1");
    }

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
    fn html_injects_path_prefix_and_platform_user() {
        let script = workbench_head_script(Some(&sample_identity()), true);
        let html = inject_script_into_html("<html><head></head><body></body></html>", &script);
        assert!(html.contains(r#"window.__ZEROCLAW_BASE__="/hbcdcagent""#));
        assert!(html.contains("<head><script>window.__ZEROCLAW_BASE__="));
        assert!(html.contains("window.__ZEROCLAW_PLATFORM_USER__="));
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

        let ordinary = mock_identity(&cfg, Some("zeroclaw_mock_user=liuyang")).expect("user");
        assert_eq!(ordinary.role, crate::identity::ROLE_NORMAL);

        let ops = mock_identity(&cfg, Some("zeroclaw_mock_user=ops")).expect("ops");
        assert_eq!(ops.role, crate::identity::ROLE_OPS);

        let last = mock_identity(
            &cfg,
            Some("zeroclaw_mock_user=chenmin; zeroclaw_mock_user=ops"),
        )
        .expect("last cookie wins");
        assert_eq!(last.user_id, "ops");

        assert!(mock_identity(&cfg, Some("zeroclaw_mock_user=evil")).is_none());
        assert!(mock_identity(&cfg, Some("hbcdcagent_session=abc")).is_none());
        assert!(mock_identity(&cfg, None).is_none());
    }

    #[test]
    fn frame_policy_replaces_deny_with_the_allowlist() {
        let mut headers = HeaderMap::new();
        headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
        headers.insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static("default-src 'self'; frame-ancestors 'none'"),
        );
        headers.insert(
            HeaderName::from_static("cross-origin-resource-policy"),
            HeaderValue::from_static("same-origin"),
        );
        apply_frame_policy(&mut headers, &[]);
        assert_eq!(headers.get(header::X_FRAME_OPTIONS).unwrap(), "DENY");
        apply_frame_policy(&mut headers, &["http://alert.example".to_string()]);
        assert!(headers.get(header::X_FRAME_OPTIONS).is_none());
        let csp = headers
            .get(header::CONTENT_SECURITY_POLICY)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(csp.contains("frame-ancestors 'self' http://alert.example"));
        assert!(!csp.contains("frame-ancestors 'none'"));
        assert_eq!(
            headers
                .get(HeaderName::from_static("cross-origin-resource-policy"))
                .unwrap(),
            "cross-origin"
        );
    }
}
