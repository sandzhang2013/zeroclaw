//! Composer prompt snippets for the workbench.
//!
//! `GET`/`PUT /api/quick-prompts`. Personal rows live under the frozen
//! user id. Shared rows are one list for every login on this install.
//! A missing file means "never saved" so a browser can upload its local
//! copy once. An empty file means the user cleared that list.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use serde::{Deserialize, Serialize};

use super::AppState;

const TITLE_MAX: usize = 40;
const BODY_MAX: usize = 4000;
const ID_MAX: usize = 80;
const LIST_MAX: usize = 100;
const PAIRING_USER: &str = "_pairing";
static WRITE_SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct QuickPromptRow {
    pub id: String,
    pub title: String,
    pub body: String,
}

#[derive(Debug, Deserialize)]
pub struct QuickPromptPut {
    #[serde(default)]
    pub personal: Vec<QuickPromptRow>,
    #[serde(default)]
    pub shared: Vec<QuickPromptRow>,
}

#[derive(Debug, Serialize)]
struct QuickPromptList {
    personal: Vec<QuickPromptRow>,
    shared: Vec<QuickPromptRow>,
    personal_stored: bool,
    shared_stored: bool,
}

/// `GET /api/quick-prompts`
pub async fn handle_list_quick_prompts(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let user_id = match prompt_user_id(&state, &headers) {
        Ok(id) => id,
        Err(response) => return response,
    };
    let config = state.config.read();
    match load_lists(&config, &user_id) {
        Ok(list) => (StatusCode::OK, Json(list)).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &error),
    }
}

/// `PUT /api/quick-prompts`
pub async fn handle_save_quick_prompts(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<QuickPromptPut>,
) -> impl IntoResponse {
    let user_id = match prompt_user_id(&state, &headers) {
        Ok(id) => id,
        Err(response) => return response,
    };
    let personal = match sanitize_rows(body.personal) {
        Ok(rows) => rows,
        Err(error) => return json_error(StatusCode::BAD_REQUEST, &error),
    };
    let shared = match sanitize_rows(body.shared) {
        Ok(rows) => rows,
        Err(error) => return json_error(StatusCode::BAD_REQUEST, &error),
    };
    let config = state.config.read();
    if let Err(error) = write_rows(&personal_path(&config, &user_id), &personal) {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, &error);
    }
    if let Err(error) = write_rows(&shared_path(&config), &shared) {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, &error);
    }
    (
        StatusCode::OK,
        Json(QuickPromptList {
            personal,
            shared,
            personal_stored: true,
            shared_stored: true,
        }),
    )
        .into_response()
}

fn prompt_user_id(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<String, axum::response::Response> {
    let (_principal, attrs) = match crate::trusted_proxy::require_user_principal(state, headers) {
        Ok(value) => value,
        Err(error) => return Err(error.into_response()),
    };
    match attrs {
        Some(attrs) => match zeroclaw_api::normalize_user_id(&attrs.user_id) {
            Ok(id) => Ok(id),
            Err(_) => Err(json_error(
                StatusCode::BAD_REQUEST,
                "invalid frozen user id",
            )),
        },
        None => Ok(PAIRING_USER.to_string()),
    }
}

fn personal_path(config: &zeroclaw_config::schema::Config, user_id: &str) -> PathBuf {
    config
        .install_root_dir()
        .join("users")
        .join(user_id)
        .join("quick-prompts.json")
}

fn shared_path(config: &zeroclaw_config::schema::Config) -> PathBuf {
    config.shared_workspace_dir().join("quick-prompts.json")
}

fn load_lists(
    config: &zeroclaw_config::schema::Config,
    user_id: &str,
) -> Result<QuickPromptList, String> {
    let personal = read_rows(&personal_path(config, user_id))?;
    let shared = read_rows(&shared_path(config))?;
    Ok(QuickPromptList {
        personal_stored: personal.is_some(),
        shared_stored: shared.is_some(),
        personal: personal.unwrap_or_default(),
        shared: shared.unwrap_or_default(),
    })
}

fn read_rows(path: &Path) -> Result<Option<Vec<QuickPromptRow>>, String> {
    match std::fs::read(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|error| error.to_string()),
    }
}

fn write_rows(path: &Path, rows: &[QuickPromptRow]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let payload = serde_json::to_vec_pretty(rows).map_err(|error| error.to_string())?;
    let seq = WRITE_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = path.with_extension(format!("json.{seq}.tmp"));
    std::fs::write(&tmp, payload).map_err(|error| error.to_string())?;
    std::fs::rename(&tmp, path).map_err(|error| {
        let _ = std::fs::remove_file(&tmp);
        error.to_string()
    })?;
    Ok(())
}

fn sanitize_rows(rows: Vec<QuickPromptRow>) -> Result<Vec<QuickPromptRow>, String> {
    if rows.len() > LIST_MAX {
        return Err(format!("at most {LIST_MAX} prompts"));
    }
    let mut clean = Vec::with_capacity(rows.len());
    for row in rows {
        let id = row.id.trim();
        let title = row.title.trim();
        let body = row.body.trim();
        if id.is_empty() || title.is_empty() || body.is_empty() {
            return Err("prompt id, title, and body are required".to_string());
        }
        if id.chars().count() > ID_MAX
            || title.chars().count() > TITLE_MAX
            || body.chars().count() > BODY_MAX
        {
            return Err("prompt field is too long".to_string());
        }
        if id.contains(['/', '\\', '\0']) || id.contains("..") || id.chars().any(|c| c.is_control())
        {
            return Err("invalid prompt id".to_string());
        }
        clean.push(QuickPromptRow {
            id: id.to_string(),
            title: title.to_string(),
            body: body.to_string(),
        });
    }
    Ok(clean)
}

fn json_error(status: StatusCode, message: &str) -> axum::response::Response {
    (status, Json(serde_json::json!({ "error": message }))).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::test_state;
    use axum::http::HeaderValue;
    use http_body_util::BodyExt;

    fn state_in(tmp: &tempfile::TempDir) -> AppState {
        let mut config = zeroclaw_config::schema::Config {
            data_dir: tmp.path().join("data"),
            config_path: tmp.path().join("config.toml"),
            ..zeroclaw_config::schema::Config::default()
        };
        config.gateway.trusted_proxy = true;
        config.gateway.trusted_proxy_secret = Some("s3cret".into());
        test_state(config)
    }

    fn headers(user: &str) -> HeaderMap {
        let mut map = HeaderMap::new();
        map.insert("x-auth-secret", HeaderValue::from_static("s3cret"));
        map.insert("x-user-id", HeaderValue::from_str(user).unwrap());
        map
    }

    fn row(id: &str, title: &str, body: &str) -> QuickPromptRow {
        QuickPromptRow {
            id: id.into(),
            title: title.into(),
            body: body.into(),
        }
    }

    async fn body_json(response: axum::response::Response) -> serde_json::Value {
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn personal_rows_stay_with_the_frozen_user_and_shared_rows_are_visible() {
        let tmp = tempfile::tempdir().unwrap();
        let state = state_in(&tmp);
        let saved = handle_save_quick_prompts(
            State(state.clone()),
            headers("alice"),
            Json(QuickPromptPut {
                personal: vec![row("a", "疫情概况", "概述近期疫情。")],
                shared: vec![row("s", "周报", "起草周报。")],
            }),
        )
        .await
        .into_response();
        assert_eq!(saved.status(), StatusCode::OK);

        let alice = body_json(
            handle_list_quick_prompts(State(state.clone()), headers("alice"))
                .await
                .into_response(),
        )
        .await;
        assert_eq!(alice["personal"][0]["id"], "a");
        assert_eq!(alice["shared"][0]["id"], "s");
        assert_eq!(alice["personal_stored"], true);

        let bob = body_json(
            handle_list_quick_prompts(State(state), headers("bob"))
                .await
                .into_response(),
        )
        .await;
        assert!(bob["personal"].as_array().unwrap().is_empty());
        assert_eq!(bob["personal_stored"], false);
        assert_eq!(bob["shared"][0]["title"], "周报");
        assert_eq!(bob["shared_stored"], true);
    }

    #[tokio::test]
    async fn missing_secret_does_not_write_a_file() {
        let tmp = tempfile::tempdir().unwrap();
        let state = state_in(&tmp);
        let response = handle_save_quick_prompts(
            State(state),
            HeaderMap::new(),
            Json(QuickPromptPut {
                personal: vec![row("a", "标题", "正文")],
                shared: Vec::new(),
            }),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert!(!tmp.path().join("users").exists());
    }

    #[test]
    fn sanitize_rows_rejects_a_path_id_and_a_blank_title() {
        assert!(sanitize_rows(vec![row("../a", "标题", "正文")]).is_err());
        assert!(sanitize_rows(vec![row("a", "  ", "正文")]).is_err());
        assert_eq!(
            sanitize_rows(vec![row(" a ", " 标题 ", " 正文 ")]).unwrap(),
            vec![row("a", "标题", "正文")]
        );
    }
}
