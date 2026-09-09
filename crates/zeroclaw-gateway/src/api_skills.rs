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
    let config = state.config.read().clone();
    let install_root = config.install_root_dir();
    let service = SkillsService::new(&config, install_root);

    match service.resolve_effective_skills(&alias) {
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
pub struct PersonalSkillBody {
    pub agent: String,
    pub name: String,
    #[serde(default)]
    pub frontmatter: SkillFrontmatter,
    #[serde(default)]
    pub body: String,
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

fn require_personal_user(
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

fn require_agent(agent: &str) -> Result<&str, Response> {
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

fn require_skill_name(raw: &str) -> Result<String, Response> {
    match zeroclaw_api::normalize_user_id(raw.trim()) {
        Ok(n) => Ok(n),
        Err(_) => Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "invalid skill name"})),
        )
            .into_response()),
    }
}

fn personal_skills_dir(
    config: &zeroclaw_config::schema::Config,
    user_id: &str,
    agent: &str,
) -> std::path::PathBuf {
    config.user_workspace_dir(user_id, agent).join("skills")
}

fn write_personal_skill_file(
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
    let written = match write_personal_skill_file(&dir, &name, body.frontmatter, body.body) {
        Ok(n) => n,
        Err(resp) => return resp,
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
            let (description, title) =
                match zeroclaw_runtime::skills::document::SkillDocument::parse(&content) {
                    Ok(doc) => (
                        doc.frontmatter.description,
                        if doc.frontmatter.name.trim().is_empty() {
                            name.to_string()
                        } else {
                            doc.frontmatter.name
                        },
                    ),
                    Err(_) => (String::new(), name.to_string()),
                };
            skills.push(serde_json::json!({
                "name": name,
                "title": title,
                "description": description,
                "enabled": zeroclaw_runtime::skills::skill_directory_enabled(&path),
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
}
