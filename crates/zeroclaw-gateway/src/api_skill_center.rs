//! Platform skill catalog. Plaza stays the published projection.

use std::path::{Path, PathBuf};

use axum::{
    Json,
    extract::{Path as AxumPath, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use zeroclaw_runtime::skills::SkillFrontmatter;

use super::AppState;
use super::api_skills::{
    personal_skills_dir, require_agent, require_personal_user, require_skill_name,
    respond_skill_files, skill_plaza_dir, write_personal_skill_file,
};

const STATUS_DRAFT: &str = "draft";
const STATUS_PENDING: &str = "pending";
const STATUS_APPROVED: &str = "approved";
const STATUS_REJECTED: &str = "rejected";
const STATUS_PUBLISHED: &str = "published";
const STATUS_OFFLINE: &str = "offline";

fn can_edit_content(status: &str) -> bool {
    matches!(status, STATUS_DRAFT | STATUS_REJECTED | STATUS_OFFLINE)
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
struct SkillRelease {
    version: u32,
    published_at: String,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
struct SkillReview {
    status: String,
    #[serde(default)]
    creator_id: String,
    #[serde(default)]
    creator_name: String,
    #[serde(default)]
    submitter_id: String,
    #[serde(default)]
    submitter_name: String,
    #[serde(default)]
    reject_reason: String,
    #[serde(default)]
    version: u32,
    #[serde(default)]
    published_at: String,
    #[serde(default)]
    releases: Vec<SkillRelease>,
}

#[derive(Deserialize)]
pub struct SkillCenterWriteBody {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub display_name: String,
}

#[derive(Deserialize)]
pub struct SkillCenterReviewBody {
    pub decision: String,
    #[serde(default)]
    pub note: String,
}

#[derive(Deserialize)]
pub struct PersonalSubmitBody {
    pub agent: String,
    #[serde(default)]
    pub display_name: String,
}

#[derive(Deserialize)]
pub struct PersonalForkBody {
    pub agent: String,
    pub name: String,
}

fn catalog_root(config: &zeroclaw_config::schema::Config) -> PathBuf {
    config
        .install_root_dir()
        .join("shared")
        .join("skill-catalog")
}

fn catalog_dir(config: &zeroclaw_config::schema::Config, id: &str) -> PathBuf {
    catalog_root(config).join(id)
}

fn skill_seq_path(config: &zeroclaw_config::schema::Config) -> PathBuf {
    config.install_root_dir().join("shared").join("skill-seq")
}

/// `sk0001` … `sk9999`, then `sk10000` without a fixed width.
fn format_skill_id(n: u64) -> String {
    format!("sk{n:04}")
}

/// Next skill id. The counter advances even if the caller never saves.
fn allocate_skill_id(config: &zeroclaw_config::schema::Config) -> Result<String, Response> {
    let path = skill_seq_path(config);
    if let Some(parent) = path.parent() {
        if let Err(err) = std::fs::create_dir_all(parent) {
            return Err(json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("failed to allocate skill id: {err}"),
            ));
        }
    }
    let mut file = match std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
    {
        Ok(file) => file,
        Err(err) => {
            return Err(json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("failed to allocate skill id: {err}"),
            ));
        }
    };
    if let Err(err) = lock_skill_seq(&file) {
        return Err(json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("failed to allocate skill id: {err}"),
        ));
    }
    use std::os::unix::io::AsRawFd;
    let _unlock = SkillSeqUnlock(file.as_raw_fd());
    let mut buf = String::new();
    if let Err(err) = std::io::Read::read_to_string(&mut file, &mut buf) {
        return Err(json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("failed to allocate skill id: {err}"),
        ));
    }
    let current = if buf.trim().is_empty() {
        0
    } else {
        match buf.trim().parse::<u64>() {
            Ok(n) => n,
            Err(_) => {
                return Err(json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "skill id counter is invalid",
                ));
            }
        }
    };
    let Some(next) = current.checked_add(1) else {
        return Err(json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "skill id counter is exhausted",
        ));
    };
    if let Err(err) = (|| -> std::io::Result<()> {
        use std::io::{Seek, Write};
        file.seek(std::io::SeekFrom::Start(0))?;
        file.set_len(0)?;
        write!(file, "{next}")?;
        file.sync_all()?;
        Ok(())
    })() {
        return Err(json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("failed to allocate skill id: {err}"),
        ));
    }
    Ok(format_skill_id(next))
}

struct SkillSeqUnlock(std::os::unix::io::RawFd);

impl Drop for SkillSeqUnlock {
    fn drop(&mut self) {
        unsafe {
            libc::flock(self.0, libc::LOCK_UN);
        }
    }
}

fn lock_skill_seq(file: &std::fs::File) -> std::io::Result<()> {
    use std::os::unix::io::AsRawFd;
    let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) };
    if rc == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

/// `POST /api/skill-ids` — one new id. Cancelled forms do not return the number.
pub async fn handle_allocate_skill_id(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Response {
    if let Err(resp) = require_personal_user(&state, &headers) {
        return resp;
    }
    let config = state.config.read().clone();
    match allocate_skill_id(&config) {
        Ok(id) => Json(serde_json::json!({ "id": id })).into_response(),
        Err(resp) => resp,
    }
}

fn review_path(config: &zeroclaw_config::schema::Config, id: &str) -> PathBuf {
    catalog_root(config).join(format!("{id}.review.json"))
}

fn json_error(status: StatusCode, message: &str) -> Response {
    (status, Json(serde_json::json!({ "error": message }))).into_response()
}

fn require_admin(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<zeroclaw_api::UserAttrs, Response> {
    if let Err(err) = crate::trusted_proxy::require_ops_auth(state, headers) {
        return Err(err.into_response());
    }
    crate::trusted_proxy::frozen_bff_user(state, headers).ok_or_else(|| {
        json_error(
            StatusCode::FORBIDDEN,
            "skill center requires a BFF user identity",
        )
    })
}

fn clean_label(raw: &str, fallback: &str) -> String {
    let label: String = raw.chars().filter(|ch| !ch.is_control()).take(64).collect();
    let label = label.trim();
    if label.is_empty() {
        fallback.to_string()
    } else {
        label.to_string()
    }
}

fn local_now() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M").to_string()
}

fn parse_version_num(raw: &str) -> u32 {
    raw.trim().trim_matches('"').parse().unwrap_or(0)
}

fn skill_text(dir: &Path) -> Option<(String, String, String, u32)> {
    let content = std::fs::read_to_string(dir.join("SKILL.md")).ok()?;
    let doc = zeroclaw_runtime::skills::document::SkillDocument::parse(&content).ok()?;
    let version = doc
        .frontmatter
        .version
        .as_deref()
        .map(parse_version_num)
        .unwrap_or(0);
    Some((
        doc.frontmatter.name,
        doc.frontmatter.description,
        doc.body,
        version,
    ))
}

fn load_review(config: &zeroclaw_config::schema::Config, id: &str) -> Option<SkillReview> {
    let text = std::fs::read_to_string(review_path(config, id)).ok()?;
    serde_json::from_str(&text).ok()
}

fn save_review(
    config: &zeroclaw_config::schema::Config,
    id: &str,
    review: &SkillReview,
) -> Result<(), Response> {
    let path = review_path(config, id);
    if let Some(parent) = path.parent() {
        if let Err(err) = std::fs::create_dir_all(parent) {
            return Err(json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("Failed to create skill catalog: {err}"),
            ));
        }
    }
    let text = serde_json::to_string_pretty(review).map_err(|err| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("Failed to encode skill review: {err}"),
        )
    })?;
    std::fs::write(path, text).map_err(|err| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("Failed to write skill review: {err}"),
        )
    })
}

fn skip_package_name(name: &std::ffi::OsStr) -> bool {
    let Some(text) = name.to_str() else {
        return true;
    };
    text.starts_with('.') || text == "__MACOSX" || text == ".DS_Store"
}

fn copy_skill_tree(src: &Path, dest: &Path) -> Result<(), String> {
    fn walk(src: &Path, dest: &Path, files: &mut usize, total: &mut u64) -> Result<(), String> {
        std::fs::create_dir_all(dest).map_err(|err| err.to_string())?;
        for entry in std::fs::read_dir(src).map_err(|err| err.to_string())? {
            let entry = entry.map_err(|err| err.to_string())?;
            if skip_package_name(&entry.file_name()) {
                continue;
            }
            let file_type = entry.file_type().map_err(|err| err.to_string())?;
            if file_type.is_symlink() {
                return Err("skill package contains a symlink".into());
            }
            let from = entry.path();
            let to = dest.join(entry.file_name());
            if !to.starts_with(dest) {
                return Err("invalid skill file path".into());
            }
            if file_type.is_dir() {
                walk(&from, &to, files, total)?;
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let len = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
            if len > 1024 * 1024 || *files >= 512 || total.saturating_add(len) > 8 * 1024 * 1024 {
                return Err("skill package is too large".into());
            }
            *files += 1;
            *total = total.saturating_add(len);
            if let Some(parent) = to.parent() {
                std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
            }
            std::fs::copy(&from, &to).map_err(|err| err.to_string())?;
        }
        Ok(())
    }
    let mut files = 0usize;
    let mut total = 0u64;
    walk(src, dest, &mut files, &mut total)
}

fn replace_skill_tree(src: &Path, dest: &Path) -> Result<(), Response> {
    if dest.exists() {
        if let Err(err) = std::fs::remove_dir_all(dest) {
            return Err(json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("Failed to replace skill directory: {err}"),
            ));
        }
    }
    copy_skill_tree(src, dest).map_err(|err| {
        json_error(
            StatusCode::BAD_REQUEST,
            &format!("Failed to copy skill: {err}"),
        )
    })
}

fn upsert_version(text: &str, version: u32) -> String {
    let line = format!("version: \"{version}\"");
    let Some(rest) = text.strip_prefix("---\n") else {
        return format!("---\n{line}\n---\n\n{text}");
    };
    let Some(end) = rest.find("\n---") else {
        return format!("---\n{line}\n---\n\n{text}");
    };
    let front = &rest[..end];
    let tail = &rest[end + "\n---".len()..];
    let mut lines = Vec::new();
    let mut replaced = false;
    for raw in front.lines() {
        if raw.trim_start().starts_with("version:") {
            lines.push(line.clone());
            replaced = true;
        } else {
            lines.push(raw.to_string());
        }
    }
    if !replaced {
        lines.push(line);
    }
    format!("---\n{}\n---{tail}", lines.join("\n"))
}

fn write_skill_version(path: &Path, version: u32) -> Result<(), Response> {
    let text = std::fs::read_to_string(path).map_err(|err| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("Failed to read SKILL.md: {err}"),
        )
    })?;
    std::fs::write(path, upsert_version(&text, version)).map_err(|err| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("Failed to write SKILL.md: {err}"),
        )
    })
}

/// Personal directory was installed from the plaza.
///
/// A `.from-plaza` marker always counts. The same id on the plaza without that
/// marker also counts, except for the catalog creator: that directory is the
/// working copy they submitted, and publishing it must not lock them out.
#[must_use]
pub(crate) fn is_plaza_copy(
    config: &zeroclaw_config::schema::Config,
    dir: &Path,
    name: &str,
    user_id: &str,
) -> bool {
    if dir.join(".from-plaza").is_file() {
        return true;
    }
    if !skill_plaza_dir(config)
        .join(name)
        .join("SKILL.md")
        .is_file()
    {
        return false;
    }
    match load_review(config, name) {
        Some(review) if !review.creator_id.is_empty() && review.creator_id == user_id => false,
        _ => true,
    }
}

/// Creator recorded the first time this id entered the catalog. Empty for plaza-only skills.
#[must_use]
pub(crate) fn plaza_creator(
    config: &zeroclaw_config::schema::Config,
    name: &str,
) -> (String, String) {
    load_review(config, name)
        .map(|review| (review.creator_id, review.creator_name))
        .unwrap_or_default()
}

/// Latest publish time for a plaza skill. Empty until the skill center publishes it.
#[must_use]
pub(crate) fn plaza_published_at(config: &zeroclaw_config::schema::Config, name: &str) -> String {
    load_review(config, name)
        .map(|review| review.published_at)
        .unwrap_or_default()
}

/// Review status when this user created or most recently submitted the platform skill.
#[must_use]
pub(crate) fn review_status_for_submitter(
    config: &zeroclaw_config::schema::Config,
    user_id: &str,
    name: &str,
) -> String {
    let Some(review) = load_review(config, name) else {
        return String::new();
    };
    if review.creator_id == user_id || review.submitter_id == user_id {
        review.status
    } else {
        String::new()
    }
}

fn on_plaza(config: &zeroclaw_config::schema::Config, id: &str) -> bool {
    skill_plaza_dir(config).join(id).join("SKILL.md").is_file()
}

fn skill_dir_ci(root: &Path, id: &str) -> Option<PathBuf> {
    let direct = root.join(id);
    if direct.join("SKILL.md").is_file() {
        return Some(direct);
    }
    let entries = std::fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if name.eq_ignore_ascii_case(id) && path.join("SKILL.md").is_file() {
            return Some(path);
        }
    }
    None
}

fn review_exists_ci(config: &zeroclaw_config::schema::Config, id: &str) -> bool {
    if review_path(config, id).is_file() {
        return true;
    }
    let Ok(entries) = std::fs::read_dir(catalog_root(config)) else {
        return false;
    };
    entries.flatten().any(|entry| {
        entry
            .file_name()
            .to_str()
            .and_then(|name| name.strip_suffix(".review.json"))
            .is_some_and(|stem| stem.eq_ignore_ascii_case(id))
    })
}

/// Plaza, catalog, or a review sidecar already uses this id. Comparison ignores ASCII case.
pub(crate) fn platform_skill_id_occupied(
    config: &zeroclaw_config::schema::Config,
    id: &str,
) -> bool {
    skill_dir_ci(&skill_plaza_dir(config), id).is_some()
        || skill_dir_ci(&catalog_root(config), id).is_some()
        || review_exists_ci(config, id)
}

/// First user who has this id as their own skill, not a plaza copy.
pub(crate) fn personal_original_owner(
    config: &zeroclaw_config::schema::Config,
    id: &str,
) -> Option<String> {
    let users = config.install_root_dir().join("users");
    let entries = std::fs::read_dir(users).ok()?;
    for user in entries.flatten() {
        if !user.path().is_dir() {
            continue;
        }
        let Some(user_id) = user.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let Ok(agents) = std::fs::read_dir(user.path().join("agents")) else {
            continue;
        };
        for agent in agents.flatten() {
            let Some(dir) = skill_dir_ci(&agent.path().join("workspace").join("skills"), id) else {
                continue;
            };
            let Some(dir_name) = dir.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if !is_plaza_copy(config, &dir, dir_name, &user_id) {
                return Some(user_id);
            }
        }
    }
    None
}

pub(crate) fn user_has_skill(
    config: &zeroclaw_config::schema::Config,
    user_id: &str,
    id: &str,
) -> bool {
    let agents = config
        .install_root_dir()
        .join("users")
        .join(user_id)
        .join("agents");
    let Ok(entries) = std::fs::read_dir(agents) else {
        return false;
    };
    entries
        .flatten()
        .any(|agent| skill_dir_ci(&agent.path().join("workspace").join("skills"), id).is_some())
}

fn review_json(review: &SkillReview, on_plaza: bool) -> serde_json::Value {
    let mut releases = review.releases.clone();
    releases.reverse();
    serde_json::json!({
        "status": review.status,
        "creator_id": review.creator_id,
        "creator_name": review.creator_name,
        "submitter_id": review.submitter_id,
        "submitter_name": review.submitter_name,
        "reject_reason": review.reject_reason,
        "version": review.version,
        "published_at": review.published_at,
        "releases": releases,
        "on_plaza": on_plaza,
    })
}

fn list_row(id: &str, dir: &Path, review: &SkillReview, on_plaza: bool) -> serde_json::Value {
    let (title, description, _, _) = skill_text(dir).unwrap_or_default();
    let mut row = review_json(review, on_plaza);
    if let Some(obj) = row.as_object_mut() {
        obj.insert("id".into(), serde_json::json!(id));
        obj.insert(
            "title".into(),
            serde_json::json!(if title.trim().is_empty() {
                id
            } else {
                title.as_str()
            }),
        );
        obj.insert("description".into(), serde_json::json!(description));
    }
    row
}

fn materialize_plaza(
    config: &zeroclaw_config::schema::Config,
    id: &str,
) -> Result<SkillReview, Response> {
    if let Some(review) = load_review(config, id) {
        return Ok(review);
    }
    let plaza = skill_plaza_dir(config).join(id);
    if !plaza.join("SKILL.md").is_file() {
        return Err(json_error(StatusCode::NOT_FOUND, "skill not found"));
    }
    replace_skill_tree(&plaza, &catalog_dir(config, id))?;
    let version = skill_text(&catalog_dir(config, id))
        .map(|(_, _, _, version)| version)
        .unwrap_or(0);
    let review = SkillReview {
        status: STATUS_PUBLISHED.to_string(),
        creator_id: String::new(),
        creator_name: String::new(),
        submitter_id: String::new(),
        submitter_name: String::new(),
        reject_reason: String::new(),
        version,
        published_at: String::new(),
        releases: Vec::new(),
    };
    save_review(config, id, &review)?;
    Ok(review)
}

fn content_dir(config: &zeroclaw_config::schema::Config, id: &str) -> Option<PathBuf> {
    let catalog = catalog_dir(config, id);
    if catalog.join("SKILL.md").is_file() {
        return Some(catalog);
    }
    let plaza = skill_plaza_dir(config).join(id);
    if plaza.join("SKILL.md").is_file() {
        return Some(plaza);
    }
    None
}

/// `GET /api/skill-center`
pub async fn handle_list_skill_center(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Response {
    if let Err(resp) = require_admin(&state, &headers) {
        return resp;
    }
    let config = state.config.read().clone();
    let mut skills = Vec::new();
    let mut seen = std::collections::HashSet::new();
    if let Ok(entries) = std::fs::read_dir(catalog_root(&config)) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(id) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if zeroclaw_api::normalize_user_id(id).is_err() || !path.join("SKILL.md").is_file() {
                continue;
            }
            let review = load_review(&config, id).unwrap_or(SkillReview {
                status: STATUS_DRAFT.to_string(),
                creator_id: String::new(),
                creator_name: String::new(),
                submitter_id: String::new(),
                submitter_name: String::new(),
                reject_reason: String::new(),
                version: 0,
                published_at: String::new(),
                releases: Vec::new(),
            });
            skills.push(list_row(id, &path, &review, on_plaza(&config, id)));
            seen.insert(id.to_string());
        }
    }
    let plaza = skill_plaza_dir(&config);
    if let Ok(entries) = std::fs::read_dir(&plaza) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(id) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if seen.contains(id) || zeroclaw_api::normalize_user_id(id).is_err() {
                continue;
            }
            if skill_text(&path).is_none() {
                continue;
            }
            let version = skill_text(&path)
                .map(|(_, _, _, version)| version)
                .unwrap_or(0);
            let review = SkillReview {
                status: STATUS_PUBLISHED.to_string(),
                creator_id: String::new(),
                creator_name: String::new(),
                submitter_id: String::new(),
                submitter_name: String::new(),
                reject_reason: String::new(),
                version,
                published_at: String::new(),
                releases: Vec::new(),
            };
            skills.push(list_row(id, &path, &review, true));
        }
    }
    skills.sort_by(|a, b| {
        a["id"]
            .as_str()
            .unwrap_or_default()
            .cmp(b["id"].as_str().unwrap_or_default())
    });
    Json(serde_json::json!({ "skills": skills })).into_response()
}

/// `POST /api/skill-center` — admin draft. Publishing still requires submit and review.
pub async fn handle_create_skill_center(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<SkillCenterWriteBody>,
) -> Response {
    let attrs = match require_admin(&state, &headers) {
        Ok(attrs) => attrs,
        Err(resp) => return resp,
    };
    let id = match require_skill_name(&body.name) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let config = state.config.read().clone();
    if platform_skill_id_occupied(&config, &id) || personal_original_owner(&config, &id).is_some() {
        return json_error(StatusCode::CONFLICT, "skill id is already used");
    }
    let dir = catalog_dir(&config, &id);
    let title = if body.title.trim().is_empty() {
        id.clone()
    } else {
        body.title.clone()
    };
    if write_personal_skill_file(
        &dir,
        &id,
        SkillFrontmatter {
            name: title,
            description: body.description.clone(),
            ..SkillFrontmatter::default()
        },
        body.body.clone(),
    )
    .is_err()
    {
        return json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to write SKILL.md",
        );
    }
    let label = clean_label(&body.display_name, &attrs.user_id);
    let review = SkillReview {
        status: STATUS_DRAFT.to_string(),
        creator_id: attrs.user_id.clone(),
        creator_name: label,
        submitter_id: String::new(),
        submitter_name: String::new(),
        reject_reason: String::new(),
        version: 0,
        published_at: String::new(),
        releases: Vec::new(),
    };
    if let Err(resp) = save_review(&config, &id, &review) {
        return resp;
    }
    (
        StatusCode::CREATED,
        Json(serde_json::json!({ "id": id, "status": review.status })),
    )
        .into_response()
}

/// `GET /api/skill-center/{name}`
pub async fn handle_read_skill_center(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(name): AxumPath<String>,
) -> Response {
    if let Err(resp) = require_admin(&state, &headers) {
        return resp;
    }
    let id = match require_skill_name(&name) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let config = state.config.read().clone();
    let Some(dir) = content_dir(&config, &id) else {
        return json_error(StatusCode::NOT_FOUND, "skill not found");
    };
    let Some((title, description, body, file_version)) = skill_text(&dir) else {
        return json_error(StatusCode::UNPROCESSABLE_ENTITY, "SKILL.md is invalid");
    };
    let review = load_review(&config, &id).unwrap_or(SkillReview {
        status: if on_plaza(&config, &id) {
            STATUS_PUBLISHED
        } else {
            STATUS_DRAFT
        }
        .to_string(),
        creator_id: String::new(),
        creator_name: String::new(),
        submitter_id: String::new(),
        submitter_name: String::new(),
        reject_reason: String::new(),
        version: file_version,
        published_at: String::new(),
        releases: Vec::new(),
    });
    let mut row = review_json(&review, on_plaza(&config, &id));
    if let Some(obj) = row.as_object_mut() {
        obj.insert("id".into(), serde_json::json!(id));
        obj.insert(
            "title".into(),
            serde_json::json!(if title.trim().is_empty() {
                id.as_str()
            } else {
                title.as_str()
            }),
        );
        obj.insert("description".into(), serde_json::json!(description));
        obj.insert("body".into(), serde_json::json!(body));
    }
    Json(row).into_response()
}

/// `PUT /api/skill-center/{name}` — edits the catalog master.
/// Only a new, rejected, or offline skill can be edited. Saving does not change status.
pub async fn handle_update_skill_center(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(name): AxumPath<String>,
    Json(body): Json<SkillCenterWriteBody>,
) -> Response {
    if let Err(resp) = require_admin(&state, &headers) {
        return resp;
    }
    let id = match require_skill_name(&name) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let config = state.config.read().clone();
    let review = match materialize_plaza(&config, &id) {
        Ok(review) => review,
        Err(resp) => return resp,
    };
    if !can_edit_content(&review.status) {
        return json_error(
            StatusCode::CONFLICT,
            "skill can only be edited while it is new, rejected, or offline",
        );
    }
    let dir = catalog_dir(&config, &id);
    let title = if body.title.trim().is_empty() {
        id.clone()
    } else {
        body.title
    };
    if let Err(resp) = write_personal_skill_file(
        &dir,
        &id,
        SkillFrontmatter {
            name: title,
            description: body.description,
            ..SkillFrontmatter::default()
        },
        body.body,
    ) {
        return resp;
    }
    Json(serde_json::json!({ "id": id, "status": review.status })).into_response()
}

/// `GET /api/skill-center/{name}/files`
pub async fn handle_skill_center_files(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(name): AxumPath<String>,
    Query(query): Query<super::api_skills::SkillFileQuery>,
) -> Response {
    if let Err(resp) = require_admin(&state, &headers) {
        return resp;
    }
    let id = match require_skill_name(&name) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let config = state.config.read().clone();
    let Some(dir) = content_dir(&config, &id) else {
        return json_error(StatusCode::NOT_FOUND, "skill not found");
    };
    respond_skill_files(&dir, &query.path)
}

/// `POST /api/skill-center/{name}/submit`
pub async fn handle_submit_skill_center(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(name): AxumPath<String>,
    Json(body): Json<SkillCenterWriteBody>,
) -> Response {
    let attrs = match require_admin(&state, &headers) {
        Ok(attrs) => attrs,
        Err(resp) => return resp,
    };
    let id = match require_skill_name(&name) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let config = state.config.read().clone();
    let Some(mut review) = load_review(&config, &id) else {
        return json_error(
            StatusCode::CONFLICT,
            "edit the plaza skill before submitting",
        );
    };
    if !matches!(
        review.status.as_str(),
        STATUS_DRAFT | STATUS_REJECTED | STATUS_OFFLINE
    ) {
        return json_error(
            StatusCode::CONFLICT,
            "skill cannot be submitted in this state",
        );
    }
    review.status = STATUS_PENDING.to_string();
    review.submitter_id = attrs.user_id.clone();
    review.submitter_name = clean_label(&body.display_name, &attrs.user_id);
    review.reject_reason.clear();
    if let Err(resp) = save_review(&config, &id, &review) {
        return resp;
    }
    Json(serde_json::json!({ "id": id, "status": review.status })).into_response()
}

/// `POST /api/skill-center/{name}/review`
pub async fn handle_review_skill_center(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(name): AxumPath<String>,
    Json(body): Json<SkillCenterReviewBody>,
) -> Response {
    if let Err(resp) = require_admin(&state, &headers) {
        return resp;
    }
    let id = match require_skill_name(&name) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let config = state.config.read().clone();
    let Some(mut review) = load_review(&config, &id) else {
        return json_error(StatusCode::NOT_FOUND, "skill not found");
    };
    let before_version = review.version;
    let before_published = review.published_at.clone();
    match body.decision.trim() {
        "approve" => {
            if review.status != STATUS_PENDING {
                return json_error(StatusCode::CONFLICT, "skill is not pending review");
            }
            review.status = STATUS_APPROVED.to_string();
            review.reject_reason.clear();
        }
        "reject" => {
            if !matches!(review.status.as_str(), STATUS_PENDING | STATUS_APPROVED) {
                return json_error(
                    StatusCode::CONFLICT,
                    "skill can only be rejected while it is pending or approved",
                );
            }
            let note = clean_label(&body.note, "");
            if note.is_empty() {
                return json_error(StatusCode::BAD_REQUEST, "reject reason is required");
            }
            review.status = STATUS_REJECTED.to_string();
            review.reject_reason = note;
        }
        _ => {
            return json_error(
                StatusCode::BAD_REQUEST,
                "decision must be approve or reject",
            );
        }
    }
    review.version = before_version;
    review.published_at = before_published;
    if let Err(resp) = save_review(&config, &id, &review) {
        return resp;
    }
    Json(review_json(&review, on_plaza(&config, &id))).into_response()
}

/// `POST /api/skill-center/{name}/publish` — only an approved skill. This bumps the version.
pub async fn handle_publish_skill_center(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(name): AxumPath<String>,
) -> Response {
    if let Err(resp) = require_admin(&state, &headers) {
        return resp;
    }
    let id = match require_skill_name(&name) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let config = state.config.read().clone();
    let Some(mut review) = load_review(&config, &id) else {
        return json_error(StatusCode::CONFLICT, "approve the skill before publishing");
    };
    if review.status != STATUS_APPROVED {
        return json_error(
            StatusCode::CONFLICT,
            "only an approved skill can be published",
        );
    }
    let next = review.version.saturating_add(1);
    let published_at = local_now();
    let src = catalog_dir(&config, &id);
    let plaza = skill_plaza_dir(&config).join(&id);
    if let Err(resp) = replace_skill_tree(&src, &plaza) {
        return resp;
    }
    if let Err(resp) = write_skill_version(&src.join("SKILL.md"), next) {
        return resp;
    }
    if let Err(resp) = write_skill_version(&plaza.join("SKILL.md"), next) {
        return resp;
    }
    review.version = next;
    review.published_at = published_at.clone();
    review.status = STATUS_PUBLISHED.to_string();
    review.reject_reason.clear();
    review.releases.push(SkillRelease {
        version: next,
        published_at: published_at.clone(),
    });
    if let Err(resp) = save_review(&config, &id, &review) {
        return resp;
    }
    zeroclaw_runtime::skills::cache::invalidate();
    Json(serde_json::json!({
        "id": id,
        "status": review.status,
        "version": next,
        "published_at": published_at,
    }))
    .into_response()
}

/// `POST /api/skill-center/{name}/unpublish` — remove the plaza projection. Catalog stays.
pub async fn handle_unpublish_skill_center(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(name): AxumPath<String>,
) -> Response {
    if let Err(resp) = require_admin(&state, &headers) {
        return resp;
    }
    let id = match require_skill_name(&name) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let config = state.config.read().clone();
    let mut review = match materialize_plaza(&config, &id) {
        Ok(review) => review,
        Err(resp) => return resp,
    };
    let plaza = skill_plaza_dir(&config).join(&id);
    if !plaza.exists() && review.status != STATUS_PUBLISHED {
        return json_error(StatusCode::CONFLICT, "skill is not on the plaza");
    }
    if plaza.exists() {
        if let Err(err) = std::fs::remove_dir_all(&plaza) {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("Failed to remove plaza skill: {err}"),
            );
        }
    }
    review.status = STATUS_OFFLINE.to_string();
    if let Err(resp) = save_review(&config, &id, &review) {
        return resp;
    }
    zeroclaw_runtime::skills::cache::invalidate();
    Json(serde_json::json!({
        "id": id,
        "status": review.status,
        "version": review.version,
        "releases": review.releases.len(),
    }))
    .into_response()
}

/// `POST /api/user/skills/{name}/submit` — copy a personal skill into the catalog as pending.
pub async fn handle_submit_personal_skill(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(name): AxumPath<String>,
    Json(body): Json<PersonalSubmitBody>,
) -> Response {
    let attrs = match require_personal_user(&state, &headers) {
        Ok(attrs) => attrs,
        Err(resp) => return resp,
    };
    let id = match require_skill_name(&name) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let agent = match require_agent(&body.agent) {
        Ok(agent) => agent.to_string(),
        Err(resp) => return resp,
    };
    let config = state.config.read().clone();
    let src = personal_skills_dir(&config, &attrs.user_id, &agent).join(&id);
    if !src.join("SKILL.md").is_file() {
        return json_error(StatusCode::NOT_FOUND, "skill not found");
    }
    if is_plaza_copy(&config, &src, &id, &attrs.user_id) {
        return json_error(
            StatusCode::FORBIDDEN,
            "plaza copies cannot be submitted; fork the skill first",
        );
    }
    let existing = load_review(&config, &id);
    if existing
        .as_ref()
        .is_some_and(|review| review.status != STATUS_REJECTED)
    {
        return json_error(
            StatusCode::CONFLICT,
            "skill can only be submitted again after rejection",
        );
    }
    if existing.is_none()
        && (platform_skill_id_occupied(&config, &id)
            || personal_original_owner(&config, &id).is_some_and(|owner| owner != attrs.user_id))
    {
        return json_error(StatusCode::CONFLICT, "skill id is already used");
    }
    let plaza_before = on_plaza(&config, &id);
    if let Err(resp) = replace_skill_tree(&src, &catalog_dir(&config, &id)) {
        return resp;
    }
    let label = clean_label(&body.display_name, &attrs.user_id);
    let mut review = existing.unwrap_or(SkillReview {
        status: STATUS_DRAFT.to_string(),
        creator_id: attrs.user_id.clone(),
        creator_name: label.clone(),
        submitter_id: String::new(),
        submitter_name: String::new(),
        reject_reason: String::new(),
        version: 0,
        published_at: String::new(),
        releases: Vec::new(),
    });
    review.status = STATUS_PENDING.to_string();
    review.submitter_id = attrs.user_id.clone();
    review.submitter_name = label;
    review.reject_reason.clear();
    if let Err(resp) = save_review(&config, &id, &review) {
        return resp;
    }
    Json(serde_json::json!({
        "id": id,
        "status": review.status,
        "creator_id": review.creator_id,
        "on_plaza": plaza_before && on_plaza(&config, &id),
    }))
    .into_response()
}

/// `POST /api/user/skills/{name}/fork` — copy a plaza install to a new personal id.
pub async fn handle_fork_personal_skill(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(name): AxumPath<String>,
    Json(body): Json<PersonalForkBody>,
) -> Response {
    let attrs = match require_personal_user(&state, &headers) {
        Ok(attrs) => attrs,
        Err(resp) => return resp,
    };
    let id = match require_skill_name(&name) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let new_id = match require_skill_name(&body.name) {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    let agent = match require_agent(&body.agent) {
        Ok(agent) => agent.to_string(),
        Err(resp) => return resp,
    };
    if new_id == id {
        return json_error(StatusCode::BAD_REQUEST, "choose a new skill id");
    }
    let config = state.config.read().clone();
    let root = personal_skills_dir(&config, &attrs.user_id, &agent);
    let src = root.join(&id);
    if !src.join("SKILL.md").is_file() {
        return json_error(StatusCode::NOT_FOUND, "skill not found");
    }
    if user_has_skill(&config, &attrs.user_id, &new_id) {
        return json_error(StatusCode::CONFLICT, "you already have this skill id");
    }
    if platform_skill_id_occupied(&config, &new_id)
        || personal_original_owner(&config, &new_id).is_some()
    {
        return json_error(StatusCode::CONFLICT, "skill id is already used");
    }
    let dest = root.join(&new_id);
    if let Err(resp) = replace_skill_tree(&src, &dest) {
        return resp;
    }
    zeroclaw_runtime::skills::cache::invalidate();
    Json(serde_json::json!({ "name": new_id })).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ops::Deref;

    use crate::api::test_state;
    use crate::api_skills::{
        InstallPlazaSkillBody, PersonalSkillBody, PersonalSkillPackageFile, PersonalSkillQuery,
        PersonalSkillWriteBody, handle_install_plaza_skill, handle_list_skill_plaza,
        handle_read_personal_skill, handle_save_personal_skill, handle_write_personal_skill,
    };
    use axum::http::HeaderValue;
    use zeroclaw_api::ROLE_OPS;

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

    fn headers(user: &str, role: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("x-auth-secret", HeaderValue::from_static("s3cret"));
        headers.insert(
            "x-user-id",
            HeaderValue::from_bytes(user.as_bytes()).unwrap(),
        );
        headers.insert(
            "x-user-role",
            HeaderValue::from_bytes(role.as_bytes()).unwrap(),
        );
        headers
    }

    async fn json_body(response: Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    fn write_body(name: &str, title: &str, body: &str) -> SkillCenterWriteBody {
        SkillCenterWriteBody {
            name: name.into(),
            title: title.into(),
            description: "说明".into(),
            body: body.into(),
            display_name: String::new(),
        }
    }

    #[test]
    fn upsert_version_inserts_or_replaces_the_frontmatter_line() {
        let inserted = upsert_version("---\nname: 甲\ndescription: 乙\n---\n\n# 正文\n", 1);
        assert!(inserted.contains("version: \"1\""));
        assert!(inserted.contains("# 正文"));
        let replaced = upsert_version(
            "---\nname: 甲\ndescription: 乙\nversion: \"1\"\n---\n\n# 正文\n",
            2,
        );
        assert!(replaced.contains("version: \"2\""));
        assert!(!replaced.contains("version: \"1\""));
    }

    #[tokio::test]
    async fn skill_ids_increment_and_are_not_reused() {
        let tmp = tempfile::TempDir::new().unwrap();
        let state = state_in(&tmp);
        let headers = headers("ops", ROLE_OPS);
        let first = handle_allocate_skill_id(State(state.clone()), headers.clone()).await;
        assert_eq!(first.status(), StatusCode::OK);
        assert_eq!(json_body(first).await["id"], "sk0001");
        let second = handle_allocate_skill_id(State(state.clone()), headers).await;
        assert_eq!(second.status(), StatusCode::OK);
        assert_eq!(json_body(second).await["id"], "sk0002");
        let stored = std::fs::read_to_string(tmp.path().join("shared").join("skill-seq")).unwrap();
        assert_eq!(stored.trim(), "2");
    }

    #[tokio::test]
    async fn skill_center_lifecycle_keeps_creator_version_and_plaza_projection() {
        let tmp = tempfile::TempDir::new().unwrap();
        let state = state_in(&tmp);
        let user = headers("alice", "普通用户");
        let old_role = headers("ops", "运维");
        let admin = headers("ops", ROLE_OPS);

        let denied = handle_list_skill_center(State(state.clone()), user.clone()).await;
        assert_eq!(denied.status(), StatusCode::FORBIDDEN);
        let retired = handle_list_skill_center(State(state.clone()), old_role).await;
        assert_eq!(
            retired.status(),
            StatusCode::FORBIDDEN,
            "the retired Chinese role is not an admin"
        );

        let created = handle_create_skill_center(
            State(state.clone()),
            admin.clone(),
            Json(SkillCenterWriteBody {
                display_name: "系统管理员".into(),
                ..write_body("sk-center", "中心技能", "# 一")
            }),
        )
        .await;
        assert_eq!(created.status(), StatusCode::CREATED);
        std::fs::create_dir_all(
            catalog_dir(state.config.read().deref(), "sk-center").join("scripts"),
        )
        .unwrap();
        std::fs::write(
            catalog_dir(state.config.read().deref(), "sk-center")
                .join("scripts")
                .join("compute.py"),
            "print(1)\n",
        )
        .unwrap();

        let early = handle_publish_skill_center(
            State(state.clone()),
            admin.clone(),
            AxumPath("sk-center".into()),
        )
        .await;
        assert_eq!(early.status(), StatusCode::CONFLICT);

        let submitted = handle_submit_skill_center(
            State(state.clone()),
            admin.clone(),
            AxumPath("sk-center".into()),
            Json(write_body("", "", "")),
        )
        .await;
        assert_eq!(submitted.status(), StatusCode::OK);
        let locked_pending = handle_update_skill_center(
            State(state.clone()),
            admin.clone(),
            AxumPath("sk-center".into()),
            Json(write_body("", "中心技能", "# 待审不能改")),
        )
        .await;
        assert_eq!(locked_pending.status(), StatusCode::CONFLICT);
        let approved = handle_review_skill_center(
            State(state.clone()),
            admin.clone(),
            AxumPath("sk-center".into()),
            Json(SkillCenterReviewBody {
                decision: "approve".into(),
                note: String::new(),
            }),
        )
        .await;
        assert_eq!(approved.status(), StatusCode::OK);
        let approved_json = json_body(approved).await;
        assert_eq!(approved_json["version"], 0);
        assert_eq!(approved_json["published_at"], "");
        assert!(!on_plaza(state.config.read().deref(), "sk-center"));
        let locked_approved = handle_update_skill_center(
            State(state.clone()),
            admin.clone(),
            AxumPath("sk-center".into()),
            Json(write_body("", "中心技能", "# 已通过不能改")),
        )
        .await;
        assert_eq!(locked_approved.status(), StatusCode::CONFLICT);
        let pulled = handle_review_skill_center(
            State(state.clone()),
            admin.clone(),
            AxumPath("sk-center".into()),
            Json(SkillCenterReviewBody {
                decision: "reject".into(),
                note: "先不发".into(),
            }),
        )
        .await;
        assert_eq!(pulled.status(), StatusCode::OK);
        assert_eq!(json_body(pulled).await["status"], "rejected");
        handle_submit_skill_center(
            State(state.clone()),
            admin.clone(),
            AxumPath("sk-center".into()),
            Json(write_body("", "", "")),
        )
        .await;
        handle_review_skill_center(
            State(state.clone()),
            admin.clone(),
            AxumPath("sk-center".into()),
            Json(SkillCenterReviewBody {
                decision: "approve".into(),
                note: String::new(),
            }),
        )
        .await;

        let published = handle_publish_skill_center(
            State(state.clone()),
            admin.clone(),
            AxumPath("sk-center".into()),
        )
        .await;
        assert_eq!(published.status(), StatusCode::OK);
        let published_json = json_body(published).await;
        assert_eq!(published_json["version"], 1);
        assert!(!published_json["published_at"].as_str().unwrap().is_empty());
        let plaza = handle_list_skill_plaza(State(state.clone()), user.clone()).await;
        let plaza_json = json_body(plaza).await;
        assert_eq!(plaza_json["skills"][0]["name"], "sk-center");
        assert_eq!(plaza_json["skills"][0]["creator_id"], "ops");
        assert_eq!(plaza_json["skills"][0]["creator_name"], "系统管理员");
        assert_eq!(
            plaza_json["skills"][0]["published_at"],
            published_json["published_at"]
        );
        assert!(
            std::fs::read_to_string(
                skill_plaza_dir(state.config.read().deref())
                    .join("sk-center")
                    .join("SKILL.md")
            )
            .unwrap()
            .contains("version: \"1\"")
        );

        let locked_published = handle_update_skill_center(
            State(state.clone()),
            admin.clone(),
            AxumPath("sk-center".into()),
            Json(write_body("", "中心技能", "# 已发布不能改")),
        )
        .await;
        assert_eq!(locked_published.status(), StatusCode::CONFLICT);
        assert!(
            std::fs::read_to_string(
                catalog_dir(state.config.read().deref(), "sk-center").join("SKILL.md")
            )
            .unwrap()
            .contains("# 一")
        );
        let taken_down = handle_unpublish_skill_center(
            State(state.clone()),
            admin.clone(),
            AxumPath("sk-center".into()),
        )
        .await;
        assert_eq!(taken_down.status(), StatusCode::OK);
        assert!(!on_plaza(state.config.read().deref(), "sk-center"));
        let edited = handle_update_skill_center(
            State(state.clone()),
            admin.clone(),
            AxumPath("sk-center".into()),
            Json(write_body("", "中心技能", "# 改过")),
        )
        .await;
        assert_eq!(edited.status(), StatusCode::OK);
        assert_eq!(json_body(edited).await["status"], "offline");
        assert!(
            std::fs::read_to_string(
                catalog_dir(state.config.read().deref(), "sk-center")
                    .join("scripts")
                    .join("compute.py")
            )
            .unwrap()
                == "print(1)\n"
        );
        let detail = handle_read_skill_center(
            State(state.clone()),
            admin.clone(),
            AxumPath("sk-center".into()),
        )
        .await;
        let detail_json = json_body(detail).await;
        assert_eq!(detail_json["creator_id"], "ops");
        assert_eq!(detail_json["version"], 1);
        assert!(!detail_json["on_plaza"].as_bool().unwrap());
        assert!(
            std::fs::read_to_string(
                catalog_dir(state.config.read().deref(), "sk-center").join("SKILL.md")
            )
            .unwrap()
            .contains("# 改过")
        );

        handle_submit_skill_center(
            State(state.clone()),
            admin.clone(),
            AxumPath("sk-center".into()),
            Json(write_body("", "", "")),
        )
        .await;
        handle_review_skill_center(
            State(state.clone()),
            admin.clone(),
            AxumPath("sk-center".into()),
            Json(SkillCenterReviewBody {
                decision: "approve".into(),
                note: String::new(),
            }),
        )
        .await;
        let again = handle_publish_skill_center(
            State(state.clone()),
            admin.clone(),
            AxumPath("sk-center".into()),
        )
        .await;
        assert_eq!(json_body(again).await["version"], 2);

        let rejected = handle_create_skill_center(
            State(state.clone()),
            admin.clone(),
            Json(write_body("sk-nope", "不上架", "# 驳回")),
        )
        .await;
        assert_eq!(rejected.status(), StatusCode::CREATED);
        handle_submit_skill_center(
            State(state.clone()),
            admin.clone(),
            AxumPath("sk-nope".into()),
            Json(write_body("", "", "")),
        )
        .await;
        let reject = handle_review_skill_center(
            State(state.clone()),
            admin.clone(),
            AxumPath("sk-nope".into()),
            Json(SkillCenterReviewBody {
                decision: "reject".into(),
                note: "口径不对".into(),
            }),
        )
        .await;
        assert_eq!(reject.status(), StatusCode::OK);
        assert!(!on_plaza(state.config.read().deref(), "sk-nope"));

        let removed = handle_unpublish_skill_center(
            State(state.clone()),
            admin.clone(),
            AxumPath("sk-center".into()),
        )
        .await;
        assert_eq!(removed.status(), StatusCode::OK);
        assert!(!on_plaza(state.config.read().deref(), "sk-center"));
        assert!(
            catalog_dir(state.config.read().deref(), "sk-center")
                .join("SKILL.md")
                .is_file()
        );
        let kept = json_body(
            handle_read_skill_center(
                State(state.clone()),
                admin.clone(),
                AxumPath("sk-center".into()),
            )
            .await,
        )
        .await;
        assert_eq!(kept["status"], "offline");
        assert_eq!(kept["releases"].as_array().unwrap().len(), 2);
        assert_eq!(kept["creator_id"], "ops");

        let legacy = skill_plaza_dir(state.config.read().deref()).join("sk-legacy");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(
            legacy.join("SKILL.md"),
            "---\nname: 旧技能\ndescription: 说明\nversion: \"4\"\n---\n\n# 旧\n",
        )
        .unwrap();
        let listed =
            json_body(handle_list_skill_center(State(state.clone()), admin.clone()).await).await;
        let legacy_row = listed["skills"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["id"] == "sk-legacy")
            .unwrap();
        assert_eq!(legacy_row["status"], "published");
        assert_eq!(legacy_row["creator_id"], "");
        assert_eq!(legacy_row["creator_name"], "");
        assert_eq!(legacy_row["version"], 4);
        assert_eq!(legacy_row["published_at"], "");
        let legacy_off = handle_unpublish_skill_center(
            State(state.clone()),
            admin.clone(),
            AxumPath("sk-legacy".into()),
        )
        .await;
        assert_eq!(legacy_off.status(), StatusCode::OK);
        let legacy_detail = json_body(
            handle_read_skill_center(State(state.clone()), admin, AxumPath("sk-legacy".into()))
                .await,
        )
        .await;
        assert_eq!(legacy_detail["creator_id"], "");
        assert_eq!(legacy_detail["version"], 4);

        let personal = handle_submit_personal_skill(
            State(state.clone()),
            user.clone(),
            AxumPath("sk-alice".into()),
            Json(PersonalSubmitBody {
                agent: "deepseek".into(),
                display_name: "爱丽丝".into(),
            }),
        )
        .await;
        assert_eq!(personal.status(), StatusCode::NOT_FOUND);
        let dir =
            personal_skills_dir(state.config.read().deref(), "alice", "deepseek").join("sk-alice");
        std::fs::create_dir_all(dir.join("scripts")).unwrap();
        std::fs::write(
            dir.join("SKILL.md"),
            "---\nname: 爱丽丝的技能\ndescription: 说明\n---\n\n# 个人\n",
        )
        .unwrap();
        std::fs::write(dir.join("scripts").join("run.py"), "print(2)\n").unwrap();
        let first = json_body(
            handle_submit_personal_skill(
                State(state.clone()),
                user.clone(),
                AxumPath("sk-alice".into()),
                Json(PersonalSubmitBody {
                    agent: "deepseek".into(),
                    display_name: "爱丽丝".into(),
                }),
            )
            .await,
        )
        .await;
        assert_eq!(first["creator_id"], "alice");
        assert_eq!(first["status"], "pending");
        assert!(!on_plaza(state.config.read().deref(), "sk-alice"));
        std::fs::write(
            dir.join("SKILL.md"),
            "---\nname: 爱丽丝的技能\ndescription: 说明\n---\n\n# 修订\n",
        )
        .unwrap();
        let blocked = handle_submit_personal_skill(
            State(state.clone()),
            user.clone(),
            AxumPath("sk-alice".into()),
            Json(PersonalSubmitBody {
                agent: "deepseek".into(),
                display_name: "别人".into(),
            }),
        )
        .await;
        assert_eq!(blocked.status(), StatusCode::CONFLICT);
        assert!(
            std::fs::read_to_string(
                catalog_dir(state.config.read().deref(), "sk-alice").join("SKILL.md")
            )
            .unwrap()
            .contains("# 个人")
        );
        let rejected = handle_review_skill_center(
            State(state.clone()),
            headers("ops", ROLE_OPS),
            AxumPath("sk-alice".into()),
            Json(SkillCenterReviewBody {
                decision: "reject".into(),
                note: "改一下".into(),
            }),
        )
        .await;
        assert_eq!(rejected.status(), StatusCode::OK);
        let second = json_body(
            handle_submit_personal_skill(
                State(state.clone()),
                user.clone(),
                AxumPath("sk-alice".into()),
                Json(PersonalSubmitBody {
                    agent: "deepseek".into(),
                    display_name: "别人".into(),
                }),
            )
            .await,
        )
        .await;
        assert_eq!(second["status"], "pending");
        assert_eq!(second["creator_id"], "alice");
        assert!(
            std::fs::read_to_string(
                catalog_dir(state.config.read().deref(), "sk-alice").join("SKILL.md")
            )
            .unwrap()
            .contains("# 修订")
        );
        assert!(
            catalog_dir(state.config.read().deref(), "sk-alice")
                .join("scripts")
                .join("run.py")
                .is_file()
        );

        handle_review_skill_center(
            State(state.clone()),
            headers("ops", ROLE_OPS),
            AxumPath("sk-alice".into()),
            Json(SkillCenterReviewBody {
                decision: "approve".into(),
                note: String::new(),
            }),
        )
        .await;
        let published_alice = handle_publish_skill_center(
            State(state.clone()),
            headers("ops", ROLE_OPS),
            AxumPath("sk-alice".into()),
        )
        .await;
        assert_eq!(published_alice.status(), StatusCode::OK);
        assert!(on_plaza(state.config.read().deref(), "sk-alice"));
        let still_editable = handle_write_personal_skill(
            State(state.clone()),
            user.clone(),
            AxumPath("sk-alice".into()),
            Json(PersonalSkillWriteBody {
                agent: "deepseek".into(),
                frontmatter: SkillFrontmatter {
                    name: "爱丽丝的技能".into(),
                    description: "说明".into(),
                    ..SkillFrontmatter::default()
                },
                body: "# 发布后仍可改".into(),
            }),
        )
        .await;
        assert_eq!(still_editable.status(), StatusCode::OK);
        let mine_after = json_body(
            handle_read_personal_skill(
                State(state.clone()),
                user.clone(),
                AxumPath("sk-alice".into()),
                Query(PersonalSkillQuery {
                    agent: "deepseek".into(),
                }),
            )
            .await,
        )
        .await;
        assert_eq!(mine_after["from_plaza"], false);
        assert!(
            mine_after["body"]
                .as_str()
                .unwrap()
                .contains("发布后仍可改")
        );
        let clobber = handle_install_plaza_skill(
            State(state.clone()),
            user.clone(),
            Json(InstallPlazaSkillBody {
                agent: "deepseek".into(),
                name: "sk-alice".into(),
                update: true,
            }),
        )
        .await;
        assert_eq!(clobber.status(), StatusCode::CONFLICT);
        assert!(
            std::fs::read_to_string(dir.join("SKILL.md"))
                .unwrap()
                .contains("发布后仍可改")
        );

        let installed = handle_install_plaza_skill(
            State(state.clone()),
            user.clone(),
            Json(InstallPlazaSkillBody {
                agent: "deepseek".into(),
                name: "sk-center".into(),
                update: false,
            }),
        )
        .await;
        assert_eq!(
            installed.status(),
            StatusCode::NOT_FOUND,
            "unpublished plaza skill is gone"
        );

        std::fs::create_dir_all(skill_plaza_dir(state.config.read().deref()).join("sk-live"))
            .unwrap();
        std::fs::write(
            skill_plaza_dir(state.config.read().deref())
                .join("sk-live")
                .join("SKILL.md"),
            "---\nname: 在架\ndescription: 说明\nversion: \"1\"\n---\n\n# 广场\n",
        )
        .unwrap();
        let copied = handle_install_plaza_skill(
            State(state.clone()),
            user.clone(),
            Json(InstallPlazaSkillBody {
                agent: "deepseek".into(),
                name: "sk-live".into(),
                update: false,
            }),
        )
        .await;
        assert_eq!(copied.status(), StatusCode::OK);
        let personal_live =
            personal_skills_dir(state.config.read().deref(), "alice", "deepseek").join("sk-live");
        assert!(personal_live.join(".from-plaza").is_file());
        std::fs::remove_file(personal_live.join(".from-plaza")).unwrap();
        let same_id = handle_write_personal_skill(
            State(state.clone()),
            user.clone(),
            AxumPath("sk-live".into()),
            Json(PersonalSkillWriteBody {
                agent: "deepseek".into(),
                frontmatter: SkillFrontmatter {
                    name: "在架".into(),
                    description: "说明".into(),
                    ..SkillFrontmatter::default()
                },
                body: "# 同名也不行".into(),
            }),
        )
        .await;
        assert_eq!(same_id.status(), StatusCode::FORBIDDEN);
        let locked = handle_write_personal_skill(
            State(state.clone()),
            user.clone(),
            AxumPath("sk-live".into()),
            Json(PersonalSkillWriteBody {
                agent: "deepseek".into(),
                frontmatter: SkillFrontmatter {
                    name: "在架".into(),
                    description: "说明".into(),
                    ..SkillFrontmatter::default()
                },
                body: "# 不行".into(),
            }),
        )
        .await;
        assert_eq!(locked.status(), StatusCode::FORBIDDEN);
        let locked_submit = handle_submit_personal_skill(
            State(state.clone()),
            user.clone(),
            AxumPath("sk-live".into()),
            Json(PersonalSubmitBody {
                agent: "deepseek".into(),
                display_name: "爱丽丝".into(),
            }),
        )
        .await;
        assert_eq!(locked_submit.status(), StatusCode::FORBIDDEN);
        let forked = handle_fork_personal_skill(
            State(state.clone()),
            user.clone(),
            AxumPath("sk-live".into()),
            Json(PersonalForkBody {
                agent: "deepseek".into(),
                name: "sk-live-mine".into(),
            }),
        )
        .await;
        assert_eq!(forked.status(), StatusCode::OK);
        let mine = personal_skills_dir(state.config.read().deref(), "alice", "deepseek")
            .join("sk-live-mine");
        assert!(!mine.join(".from-plaza").is_file());
        let editable = handle_write_personal_skill(
            State(state.clone()),
            user.clone(),
            AxumPath("sk-live-mine".into()),
            Json(PersonalSkillWriteBody {
                agent: "deepseek".into(),
                frontmatter: SkillFrontmatter {
                    name: "我的".into(),
                    description: "说明".into(),
                    ..SkillFrontmatter::default()
                },
                body: "# 可以".into(),
            }),
        )
        .await;
        assert_eq!(editable.status(), StatusCode::OK);
        let submitted_fork = json_body(
            handle_submit_personal_skill(
                State(state),
                user,
                AxumPath("sk-live-mine".into()),
                Json(PersonalSubmitBody {
                    agent: "deepseek".into(),
                    display_name: "爱丽丝".into(),
                }),
            )
            .await,
        )
        .await;
        assert_eq!(submitted_fork["creator_id"], "alice");
        assert_eq!(submitted_fork["status"], "pending");
    }

    #[tokio::test]
    async fn new_skill_ids_stay_unique_across_plaza_catalog_and_people() {
        let tmp = tempfile::TempDir::new().unwrap();
        let state = state_in(&tmp);
        let alice = headers("alice", "普通用户");
        let bob = headers("bob", "普通用户");
        let admin = headers("ops", ROLE_OPS);
        let plaza = skill_plaza_dir(state.config.read().deref()).join("sk-taken");
        std::fs::create_dir_all(&plaza).unwrap();
        std::fs::write(
            plaza.join("SKILL.md"),
            "---\nname: 已占用\ndescription: 说明\n---\n\n# 广场\n",
        )
        .unwrap();

        let save = |headers: HeaderMap, name: &str| {
            let state = state.clone();
            let name = name.to_string();
            async move {
                handle_save_personal_skill(
                    State(state),
                    headers,
                    Json(PersonalSkillBody {
                        agent: "deepseek".into(),
                        name,
                        frontmatter: SkillFrontmatter {
                            name: "标题".into(),
                            description: "说明".into(),
                            ..SkillFrontmatter::default()
                        },
                        body: "# 正文".into(),
                        files: Vec::new(),
                    }),
                )
                .await
            }
        };

        let plaza_hit = save(alice.clone(), "sk-taken").await;
        assert_eq!(plaza_hit.status(), StatusCode::CONFLICT);
        let created = save(alice.clone(), "sk-mine").await;
        assert_eq!(created.status(), StatusCode::CREATED);
        let again = save(alice.clone(), "sk-mine").await;
        assert_eq!(again.status(), StatusCode::CONFLICT);
        assert!(
            std::fs::read_to_string(
                personal_skills_dir(state.config.read().deref(), "alice", "deepseek")
                    .join("sk-mine")
                    .join("SKILL.md")
            )
            .unwrap()
            .contains("# 正文")
        );
        let other = save(bob, "sk-mine").await;
        assert_eq!(other.status(), StatusCode::CONFLICT);
        let center = handle_create_skill_center(
            State(state.clone()),
            admin,
            Json(SkillCenterWriteBody {
                name: "sk-mine".into(),
                title: "标题".into(),
                description: "说明".into(),
                body: "# 中心".into(),
                display_name: "系统管理员".into(),
            }),
        )
        .await;
        assert_eq!(center.status(), StatusCode::CONFLICT);

        let replaced = handle_save_personal_skill(
            State(state),
            alice,
            Json(PersonalSkillBody {
                agent: "deepseek".into(),
                name: "sk-mine".into(),
                frontmatter: SkillFrontmatter::default(),
                body: String::new(),
                files: vec![PersonalSkillPackageFile {
                    path: "SKILL.md".into(),
                    data_base64: base64::Engine::encode(
                        &base64::engine::general_purpose::STANDARD,
                        "---\nname: 标题\ndescription: 说明\n---\n\n# 导入\n",
                    ),
                }],
            }),
        )
        .await;
        assert_eq!(replaced.status(), StatusCode::CREATED);
    }
}
