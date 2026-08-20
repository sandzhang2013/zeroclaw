//! HTTP adapter over `zeroclaw_runtime::browse::list_directory`.

use axum::{
    Json,
    body::Bytes,
    extract::{Path as AxumPath, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use base64::Engine;
use serde::{Deserialize, Serialize};
use zeroclaw_runtime::browse::{
    AGENT_WORKSPACE_UPLOAD_CAP, BrowseEntry, BrowseError, delete_agent_workspace_path_for_user,
    list_agent_workspace_for_user, list_directory, make_agent_workspace_directory_for_user,
    make_directory, move_agent_workspace_path_for_user, read_agent_workspace_file_for_user,
    remove_directory, write_agent_workspace_file_for_user,
};

use super::AppState;
use super::api::require_auth;
use super::trusted_proxy::{HEADER_AUTH_SECRET, require_trusted_proxy, trusted_proxy_enabled};

#[derive(Debug, Deserialize, Default)]
pub struct BrowseQuery {
    /// Path relative to `<install>/shared/` or the agent workspace root.
    #[serde(default)]
    pub path: Option<String>,
    /// When set on the raw-file endpoint, force `Content-Disposition: attachment`.
    #[serde(default)]
    pub download: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct BrowseResponse {
    pub path: String,
    pub entries: Vec<BrowseEntry>,
}

/// `GET /api/browse?path=<relative-to-shared>`
pub async fn handle_browse(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<BrowseQuery>,
) -> Response {
    if let Err(e) = require_auth(&state, &headers) {
        return e.into_response();
    }
    let config = state.config.read().clone();
    let raw = q.path.unwrap_or_default();
    match list_directory(&config, &raw) {
        Ok(result) => Json(BrowseResponse {
            path: result.path,
            entries: result.entries,
        })
        .into_response(),
        Err(err) => browse_error_response(err),
    }
}

fn browse_error_response(err: BrowseError) -> Response {
    let status = match &err {
        BrowseError::Escape(_) => StatusCode::BAD_REQUEST,
        BrowseError::NotFound(_) => StatusCode::NOT_FOUND,
        BrowseError::NotADirectory(_) => StatusCode::BAD_REQUEST,
        BrowseError::Protected(_) => StatusCode::FORBIDDEN,
        BrowseError::ProtectedFile(_) => StatusCode::FORBIDDEN,
        BrowseError::TooLarge(_, _) => StatusCode::PAYLOAD_TOO_LARGE,
        BrowseError::Io(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    (
        status,
        Json(serde_json::json!({ "error": format!("{}", err) })),
    )
        .into_response()
}

#[derive(Debug, Deserialize)]
pub struct BrowsePathBody {
    pub path: String,
}

/// `POST /api/browse/mkdir` — create a directory under `<install>/shared/`.
pub async fn handle_browse_mkdir(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<BrowsePathBody>,
) -> Response {
    if let Err(e) = require_auth(&state, &headers) {
        return e.into_response();
    }
    let config = state.config.read().clone();
    match make_directory(&config, &body.path) {
        Ok(()) => Json(serde_json::json!({ "created": body.path })).into_response(),
        Err(err) => browse_error_response(err),
    }
}

/// `DELETE /api/browse/rmdir` — recursively remove a directory under
/// `<install>/shared/`. Refuses protected top-level entries.
pub async fn handle_browse_rmdir(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<BrowsePathBody>,
) -> Response {
    if let Err(e) = require_auth(&state, &headers) {
        return e.into_response();
    }
    let config = state.config.read().clone();
    match remove_directory(&config, &body.path) {
        Ok(()) => Json(serde_json::json!({ "removed": body.path })).into_response(),
        Err(err) => browse_error_response(err),
    }
}

// ── Agent workspace ──────────────────────────────────────────────────────

/// Pairing still opens the shared agent workspace (ops dashboard). When the
/// BFF asserts identity, list/read/mutate the frozen user's workspace instead.
fn workspace_scope(state: &AppState, headers: &HeaderMap) -> Result<Option<String>, Response> {
    if trusted_proxy_enabled(state) && headers.get(HEADER_AUTH_SECRET).is_some() {
        let (principal, _) =
            require_trusted_proxy(state, headers).map_err(IntoResponse::into_response)?;
        return Ok(Some(principal.user_id));
    }
    require_auth(state, headers).map_err(IntoResponse::into_response)?;
    Ok(None)
}

/// `GET /api/agents/{alias}/workspace/list?path=<rel>` — one level under
/// the caller's workspace (`users/<id>/...` when identity is frozen,
/// otherwise `<install>/agents/{alias}/workspace/<rel>`).
pub async fn handle_agent_workspace_list(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(alias): AxumPath<String>,
    Query(q): Query<BrowseQuery>,
) -> Response {
    let user_id = match workspace_scope(&state, &headers) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let config = state.config.read().clone();
    let raw = q.path.unwrap_or_default();
    match list_agent_workspace_for_user(&config, &alias, &raw, user_id.as_deref()) {
        Ok(result) => Json(BrowseResponse {
            path: result.path,
            entries: result.entries,
        })
        .into_response(),
        Err(err) => browse_error_response(err),
    }
}

#[derive(Debug, Serialize)]
pub struct FileReadResponse {
    pub path: String,
    pub size: u64,
    pub is_text: bool,
    /// UTF-8 text when `is_text` is true, base64 when false. Lets the
    /// dashboard render inline without a second round-trip for binary
    /// previews.
    pub content: String,
    pub encoding: &'static str,
    pub mime: String,
}

/// `GET /api/agents/{alias}/workspace/read?path=<rel>` — read a single
/// file. Bounded by `AGENT_WORKSPACE_READ_CAP`.
pub async fn handle_agent_workspace_read(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(alias): AxumPath<String>,
    Query(q): Query<BrowseQuery>,
) -> Response {
    let user_id = match workspace_scope(&state, &headers) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let config = state.config.read().clone();
    let raw = q.path.unwrap_or_default();
    match read_agent_workspace_file_for_user(&config, &alias, &raw, user_id.as_deref()) {
        Ok(result) => {
            let (content, encoding) = if result.is_text {
                (String::from_utf8(result.bytes).unwrap_or_default(), "utf8")
            } else {
                (
                    base64::engine::general_purpose::STANDARD.encode(&result.bytes),
                    "base64",
                )
            };
            Json(FileReadResponse {
                path: result.path,
                size: result.size,
                is_text: result.is_text,
                content,
                encoding,
                mime: result.mime,
            })
            .into_response()
        }
        Err(err) => browse_error_response(err),
    }
}

fn safe_download_name(filename: &str) -> String {
    let cleaned: String = filename
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        .collect();
    if cleaned.is_empty() {
        "file".into()
    } else {
        cleaned
    }
}

/// Untrusted workspace HTML: unique origin (no `allow-same-origin`), scripts
/// for Chart.js, no popups/forms so preview cannot open an unsandboxed window.
const WORKSPACE_HTML_CSP: &str = concat!(
    "sandbox allow-scripts; ",
    "default-src 'none'; ",
    "script-src 'unsafe-inline' https:; ",
    "style-src 'unsafe-inline' https:; ",
    "img-src data: blob: https:; ",
    "font-src data: https:; ",
    "connect-src https:; ",
    "object-src 'none'; ",
    "base-uri 'none'; ",
    "form-action 'none'; ",
    "frame-src 'none'; ",
    "frame-ancestors 'self'",
);

fn is_untrusted_svg(mime: &str, filename: &str) -> bool {
    let mime = mime.to_ascii_lowercase();
    let name = filename.to_ascii_lowercase();
    mime.starts_with("image/svg") || mime.contains("svg+xml") || name.ends_with(".svg")
}

fn raw_file_response(result: zeroclaw_runtime::browse::FileReadResult, download: bool) -> Response {
    let mime = if result.mime.is_empty() {
        "application/octet-stream".to_string()
    } else {
        result.mime.clone()
    };
    let filename = std::path::Path::new(&result.path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".into());
    let svg = is_untrusted_svg(&mime, &filename);
    let mime = if svg {
        "application/octet-stream".to_string()
    } else {
        mime
    };
    let kind = if download || svg {
        "attachment"
    } else {
        "inline"
    };
    let disposition = format!("{kind}; filename=\"{}\"", safe_download_name(&filename));
    let content_type = HeaderValue::from_str(&mime)
        .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream"));
    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_DISPOSITION, disposition)
        .header(header::CACHE_CONTROL, "private, no-store")
        .header("x-content-type-options", "nosniff")
        .header(header::X_FRAME_OPTIONS, "SAMEORIGIN");
    if mime.starts_with("text/html") {
        // Opaque origin (no allow-same-origin). Scripts stay for Chart.js;
        // popups/forms are off so preview HTML cannot open an unsandboxed window.
        builder = builder.header(header::CONTENT_SECURITY_POLICY, WORKSPACE_HTML_CSP);
    }
    builder
        .body(axum::body::Body::from(result.bytes))
        .unwrap_or_else(|_| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "failed to build file response",
            )
                .into_response()
        })
}

/// `GET /api/agents/{alias}/workspace/raw?path=<rel>` — bytes with MIME.
/// Same frozen-user root as list/read. For `<iframe>` / `<img>` / `<embed>`.
pub async fn handle_agent_workspace_raw(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(alias): AxumPath<String>,
    Query(q): Query<BrowseQuery>,
) -> Response {
    let user_id = match workspace_scope(&state, &headers) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let config = state.config.read().clone();
    let raw = q.path.unwrap_or_default();
    match read_agent_workspace_file_for_user(&config, &alias, &raw, user_id.as_deref()) {
        Ok(result) => raw_file_response(result, q.download.unwrap_or(false)),
        Err(err) => browse_error_response(err),
    }
}

/// `DELETE /api/agents/{alias}/workspace/path` body `{ path: "<rel>" }`.
pub async fn handle_agent_workspace_delete(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(alias): AxumPath<String>,
    Json(body): Json<BrowsePathBody>,
) -> Response {
    let user_id = match workspace_scope(&state, &headers) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let config = state.config.read().clone();
    match delete_agent_workspace_path_for_user(&config, &alias, &body.path, user_id.as_deref()) {
        Ok(()) => Json(serde_json::json!({ "removed": body.path })).into_response(),
        Err(err) => browse_error_response(err),
    }
}

#[derive(Debug, Deserialize)]
pub struct MoveBody {
    pub from: String,
    pub to: String,
}

/// `POST /api/agents/{alias}/workspace/move` body `{ from, to }`.
pub async fn handle_agent_workspace_move(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(alias): AxumPath<String>,
    Json(body): Json<MoveBody>,
) -> Response {
    let user_id = match workspace_scope(&state, &headers) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let config = state.config.read().clone();
    match move_agent_workspace_path_for_user(
        &config,
        &alias,
        &body.from,
        &body.to,
        user_id.as_deref(),
    ) {
        Ok(()) => Json(serde_json::json!({ "from": body.from, "to": body.to })).into_response(),
        Err(err) => browse_error_response(err),
    }
}

/// `POST /api/agents/{alias}/workspace/mkdir` body `{ path: "<rel>" }`.
pub async fn handle_agent_workspace_mkdir(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(alias): AxumPath<String>,
    Json(body): Json<BrowsePathBody>,
) -> Response {
    let user_id = match workspace_scope(&state, &headers) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let config = state.config.read().clone();
    match make_agent_workspace_directory_for_user(&config, &alias, &body.path, user_id.as_deref()) {
        Ok(()) => Json(serde_json::json!({ "created": body.path })).into_response(),
        Err(err) => browse_error_response(err),
    }
}

/// `POST /api/agents/{alias}/workspace/upload?path=<rel>` — raw body bytes.
/// Lives on a sibling router with a larger body limit than the gateway-wide
/// 64 KiB cap. Path is relative to the frozen-user workspace when BFF identity
/// is present.
pub async fn handle_agent_workspace_upload(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(alias): AxumPath<String>,
    Query(q): Query<BrowseQuery>,
    body: Bytes,
) -> Response {
    let user_id = match workspace_scope(&state, &headers) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let path = q.path.unwrap_or_default();
    if path.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "path is required" })),
        )
            .into_response();
    }
    if body.len() as u64 > AGENT_WORKSPACE_UPLOAD_CAP {
        return browse_error_response(BrowseError::TooLarge(path, AGENT_WORKSPACE_UPLOAD_CAP));
    }
    let config = state.config.read().clone();
    match write_agent_workspace_file_for_user(&config, &alias, &path, &body, user_id.as_deref()) {
        Ok(wrote) => Json(serde_json::json!({
            "path": wrote.path,
            "size": wrote.size,
            "mime": wrote.mime,
        }))
        .into_response(),
        Err(err) => browse_error_response(err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::test_state;
    use axum::http::HeaderValue;
    use http_body_util::BodyExt;

    fn bff_headers(user: &str, role: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert("x-auth-secret", HeaderValue::from_static("s3cret"));
        h.insert("x-user-id", HeaderValue::from_str(user).unwrap());
        h.insert(
            "x-user-role",
            HeaderValue::from_bytes(role.as_bytes()).unwrap(),
        );
        h
    }

    fn trusted_proxy_config(tmp: &tempfile::TempDir) -> zeroclaw_config::schema::Config {
        let mut config = zeroclaw_config::schema::Config {
            data_dir: tmp.path().join("data"),
            config_path: tmp.path().join("config.toml"),
            ..zeroclaw_config::schema::Config::default()
        };
        config.gateway.trusted_proxy = true;
        config.gateway.trusted_proxy_secret = Some("s3cret".into());
        config
    }

    async fn response_json(response: Response) -> serde_json::Value {
        let body = response
            .into_body()
            .collect()
            .await
            .expect("response body")
            .to_bytes();
        serde_json::from_slice(&body).expect("valid json response")
    }

    #[tokio::test]
    async fn workspace_list_with_bff_identity_reads_user_session_dir() {
        let tmp = tempfile::TempDir::new().unwrap();
        let config = trusted_proxy_config(&tmp);
        let session = "51956add-a083-4beb-a3ad-a88347f077de";
        let user_dir = config.user_session_workspace_dir("ops", "deepseek", session);
        std::fs::create_dir_all(&user_dir).unwrap();
        std::fs::write(user_dir.join("login.html"), b"<html>ok</html>").unwrap();
        let shared = config.agent_session_workspace_dir("deepseek", session);
        std::fs::create_dir_all(&shared).unwrap();
        std::fs::write(shared.join("other.html"), b"nope").unwrap();

        let state = test_state(config);
        let response = handle_agent_workspace_list(
            State(state),
            bff_headers("ops", "运维"),
            AxumPath("deepseek".into()),
            Query(BrowseQuery {
                path: Some(format!("sessions/{session}")),
                download: None,
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let json = response_json(response).await;
        let names: Vec<&str> = json["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, vec!["login.html"]);
    }

    #[tokio::test]
    async fn workspace_list_does_not_leak_another_users_files() {
        let tmp = tempfile::TempDir::new().unwrap();
        let config = trusted_proxy_config(&tmp);
        let session = "51956add-a083-4beb-a3ad-a88347f077de";
        let ops_dir = config.user_session_workspace_dir("ops", "deepseek", session);
        std::fs::create_dir_all(&ops_dir).unwrap();
        std::fs::write(ops_dir.join("login.html"), b"<html>ok</html>").unwrap();

        let state = test_state(config);
        let response = handle_agent_workspace_list(
            State(state),
            bff_headers("liuyang", "高级用户"),
            AxumPath("deepseek".into()),
            Query(BrowseQuery {
                path: Some(format!("sessions/{session}")),
                download: None,
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn workspace_raw_serves_mime_for_frozen_user_only() {
        let tmp = tempfile::TempDir::new().unwrap();
        let config = trusted_proxy_config(&tmp);
        let session = "51956add-a083-4beb-a3ad-a88347f077de";
        let user_dir = config.user_session_workspace_dir("ops", "deepseek", session);
        std::fs::create_dir_all(&user_dir).unwrap();
        std::fs::write(user_dir.join("login.html"), b"<html>ok</html>").unwrap();
        let rel = format!("sessions/{session}/login.html");

        let ops_state = test_state(config.clone());
        let response = handle_agent_workspace_raw(
            State(ops_state),
            bff_headers("ops", "运维"),
            AxumPath("deepseek".into()),
            Query(BrowseQuery {
                path: Some(rel.clone()),
                download: None,
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get(header::CONTENT_TYPE)
                .unwrap()
                .to_str()
                .unwrap(),
            "text/html"
        );
        assert_eq!(
            response.headers().get(header::X_FRAME_OPTIONS).unwrap(),
            "SAMEORIGIN"
        );
        let csp = response
            .headers()
            .get(header::CONTENT_SECURITY_POLICY)
            .expect("html preview must set CSP")
            .to_str()
            .unwrap();
        assert!(csp.contains("sandbox allow-scripts"), "{csp}");
        assert!(
            !csp.contains("allow-popups"),
            "preview HTML must not open unsandboxed windows: {csp}"
        );
        assert!(
            !csp.contains("allow-same-origin"),
            "preview HTML must stay opaque-origin: {csp}"
        );
        assert!(csp.contains("form-action 'none'"), "{csp}");
        let body = response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes();
        assert_eq!(&body[..], b"<html>ok</html>");

        let other = test_state(config);
        let leaked = handle_agent_workspace_raw(
            State(other),
            bff_headers("liuyang", "高级用户"),
            AxumPath("deepseek".into()),
            Query(BrowseQuery {
                path: Some(rel),
                download: None,
            }),
        )
        .await;
        assert_eq!(leaked.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn workspace_raw_svg_is_attachment_octet_stream() {
        let tmp = tempfile::TempDir::new().unwrap();
        let config = trusted_proxy_config(&tmp);
        let session = "51956add-a083-4beb-a3ad-a88347f077de";
        let user_dir = config.user_session_workspace_dir("ops", "deepseek", session);
        std::fs::create_dir_all(&user_dir).unwrap();
        std::fs::write(
            user_dir.join("chart.svg"),
            b"<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>",
        )
        .unwrap();
        let rel = format!("sessions/{session}/chart.svg");

        let response = handle_agent_workspace_raw(
            State(test_state(config)),
            bff_headers("ops", "运维"),
            AxumPath("deepseek".into()),
            Query(BrowseQuery {
                path: Some(rel),
                download: None,
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get(header::CONTENT_TYPE)
                .unwrap()
                .to_str()
                .unwrap(),
            "application/octet-stream"
        );
        let disposition = response
            .headers()
            .get(header::CONTENT_DISPOSITION)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(
            disposition.starts_with("attachment;"),
            "svg must not render inline: {disposition}"
        );
    }

    #[tokio::test]
    async fn workspace_upload_writes_into_frozen_user_session() {
        let tmp = tempfile::TempDir::new().unwrap();
        let config = trusted_proxy_config(&tmp);
        let session = "51956add-a083-4beb-a3ad-a88347f077de";
        let rel = format!("sessions/{session}/uploads/notes.csv");

        let state = test_state(config.clone());
        let response = handle_agent_workspace_upload(
            State(state),
            bff_headers("ops", "运维"),
            AxumPath("deepseek".into()),
            Query(BrowseQuery {
                path: Some(rel.clone()),
                download: None,
            }),
            Bytes::from_static(b"a,b\n1,2\n"),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let json = response_json(response).await;
        assert_eq!(json["path"], rel);
        assert_eq!(json["size"], 8);

        let on_disk = config
            .user_session_workspace_dir("ops", "deepseek", session)
            .join("uploads/notes.csv");
        assert_eq!(std::fs::read(on_disk).unwrap(), b"a,b\n1,2\n");
        assert!(
            !config
                .agent_session_workspace_dir("deepseek", session)
                .join("uploads/notes.csv")
                .exists()
        );
    }

    #[tokio::test]
    async fn workspace_raw_png_is_inline_image() {
        let tmp = tempfile::TempDir::new().unwrap();
        let config = trusted_proxy_config(&tmp);
        let session = "51956add-a083-4beb-a3ad-a88347f077de";
        let user_dir = config.user_session_workspace_dir("ops", "deepseek", session);
        std::fs::create_dir_all(&user_dir).unwrap();
        std::fs::write(user_dir.join("chart.png"), b"\x89PNG").unwrap();
        let response = handle_agent_workspace_raw(
            State(test_state(config)),
            bff_headers("ops", "运维"),
            AxumPath("deepseek".into()),
            Query(BrowseQuery {
                path: Some(format!("sessions/{session}/chart.png")),
                download: None,
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get(header::CONTENT_TYPE)
                .unwrap()
                .to_str()
                .unwrap(),
            "image/png"
        );
        let disposition = response
            .headers()
            .get(header::CONTENT_DISPOSITION)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(
            disposition.starts_with("inline;"),
            "raster charts must preview inline: {disposition}"
        );
        assert!(
            response
                .headers()
                .get(header::CONTENT_SECURITY_POLICY)
                .is_none()
        );
    }

    #[tokio::test]
    async fn workspace_raw_html_download_is_attachment_and_keeps_csp() {
        let tmp = tempfile::TempDir::new().unwrap();
        let config = trusted_proxy_config(&tmp);
        let session = "51956add-a083-4beb-a3ad-a88347f077de";
        let user_dir = config.user_session_workspace_dir("ops", "deepseek", session);
        std::fs::create_dir_all(&user_dir).unwrap();
        std::fs::write(user_dir.join("login.html"), b"<html>ok</html>").unwrap();
        let response = handle_agent_workspace_raw(
            State(test_state(config)),
            bff_headers("ops", "运维"),
            AxumPath("deepseek".into()),
            Query(BrowseQuery {
                path: Some(format!("sessions/{session}/login.html")),
                download: Some(true),
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let disposition = response
            .headers()
            .get(header::CONTENT_DISPOSITION)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(disposition.starts_with("attachment;"), "{disposition}");
        let csp = response
            .headers()
            .get(header::CONTENT_SECURITY_POLICY)
            .expect("html still gets CSP")
            .to_str()
            .unwrap();
        assert!(csp.contains("form-action 'none'"), "{csp}");
    }

    #[tokio::test]
    async fn workspace_list_and_upload_reject_path_escape() {
        let tmp = tempfile::TempDir::new().unwrap();
        let config = trusted_proxy_config(&tmp);
        let state = test_state(config);
        let list = handle_agent_workspace_list(
            State(state.clone()),
            bff_headers("ops", "运维"),
            AxumPath("deepseek".into()),
            Query(BrowseQuery {
                path: Some("../etc".into()),
                download: None,
            }),
        )
        .await;
        assert_eq!(list.status(), StatusCode::BAD_REQUEST);

        let upload = handle_agent_workspace_upload(
            State(state.clone()),
            bff_headers("ops", "运维"),
            AxumPath("deepseek".into()),
            Query(BrowseQuery {
                path: Some("../escape.txt".into()),
                download: None,
            }),
            Bytes::from_static(b"nope"),
        )
        .await;
        assert_eq!(upload.status(), StatusCode::BAD_REQUEST);

        let missing = handle_agent_workspace_upload(
            State(state),
            bff_headers("ops", "运维"),
            AxumPath("deepseek".into()),
            Query(BrowseQuery {
                path: None,
                download: None,
            }),
            Bytes::from_static(b"nope"),
        )
        .await;
        assert_eq!(missing.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn workspace_raw_uppercase_svg_is_still_attachment() {
        let tmp = tempfile::TempDir::new().unwrap();
        let config = trusted_proxy_config(&tmp);
        let session = "51956add-a083-4beb-a3ad-a88347f077de";
        let user_dir = config.user_session_workspace_dir("ops", "deepseek", session);
        std::fs::create_dir_all(&user_dir).unwrap();
        std::fs::write(user_dir.join("Chart.SVG"), b"<svg></svg>").unwrap();
        let response = handle_agent_workspace_raw(
            State(test_state(config)),
            bff_headers("ops", "运维"),
            AxumPath("deepseek".into()),
            Query(BrowseQuery {
                path: Some(format!("sessions/{session}/Chart.SVG")),
                download: None,
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get(header::CONTENT_TYPE)
                .unwrap()
                .to_str()
                .unwrap(),
            "application/octet-stream"
        );
        assert!(
            response
                .headers()
                .get(header::CONTENT_DISPOSITION)
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("attachment;")
        );
    }

    #[test]
    fn is_untrusted_svg_matches_mime_and_extension() {
        assert!(is_untrusted_svg("image/svg+xml", "a.png"));
        assert!(is_untrusted_svg("IMAGE/SVG", "a.png"));
        assert!(is_untrusted_svg("application/octet-stream", "chart.SVG"));
        assert!(!is_untrusted_svg("image/png", "chart.png"));
    }

    #[test]
    fn safe_download_name_strips_path_and_cjk() {
        assert!(!safe_download_name("../../a.png").contains('/'));
        assert!(safe_download_name("../../a.png").ends_with("a.png"));
        assert_eq!(
            safe_download_name("报告.html"),
            ".html",
            "non-ascii names drop to the leftover extension"
        );
        assert_eq!(safe_download_name("报告"), "file");
        assert_eq!(safe_download_name(""), "file");
    }
}
