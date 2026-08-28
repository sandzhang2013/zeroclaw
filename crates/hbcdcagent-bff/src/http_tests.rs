use crate::config::Config;
use crate::crypto::{decrypt_data, encrypt_data, sign};
use crate::identity::{
    HEADER_AUTH_SECRET, HEADER_USER_ID, HEADER_USER_ORG, HEADER_USER_REGION, HEADER_USER_ROLE,
};
use crate::router;
use crate::session::COOKIE_NAME;
use axum::Router;
use axum::body::{Body, to_bytes};
use axum::extract::Request;
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::IntoResponse;
use axum::routing::post;
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use tokio::net::TcpListener;
use tower::ServiceExt;

const SECRET: &str = "00112233445566778899aabbccddeeff";
const TICKET: &str = "ticket-1";
const TICKET_SECRET: &str = "ticket-secret-1";
const REFRESH: &str = "refresh-1";

struct MockUserCenter {
    user_info_calls: AtomicU32,
    fail_first_user_info: bool,
}

impl MockUserCenter {
    fn ok() -> Arc<Self> {
        Arc::new(Self {
            user_info_calls: AtomicU32::new(0),
            fail_first_user_info: false,
        })
    }

    fn expire_ticket_once() -> Arc<Self> {
        Arc::new(Self {
            user_info_calls: AtomicU32::new(0),
            fail_first_user_info: true,
        })
    }
}

fn header_text(headers: &HeaderMap, name: &str) -> String {
    headers
        .get(name)
        .and_then(|v| std::str::from_utf8(v.as_bytes()).ok())
        .unwrap_or("")
        .to_string()
}

async fn mock_ticket(axum::Json(body): axum::Json<Value>) -> impl IntoResponse {
    assert_eq!(body["appId"], "app-id");
    assert_eq!(body["appSecret"], SECRET);
    let plain = json!({
        "ticket": TICKET,
        "ticketSecret": TICKET_SECRET,
        "refreshTicket": REFRESH,
    });
    let data = encrypt_data(SECRET, &plain.to_string()).expect("ticket enc");
    axum::Json(json!({"success": true, "retCode": "999999", "data": data}))
}

async fn mock_user_info(
    axum::extract::State(state): axum::extract::State<Arc<MockUserCenter>>,
    headers: HeaderMap,
    axum::Json(body): axum::Json<Value>,
) -> impl IntoResponse {
    let n = state.user_info_calls.fetch_add(1, Ordering::SeqCst);
    if state.fail_first_user_info && n == 0 {
        return axum::Json(json!({"success": false, "retCode": "GW0003", "retMsg": "expired"}))
            .into_response();
    }
    let ts = header_text(&headers, "timeStamp");
    let expected = sign(
        "MD5",
        &["app-id", TICKET, TICKET_SECRET, &ts, SECRET, "app-key"],
    )
    .expect("sign");
    assert_eq!(header_text(&headers, "sign"), expected);
    assert_eq!(header_text(&headers, "ticket"), TICKET);
    let cipher = body["encodeData"].as_str().expect("encodeData");
    let plain: Value =
        serde_json::from_str(&decrypt_data(SECRET, cipher).expect("dec")).expect("json");
    let code = plain["verifyCode"].as_str().unwrap_or("");
    if code == "bad-id" {
        let data = encrypt_data(
            SECRET,
            &json!({"userInfo": {"userId": "../x", "tenantName": "x"}}).to_string(),
        )
        .expect("enc");
        return axum::Json(json!({"success": true, "retCode": "999999", "data": data}))
            .into_response();
    }
    if code != "good-code" && code != "ops-code" {
        return axum::Json(json!({"success": false, "retCode": "UC0001", "retMsg": "bad code"}))
            .into_response();
    }
    let user_id = if code == "ops-code" {
        "ops-user"
    } else {
        "alice"
    };
    let data = encrypt_data(
        SECRET,
        &json!({
            "userInfo": {
                "userId": user_id,
                "realName": if code == "ops-code" { "系统运维" } else { "爱丽丝" },
                "tenantName": "武汉疾控"
            }
        })
        .to_string(),
    )
    .expect("enc");
    axum::Json(json!({"success": true, "retCode": "999999", "data": data})).into_response()
}

async fn start_user_center(state: Arc<MockUserCenter>) -> (String, tokio::task::JoinHandle<()>) {
    let app = Router::new()
        .route("/auth/ticket", post(mock_ticket))
        .route("/sso/code/userInfo", post(mock_user_info))
        .with_state(state);
    serve(app).await
}

async fn start_html_upstream() -> (String, tokio::task::JoinHandle<()>) {
    let app = Router::new().fallback(async || {
        (
            [(axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8")],
            "<html><head></head><body>workbench</body></html>",
        )
    });
    serve(app).await
}

async fn start_upstream() -> (String, tokio::task::JoinHandle<()>) {
    let app = Router::new().fallback(async |req: Request| {
        let user = header_text(req.headers(), HEADER_USER_ID);
        let role = header_text(req.headers(), HEADER_USER_ROLE);
        let org = header_text(req.headers(), HEADER_USER_ORG);
        let secret = header_text(req.headers(), HEADER_AUTH_SECRET);
        axum::Json(json!({
            "path": req.uri().path(),
            "query": req.uri().query(),
            "user": user,
            "role": role,
            "org": org,
            "secret": secret,
        }))
    });
    serve(app).await
}

async fn serve(app: Router) -> (String, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    let handle = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{addr}"), handle)
}

fn cookie_sid(set_cookie: &str) -> String {
    set_cookie
        .split(';')
        .next()
        .and_then(|p| p.strip_prefix(&format!("{COOKIE_NAME}=")))
        .expect("sid")
        .to_string()
}

async fn json_body(resp: axum::response::Response) -> Value {
    let bytes = to_bytes(resp.into_body(), usize::MAX).await.expect("body");
    serde_json::from_slice(&bytes).expect("json")
}

#[tokio::test]
async fn health_ok() {
    let (uc, uc_h) = start_user_center(MockUserCenter::ok()).await;
    let (up, up_h) = start_upstream().await;
    let app = router(Config::for_test(&uc, &up)).expect("router");
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/health")
                .body(Body::empty())
                .expect("req"),
        )
        .await
        .expect("resp");
    assert_eq!(resp.status(), StatusCode::OK);
    uc_h.abort();
    up_h.abort();
}

#[tokio::test]
async fn callback_requires_verify_code() {
    let (uc, uc_h) = start_user_center(MockUserCenter::ok()).await;
    let (up, up_h) = start_upstream().await;
    let app = router(Config::for_test(&uc, &up)).expect("router");
    for uri in [
        "/auth/callback",
        "/auth/callback?verifyCode=",
        "/auth/callback?verifyCode=%20",
    ] {
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(uri)
                    .body(Body::empty())
                    .expect("req"),
            )
            .await
            .expect("resp");
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST, "{uri}");
    }
    uc_h.abort();
    up_h.abort();
}

#[tokio::test]
async fn callback_success_sets_httponly_cookie_and_strips_code() {
    let (uc, uc_h) = start_user_center(MockUserCenter::ok()).await;
    let (up, up_h) = start_upstream().await;
    let app = router(Config::for_test(&uc, &up)).expect("router");
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/auth/callback?verifyCode=good-code")
                .body(Body::empty())
                .expect("req"),
        )
        .await
        .expect("resp");
    assert_eq!(resp.status(), StatusCode::TEMPORARY_REDIRECT);
    assert_eq!(
        resp.headers().get("location").and_then(|v| v.to_str().ok()),
        Some("/hbcdcagent/workbench")
    );
    let cookie = resp
        .headers()
        .get("set-cookie")
        .and_then(|v| v.to_str().ok())
        .expect("set-cookie");
    assert!(cookie.contains("HttpOnly"));
    assert!(cookie.contains(COOKIE_NAME));
    assert!(!cookie.contains("good-code"));
    uc_h.abort();
    up_h.abort();
}

#[tokio::test]
async fn callback_rejects_unsafe_user_id() {
    let (uc, uc_h) = start_user_center(MockUserCenter::ok()).await;
    let (up, up_h) = start_upstream().await;
    let app = router(Config::for_test(&uc, &up)).expect("router");
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/auth/callback?verifyCode=bad-id")
                .body(Body::empty())
                .expect("req"),
        )
        .await
        .expect("resp");
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    uc_h.abort();
    up_h.abort();
}

#[tokio::test]
async fn callback_unknown_code_is_bad_gateway() {
    let (uc, uc_h) = start_user_center(MockUserCenter::ok()).await;
    let (up, up_h) = start_upstream().await;
    let app = router(Config::for_test(&uc, &up)).expect("router");
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/auth/callback?verifyCode=unknown")
                .body(Body::empty())
                .expect("req"),
        )
        .await
        .expect("resp");
    assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);
    uc_h.abort();
    up_h.abort();
}

#[tokio::test]
async fn workbench_without_cookie_redirects_to_sso() {
    let (uc, uc_h) = start_user_center(MockUserCenter::ok()).await;
    let (up, up_h) = start_upstream().await;
    let app = router(Config::for_test(&uc, &up)).expect("router");
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/hbcdcagent/workbench")
                .body(Body::empty())
                .expect("req"),
        )
        .await
        .expect("resp");
    assert_eq!(resp.status(), StatusCode::TEMPORARY_REDIRECT);
    let loc = resp
        .headers()
        .get("location")
        .and_then(|v| v.to_str().ok())
        .expect("loc");
    assert!(loc.starts_with("http://sso/login?"));
    assert!(loc.contains("redirectUrl=http%3A%2F%2F88.8.130.150%3A50001%2Fauth%2Fcallback"));
    uc_h.abort();
    up_h.abort();
}

#[tokio::test]
async fn api_without_cookie_is_unauthorized() {
    let (uc, uc_h) = start_user_center(MockUserCenter::ok()).await;
    let (up, up_h) = start_upstream().await;
    let app = router(Config::for_test(&uc, &up)).expect("router");
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/hbcdcagent/api/status")
                .body(Body::empty())
                .expect("req"),
        )
        .await
        .expect("resp");
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    uc_h.abort();
    up_h.abort();
}

#[tokio::test]
async fn local_mock_cookie_skips_sso() {
    let (uc, uc_h) = start_user_center(MockUserCenter::ok()).await;
    let (up, up_h) = start_upstream().await;
    let mut cfg = Config::for_test(&uc, &up);
    cfg.local_mock = true;
    let app = router(cfg).expect("router");
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/hbcdcagent/api/status")
                .header("cookie", "zeroclaw_mock_user=chenmin")
                .body(Body::empty())
                .expect("req"),
        )
        .await
        .expect("resp");
    assert_eq!(resp.status(), StatusCode::OK);
    let body = json_body(resp).await;
    assert_eq!(body["user"], "chenmin");
    assert_eq!(body["role"], "普通用户");
    assert_eq!(body["secret"], "bff-secret");
    uc_h.abort();
    up_h.abort();
}

#[tokio::test]
async fn local_mock_rejects_non_allowlisted_user() {
    let (uc, uc_h) = start_user_center(MockUserCenter::ok()).await;
    let (up, up_h) = start_upstream().await;
    let mut cfg = Config::for_test(&uc, &up);
    cfg.local_mock = true;
    let app = router(cfg).expect("router");
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/hbcdcagent/api/status")
                .header("cookie", "zeroclaw_mock_user=evil")
                .body(Body::empty())
                .expect("req"),
        )
        .await
        .expect("resp");
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    uc_h.abort();
    up_h.abort();
}

#[tokio::test]
async fn local_mock_workbench_without_cookie_serves_spa() {
    let (uc, uc_h) = start_user_center(MockUserCenter::ok()).await;
    let (up, up_h) = start_html_upstream().await;
    let mut cfg = Config::for_test(&uc, &up);
    cfg.local_mock = true;
    let app = router(cfg).expect("router");
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/hbcdcagent/workbench")
                .body(Body::empty())
                .expect("req"),
        )
        .await
        .expect("resp");
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = to_bytes(resp.into_body(), usize::MAX).await.expect("body");
    let html = String::from_utf8(bytes.to_vec()).expect("utf8");
    assert!(html.contains("workbench</body>"));
    assert!(!html.contains("__ZEROCLAW_PLATFORM_USER__"));
    uc_h.abort();
    up_h.abort();
}

#[tokio::test]
async fn local_mock_api_without_cookie_is_unauthorized() {
    let (uc, uc_h) = start_user_center(MockUserCenter::ok()).await;
    let (up, up_h) = start_upstream().await;
    let mut cfg = Config::for_test(&uc, &up);
    cfg.local_mock = true;
    let app = router(cfg).expect("router");
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/hbcdcagent/api/status")
                .body(Body::empty())
                .expect("req"),
        )
        .await
        .expect("resp");
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    uc_h.abort();
    up_h.abort();
}

#[tokio::test]
async fn local_mock_login_sets_cookie_and_redirects() {
    let (uc, uc_h) = start_user_center(MockUserCenter::ok()).await;
    let (up, up_h) = start_upstream().await;
    let mut cfg = Config::for_test(&uc, &up);
    cfg.local_mock = true;
    let app = router(cfg).expect("router");
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/auth/mock?user=chenmin")
                .body(Body::empty())
                .expect("req"),
        )
        .await
        .expect("resp");
    assert_eq!(resp.status(), StatusCode::TEMPORARY_REDIRECT);
    assert_eq!(
        resp.headers()
            .get("location")
            .and_then(|v| v.to_str().ok()),
        Some("/hbcdcagent/workbench")
    );
    let set_cookie = resp
        .headers()
        .get("set-cookie")
        .and_then(|v| v.to_str().ok())
        .expect("set-cookie");
    assert!(set_cookie.contains("zeroclaw_mock_user=chenmin"));
    assert!(!set_cookie.to_ascii_lowercase().contains("httponly"));

    let api = app
        .oneshot(
            Request::builder()
                .uri("/hbcdcagent/api/status")
                .header("cookie", "zeroclaw_mock_user=chenmin")
                .body(Body::empty())
                .expect("req"),
        )
        .await
        .expect("resp");
    assert_eq!(api.status(), StatusCode::OK);
    uc_h.abort();
    up_h.abort();
}

#[tokio::test]
async fn mock_login_hidden_when_sso_mode() {
    let (uc, uc_h) = start_user_center(MockUserCenter::ok()).await;
    let (up, up_h) = start_upstream().await;
    let app = router(Config::for_test(&uc, &up)).expect("router");
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/auth/mock?user=chenmin")
                .body(Body::empty())
                .expect("req"),
        )
        .await
        .expect("resp");
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    uc_h.abort();
    up_h.abort();
}

#[tokio::test]
async fn local_mock_login_rejects_unknown_user() {
    let (uc, uc_h) = start_user_center(MockUserCenter::ok()).await;
    let (up, up_h) = start_upstream().await;
    let mut cfg = Config::for_test(&uc, &up);
    cfg.local_mock = true;
    let app = router(cfg).expect("router");
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/auth/mock?user=evil")
                .body(Body::empty())
                .expect("req"),
        )
        .await
        .expect("resp");
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    uc_h.abort();
    up_h.abort();
}

async fn login(app: &axum::Router, code: &str) -> String {
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/auth/callback?verifyCode={code}"))
                .body(Body::empty())
                .expect("req"),
        )
        .await
        .expect("resp");
    assert_eq!(resp.status(), StatusCode::TEMPORARY_REDIRECT);
    let cookie = resp
        .headers()
        .get("set-cookie")
        .and_then(|v| v.to_str().ok())
        .expect("set-cookie");
    format!("{COOKIE_NAME}={}", cookie_sid(cookie))
}

#[tokio::test]
async fn proxy_keeps_prefix_and_drops_forged_identity() {
    let (uc, uc_h) = start_user_center(MockUserCenter::ok()).await;
    let (up, up_h) = start_upstream().await;
    let app = router(Config::for_test(&uc, &up)).expect("router");
    let cookie = login(&app, "good-code").await;
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/hbcdcagent/api/status?x=1")
                .header("cookie", cookie)
                .header(HEADER_USER_ID, "forged-ops")
                .header(HEADER_AUTH_SECRET, "forged-secret")
                .body(Body::empty())
                .expect("req"),
        )
        .await
        .expect("resp");
    assert_eq!(resp.status(), StatusCode::OK);
    let body = json_body(resp).await;
    assert_eq!(body["path"], "/hbcdcagent/api/status");
    assert_eq!(body["query"], "x=1");
    assert_eq!(body["user"], "alice");
    assert_eq!(body["role"], "普通用户");
    assert_eq!(body["org"], "武汉疾控");
    assert_eq!(body["secret"], "bff-secret");
    uc_h.abort();
    up_h.abort();
}

#[tokio::test]
async fn html_proxy_injects_platform_user() {
    let (uc, uc_h) = start_user_center(MockUserCenter::ok()).await;
    let (up, up_h) = start_html_upstream().await;
    let app = router(Config::for_test(&uc, &up)).expect("router");
    let cookie = login(&app, "good-code").await;
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/hbcdcagent/workbench")
                .header("cookie", cookie)
                .body(Body::empty())
                .expect("req"),
        )
        .await
        .expect("resp");
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = to_bytes(resp.into_body(), usize::MAX).await.expect("body");
    let html = String::from_utf8(bytes.to_vec()).expect("utf8");
    assert!(
        html.contains(
            r#"window.__ZEROCLAW_PLATFORM_USER__={"userId":"alice","displayName":"爱丽丝""#
        )
    );
    assert!(html.contains("<head><script>window.__ZEROCLAW_PLATFORM_USER__="));
    assert!(html.contains("workbench</body>"));
    uc_h.abort();
    up_h.abort();
}

#[tokio::test]
async fn ops_allowlist_sets_ops_role() {
    let (uc, uc_h) = start_user_center(MockUserCenter::ok()).await;
    let (up, up_h) = start_upstream().await;
    let app = router(Config::for_test(&uc, &up)).expect("router");
    let cookie = login(&app, "ops-code").await;
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/hbcdcagent/api/status")
                .header("cookie", cookie)
                .body(Body::empty())
                .expect("req"),
        )
        .await
        .expect("resp");
    let body = json_body(resp).await;
    assert_eq!(body["user"], "ops-user");
    assert_eq!(body["role"], "运维");
    uc_h.abort();
    up_h.abort();
}

#[tokio::test]
async fn logout_invalidates_session() {
    let (uc, uc_h) = start_user_center(MockUserCenter::ok()).await;
    let (up, up_h) = start_upstream().await;
    let app = router(Config::for_test(&uc, &up)).expect("router");
    let cookie = login(&app, "good-code").await;
    let logout = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/auth/logout")
                .header("cookie", &cookie)
                .body(Body::empty())
                .expect("req"),
        )
        .await
        .expect("resp");
    assert_eq!(logout.status(), StatusCode::TEMPORARY_REDIRECT);
    let api = app
        .oneshot(
            Request::builder()
                .uri("/hbcdcagent/api/status")
                .header("cookie", cookie)
                .body(Body::empty())
                .expect("req"),
        )
        .await
        .expect("resp");
    assert_eq!(api.status(), StatusCode::UNAUTHORIZED);
    uc_h.abort();
    up_h.abort();
}

#[tokio::test]
async fn gw0003_retries_after_new_ticket() {
    let (uc, uc_h) = start_user_center(MockUserCenter::expire_ticket_once()).await;
    let (up, up_h) = start_upstream().await;
    let app = router(Config::for_test(&uc, &up)).expect("router");
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/auth/callback?verifyCode=good-code")
                .body(Body::empty())
                .expect("req"),
        )
        .await
        .expect("resp");
    assert_eq!(resp.status(), StatusCode::TEMPORARY_REDIRECT);
    uc_h.abort();
    up_h.abort();
}

#[tokio::test]
async fn chinese_role_header_is_utf8_bytes() {
    let mut headers = HeaderMap::new();
    headers.insert(
        HEADER_USER_ROLE,
        HeaderValue::from_bytes("普通用户".as_bytes()).expect("utf8"),
    );
    assert_eq!(
        std::str::from_utf8(headers.get(HEADER_USER_ROLE).expect("h").as_bytes()).expect("s"),
        "普通用户"
    );
}

#[tokio::test]
async fn ws_proxy_splices_chinese_identity_and_frames() {
    use axum::extract::State;
    use axum::extract::ws::{Message, WebSocketUpgrade};
    use axum::routing::get;
    use futures_util::StreamExt;
    use std::sync::Mutex;
    use tokio_tungstenite::connect_async;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::http::header::SEC_WEBSOCKET_PROTOCOL;
    use tokio_tungstenite::tungstenite::Message as WsMessage;

    #[derive(Clone)]
    struct Cap(Arc<Mutex<Option<(String, String, String)>>>);

    async fn handler(
        State(cap): State<Cap>,
        headers: HeaderMap,
        ws: WebSocketUpgrade,
    ) -> impl IntoResponse {
        let role = header_text(&headers, HEADER_USER_ROLE);
        let region = header_text(&headers, HEADER_USER_REGION);
        let org = header_text(&headers, HEADER_USER_ORG);
        *cap.0.lock().expect("lock") = Some((role, region, org));
        ws.protocols(["zeroclaw.v1"]).on_upgrade(|mut socket| async move {
            let _ = socket.send(Message::Text("ok".into())).await;
        })
    }

    let cap = Cap(Arc::new(Mutex::new(None)));
    let upstream = Router::new()
        .route("/hbcdcagent/ws/chat", get(handler))
        .with_state(cap.clone());
    let (uc, uc_h) = start_user_center(MockUserCenter::ok()).await;
    let (up, up_h) = serve(upstream).await;
    let mut cfg = Config::for_test(&uc, &up);
    cfg.local_mock = true;
    let (bff, bff_h) = serve(router(cfg).expect("router")).await;
    let ws_url = format!(
        "{}/hbcdcagent/ws/chat?agent=default",
        bff.replacen("http://", "ws://", 1)
    );
    let mut req = ws_url.into_client_request().expect("req");
    req.headers_mut().insert(
        axum::http::header::COOKIE,
        "zeroclaw_mock_user=chenmin".parse().expect("cookie"),
    );
    req.headers_mut().insert(
        SEC_WEBSOCKET_PROTOCOL,
        "zeroclaw.v1".parse().expect("proto"),
    );
    let (mut ws, _) = connect_async(req).await.expect("connect");
    let msg = ws.next().await.expect("msg").expect("frame");
    assert_eq!(msg, WsMessage::Text("ok".into()));
    let got = cap.0.lock().expect("lock").clone().expect("headers");
    assert_eq!(got.0, "普通用户");
    assert_eq!(got.1, "武汉市");
    assert_eq!(got.2, "武汉市疾病预防控制中心");
    bff_h.abort();
    up_h.abort();
    uc_h.abort();
}
