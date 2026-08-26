use crate::config::Config;
use crate::identity::{
    HEADER_AUTH_SECRET, HEADER_USER_ID, HEADER_USER_ORG, HEADER_USER_REGION, HEADER_USER_ROLE,
    IDENTITY_HEADERS, Identity,
};
use crate::session::{SessionStore, sid_from_cookie_header};
use crate::user_center::UserCenter;
use anyhow::Result;
use axum::body::Body;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{FromRequest, Request, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Redirect, Response};
use futures_util::{SinkExt, StreamExt};
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;
use std::sync::Arc;
use tokio_tungstenite::tungstenite;

pub type HttpClient = Client<hyper_util::client::legacy::connect::HttpConnector, Body>;

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
    let sid = sid_from_cookie_header(cookie)?;
    state.sessions.get(&sid)
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

async fn proxy_http(state: Arc<AppState>, mut req: Request) -> Result<Response, Response> {
    let Some(identity) = identity_from_request(&state, req.headers()) else {
        return Err(unauthenticated(&state.cfg, req.uri().path()));
    };
    strip_identity(req.headers_mut());
    inject_identity(
        req.headers_mut(),
        &state.cfg.trusted_proxy_secret,
        &identity,
    );
    let target = rewrite_uri(&state.cfg.upstream, req.uri())
        .map_err(|_| (StatusCode::BAD_GATEWAY, "bad upstream URI").into_response())?;
    *req.uri_mut() = target;
    if let Ok(host) = HeaderValue::from_str(&upstream_host(&state.cfg.upstream)) {
        req.headers_mut().insert(axum::http::header::HOST, host);
    }
    remove_hop_by_hop(req.headers_mut());
    match state.http.request(req).await {
        Ok(resp) => Ok(resp.map(Body::new).into_response()),
        Err(err) => {
            tracing::warn!(error = %err, "upstream request failed");
            Err((StatusCode::BAD_GATEWAY, "upstream failed").into_response())
        }
    }
}

async fn proxy_ws(state: Arc<AppState>, req: Request) -> Response {
    let identity = match identity_from_request(&state, req.headers()) {
        Some(id) => id,
        None => return unauthenticated(&state.cfg, req.uri().path()),
    };
    let upstream = match ws_upstream_url(&state.cfg.upstream, req.uri()) {
        Ok(u) => u,
        Err(_) => return (StatusCode::BAD_GATEWAY, "bad upstream URI").into_response(),
    };
    let secret = state.cfg.trusted_proxy_secret.clone();
    let upgrade = match WebSocketUpgrade::from_request(req, &()).await {
        Ok(u) => u,
        Err(_) => return (StatusCode::BAD_REQUEST, "expected websocket").into_response(),
    };
    upgrade
        .on_upgrade(move |client| pump_ws(client, upstream, secret, identity))
        .into_response()
}

async fn pump_ws(client: WebSocket, upstream: String, secret: String, identity: Identity) {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let mut ws_req = match upstream.into_client_request() {
        Ok(req) => req,
        Err(err) => {
            tracing::warn!(error = %err, "ws request build failed");
            return;
        }
    };
    let headers = ws_req.headers_mut();
    headers.insert(HEADER_AUTH_SECRET, header_utf8(&secret));
    headers.insert(HEADER_USER_ID, header_utf8(&identity.user_id));
    headers.insert(HEADER_USER_ROLE, header_utf8(&identity.role));
    if let Some(org) = &identity.org {
        headers.insert(HEADER_USER_ORG, header_utf8(org));
    }
    if let Some(region) = &identity.region {
        headers.insert(HEADER_USER_REGION, header_utf8(region));
    }
    let (upstream_ws, _) = match tokio_tungstenite::connect_async(ws_req).await {
        Ok(pair) => pair,
        Err(err) => {
            tracing::warn!(error = %err, "upstream websocket failed");
            return;
        }
    };
    let (mut client_sink, mut client_stream) = client.split();
    let (mut up_sink, mut up_stream) = upstream_ws.split();
    let c2u = async {
        while let Some(Ok(msg)) = client_stream.next().await {
            if up_sink.send(to_tungstenite(msg)).await.is_err() {
                break;
            }
        }
    };
    let u2c = async {
        while let Some(Ok(msg)) = up_stream.next().await {
            if client_sink.send(from_tungstenite(msg)).await.is_err() {
                break;
            }
        }
    };
    tokio::select! {
        _ = c2u => {}
        _ = u2c => {}
    }
}

fn to_tungstenite(msg: Message) -> tungstenite::Message {
    match msg {
        Message::Text(t) => tungstenite::Message::Text(t.to_string().into()),
        Message::Binary(b) => tungstenite::Message::Binary(b.to_vec().into()),
        Message::Ping(b) => tungstenite::Message::Ping(b.to_vec().into()),
        Message::Pong(b) => tungstenite::Message::Pong(b.to_vec().into()),
        Message::Close(_) => tungstenite::Message::Close(None),
    }
}

fn from_tungstenite(msg: tungstenite::Message) -> Message {
    match msg {
        tungstenite::Message::Text(t) => Message::Text(t.to_string().into()),
        tungstenite::Message::Binary(b) => Message::Binary(b.to_vec().into()),
        tungstenite::Message::Ping(b) => Message::Ping(b.to_vec().into()),
        tungstenite::Message::Pong(b) => Message::Pong(b.to_vec().into()),
        tungstenite::Message::Close(_) => Message::Close(None),
        tungstenite::Message::Frame(_) => Message::Pong(vec![].into()),
    }
}

fn unauthenticated(cfg: &Config, path: &str) -> Response {
    let api = path.contains("/api") || path.contains("/ws") || path.contains("/admin");
    if api {
        return (StatusCode::UNAUTHORIZED, "login required").into_response();
    }
    match cfg.login_redirect() {
        Some(url) => Redirect::temporary(&url).into_response(),
        None => (StatusCode::UNAUTHORIZED, "login required").into_response(),
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

pub(crate) fn ws_upstream_url(upstream: &str, incoming: &Uri) -> Result<String, ()> {
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

fn upstream_host(upstream: &str) -> String {
    Uri::try_from(upstream)
        .ok()
        .and_then(|u| {
            let host = u.host()?.to_string();
            match u.port_u16() {
                Some(port) => Some(format!("{host}:{port}")),
                None => Some(host),
            }
        })
        .unwrap_or_else(|| "127.0.0.1:42617".to_string())
}

fn remove_hop_by_hop(headers: &mut HeaderMap) {
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
    fn ws_url_rewrites_http_scheme() {
        let uri: Uri = "/hbcdcagent/ws/chat".parse().expect("uri");
        let out = ws_upstream_url("http://127.0.0.1:42617", &uri).expect("ws");
        assert_eq!(out, "ws://127.0.0.1:42617/hbcdcagent/ws/chat");
    }
}
