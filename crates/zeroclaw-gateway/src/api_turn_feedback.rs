//! Like / dislike on one finished assistant turn.
//!
//! `GET`/`PUT /api/turn-feedback`. Rows belong to the frozen user.
//! A missing verdict removes that turn's row.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use chrono::Utc;
use serde::{Deserialize, Serialize};

use super::AppState;

const SESSION_MAX: usize = 128;
const KEY_MAX: usize = 700;
const COMMENT_MAX: usize = 1000;
const LIST_MAX: usize = 400;
const PAIRING_USER: &str = "_pairing";
static WRITE_SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TurnVerdict {
    Like,
    Dislike,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DislikeReason {
    WrongData,
    Unhelpful,
    Unsafe,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TurnFeedbackEntry {
    pub session_id: String,
    pub message_key: String,
    pub verdict: TurnVerdict,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<DislikeReason>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub comment: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct TurnFeedbackPut {
    pub session_id: String,
    pub message_key: String,
    #[serde(default)]
    pub verdict: Option<TurnVerdict>,
    #[serde(default)]
    pub reason: Option<DislikeReason>,
    #[serde(default)]
    pub comment: String,
}

#[derive(Debug, Serialize)]
struct TurnFeedbackList {
    entries: Vec<TurnFeedbackEntry>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct TurnFeedbackFile {
    #[serde(default)]
    entries: Vec<TurnFeedbackEntry>,
}

/// `GET /api/turn-feedback`
pub async fn handle_list_turn_feedback(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let user_id = match feedback_user_id(&state, &headers) {
        Ok(id) => id,
        Err(response) => return response,
    };
    let config = state.config.read();
    match read_file(&feedback_path(&config, &user_id)) {
        Ok(file) => (
            StatusCode::OK,
            Json(TurnFeedbackList {
                entries: file.entries,
            }),
        )
            .into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &error),
    }
}

/// `GET /api/turn-feedback/review` — every user's rows, for an operator.
pub async fn handle_review_turn_feedback(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err(error) = crate::trusted_proxy::require_ops_auth(&state, &headers) {
        return error.into_response();
    }
    let backend = state.session_backend.clone();
    let config = state.config.read();
    match load_review(&config, backend.as_deref()) {
        Ok(body) => (StatusCode::OK, Json(body)).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &error),
    }
}

/// `PUT /api/turn-feedback`
pub async fn handle_save_turn_feedback(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<TurnFeedbackPut>,
) -> impl IntoResponse {
    let user_id = match feedback_user_id(&state, &headers) {
        Ok(id) => id,
        Err(response) => return response,
    };
    let session_id = body.session_id.trim();
    let message_key = body.message_key.trim();
    if let Err(error) = check_identity(session_id, message_key) {
        return json_error(StatusCode::BAD_REQUEST, &error);
    }
    let config = state.config.read();
    let path = feedback_path(&config, &user_id);
    let mut file = match read_file(&path) {
        Ok(file) => file,
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, &error),
    };
    file.entries
        .retain(|entry| entry.session_id != session_id || entry.message_key != message_key);
    if let Some(verdict) = body.verdict {
        let comment = body.comment.trim();
        if comment.chars().count() > COMMENT_MAX {
            return json_error(StatusCode::BAD_REQUEST, "comment is too long");
        }
        let reason = match verdict {
            TurnVerdict::Like => None,
            TurnVerdict::Dislike => body.reason,
        };
        file.entries.push(TurnFeedbackEntry {
            session_id: session_id.to_string(),
            message_key: message_key.to_string(),
            verdict,
            reason,
            comment: if verdict == TurnVerdict::Like {
                String::new()
            } else {
                comment.to_string()
            },
            updated_at: Utc::now().to_rfc3339(),
        });
    }
    if file.entries.len() > LIST_MAX {
        file.entries.sort_by(|a, b| a.updated_at.cmp(&b.updated_at));
        let drop_count = file.entries.len() - LIST_MAX;
        file.entries.drain(0..drop_count);
    }
    if let Err(error) = write_file(&path, &file) {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, &error);
    }
    (
        StatusCode::OK,
        Json(TurnFeedbackList {
            entries: file.entries,
        }),
    )
        .into_response()
}

fn feedback_user_id(
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

fn feedback_path(config: &zeroclaw_config::schema::Config, user_id: &str) -> PathBuf {
    config
        .install_root_dir()
        .join("users")
        .join(user_id)
        .join("turn-feedback.json")
}

fn check_identity(session_id: &str, message_key: &str) -> Result<(), String> {
    if session_id.is_empty() || message_key.is_empty() {
        return Err("session_id and message_key are required".to_string());
    }
    if session_id.chars().count() > SESSION_MAX || message_key.chars().count() > KEY_MAX {
        return Err("feedback field is too long".to_string());
    }
    if !session_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("invalid session_id".to_string());
    }
    if message_key.chars().any(|c| c.is_control()) {
        return Err("invalid message_key".to_string());
    }
    Ok(())
}

fn read_file(path: &Path) -> Result<TurnFeedbackFile, String> {
    match std::fs::read(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(TurnFeedbackFile::default())
        }
        Err(error) => Err(error.to_string()),
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| error.to_string()),
    }
}

fn write_file(path: &Path, file: &TurnFeedbackFile) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let payload = serde_json::to_vec_pretty(file).map_err(|error| error.to_string())?;
    let seq = WRITE_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = path.with_extension(format!("json.{seq}.tmp"));
    std::fs::write(&tmp, payload).map_err(|error| error.to_string())?;
    std::fs::rename(&tmp, path).map_err(|error| {
        let _ = std::fs::remove_file(&tmp);
        error.to_string()
    })?;
    Ok(())
}

#[derive(Debug, Serialize)]
struct ReviewSummary {
    like: u32,
    dislike: u32,
    wrong_data: u32,
    unhelpful: u32,
    #[serde(rename = "unsafe")]
    harmful: u32,
    other: u32,
}

#[derive(Debug, Serialize)]
struct ReviewEntry {
    user_id: String,
    session_id: String,
    verdict: TurnVerdict,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<DislikeReason>,
    #[serde(skip_serializing_if = "String::is_empty")]
    comment: String,
    updated_at: String,
    excerpt: String,
}

/// Likes, dislikes, and unrated replies among assistant turns still stored
/// in sessions. The three verdict counts add up to `turns`.
#[derive(Debug, Serialize)]
struct TurnCoverage {
    turns: u32,
    like: u32,
    dislike: u32,
    unrated: u32,
}

#[derive(Debug, Serialize)]
struct ReviewBody {
    summary: ReviewSummary,
    coverage: TurnCoverage,
    entries: Vec<ReviewEntry>,
}

const REVIEW_MAX: usize = 500;

fn load_review(
    config: &zeroclaw_config::schema::Config,
    backend: Option<&dyn zeroclaw_infra::session_backend::SessionBackend>,
) -> Result<ReviewBody, String> {
    let mut entries = Vec::new();
    let mut verdicts = HashMap::new();
    let users = config.install_root_dir().join("users");
    let dir = match std::fs::read_dir(&users) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ReviewBody {
                summary: ReviewSummary {
                    like: 0,
                    dislike: 0,
                    wrong_data: 0,
                    unhelpful: 0,
                    harmful: 0,
                    other: 0,
                },
                coverage: coverage_for(backend, &verdicts),
                entries,
            });
        }
        Err(error) => return Err(error.to_string()),
        Ok(dir) => dir,
    };
    for item in dir {
        let item = item.map_err(|error| error.to_string())?;
        if !item.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            continue;
        }
        let Some(user_id) = item.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if user_id.contains(['/', '\\']) || user_id.contains("..") {
            continue;
        }
        let file = read_file(&item.path().join("turn-feedback.json"))?;
        for entry in file.entries {
            verdicts.insert(entry.message_key.clone(), entry.verdict);
            entries.push(ReviewEntry {
                user_id: user_id.clone(),
                session_id: entry.session_id,
                verdict: entry.verdict,
                reason: entry.reason,
                comment: entry.comment,
                updated_at: entry.updated_at,
                excerpt: excerpt_from_key(&entry.message_key),
            });
        }
    }
    let summary = ReviewSummary {
        like: entries
            .iter()
            .filter(|e| e.verdict == TurnVerdict::Like)
            .count() as u32,
        dislike: entries
            .iter()
            .filter(|e| e.verdict == TurnVerdict::Dislike)
            .count() as u32,
        wrong_data: count_reason(&entries, DislikeReason::WrongData),
        unhelpful: count_reason(&entries, DislikeReason::Unhelpful),
        harmful: count_reason(&entries, DislikeReason::Unsafe),
        other: count_reason(&entries, DislikeReason::Other),
    };
    entries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    entries.truncate(REVIEW_MAX);
    Ok(ReviewBody {
        summary,
        coverage: coverage_for(backend, &verdicts),
        entries,
    })
}

fn coverage_for(
    backend: Option<&dyn zeroclaw_infra::session_backend::SessionBackend>,
    verdicts: &HashMap<String, TurnVerdict>,
) -> TurnCoverage {
    let Some(backend) = backend else {
        return TurnCoverage {
            turns: 0,
            like: 0,
            dislike: 0,
            unrated: 0,
        };
    };
    let mut turns = HashSet::new();
    for meta in backend.list_sessions_with_metadata() {
        let session_id = meta.key.strip_prefix("gw_").unwrap_or(&meta.key);
        let mut seen: HashMap<String, u32> = HashMap::new();
        for message in backend.load(&meta.key) {
            if message.role != "assistant" {
                continue;
            }
            let needle = normalize_turn_content(&message.content);
            if needle.is_empty() {
                continue;
            }
            let occurrence = seen.entry(needle.clone()).or_insert(0);
            turns.insert(format!("{session_id}:{occurrence}:{needle}"));
            *occurrence += 1;
        }
    }
    let mut like = 0;
    let mut dislike = 0;
    for key in &turns {
        match verdicts.get(key) {
            Some(TurnVerdict::Like) => like += 1,
            Some(TurnVerdict::Dislike) => dislike += 1,
            None => {}
        }
    }
    let total = turns.len() as u32;
    TurnCoverage {
        turns: total,
        like,
        dislike,
        unrated: total.saturating_sub(like + dislike),
    }
}

fn normalize_turn_content(content: &str) -> String {
    let collapsed = content.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.chars().take(400).collect()
}

fn count_reason(entries: &[ReviewEntry], reason: DislikeReason) -> u32 {
    entries
        .iter()
        .filter(|entry| entry.reason == Some(reason))
        .count() as u32
}

fn excerpt_from_key(message_key: &str) -> String {
    let mut parts = message_key.splitn(3, ':');
    let _session = parts.next();
    let occurrence = parts.next();
    match (occurrence, parts.next()) {
        (Some(index), Some(text))
            if !index.is_empty() && index.bytes().all(|b| b.is_ascii_digit()) =>
        {
            text.to_string()
        }
        _ => message_key.to_string(),
    }
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
    use zeroclaw_infra::session_backend::SessionBackend;

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

    async fn body_json(response: axum::response::Response) -> serde_json::Value {
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        serde_json::from_slice(&bytes).unwrap()
    }

    fn put(
        verdict: Option<TurnVerdict>,
        reason: Option<DislikeReason>,
        comment: &str,
    ) -> TurnFeedbackPut {
        TurnFeedbackPut {
            session_id: "sess-1".into(),
            message_key: "sess-1:0:概述".into(),
            verdict,
            reason,
            comment: comment.into(),
        }
    }

    #[tokio::test]
    async fn a_users_like_is_hidden_from_another_user() {
        let tmp = tempfile::tempdir().unwrap();
        let state = state_in(&tmp);
        let saved = handle_save_turn_feedback(
            State(state.clone()),
            headers("alice"),
            Json(put(
                Some(TurnVerdict::Dislike),
                Some(DislikeReason::WrongData),
                "数字不对",
            )),
        )
        .await
        .into_response();
        assert_eq!(saved.status(), StatusCode::OK);

        let alice = body_json(
            handle_list_turn_feedback(State(state.clone()), headers("alice"))
                .await
                .into_response(),
        )
        .await;
        assert_eq!(alice["entries"][0]["verdict"], "dislike");
        assert_eq!(alice["entries"][0]["reason"], "wrong_data");
        assert_eq!(alice["entries"][0]["comment"], "数字不对");

        let bob = body_json(
            handle_list_turn_feedback(State(state), headers("bob"))
                .await
                .into_response(),
        )
        .await;
        assert!(bob["entries"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn clearing_a_verdict_removes_the_row_and_a_like_drops_the_comment() {
        let tmp = tempfile::tempdir().unwrap();
        let state = state_in(&tmp);
        let _ = handle_save_turn_feedback(
            State(state.clone()),
            headers("alice"),
            Json(put(
                Some(TurnVerdict::Like),
                Some(DislikeReason::Other),
                "忽略",
            )),
        )
        .await
        .into_response();
        let liked = body_json(
            handle_list_turn_feedback(State(state.clone()), headers("alice"))
                .await
                .into_response(),
        )
        .await;
        assert_eq!(liked["entries"][0]["verdict"], "like");
        assert!(liked["entries"][0].get("comment").is_none());
        assert!(liked["entries"][0].get("reason").is_none());

        let _ = handle_save_turn_feedback(
            State(state.clone()),
            headers("alice"),
            Json(put(None, None, "")),
        )
        .await
        .into_response();
        let cleared = body_json(
            handle_list_turn_feedback(State(state), headers("alice"))
                .await
                .into_response(),
        )
        .await;
        assert!(cleared["entries"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn missing_secret_does_not_write_a_file() {
        let tmp = tempfile::tempdir().unwrap();
        let state = state_in(&tmp);
        let response = handle_save_turn_feedback(
            State(state),
            HeaderMap::new(),
            Json(put(Some(TurnVerdict::Like), None, "")),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert!(!tmp.path().join("users").exists());
    }

    fn ops_headers() -> HeaderMap {
        let mut map = headers("ops");
        map.insert(
            "x-user-role",
            HeaderValue::from_bytes("管理员".as_bytes()).unwrap(),
        );
        map
    }

    #[tokio::test]
    async fn review_lists_every_user_for_ops_and_hides_it_from_an_ordinary_user() {
        let tmp = tempfile::tempdir().unwrap();
        let state = state_in(&tmp);
        let _ = handle_save_turn_feedback(
            State(state.clone()),
            headers("alice"),
            Json(put(
                Some(TurnVerdict::Dislike),
                Some(DislikeReason::WrongData),
                "数字不对",
            )),
        )
        .await
        .into_response();
        let mut bob = put(Some(TurnVerdict::Like), None, "");
        bob.session_id = "sess-2".into();
        bob.message_key = "sess-2:0:周报".into();
        let _ = handle_save_turn_feedback(State(state.clone()), headers("bob"), Json(bob))
            .await
            .into_response();

        let denied = handle_review_turn_feedback(State(state.clone()), headers("alice"))
            .await
            .into_response();
        assert_eq!(denied.status(), StatusCode::FORBIDDEN);

        let review = body_json(
            handle_review_turn_feedback(State(state), ops_headers())
                .await
                .into_response(),
        )
        .await;
        assert_eq!(review["summary"]["like"], 1);
        assert_eq!(review["summary"]["dislike"], 1);
        assert_eq!(review["summary"]["wrong_data"], 1);
        assert_eq!(review["coverage"]["turns"], 0);
        let rows = review["entries"].as_array().unwrap();
        assert_eq!(rows.len(), 2);
        assert!(
            rows.iter()
                .any(|row| row["user_id"] == "alice" && row["excerpt"] == "概述")
        );
        assert!(
            rows.iter()
                .any(|row| row["user_id"] == "bob" && row["excerpt"] == "周报")
        );
    }

    #[tokio::test]
    async fn coverage_counts_stored_replies_that_were_not_rated() {
        let tmp = tempfile::tempdir().unwrap();
        let mut state = state_in(&tmp);
        let backend =
            zeroclaw_infra::session_sqlite::SqliteSessionBackend::new(tmp.path()).unwrap();
        let assistant = |text: &str| zeroclaw_api::model_provider::ChatMessage::assistant(text);
        backend.append("gw_sess-1", &assistant("概述")).unwrap();
        backend
            .append(
                "gw_sess-1",
                &zeroclaw_api::model_provider::ChatMessage::user("下一问"),
            )
            .unwrap();
        backend.append("gw_sess-1", &assistant("另一轮")).unwrap();
        backend.append("gw_sess-2", &assistant("没人评")).unwrap();
        state.session_backend = Some(std::sync::Arc::new(backend));

        let _ = handle_save_turn_feedback(
            State(state.clone()),
            headers("alice"),
            Json(put(
                Some(TurnVerdict::Dislike),
                Some(DislikeReason::WrongData),
                "数字不对",
            )),
        )
        .await
        .into_response();

        let review = body_json(
            handle_review_turn_feedback(State(state), ops_headers())
                .await
                .into_response(),
        )
        .await;
        assert_eq!(review["coverage"]["turns"], 3);
        assert_eq!(review["coverage"]["like"], 0);
        assert_eq!(review["coverage"]["dislike"], 1);
        assert_eq!(review["coverage"]["unrated"], 2);
    }

    #[test]
    fn identity_rejects_a_path_session_and_a_control_char_in_the_key() {
        assert!(check_identity("../a", "key").is_err());
        assert!(check_identity("sess", "bad\nkey").is_err());
        assert!(check_identity("sess-1", "sess-1:0:概述").is_ok());
    }
}
