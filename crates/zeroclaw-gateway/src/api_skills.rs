//! HTTP adapter over `zeroclaw_runtime::skills::SkillsService`.

use axum::{
    Json,
    extract::{Path, State},
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

/// `POST /api/user/skills` — 高级用户 only; writes the caller's user workspace.
pub async fn handle_save_personal_skill(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PersonalSkillBody>,
) -> Response {
    let attrs = match crate::trusted_proxy::require_user_principal(&state, &headers) {
        Ok((_, Some(attrs))) => attrs,
        Ok((_, None)) => {
            return (
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({
                    "error": "Forbidden — personal skill save requires a BFF user identity"
                })),
            )
                .into_response();
        }
        Err(e) => return e.into_response(),
    };
    if !attrs.is_advanced() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "error": "Forbidden — saving a personal skill requires X-User-Role: 高级用户"
            })),
        )
            .into_response();
    }
    let name = match zeroclaw_api::normalize_user_id(body.name.trim()) {
        Ok(n) => n,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "invalid skill name"})),
            )
                .into_response();
        }
    };
    let agent = body.agent.trim();
    if agent.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "agent is required"})),
        )
            .into_response();
    }
    let config = state.config.read().clone();
    let dir = config
        .user_workspace_dir(&attrs.user_id, agent)
        .join("skills")
        .join(&name);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Failed to create skill directory: {e}")})),
        )
            .into_response();
    }
    let mut fm = body.frontmatter;
    if fm.name.trim().is_empty() {
        fm.name = name.clone();
    }
    let description = if fm.description.trim().is_empty() {
        fm.name.clone()
    } else {
        fm.description.replace('\n', " ")
    };
    let body_md = if body.body.trim().is_empty() {
        format!("# {}\n", fm.name)
    } else {
        body.body
    };
    let markdown = format!(
        "---\nname: {}\ndescription: {}\n---\n\n{body_md}",
        fm.name, description
    );
    let path = dir.join("SKILL.md");
    if let Err(e) = std::fs::write(&path, markdown) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Failed to write SKILL.md: {e}")})),
        )
            .into_response();
    }
    (
        StatusCode::CREATED,
        Json(serde_json::json!({
            "name": fm.name,
            "directory": dir.display().to_string(),
        })),
    )
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
    async fn save_personal_skill_requires_advanced_user() {
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
        assert_eq!(response.status(), StatusCode::FORBIDDEN);

        let mut headers = HeaderMap::new();
        headers.insert("x-auth-secret", HeaderValue::from_static("s3cret"));
        headers.insert("x-user-id", HeaderValue::from_static("alice"));
        headers.insert(
            "x-user-role",
            HeaderValue::from_bytes("高级用户".as_bytes()).unwrap(),
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
    }
}
