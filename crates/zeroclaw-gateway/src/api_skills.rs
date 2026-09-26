//! HTTP adapter over `zeroclaw_runtime::skills::SkillsService`.

use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use zeroclaw_runtime::rpc::types::{
    AgentSkillEntry, AgentSkillsResult, DroppedSkillEntry, ShadowedSkillEntry, SkillBundleEntry,
    SkillListEntry, SkillsBundlesResult, SkillsListResult, SkillsReadResult,
};
use zeroclaw_runtime::skills::{
    DroppedSkill, EffectiveSkill, RemoveMode, ScaffoldOptions, ServiceError, SkillDropReason,
    SkillFrontmatter, SkillOrigin, SkillsService, SlashOptionKindDescriptor,
};

use super::AppState;
use super::trusted_proxy::require_ops_auth as require_auth;

// ── HTTP-specific request shapes (not shared) ───────────────────────

/// Response for `GET /api/skills/slash-option-kinds`: the canonical registry,
/// built by walking `SlashOptionKind::ALL`.
#[derive(Debug, Serialize)]
#[cfg_attr(feature = "schema-export", derive(schemars::JsonSchema))]
pub struct SlashOptionKindsResult {
    pub kinds: Vec<SlashOptionKindDescriptor>,
}

#[derive(Debug, Deserialize)]
pub struct SkillCreateBody {
    pub name: String,
    pub frontmatter: SkillFrontmatter,
    /// Initial markdown body. When empty, the service writes a default
    /// `# <Title>` heading derived from the skill name.
    #[serde(default)]
    pub body: String,
    /// Skip scaffolding the optional `scripts/`, `references/`, `assets/`
    /// subdirs. Defaults to `false` (create them).
    #[serde(default)]
    pub no_scaffold: bool,
}

#[derive(Debug, Deserialize)]
pub struct SkillWriteBody {
    pub frontmatter: SkillFrontmatter,
    #[serde(default)]
    pub body: String,
}

#[derive(Debug, Deserialize, Default)]
pub struct DeleteQuery {
    /// When `true`, hard-delete the skill instead of archiving. Defaults to
    /// `false` — same as `RemoveMode::Archive`.
    #[serde(default)]
    pub purge: bool,
}

// ── Handlers ────────────────────────────────────────────────────────

/// `GET /api/skills/slash-option-kinds` — the canonical typed-slash-option kind
/// registry (kind list + per-kind constraint capabilities), built by walking
/// `SlashOptionKind::ALL`. Surfaces read this instead of restating the kind set.
pub async fn handle_slash_option_kinds(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Response {
    if let Err(e) = require_auth(&state, &headers) {
        return e.into_response();
    }
    Json(SlashOptionKindsResult {
        kinds: zeroclaw_runtime::skills::slash_option_kinds(),
    })
    .into_response()
}

/// `GET /api/skills/bundles`
pub async fn handle_list_bundles(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(e) = require_auth(&state, &headers) {
        return e.into_response();
    }
    let config = state.config.read().clone();
    let install_root = config.install_root_dir();
    let service = SkillsService::new(&config, install_root);

    match service.list_bundles() {
        Ok(bundles) => Json(SkillsBundlesResult {
            bundles: bundles
                .into_iter()
                .map(|b| SkillBundleEntry {
                    alias: b.alias,
                    directory: b.directory.display().to_string(),
                    include: b.include,
                    exclude: b.exclude,
                })
                .collect(),
        })
        .into_response(),
        Err(e) => service_error_response(e),
    }
}

/// `GET /api/skills/bundles/:alias/skills`
pub async fn handle_list_skills(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(alias): Path<String>,
) -> Response {
    if let Err(e) = require_auth(&state, &headers) {
        return e.into_response();
    }
    let config = state.config.read().clone();
    let install_root = config.install_root_dir();
    let service = SkillsService::new(&config, install_root);

    match service.list_skills(Some(&alias)) {
        Ok(skills) => Json(SkillsListResult {
            skills: skills
                .into_iter()
                .map(|s| SkillListEntry {
                    bundle: s.r#ref.bundle().to_string(),
                    name: s.r#ref.name().to_string(),
                    directory: s.directory.display().to_string(),
                    frontmatter: s.frontmatter,
                })
                .collect(),
        })
        .into_response(),
        Err(e) => service_error_response(e),
    }
}

pub async fn handle_agent_skills(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(alias): Path<String>,
) -> Response {
    if let Err(e) = require_auth(&state, &headers) {
        return e.into_response();
    }
    // Plaza / 我的技能 write `user_workspace_dir`. Chat already loads that
    // tree because the WS turn scopes BFF identity; this list must too, or
    // the dashboard stays empty after a personal install.
    let frozen_user = super::trusted_proxy::frozen_bff_user(&state, &headers);
    let config = state.config.read().clone();
    let install_root = config.install_root_dir();
    let service = SkillsService::new(&config, install_root);

    let resolved = if let Some(attrs) = frozen_user {
        zeroclaw_runtime::agent::loop_::scope_user_attrs(Some(attrs), async {
            service.resolve_effective_skills(&alias)
        })
        .await
    } else {
        service.resolve_effective_skills(&alias)
    };

    match resolved {
        Ok(set) => Json(AgentSkillsResult {
            agent: alias,
            skills: set.skills.into_iter().map(agent_skill_entry).collect(),
            dropped: set.dropped.into_iter().map(dropped_skill_entry).collect(),
        })
        .into_response(),
        Err(e) => service_error_response(e),
    }
}

/// Map a runtime [`EffectiveSkill`] to its flat wire shape (`origin` string +
/// optional `plugin`/`bundle` detail). `editable`/`directory`/`shadowed` pass
/// through.
fn agent_skill_entry(s: EffectiveSkill) -> AgentSkillEntry {
    let (origin, plugin, bundle) = match s.origin {
        SkillOrigin::Workspace => ("workspace", None, None),
        SkillOrigin::OpenSkills => ("open-skills", None, None),
        SkillOrigin::Plugin(p) => ("plugin", Some(p), None),
        SkillOrigin::Bundle(a) => ("bundle", None, Some(a)),
    };
    AgentSkillEntry {
        name: s.name,
        description: s.description,
        origin: origin.to_string(),
        plugin,
        bundle,
        directory: s.directory.map(|d| d.display().to_string()),
        editable: s.editable,
        shadowed: s
            .shadowed
            .into_iter()
            .map(|sh| ShadowedSkillEntry {
                name: sh.name,
                origin: sh.origin_hint,
            })
            .collect(),
    }
}

/// Map a runtime [`DroppedSkill`] to its flat wire shape, splitting the
/// [`SkillDropReason`] enum into a `(reason_kind, reason)` string pair the
/// dashboard can group on without knowing the Rust enum.
fn dropped_skill_entry(d: DroppedSkill) -> DroppedSkillEntry {
    let (reason_kind, reason, scripts_blocked) = match d.reason {
        SkillDropReason::AuditFindings {
            summary,
            scripts_blocked,
        } => ("audit_findings", summary, scripts_blocked),
        SkillDropReason::AuditError(s) => ("audit_error", s, false),
        SkillDropReason::ManifestParseError(s) => ("manifest_parse_error", s, false),
    };
    DroppedSkillEntry {
        name: d.name,
        origin: d.origin_hint,
        reason_kind: reason_kind.to_string(),
        reason,
        scripts_blocked,
        directory: d.location.map(|p| p.display().to_string()),
    }
}

/// `POST /api/skills/bundles/:alias/skills`
pub async fn handle_create_skill(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(alias): Path<String>,
    Json(body): Json<SkillCreateBody>,
) -> Response {
    if let Err(e) = require_auth(&state, &headers) {
        return e.into_response();
    }
    let config = state.config.read().clone();
    let install_root = config.install_root_dir();
    let service = SkillsService::new(&config, install_root);

    let target = match service.resolve_ref(&body.name, Some(&alias)) {
        Ok(r) => r,
        Err(e) => return service_error_response(e),
    };
    match service.scaffold_skill(
        &target,
        body.frontmatter,
        ScaffoldOptions {
            create_optional_subdirs: !body.no_scaffold,
            body: body.body,
        },
    ) {
        Ok(path) => (
            StatusCode::CREATED,
            Json(serde_json::json!({
                "bundle": target.bundle(),
                "name": target.name(),
                "directory": path.display().to_string(),
            })),
        )
            .into_response(),
        Err(e) => service_error_response(e),
    }
}

/// `GET /api/skills/bundles/:alias/skills/:name`
pub async fn handle_read_skill(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((alias, name)): Path<(String, String)>,
) -> Response {
    if let Err(e) = require_auth(&state, &headers) {
        return e.into_response();
    }
    let config = state.config.read().clone();
    let install_root = config.install_root_dir();
    let service = SkillsService::new(&config, install_root);

    let target = match service.resolve_ref(&name, Some(&alias)) {
        Ok(r) => r,
        Err(e) => return service_error_response(e),
    };
    match service.read_skill(&target) {
        Ok(doc) => Json(SkillsReadResult {
            bundle: target.bundle().to_string(),
            name: target.name().to_string(),
            frontmatter: doc.frontmatter,
            body: doc.body,
        })
        .into_response(),
        Err(e) => service_error_response(e),
    }
}

/// `PUT /api/skills/bundles/:alias/skills/:name`
pub async fn handle_write_skill(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((alias, name)): Path<(String, String)>,
    Json(body): Json<SkillWriteBody>,
) -> Response {
    if let Err(e) = require_auth(&state, &headers) {
        return e.into_response();
    }
    let config = state.config.read().clone();
    let install_root = config.install_root_dir();
    let service = SkillsService::new(&config, install_root);

    let target = match service.resolve_ref(&name, Some(&alias)) {
        Ok(r) => r,
        Err(e) => return service_error_response(e),
    };
    let doc = zeroclaw_runtime::skills::SkillDocument {
        frontmatter: body.frontmatter,
        body: body.body,
    };
    match service.write_skill(&target, &doc) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => service_error_response(e),
    }
}

/// `DELETE /api/skills/bundles/:alias/skills/:name?purge=true`
pub async fn handle_delete_skill(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((alias, name)): Path<(String, String)>,
    axum::extract::Query(q): axum::extract::Query<DeleteQuery>,
) -> Response {
    if let Err(e) = require_auth(&state, &headers) {
        return e.into_response();
    }
    let config = state.config.read().clone();
    let install_root = config.install_root_dir();
    let service = SkillsService::new(&config, install_root);

    let target = match service.resolve_ref(&name, Some(&alias)) {
        Ok(r) => r,
        Err(e) => return service_error_response(e),
    };
    let mode = if q.purge {
        RemoveMode::Purge
    } else {
        RemoveMode::Archive
    };
    match service.remove_skill(&target, mode) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => service_error_response(e),
    }
}

#[derive(Deserialize)]
pub struct PersonalSkillPackageFile {
    pub path: String,
    pub data_base64: String,
}

#[derive(Deserialize)]
pub struct PersonalSkillBody {
    pub agent: String,
    pub name: String,
    #[serde(default)]
    pub frontmatter: SkillFrontmatter,
    #[serde(default)]
    pub body: String,
    /// Original package files, including `SKILL.md`. Empty for the create form.
    #[serde(default)]
    pub files: Vec<PersonalSkillPackageFile>,
}

#[derive(Deserialize)]
pub struct PersonalSkillQuery {
    pub agent: String,
}

#[derive(Deserialize)]
pub struct PersonalSkillWriteBody {
    pub agent: String,
    #[serde(default)]
    pub frontmatter: SkillFrontmatter,
    #[serde(default)]
    pub body: String,
}

pub(crate) fn require_personal_user(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<zeroclaw_api::UserAttrs, Response> {
    match crate::trusted_proxy::require_user_principal(state, headers) {
        Ok((_, Some(attrs))) => Ok(attrs),
        Ok((_, None)) => Err((
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "error": "Forbidden — personal skills require a BFF user identity"
            })),
        )
            .into_response()),
        Err(e) => Err(e.into_response()),
    }
}

pub(crate) fn require_agent(agent: &str) -> Result<&str, Response> {
    let agent = agent.trim();
    if agent.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "agent is required"})),
        )
            .into_response());
    }
    Ok(agent)
}

pub(crate) fn require_skill_name(raw: &str) -> Result<String, Response> {
    match zeroclaw_api::normalize_user_id(raw.trim()) {
        Ok(n) => Ok(n),
        Err(_) => Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "invalid skill name"})),
        )
            .into_response()),
    }
}

pub(crate) fn personal_skills_dir(
    config: &zeroclaw_config::schema::Config,
    user_id: &str,
    agent: &str,
) -> std::path::PathBuf {
    config.user_workspace_dir(user_id, agent).join("skills")
}

pub(crate) fn write_personal_skill_file(
    dir: &std::path::Path,
    name: &str,
    mut fm: SkillFrontmatter,
    body: String,
) -> Result<String, Response> {
    if let Err(e) = std::fs::create_dir_all(dir) {
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Failed to create skill directory: {e}")})),
        )
            .into_response());
    }
    if fm.name.trim().is_empty() {
        fm.name = name.to_string();
    }
    let description = if fm.description.trim().is_empty() {
        fm.name.clone()
    } else {
        fm.description.replace('\n', " ")
    };
    let body_md = if body.trim().is_empty() {
        format!("# {}\n", fm.name)
    } else {
        body
    };
    let markdown = format!(
        "---\nname: {}\ndescription: {}\n---\n\n{body_md}",
        fm.name, description
    );
    if let Err(e) = std::fs::write(dir.join("SKILL.md"), markdown) {
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Failed to write SKILL.md: {e}")})),
        )
            .into_response());
    }
    zeroclaw_runtime::skills::cache::invalidate();
    Ok(fm.name)
}

const MAX_SKILL_PACKAGE_FILES: usize = 512;
const MAX_SKILL_PACKAGE_FILE_BYTES: usize = 1024 * 1024;
const MAX_SKILL_PACKAGE_BYTES: usize = 8 * 1024 * 1024;

fn write_skill_package(
    dir: &std::path::Path,
    files: &[PersonalSkillPackageFile],
) -> Result<(), Response> {
    if files.is_empty() || files.len() > MAX_SKILL_PACKAGE_FILES {
        return Err(skill_package_error(
            StatusCode::BAD_REQUEST,
            "invalid skill package",
        ));
    }
    let mut decoded = Vec::with_capacity(files.len());
    let mut total = 0usize;
    let mut skill_md = None;
    for file in files {
        let rel = match skill_package_rel(&file.path) {
            Some(path) => path,
            None => {
                return Err(skill_package_error(
                    StatusCode::BAD_REQUEST,
                    "invalid skill file path",
                ));
            }
        };
        let bytes = match base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            file.data_base64.trim(),
        ) {
            Ok(bytes) => bytes,
            Err(_) => {
                return Err(skill_package_error(
                    StatusCode::BAD_REQUEST,
                    "invalid skill file",
                ));
            }
        };
        if bytes.len() > MAX_SKILL_PACKAGE_FILE_BYTES {
            return Err(skill_package_error(
                StatusCode::BAD_REQUEST,
                "skill file is too large",
            ));
        }
        total = total.saturating_add(bytes.len());
        if total > MAX_SKILL_PACKAGE_BYTES {
            return Err(skill_package_error(
                StatusCode::BAD_REQUEST,
                "skill package is too large",
            ));
        }
        if rel == std::path::Path::new("SKILL.md") {
            skill_md = Some(bytes.clone());
        }
        decoded.push((rel, bytes));
    }
    let Some(skill_md) = skill_md else {
        return Err(skill_package_error(
            StatusCode::BAD_REQUEST,
            "SKILL.md is required",
        ));
    };
    let text = match String::from_utf8(skill_md) {
        Ok(text) => text,
        Err(_) => {
            return Err(skill_package_error(
                StatusCode::BAD_REQUEST,
                "SKILL.md must be UTF-8",
            ));
        }
    };
    if zeroclaw_runtime::skills::document::SkillDocument::parse(&text).is_err() {
        return Err(skill_package_error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "SKILL.md must include YAML name and description",
        ));
    }
    if let Err(error) = clear_skill_dir_except_disabled(dir) {
        return Err(skill_package_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("Failed to prepare skill directory: {error}"),
        ));
    }
    for (rel, bytes) in decoded {
        let dest = dir.join(&rel);
        if !dest.starts_with(dir) {
            return Err(skill_package_error(
                StatusCode::BAD_REQUEST,
                "invalid skill file path",
            ));
        }
        if let Some(parent) = dest.parent() {
            if let Err(error) = std::fs::create_dir_all(parent) {
                return Err(skill_package_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    &format!("Failed to create skill directory: {error}"),
                ));
            }
        }
        if let Err(error) = std::fs::write(&dest, bytes) {
            return Err(skill_package_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("Failed to write skill file: {error}"),
            ));
        }
    }
    zeroclaw_runtime::skills::cache::invalidate();
    Ok(())
}

fn skill_package_rel(raw: &str) -> Option<std::path::PathBuf> {
    let slash = raw.replace('\\', "/");
    if slash.starts_with('/') || slash.contains(':') {
        return None;
    }
    let mut out = std::path::PathBuf::new();
    for part in slash.split('/') {
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.contains('\0')
            || part == ".disabled"
        {
            return None;
        }
        out.push(part);
    }
    if out.as_os_str().is_empty() {
        None
    } else {
        Some(out)
    }
}

fn clear_skill_dir_except_disabled(dir: &std::path::Path) -> std::io::Result<()> {
    if !dir.exists() {
        return std::fs::create_dir_all(dir);
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        if name == ".disabled" || name == ".from-plaza" {
            continue;
        }
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_symlink() || !file_type.is_dir() {
            std::fs::remove_file(&path)?;
        } else {
            std::fs::remove_dir_all(&path)?;
        }
    }
    Ok(())
}

fn skill_package_error(status: StatusCode, message: &str) -> Response {
    (status, Json(serde_json::json!({ "error": message }))).into_response()
}

/// `POST /api/user/skills` — any frozen BFF user; writes that caller's workspace.
pub async fn handle_save_personal_skill(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PersonalSkillBody>,
) -> Response {
    let attrs = match require_personal_user(&state, &headers) {
        Ok(attrs) => attrs,
        Err(resp) => return resp,
    };
    let name = match require_skill_name(&body.name) {
        Ok(n) => n,
        Err(resp) => return resp,
    };
    let agent = match require_agent(&body.agent) {
        Ok(a) => a.to_string(),
        Err(resp) => return resp,
    };
    let config = state.config.read().clone();
    let dir = personal_skills_dir(&config, &attrs.user_id, &agent).join(&name);
    let reimport = !body.files.is_empty()
        && dir.join("SKILL.md").is_file()
        && !crate::api_skill_center::is_plaza_copy(&config, &dir, &name, &attrs.user_id);
    if !reimport
        && (crate::api_skill_center::user_has_skill(&config, &attrs.user_id, &name)
            || crate::api_skill_center::platform_skill_id_occupied(&config, &name)
            || crate::api_skill_center::personal_original_owner(&config, &name).is_some())
    {
        let message = if crate::api_skill_center::user_has_skill(&config, &attrs.user_id, &name) {
            "you already have this skill id"
        } else {
            "skill id is already used"
        };
        return (
            StatusCode::CONFLICT,
            Json(serde_json::json!({ "error": message })),
        )
            .into_response();
    }
    let written = if body.files.is_empty() {
        match write_personal_skill_file(&dir, &name, body.frontmatter, body.body) {
            Ok(n) => n,
            Err(resp) => return resp,
        }
    } else {
        match write_skill_package(&dir, &body.files) {
            Ok(()) => name.clone(),
            Err(resp) => return resp,
        }
    };
    (
        StatusCode::CREATED,
        Json(serde_json::json!({
            "name": written,
            "directory": dir.display().to_string(),
        })),
    )
        .into_response()
}

/// `GET /api/user/skills?agent=` — list the caller's personal skills.
pub async fn handle_list_personal_skills(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<PersonalSkillQuery>,
) -> Response {
    let attrs = match require_personal_user(&state, &headers) {
        Ok(attrs) => attrs,
        Err(resp) => return resp,
    };
    let agent = match require_agent(&query.agent) {
        Ok(a) => a,
        Err(resp) => return resp,
    };
    let config = state.config.read().clone();
    let root = personal_skills_dir(&config, &attrs.user_id, agent);
    let mut skills = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if zeroclaw_api::normalize_user_id(name).is_err() {
                continue;
            }
            let md = path.join("SKILL.md");
            let Ok(content) = std::fs::read_to_string(&md) else {
                continue;
            };
            let (description, title, version) =
                match zeroclaw_runtime::skills::document::SkillDocument::parse(&content) {
                    Ok(doc) => (
                        doc.frontmatter.description,
                        if doc.frontmatter.name.trim().is_empty() {
                            name.to_string()
                        } else {
                            doc.frontmatter.name
                        },
                        doc.frontmatter.version.unwrap_or_default(),
                    ),
                    Err(_) => (String::new(), name.to_string(), String::new()),
                };
            let blocked_reason = personal_skill_block_reason(&path, config.skills.allow_scripts);
            skills.push(serde_json::json!({
                "name": name,
                "title": title,
                "description": description,
                "version": version,
                "enabled": zeroclaw_runtime::skills::skill_directory_enabled(&path),
                "blocked_reason": blocked_reason,
                "from_plaza": crate::api_skill_center::is_plaza_copy(
                    &config,
                    &path,
                    name,
                    &attrs.user_id,
                ),
                "review_status": crate::api_skill_center::review_status_for_submitter(
                    &config,
                    &attrs.user_id,
                    name,
                ),
            }));
        }
    }
    skills.sort_by(|a, b| {
        a["name"]
            .as_str()
            .unwrap_or_default()
            .cmp(b["name"].as_str().unwrap_or_default())
    });
    Json(serde_json::json!({ "skills": skills })).into_response()
}

/// `GET /api/user/skills/{name}?agent=`
pub async fn handle_read_personal_skill(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Query(query): Query<PersonalSkillQuery>,
) -> Response {
    let attrs = match require_personal_user(&state, &headers) {
        Ok(attrs) => attrs,
        Err(resp) => return resp,
    };
    let name = match require_skill_name(&name) {
        Ok(n) => n,
        Err(resp) => return resp,
    };
    let agent = match require_agent(&query.agent) {
        Ok(a) => a,
        Err(resp) => return resp,
    };
    let config = state.config.read().clone();
    let dir = personal_skills_dir(&config, &attrs.user_id, agent).join(&name);
    let path = dir.join("SKILL.md");
    let Ok(content) = std::fs::read_to_string(&path) else {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "skill not found"})),
        )
            .into_response();
    };
    match zeroclaw_runtime::skills::document::SkillDocument::parse(&content) {
        Ok(doc) => Json(serde_json::json!({
            "name": name,
            "title": doc.frontmatter.name,
            "description": doc.frontmatter.description,
            "body": doc.body,
            "enabled": zeroclaw_runtime::skills::skill_directory_enabled(&dir),
            "from_plaza": crate::api_skill_center::is_plaza_copy(
                &config,
                &dir,
                &name,
                &attrs.user_id,
            ),
            "review_status": crate::api_skill_center::review_status_for_submitter(
                &config,
                &attrs.user_id,
                &name,
            ),
        }))
        .into_response(),
        Err(e) => (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(serde_json::json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}

/// `PUT /api/user/skills/{name}` — overwrite the caller's skill.
pub async fn handle_write_personal_skill(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(body): Json<PersonalSkillWriteBody>,
) -> Response {
    let attrs = match require_personal_user(&state, &headers) {
        Ok(attrs) => attrs,
        Err(resp) => return resp,
    };
    let name = match require_skill_name(&name) {
        Ok(n) => n,
        Err(resp) => return resp,
    };
    let agent = match require_agent(&body.agent) {
        Ok(a) => a.to_string(),
        Err(resp) => return resp,
    };
    let config = state.config.read().clone();
    let dir = personal_skills_dir(&config, &attrs.user_id, &agent).join(&name);
    if !dir.join("SKILL.md").exists() {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "skill not found"})),
        )
            .into_response();
    }
    if crate::api_skill_center::is_plaza_copy(&config, &dir, &name, &attrs.user_id) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "error": "plaza copies are read-only; fork the skill before editing"
            })),
        )
            .into_response();
    }
    let written = match write_personal_skill_file(&dir, &name, body.frontmatter, body.body) {
        Ok(n) => n,
        Err(resp) => return resp,
    };
    Json(serde_json::json!({
        "name": written,
        "directory": dir.display().to_string(),
    }))
    .into_response()
}

/// `DELETE /api/user/skills/{name}?agent=`
pub async fn handle_delete_personal_skill(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Query(query): Query<PersonalSkillQuery>,
) -> Response {
    let attrs = match require_personal_user(&state, &headers) {
        Ok(attrs) => attrs,
        Err(resp) => return resp,
    };
    let name = match require_skill_name(&name) {
        Ok(n) => n,
        Err(resp) => return resp,
    };
    let agent = match require_agent(&query.agent) {
        Ok(a) => a,
        Err(resp) => return resp,
    };
    let config = state.config.read().clone();
    let dir = personal_skills_dir(&config, &attrs.user_id, agent).join(&name);
    if !dir.exists() {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "skill not found"})),
        )
            .into_response();
    }
    if let Err(e) = std::fs::remove_dir_all(&dir) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Failed to delete skill: {e}")})),
        )
            .into_response();
    }
    zeroclaw_runtime::skills::cache::invalidate();
    StatusCode::NO_CONTENT.into_response()
}

#[derive(Deserialize)]
pub struct PersonalSkillEnabledBody {
    pub agent: String,
    pub enabled: bool,
}

/// `PATCH /api/user/skills/{name}/enabled` — keep the skill, skip it next turn.
pub async fn handle_set_personal_skill_enabled(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(body): Json<PersonalSkillEnabledBody>,
) -> Response {
    let attrs = match require_personal_user(&state, &headers) {
        Ok(attrs) => attrs,
        Err(resp) => return resp,
    };
    let name = match require_skill_name(&name) {
        Ok(n) => n,
        Err(resp) => return resp,
    };
    let agent = match require_agent(&body.agent) {
        Ok(a) => a,
        Err(resp) => return resp,
    };
    let config = state.config.read().clone();
    let dir = personal_skills_dir(&config, &attrs.user_id, agent).join(&name);
    if !dir.join("SKILL.md").exists() {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "skill not found"})),
        )
            .into_response();
    }
    let marker = dir.join(zeroclaw_runtime::skills::SKILL_DISABLED_MARKER);
    let result = if body.enabled {
        if marker.exists() {
            std::fs::remove_file(&marker)
        } else {
            Ok(())
        }
    } else {
        std::fs::write(&marker, "")
    };
    if let Err(e) = result {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Failed to update skill: {e}")})),
        )
            .into_response();
    }
    zeroclaw_runtime::skills::cache::invalidate();
    Json(serde_json::json!({
        "name": name,
        "enabled": body.enabled,
    }))
    .into_response()
}

pub(crate) fn skill_plaza_dir(config: &zeroclaw_config::schema::Config) -> std::path::PathBuf {
    config.install_root_dir().join("shared").join("skill-plaza")
}

#[derive(Deserialize)]
pub struct SkillFileQuery {
    #[serde(default)]
    pub path: String,
}

#[derive(Deserialize)]
pub struct PersonalSkillFileQuery {
    pub agent: String,
    #[serde(default)]
    pub path: String,
}

fn rel_to_slash(rel: &std::path::Path) -> String {
    rel.components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

/// Regular files under a skill directory. Symlinks are omitted so a preview
/// cannot follow a link outside the skill.
fn list_skill_files(root: &std::path::Path) -> Result<Vec<String>, Response> {
    fn walk(
        root: &std::path::Path,
        current: &std::path::Path,
        files: &mut Vec<String>,
    ) -> Result<(), Response> {
        let entries = std::fs::read_dir(current).map_err(|error| {
            skill_package_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("Failed to read skill directory: {error}"),
            )
        })?;
        for entry in entries {
            let entry = entry.map_err(|error| {
                skill_package_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    &format!("Failed to read skill directory: {error}"),
                )
            })?;
            let name = entry.file_name();
            if name == ".disabled" || name == ".DS_Store" || name == "__MACOSX" {
                continue;
            }
            let file_type = entry.file_type().map_err(|error| {
                skill_package_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    &format!("Failed to read skill file: {error}"),
                )
            })?;
            if file_type.is_symlink() {
                continue;
            }
            let path = entry.path();
            if file_type.is_dir() {
                walk(root, &path, files)?;
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let rel = path.strip_prefix(root).map_err(|_| {
                skill_package_error(StatusCode::BAD_REQUEST, "invalid skill file path")
            })?;
            if files.len() >= MAX_SKILL_PACKAGE_FILES {
                return Err(skill_package_error(
                    StatusCode::BAD_REQUEST,
                    "skill package is too large",
                ));
            }
            files.push(rel_to_slash(rel));
        }
        Ok(())
    }
    let mut files = Vec::new();
    walk(root, root, &mut files)?;
    files.sort();
    Ok(files)
}

fn read_skill_file(root: &std::path::Path, raw_path: &str) -> Response {
    let Some(rel) = skill_package_rel(raw_path) else {
        return skill_package_error(StatusCode::BAD_REQUEST, "invalid skill file path");
    };
    let path = root.join(&rel);
    if !path.starts_with(root) {
        return skill_package_error(StatusCode::BAD_REQUEST, "invalid skill file path");
    }
    let meta = match std::fs::symlink_metadata(&path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "skill file not found"})),
            )
                .into_response();
        }
        Err(error) => {
            return skill_package_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("Failed to read skill file: {error}"),
            );
        }
    };
    if meta.file_type().is_symlink() || !meta.is_file() {
        return skill_package_error(StatusCode::BAD_REQUEST, "invalid skill file path");
    }
    if meta.len() > MAX_SKILL_PACKAGE_FILE_BYTES as u64 {
        return skill_package_error(StatusCode::PAYLOAD_TOO_LARGE, "skill file is too large");
    }
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) => {
            return skill_package_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("Failed to read skill file: {error}"),
            );
        }
    };
    let display = rel_to_slash(&rel);
    match String::from_utf8(bytes) {
        Ok(content) => Json(serde_json::json!({
            "path": display,
            "content": content,
            "binary": false,
        }))
        .into_response(),
        Err(_) => Json(serde_json::json!({
            "path": display,
            "binary": true,
        }))
        .into_response(),
    }
}

pub(crate) fn respond_skill_files(root: &std::path::Path, raw_path: &str) -> Response {
    if !root.join("SKILL.md").is_file() {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "skill not found"})),
        )
            .into_response();
    }
    let raw_path = raw_path.trim();
    if raw_path.is_empty() {
        return match list_skill_files(root) {
            Ok(files) => Json(serde_json::json!({ "files": files })).into_response(),
            Err(resp) => resp,
        };
    }
    read_skill_file(root, raw_path)
}

/// `GET /api/skill-plaza/{name}/files` — list or read one plaza skill file.
pub async fn handle_read_plaza_skill_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Query(query): Query<SkillFileQuery>,
) -> Response {
    if let Err(resp) = require_personal_user(&state, &headers) {
        return resp;
    }
    let name = match require_skill_name(&name) {
        Ok(n) => n,
        Err(resp) => return resp,
    };
    let config = state.config.read().clone();
    respond_skill_files(&skill_plaza_dir(&config).join(&name), &query.path)
}

/// `GET /api/user/skills/{name}/files?agent=` — list or read one personal skill file.
pub async fn handle_read_personal_skill_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Query(query): Query<PersonalSkillFileQuery>,
) -> Response {
    let attrs = match require_personal_user(&state, &headers) {
        Ok(attrs) => attrs,
        Err(resp) => return resp,
    };
    let name = match require_skill_name(&name) {
        Ok(n) => n,
        Err(resp) => return resp,
    };
    let agent = match require_agent(&query.agent) {
        Ok(a) => a,
        Err(resp) => return resp,
    };
    let config = state.config.read().clone();
    let dir = personal_skills_dir(&config, &attrs.user_id, agent).join(&name);
    respond_skill_files(&dir, &query.path)
}

fn read_plaza_skill(
    config: &zeroclaw_config::schema::Config,
    dir: &std::path::Path,
    name: &str,
) -> Option<serde_json::Value> {
    let content = std::fs::read_to_string(dir.join("SKILL.md")).ok()?;
    let doc = zeroclaw_runtime::skills::document::SkillDocument::parse(&content).ok()?;
    let title = if doc.frontmatter.name.trim().is_empty() {
        name.to_string()
    } else {
        doc.frontmatter.name
    };
    let (creator_id, creator_name) = crate::api_skill_center::plaza_creator(config, name);
    Some(serde_json::json!({
        "name": name,
        "title": title,
        "description": doc.frontmatter.description,
        "version": doc.frontmatter.version.unwrap_or_default(),
        "published_at": crate::api_skill_center::plaza_published_at(config, name),
        "body": doc.body,
        "creator_id": creator_id,
        "creator_name": creator_name,
    }))
}

#[derive(Deserialize)]
pub struct InstallPlazaSkillBody {
    pub agent: String,
    pub name: String,
    #[serde(default)]
    pub update: bool,
}

fn personal_skill_block_reason(dir: &std::path::Path, allow_scripts: bool) -> String {
    match zeroclaw_runtime::skills::audit::audit_skill_directory_with_options(
        dir,
        zeroclaw_runtime::skills::audit::SkillAuditOptions { allow_scripts },
    ) {
        Ok(report) if report.is_clean() => String::new(),
        Ok(report) => report.summary(),
        Err(err) => err.to_string(),
    }
}

fn skill_version(dir: &std::path::Path) -> String {
    let Ok(content) = std::fs::read_to_string(dir.join("SKILL.md")) else {
        return String::new();
    };
    zeroclaw_runtime::skills::document::SkillDocument::parse(&content)
        .ok()
        .and_then(|doc| doc.frontmatter.version)
        .unwrap_or_default()
}

/// Files under a plaza skill, relative to the skill directory. Symlinks and
/// paths outside the directory are rejected before any personal copy is written.
fn collect_plaza_files(root: &std::path::Path) -> Result<Vec<std::path::PathBuf>, Response> {
    let mut files = Vec::new();
    let mut total = 0usize;
    fn walk(
        root: &std::path::Path,
        current: &std::path::Path,
        files: &mut Vec<std::path::PathBuf>,
        total: &mut usize,
    ) -> Result<(), Response> {
        let entries = std::fs::read_dir(current).map_err(|error| {
            skill_package_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("Failed to read skill directory: {error}"),
            )
        })?;
        for entry in entries {
            let entry = entry.map_err(|error| {
                skill_package_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    &format!("Failed to read skill directory: {error}"),
                )
            })?;
            let name = entry.file_name();
            if name == ".disabled" || name == ".DS_Store" || name == "__MACOSX" {
                continue;
            }
            let path = entry.path();
            let file_type = entry.file_type().map_err(|error| {
                skill_package_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    &format!("Failed to read skill file: {error}"),
                )
            })?;
            if file_type.is_symlink() {
                return Err(skill_package_error(
                    StatusCode::BAD_REQUEST,
                    "skill package contains a symlink",
                ));
            }
            if file_type.is_dir() {
                walk(root, &path, files, total)?;
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let rel = path.strip_prefix(root).map_err(|_| {
                skill_package_error(StatusCode::BAD_REQUEST, "invalid skill file path")
            })?;
            let len = entry
                .metadata()
                .map(|meta| meta.len() as usize)
                .unwrap_or(0);
            if len > MAX_SKILL_PACKAGE_FILE_BYTES {
                return Err(skill_package_error(
                    StatusCode::BAD_REQUEST,
                    "skill file is too large",
                ));
            }
            *total = total.saturating_add(len);
            if *total > MAX_SKILL_PACKAGE_BYTES || files.len() >= MAX_SKILL_PACKAGE_FILES {
                return Err(skill_package_error(
                    StatusCode::BAD_REQUEST,
                    "skill package is too large",
                ));
            }
            files.push(rel.to_path_buf());
        }
        Ok(())
    }
    walk(root, root, &mut files, &mut total)?;
    if !files
        .iter()
        .any(|path| path == std::path::Path::new("SKILL.md"))
    {
        return Err(skill_package_error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "SKILL.md is required",
        ));
    }
    Ok(files)
}

fn copy_plaza_files(
    src: &std::path::Path,
    dest: &std::path::Path,
    files: &[std::path::PathBuf],
) -> Result<(), Response> {
    if let Err(error) = clear_skill_dir_except_disabled(dest) {
        return Err(skill_package_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("Failed to prepare skill directory: {error}"),
        ));
    }
    for rel in files {
        let from = src.join(rel);
        let to = dest.join(rel);
        if !to.starts_with(dest) {
            return Err(skill_package_error(
                StatusCode::BAD_REQUEST,
                "invalid skill file path",
            ));
        }
        if let Some(parent) = to.parent() {
            if let Err(error) = std::fs::create_dir_all(parent) {
                return Err(skill_package_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    &format!("Failed to create skill directory: {error}"),
                ));
            }
        }
        if let Err(error) = std::fs::copy(&from, &to) {
            return Err(skill_package_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("Failed to copy skill file: {error}"),
            ));
        }
    }
    zeroclaw_runtime::skills::cache::invalidate();
    Ok(())
}

/// `POST /api/user/skills/from-plaza` — copy one plaza directory into the caller's skills.
/// An existing personal copy stays until `update` is true. `.disabled` is kept.
pub async fn handle_install_plaza_skill(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<InstallPlazaSkillBody>,
) -> Response {
    let attrs = match require_personal_user(&state, &headers) {
        Ok(attrs) => attrs,
        Err(resp) => return resp,
    };
    let name = match require_skill_name(&body.name) {
        Ok(n) => n,
        Err(resp) => return resp,
    };
    let agent = match require_agent(&body.agent) {
        Ok(a) => a,
        Err(resp) => return resp,
    };
    let config = state.config.read().clone();
    let src = skill_plaza_dir(&config).join(&name);
    if !src.join("SKILL.md").is_file() {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "skill not found"})),
        )
            .into_response();
    }
    let plaza_text = match std::fs::read_to_string(src.join("SKILL.md")) {
        Ok(text) => text,
        Err(error) => {
            return skill_package_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("Failed to read skill: {error}"),
            );
        }
    };
    if zeroclaw_runtime::skills::document::SkillDocument::parse(&plaza_text).is_err() {
        return skill_package_error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "SKILL.md must include YAML name and description",
        );
    }
    let files = match collect_plaza_files(&src) {
        Ok(files) => files,
        Err(resp) => return resp,
    };
    let dest = personal_skills_dir(&config, &attrs.user_id, agent).join(&name);
    if dest.join("SKILL.md").is_file()
        && !crate::api_skill_center::is_plaza_copy(&config, &dest, &name, &attrs.user_id)
    {
        return (
            StatusCode::CONFLICT,
            Json(serde_json::json!({
                "error": "this skill is your own copy, not a plaza install",
            })),
        )
            .into_response();
    }
    if dest.join("SKILL.md").is_file() && !body.update {
        return (
            StatusCode::CONFLICT,
            Json(serde_json::json!({
                "error": "already_installed",
                "installed_version": skill_version(&dest),
                "plaza_version": skill_version(&src),
            })),
        )
            .into_response();
    }
    if let Err(resp) = copy_plaza_files(&src, &dest, &files) {
        return resp;
    }
    if let Err(error) = std::fs::write(dest.join(".from-plaza"), "") {
        return skill_package_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("Failed to mark plaza copy: {error}"),
        );
    }
    Json(serde_json::json!({
        "name": name,
        "version": skill_version(&dest),
        "directory": dest.display().to_string(),
    }))
    .into_response()
}

/// `GET /api/skill-plaza` — shared catalog under `<install>/shared/skill-plaza`.
/// A new skill is a directory with `SKILL.md`; the web bundle does not embed it.
pub async fn handle_list_skill_plaza(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Response {
    if let Err(resp) = require_personal_user(&state, &headers) {
        return resp;
    }
    let config = state.config.read().clone();
    let root = skill_plaza_dir(&config);
    let mut skills = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if zeroclaw_api::normalize_user_id(name).is_err() {
                continue;
            }
            if let Some(skill) = read_plaza_skill(&config, &path, name) {
                skills.push(skill);
            }
        }
    }
    skills.sort_by(|a, b| {
        a["name"]
            .as_str()
            .unwrap_or_default()
            .cmp(b["name"].as_str().unwrap_or_default())
    });
    Json(serde_json::json!({ "skills": skills })).into_response()
}

// ── Error mapping ───────────────────────────────────────────────────

fn service_error_response(err: ServiceError) -> Response {
    let status = match &err {
        ServiceError::Ref(_) => StatusCode::BAD_REQUEST,
        ServiceError::Bundle(_) => StatusCode::BAD_REQUEST,
        ServiceError::Scaffold(_) => StatusCode::BAD_REQUEST,
        ServiceError::DocumentParse(_) => StatusCode::UNPROCESSABLE_ENTITY,
        ServiceError::NotFound(_) => StatusCode::NOT_FOUND,
        ServiceError::NotEditable { .. } => StatusCode::FORBIDDEN,
        ServiceError::Io(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    (
        status,
        Json(serde_json::json!({
            "error": format!("{}", err),
        })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use zeroclaw_runtime::skills::{ShadowedSkill, SkillOrigin};

    // the write-guard error maps to 403, distinct from 404/400.
    #[test]
    fn not_editable_maps_to_forbidden() {
        let resp = service_error_response(ServiceError::NotEditable {
            name: "alpha/foo".into(),
            origin: "non-bundle".into(),
        });
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    }

    // shadowed records ride through to the wire entry.
    #[test]
    fn agent_skill_entry_maps_shadowed() {
        let s = EffectiveSkill {
            name: "foo".into(),
            description: "d".into(),
            origin: SkillOrigin::Workspace,
            directory: None,
            editable: false,
            bundle: None,
            shadowed: vec![ShadowedSkill {
                name: "foo".into(),
                origin_hint: "bundle".into(),
            }],
        };
        let entry = agent_skill_entry(s);
        assert_eq!(entry.origin, "workspace");
        assert_eq!(entry.shadowed.len(), 1);
        assert_eq!(entry.shadowed[0].name, "foo");
        assert_eq!(entry.shadowed[0].origin, "bundle");
    }

    // each SkillDropReason arm maps to the right reason_kind tag.
    #[test]
    fn dropped_skill_entry_maps_each_reason_kind() {
        let mk = |reason| DroppedSkill {
            name: "n".into(),
            origin_hint: "workspace".into(),
            reason,
            location: Some(PathBuf::from("/x/n")),
        };
        assert_eq!(
            dropped_skill_entry(mk(SkillDropReason::AuditFindings {
                summary: "a".into(),
                scripts_blocked: true,
            }))
            .reason_kind,
            "audit_findings"
        );
        assert!(
            dropped_skill_entry(mk(SkillDropReason::AuditFindings {
                summary: "a".into(),
                scripts_blocked: true,
            }))
            .scripts_blocked,
            "scripts_blocked flag must pass through to the wire entry"
        );
        assert_eq!(
            dropped_skill_entry(mk(SkillDropReason::AuditError("b".into()))).reason_kind,
            "audit_error"
        );
        let mpe = dropped_skill_entry(mk(SkillDropReason::ManifestParseError("c".into())));
        assert_eq!(mpe.reason_kind, "manifest_parse_error");
        assert_eq!(mpe.reason, "c");
        assert_eq!(mpe.directory.as_deref(), Some("/x/n"));
    }

    #[tokio::test]
    async fn save_personal_skill_writes_caller_workspace() {
        use crate::api::test_state;
        use axum::http::HeaderValue;
        use zeroclaw_config::schema::AliasedAgentConfig;

        let tmp = tempfile::TempDir::new().unwrap();
        let mut config = zeroclaw_config::schema::Config {
            data_dir: tmp.path().join("data"),
            config_path: tmp.path().join("config.toml"),
            ..zeroclaw_config::schema::Config::default()
        };
        config.gateway.trusted_proxy = true;
        config.gateway.trusted_proxy_secret = Some("s3cret".into());
        config
            .agents
            .insert("web".into(), AliasedAgentConfig::default());
        let state = test_state(config);

        let mut headers = HeaderMap::new();
        headers.insert("x-auth-secret", HeaderValue::from_static("s3cret"));
        headers.insert("x-user-id", HeaderValue::from_static("alice"));
        headers.insert(
            "x-user-role",
            HeaderValue::from_bytes("普通用户".as_bytes()).unwrap(),
        );

        let response = handle_save_personal_skill(
            State(state.clone()),
            headers,
            Json(PersonalSkillBody {
                agent: "web".into(),
                name: "flu-weekly".into(),
                frontmatter: SkillFrontmatter {
                    name: "flu-weekly".into(),
                    description: "weekly flu".into(),
                    ..Default::default()
                },
                body: String::new(),
                files: Vec::new(),
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::CREATED);

        let mut headers = HeaderMap::new();
        headers.insert("x-auth-secret", HeaderValue::from_static("s3cret"));
        headers.insert("x-user-id", HeaderValue::from_static("alice"));
        headers.insert(
            "x-user-role",
            HeaderValue::from_bytes("高级用户".as_bytes()).unwrap(),
        );
        let response = handle_save_personal_skill(
            State(state.clone()),
            headers.clone(),
            Json(PersonalSkillBody {
                agent: "web".into(),
                name: "flu-weekly".into(),
                frontmatter: SkillFrontmatter {
                    name: "flu-weekly".into(),
                    description: "weekly flu".into(),
                    ..Default::default()
                },
                body: "# flu".into(),
                files: Vec::new(),
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::CREATED);
        let expected = state
            .config
            .read()
            .user_workspace_dir("alice", "web")
            .join("skills")
            .join("flu-weekly")
            .join("SKILL.md");
        assert!(expected.exists(), "{}", expected.display());
        let org = state
            .config
            .read()
            .agent_workspace_dir("web")
            .join("skills");
        assert!(!org.join("flu-weekly").join("SKILL.md").exists());

        let listed = handle_list_personal_skills(
            State(state.clone()),
            headers.clone(),
            Query(PersonalSkillQuery {
                agent: "web".into(),
            }),
        )
        .await;
        assert_eq!(listed.status(), StatusCode::OK);
        let listed_body = axum::body::to_bytes(listed.into_body(), usize::MAX)
            .await
            .unwrap();
        let listed_json: serde_json::Value = serde_json::from_slice(&listed_body).unwrap();
        assert_eq!(listed_json["skills"].as_array().unwrap().len(), 1);
        assert_eq!(listed_json["skills"][0]["name"], "flu-weekly");
        assert_eq!(listed_json["skills"][0]["enabled"], true);

        let disabled = handle_set_personal_skill_enabled(
            State(state.clone()),
            headers.clone(),
            Path("flu-weekly".into()),
            Json(PersonalSkillEnabledBody {
                agent: "web".into(),
                enabled: false,
            }),
        )
        .await;
        assert_eq!(disabled.status(), StatusCode::OK);
        let listed_off = handle_list_personal_skills(
            State(state.clone()),
            headers.clone(),
            Query(PersonalSkillQuery {
                agent: "web".into(),
            }),
        )
        .await;
        let listed_off_body = axum::body::to_bytes(listed_off.into_body(), usize::MAX)
            .await
            .unwrap();
        let listed_off_json: serde_json::Value = serde_json::from_slice(&listed_off_body).unwrap();
        assert_eq!(listed_off_json["skills"][0]["enabled"], false);

        let mut bob = HeaderMap::new();
        bob.insert("x-auth-secret", HeaderValue::from_static("s3cret"));
        bob.insert("x-user-id", HeaderValue::from_static("bob"));
        let bob_listed = handle_list_personal_skills(
            State(state.clone()),
            bob,
            Query(PersonalSkillQuery {
                agent: "web".into(),
            }),
        )
        .await;
        let bob_body = axum::body::to_bytes(bob_listed.into_body(), usize::MAX)
            .await
            .unwrap();
        let bob_json: serde_json::Value = serde_json::from_slice(&bob_body).unwrap();
        assert!(bob_json["skills"].as_array().unwrap().is_empty());

        let read = handle_read_personal_skill(
            State(state.clone()),
            headers.clone(),
            Path("flu-weekly".into()),
            Query(PersonalSkillQuery {
                agent: "web".into(),
            }),
        )
        .await;
        assert_eq!(read.status(), StatusCode::OK);

        let deleted = handle_delete_personal_skill(
            State(state.clone()),
            headers,
            Path("flu-weekly".into()),
            Query(PersonalSkillQuery {
                agent: "web".into(),
            }),
        )
        .await;
        assert_eq!(deleted.status(), StatusCode::NO_CONTENT);
        assert!(!expected.exists());
    }

    #[tokio::test]
    async fn agent_skills_include_personal_skills_for_bff_caller() {
        use crate::api::test_state;
        use axum::http::HeaderValue;
        use zeroclaw_api::ROLE_OPS;
        use zeroclaw_config::schema::AliasedAgentConfig;

        let tmp = tempfile::TempDir::new().unwrap();
        let mut config = zeroclaw_config::schema::Config {
            data_dir: tmp.path().join("data"),
            config_path: tmp.path().join("config.toml"),
            ..zeroclaw_config::schema::Config::default()
        };
        config.gateway.trusted_proxy = true;
        config.gateway.trusted_proxy_secret = Some("s3cret".into());
        config
            .agents
            .insert("web".into(), AliasedAgentConfig::default());
        let state = test_state(config);

        let mut ops = HeaderMap::new();
        ops.insert("x-auth-secret", HeaderValue::from_static("s3cret"));
        ops.insert("x-user-id", HeaderValue::from_static("alice"));
        ops.insert(
            "x-user-role",
            HeaderValue::from_bytes(ROLE_OPS.as_bytes()).unwrap(),
        );

        let saved = handle_save_personal_skill(
            State(state.clone()),
            ops.clone(),
            Json(PersonalSkillBody {
                agent: "web".into(),
                name: "syndrome-ili-alert".into(),
                frontmatter: SkillFrontmatter {
                    name: "syndrome-ili-alert".into(),
                    description: "ILI alert".into(),
                    ..Default::default()
                },
                body: "# ili".into(),
                files: Vec::new(),
            }),
        )
        .await;
        assert_eq!(saved.status(), StatusCode::CREATED);

        let listed = handle_agent_skills(State(state.clone()), ops, Path("web".into())).await;
        assert_eq!(listed.status(), StatusCode::OK);
        let body = axum::body::to_bytes(listed.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let names: Vec<&str> = json["skills"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|s| s["name"].as_str())
            .collect();
        assert!(
            names.contains(&"syndrome-ili-alert"),
            "personal plaza install must show on agent skills: {json}"
        );

        let mut bob = HeaderMap::new();
        bob.insert("x-auth-secret", HeaderValue::from_static("s3cret"));
        bob.insert("x-user-id", HeaderValue::from_static("bob"));
        bob.insert(
            "x-user-role",
            HeaderValue::from_bytes(ROLE_OPS.as_bytes()).unwrap(),
        );
        let bob_listed = handle_agent_skills(State(state.clone()), bob, Path("web".into())).await;
        let bob_body = axum::body::to_bytes(bob_listed.into_body(), usize::MAX)
            .await
            .unwrap();
        let bob_json: serde_json::Value = serde_json::from_slice(&bob_body).unwrap();
        let bob_names: Vec<&str> = bob_json["skills"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|s| s["name"].as_str())
            .collect();
        assert!(!bob_names.contains(&"syndrome-ili-alert"));

        let pairing = handle_agent_skills(State(state), HeaderMap::new(), Path("web".into())).await;
        let pairing_body = axum::body::to_bytes(pairing.into_body(), usize::MAX)
            .await
            .unwrap();
        let pairing_json: serde_json::Value = serde_json::from_slice(&pairing_body).unwrap();
        let pairing_names: Vec<&str> = pairing_json["skills"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|s| s["name"].as_str())
            .collect();
        assert!(!pairing_names.contains(&"syndrome-ili-alert"));
    }

    #[tokio::test]
    async fn skill_plaza_lists_only_directories_with_skill_md() {
        use crate::api::test_state;
        use axum::http::HeaderValue;

        let tmp = tempfile::TempDir::new().unwrap();
        let mut config = zeroclaw_config::schema::Config {
            data_dir: tmp.path().join("data"),
            config_path: tmp.path().join("config.toml"),
            ..zeroclaw_config::schema::Config::default()
        };
        config.gateway.trusted_proxy = true;
        config.gateway.trusted_proxy_secret = Some("s3cret".into());
        let state = test_state(config);

        let plaza = tmp.path().join("shared").join("skill-plaza");
        let flu = plaza.join("flu-trend");
        std::fs::create_dir_all(&flu).unwrap();
        std::fs::write(
            flu.join("SKILL.md"),
            "---\nname: 流感趋势解读\ndescription: 看近期流感活动。\n---\n\n# 正文\n",
        )
        .unwrap();
        let bare = plaza.join("notes");
        std::fs::create_dir_all(&bare).unwrap();
        std::fs::write(bare.join("README.md"), "# no skill\n").unwrap();

        let mut headers = HeaderMap::new();
        headers.insert("x-auth-secret", HeaderValue::from_static("s3cret"));
        headers.insert("x-user-id", HeaderValue::from_static("alice"));
        headers.insert(
            "x-user-role",
            HeaderValue::from_bytes("普通用户".as_bytes()).unwrap(),
        );

        let response = handle_list_skill_plaza(State(state), headers).await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let skills = json["skills"].as_array().unwrap();
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0]["name"], "flu-trend");
        assert_eq!(skills[0]["title"], "流感趋势解读");
        assert_eq!(skills[0]["description"], "看近期流感活动。");
    }

    #[tokio::test]
    async fn install_plaza_skill_copies_the_directory_and_refuses_silent_overwrite() {
        use crate::api::test_state;
        use axum::http::HeaderValue;

        let tmp = tempfile::TempDir::new().unwrap();
        let mut config = zeroclaw_config::schema::Config {
            data_dir: tmp.path().join("data"),
            config_path: tmp.path().join("config.toml"),
            ..zeroclaw_config::schema::Config::default()
        };
        config.gateway.trusted_proxy = true;
        config.gateway.trusted_proxy_secret = Some("s3cret".into());
        let state = test_state(config);

        let flu = tmp
            .path()
            .join("shared")
            .join("skill-plaza")
            .join("flu-trend");
        std::fs::create_dir_all(flu.join("scripts")).unwrap();
        std::fs::write(
            flu.join("SKILL.md"),
            "---\nname: 流感趋势解读\ndescription: 看近期流感活动。\nversion: \"1\"\n---\n\n# 一\n",
        )
        .unwrap();
        std::fs::write(flu.join("scripts").join("compute.py"), "print(1)\n").unwrap();

        let mut headers = HeaderMap::new();
        headers.insert("x-auth-secret", HeaderValue::from_static("s3cret"));
        headers.insert("x-user-id", HeaderValue::from_static("alice"));
        headers.insert(
            "x-user-role",
            HeaderValue::from_bytes("普通用户".as_bytes()).unwrap(),
        );
        let body = InstallPlazaSkillBody {
            agent: "deepseek".into(),
            name: "flu-trend".into(),
            update: false,
        };
        let installed =
            handle_install_plaza_skill(State(state.clone()), headers.clone(), Json(body)).await;
        assert_eq!(installed.status(), StatusCode::OK);
        let installed_body = axum::body::to_bytes(installed.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&installed_body).unwrap();
        let dir = std::path::PathBuf::from(json["directory"].as_str().unwrap());
        assert_eq!(
            std::fs::read_to_string(dir.join("scripts").join("compute.py")).unwrap(),
            "print(1)\n"
        );
        std::fs::write(dir.join(".disabled"), "").unwrap();
        std::fs::write(dir.join("SKILL.md"), "---\nname: 流感趋势解读\ndescription: 看近期流感活动。\nversion: \"1\"\n---\n\n# 我改过\n").unwrap();

        let again = handle_install_plaza_skill(
            State(state.clone()),
            headers.clone(),
            Json(InstallPlazaSkillBody {
                agent: "deepseek".into(),
                name: "flu-trend".into(),
                update: false,
            }),
        )
        .await;
        assert_eq!(again.status(), StatusCode::CONFLICT);
        assert!(
            std::fs::read_to_string(dir.join("SKILL.md"))
                .unwrap()
                .contains("我改过")
        );

        std::fs::write(
            flu.join("SKILL.md"),
            "---\nname: 流感趋势解读\ndescription: 看近期流感活动。\nversion: \"2\"\n---\n\n# 二\n",
        )
        .unwrap();
        let updated = handle_install_plaza_skill(
            State(state),
            headers,
            Json(InstallPlazaSkillBody {
                agent: "deepseek".into(),
                name: "flu-trend".into(),
                update: true,
            }),
        )
        .await;
        assert_eq!(updated.status(), StatusCode::OK);
        let text = std::fs::read_to_string(dir.join("SKILL.md")).unwrap();
        assert!(text.contains("# 二"));
        assert!(text.contains("version: \"2\"") || text.contains("version: 2"));
        assert!(dir.join(".disabled").is_file());
        assert_eq!(
            std::fs::read_to_string(dir.join("scripts").join("compute.py")).unwrap(),
            "print(1)\n"
        );
    }

    #[tokio::test]
    async fn skill_files_lists_text_and_rejects_escape() {
        use crate::api::test_state;
        use axum::http::HeaderValue;

        let tmp = tempfile::TempDir::new().unwrap();
        let mut config = zeroclaw_config::schema::Config {
            data_dir: tmp.path().join("data"),
            config_path: tmp.path().join("config.toml"),
            ..zeroclaw_config::schema::Config::default()
        };
        config.gateway.trusted_proxy = true;
        config.gateway.trusted_proxy_secret = Some("s3cret".into());
        let state = test_state(config);

        let flu = tmp
            .path()
            .join("shared")
            .join("skill-plaza")
            .join("flu-trend");
        std::fs::create_dir_all(flu.join("scripts")).unwrap();
        std::fs::write(
            flu.join("SKILL.md"),
            "---\nname: 流感趋势解读\ndescription: 看近期流感活动。\n---\n\n# 正文\n",
        )
        .unwrap();
        std::fs::write(flu.join("scripts").join("compute.py"), "print(1)\n").unwrap();
        std::fs::write(flu.join("blob.bin"), [0xff, 0xfe]).unwrap();
        std::os::unix::fs::symlink("/etc/passwd", flu.join("secret.txt")).unwrap();

        let mut headers = HeaderMap::new();
        headers.insert("x-auth-secret", HeaderValue::from_static("s3cret"));
        headers.insert("x-user-id", HeaderValue::from_static("alice"));
        headers.insert(
            "x-user-role",
            HeaderValue::from_bytes("普通用户".as_bytes()).unwrap(),
        );

        let listed = handle_read_plaza_skill_file(
            State(state.clone()),
            headers.clone(),
            Path("flu-trend".into()),
            Query(SkillFileQuery {
                path: String::new(),
            }),
        )
        .await;
        assert_eq!(listed.status(), StatusCode::OK);
        let listed_body = axum::body::to_bytes(listed.into_body(), usize::MAX)
            .await
            .unwrap();
        let listed_json: serde_json::Value = serde_json::from_slice(&listed_body).unwrap();
        let files: Vec<&str> = listed_json["files"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|value| value.as_str())
            .collect();
        assert_eq!(files, vec!["SKILL.md", "blob.bin", "scripts/compute.py"]);

        let script = handle_read_plaza_skill_file(
            State(state.clone()),
            headers.clone(),
            Path("flu-trend".into()),
            Query(SkillFileQuery {
                path: "scripts/compute.py".into(),
            }),
        )
        .await;
        assert_eq!(script.status(), StatusCode::OK);
        let script_body = axum::body::to_bytes(script.into_body(), usize::MAX)
            .await
            .unwrap();
        let script_json: serde_json::Value = serde_json::from_slice(&script_body).unwrap();
        assert_eq!(script_json["content"], "print(1)\n");
        assert_eq!(script_json["binary"], false);

        let binary = handle_read_plaza_skill_file(
            State(state.clone()),
            headers.clone(),
            Path("flu-trend".into()),
            Query(SkillFileQuery {
                path: "blob.bin".into(),
            }),
        )
        .await;
        let binary_body = axum::body::to_bytes(binary.into_body(), usize::MAX)
            .await
            .unwrap();
        let binary_json: serde_json::Value = serde_json::from_slice(&binary_body).unwrap();
        assert_eq!(binary_json["binary"], true);
        assert!(binary_json.get("content").is_none());

        let escaped = handle_read_plaza_skill_file(
            State(state.clone()),
            headers.clone(),
            Path("flu-trend".into()),
            Query(SkillFileQuery {
                path: "../config.toml".into(),
            }),
        )
        .await;
        assert_eq!(escaped.status(), StatusCode::BAD_REQUEST);

        let personal = tmp
            .path()
            .join("users")
            .join("alice")
            .join("agents")
            .join("deepseek")
            .join("workspace")
            .join("skills")
            .join("flu-trend");
        std::fs::create_dir_all(personal.join("references")).unwrap();
        std::fs::write(
            personal.join("SKILL.md"),
            "---\nname: 流感趋势解读\ndescription: 看近期流感活动。\n---\n\n# 我的\n",
        )
        .unwrap();
        std::fs::write(personal.join("references").join("usage.md"), "口径\n").unwrap();
        let mine = handle_read_personal_skill_file(
            State(state),
            headers,
            Path("flu-trend".into()),
            Query(PersonalSkillFileQuery {
                agent: "deepseek".into(),
                path: "references/usage.md".into(),
            }),
        )
        .await;
        assert_eq!(mine.status(), StatusCode::OK);
        let mine_body = axum::body::to_bytes(mine.into_body(), usize::MAX)
            .await
            .unwrap();
        let mine_json: serde_json::Value = serde_json::from_slice(&mine_body).unwrap();
        assert_eq!(mine_json["content"], "口径\n");
    }

    #[tokio::test]
    async fn save_personal_skill_writes_package_files_beside_skill_md() {
        use crate::api::test_state;
        use axum::http::HeaderValue;
        use base64::Engine;
        use zeroclaw_config::schema::AliasedAgentConfig;

        let tmp = tempfile::TempDir::new().unwrap();
        let mut config = zeroclaw_config::schema::Config {
            data_dir: tmp.path().join("data"),
            config_path: tmp.path().join("config.toml"),
            ..zeroclaw_config::schema::Config::default()
        };
        config.gateway.trusted_proxy = true;
        config.gateway.trusted_proxy_secret = Some("s3cret".into());
        config
            .agents
            .insert("web".into(), AliasedAgentConfig::default());
        let state = test_state(config);

        let headers = || {
            let mut headers = HeaderMap::new();
            headers.insert("x-auth-secret", HeaderValue::from_static("s3cret"));
            headers.insert("x-user-id", HeaderValue::from_static("alice"));
            headers.insert(
                "x-user-role",
                HeaderValue::from_bytes("普通用户".as_bytes()).unwrap(),
            );
            headers
        };
        let skill_md = "---\nname: epi-survey-report\ndescription: 生成流调报告。\n---\n\n# 正文\n";
        let script = "print(1)\n";
        let encode = |text: &str| base64::engine::general_purpose::STANDARD.encode(text);

        let rejected = handle_save_personal_skill(
            State(state.clone()),
            headers(),
            Json(PersonalSkillBody {
                agent: "web".into(),
                name: "epi-survey-report".into(),
                frontmatter: SkillFrontmatter::default(),
                body: String::new(),
                files: vec![PersonalSkillPackageFile {
                    path: "../escape.txt".into(),
                    data_base64: encode("nope"),
                }],
            }),
        )
        .await;
        assert_eq!(rejected.status(), StatusCode::BAD_REQUEST);
        assert!(!tmp.path().join("escape.txt").exists());

        let skill_dir = tmp
            .path()
            .join("users/alice/agents/web/workspace/skills/epi-survey-report");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(skill_dir.join(".disabled"), "").unwrap();
        std::fs::write(skill_dir.join("old.py"), "stale").unwrap();

        let saved = handle_save_personal_skill(
            State(state),
            headers(),
            Json(PersonalSkillBody {
                agent: "web".into(),
                name: "epi-survey-report".into(),
                frontmatter: SkillFrontmatter::default(),
                body: String::new(),
                files: vec![
                    PersonalSkillPackageFile {
                        path: "SKILL.md".into(),
                        data_base64: encode(skill_md),
                    },
                    PersonalSkillPackageFile {
                        path: "scripts/compute_epi_stats.py".into(),
                        data_base64: encode(script),
                    },
                ],
            }),
        )
        .await;
        assert_eq!(saved.status(), StatusCode::CREATED);
        assert_eq!(
            std::fs::read_to_string(skill_dir.join("SKILL.md")).unwrap(),
            skill_md
        );
        assert_eq!(
            std::fs::read_to_string(skill_dir.join("scripts/compute_epi_stats.py")).unwrap(),
            script
        );
        assert!(skill_dir.join(".disabled").is_file());
        assert!(!skill_dir.join("old.py").exists());
    }
}
