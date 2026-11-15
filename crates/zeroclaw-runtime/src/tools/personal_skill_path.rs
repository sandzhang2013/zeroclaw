//! A new personal skill takes its directory name from `personal-skill-seq`.
//!
//! The model often writes `skills/<title-slug>/SKILL.md` during a turn. The
//! slug is not an id. These wrappers store that file under the next `ps` id
//! and say so in the tool result. A directory that already has `SKILL.md`
//! keeps its name.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use zeroclaw_api::attribution::{Attributable, Role, ToolProvenance};
use zeroclaw_api::tool::{Tool, ToolExecutionContext, ToolResult};
use zeroclaw_config::policy::SecurityPolicy;
use zeroclaw_config::schema::Config;

use crate::skills::personal::{claim_fresh_personal_skill, personal_skill_directory};

const FILE_WRITE_DESCRIPTION: &str = "\
Write contents to a file in the workspace. A new personal skill under skills/<name>/ \
is stored at the next ps id from the personal skill counter. The directory name is \
that id. The title stays in frontmatter name. Text by default; set encoding=\"base64\" \
to write binary files (e.g. .xlsx/.docx) by decoding base64 content into raw bytes.";

const SHELL_DESCRIPTION: &str = "\
Execute a shell command in the workspace directory. A new personal skill directory \
created by the command is renamed to the next ps id. The tool result reports that id.";

pub struct PersonalSkillPath<T: Tool> {
    inner: T,
    config: Arc<Config>,
    security: Arc<SecurityPolicy>,
    agent_alias: String,
    description: Option<&'static str>,
}

impl<T: Tool> PersonalSkillPath<T> {
    pub fn file_write(
        inner: T,
        config: Arc<Config>,
        security: Arc<SecurityPolicy>,
        agent_alias: String,
    ) -> Self {
        Self {
            inner,
            config,
            security,
            agent_alias,
            description: Some(FILE_WRITE_DESCRIPTION),
        }
    }

    pub fn file_edit(
        inner: T,
        config: Arc<Config>,
        security: Arc<SecurityPolicy>,
        agent_alias: String,
    ) -> Self {
        Self {
            inner,
            config,
            security,
            agent_alias,
            description: None,
        }
    }

    fn skills_root(&self) -> Option<PathBuf> {
        let attrs = zeroclaw_api::current_user_attrs().flatten()?;
        let user_id = zeroclaw_api::normalize_user_id(&attrs.user_id).ok()?;
        if self.agent_alias.is_empty() {
            return None;
        }
        Some(
            self.config
                .user_workspace_dir(&user_id, &self.agent_alias)
                .join("skills"),
        )
    }

    fn prepare(&self, args: &mut serde_json::Value) -> anyhow::Result<Option<String>> {
        let Some(raw) = args.get("path").and_then(|value| value.as_str()) else {
            return Ok(None);
        };
        let Some(skills_root) = self.skills_root() else {
            return Ok(None);
        };
        let raw_owned = raw.to_string();
        let Some((rewritten, id)) =
            rewritten_skill_path(&self.config, &self.security, &skills_root, &raw_owned)?
        else {
            return Ok(None);
        };
        if let Some(path) = args.get_mut("path") {
            *path = serde_json::Value::String(rewritten);
        }
        Ok(Some(id))
    }
}

impl<T: Tool> Attributable for PersonalSkillPath<T> {
    fn role(&self) -> Role {
        self.inner.role()
    }
    fn alias(&self) -> &str {
        self.inner.alias()
    }
    fn tool_provenance(&self) -> ToolProvenance {
        self.inner.tool_provenance()
    }
}

#[async_trait]
impl<T: Tool> Tool for PersonalSkillPath<T> {
    fn name(&self) -> &str {
        self.inner.name()
    }

    fn description(&self) -> &str {
        if let Some(description) = self.description {
            description
        } else {
            self.inner.description()
        }
    }

    fn parameters_schema(&self) -> serde_json::Value {
        self.inner.parameters_schema()
    }

    fn output_schema(&self) -> Option<serde_json::Value> {
        self.inner.output_schema()
    }

    fn param_domains(&self) -> Vec<(&'static str, zeroclaw_api::tool::OptionDomain)> {
        self.inner.param_domains()
    }

    fn invocation_triggers(&self) -> Vec<String> {
        self.inner.invocation_triggers()
    }

    async fn execute(&self, args: serde_json::Value) -> anyhow::Result<ToolResult> {
        self.execute_with_context(args, &ToolExecutionContext::current().unwrap_or_default())
            .await
    }

    async fn execute_with_context(
        &self,
        mut args: serde_json::Value,
        context: &ToolExecutionContext,
    ) -> anyhow::Result<ToolResult> {
        let id = match self.prepare(&mut args) {
            Ok(id) => id,
            Err(error) => {
                return Ok(ToolResult {
                    success: false,
                    output: zeroclaw_api::tool::ToolOutput::default(),
                    error: Some(error.to_string()),
                });
            }
        };
        let mut result = self.inner.execute_with_context(args, context).await?;
        if result.success
            && let Some(id) = id
        {
            let note = format!("\nPersonal skill id is {id}. The directory name is the id.");
            result.output.map_text(|text| format!("{text}{note}"));
        }
        Ok(result)
    }
}

pub struct PersonalSkillShell<T: Tool> {
    inner: T,
    config: Arc<Config>,
    security: Arc<SecurityPolicy>,
    agent_alias: String,
}

impl<T: Tool> PersonalSkillShell<T> {
    pub fn new(
        inner: T,
        config: Arc<Config>,
        security: Arc<SecurityPolicy>,
        agent_alias: String,
    ) -> Self {
        Self {
            inner,
            config,
            security,
            agent_alias,
        }
    }

    fn skills_root(&self) -> Option<PathBuf> {
        let attrs = zeroclaw_api::current_user_attrs().flatten()?;
        let user_id = zeroclaw_api::normalize_user_id(&attrs.user_id).ok()?;
        if self.agent_alias.is_empty() {
            return None;
        }
        Some(
            self.config
                .user_workspace_dir(&user_id, &self.agent_alias)
                .join("skills"),
        )
    }

    fn claim_new(&self, skills_root: &Path, scan_root: &Path, before: &HashSet<String>) -> String {
        let Ok(entries) = std::fs::read_dir(scan_root) else {
            return String::new();
        };
        let fresh: Vec<PathBuf> = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                    return false;
                };
                path.join("SKILL.md").is_file() && !before.contains(name)
            })
            .collect();
        let mut note = String::new();
        for source in fresh {
            match claim_fresh_personal_skill(&self.config, skills_root, &source) {
                Ok((previous, id)) if previous == id => {
                    note.push_str(&format!(
                        "\nPersonal skill id is {id}. The directory name is the id."
                    ));
                }
                Ok((previous, id)) => {
                    note.push_str(&format!(
                        "\nPersonal skill id is {id}. The directory name is the id; {previous} was not allocated."
                    ));
                }
                Err(error) => {
                    note.push_str(&format!("\nPersonal skill id was not allocated: {error}"));
                }
            }
        }
        note
    }
}

impl<T: Tool> Attributable for PersonalSkillShell<T> {
    fn role(&self) -> Role {
        self.inner.role()
    }
    fn alias(&self) -> &str {
        self.inner.alias()
    }
    fn tool_provenance(&self) -> ToolProvenance {
        self.inner.tool_provenance()
    }
}

#[async_trait]
impl<T: Tool> Tool for PersonalSkillShell<T> {
    fn name(&self) -> &str {
        self.inner.name()
    }

    fn description(&self) -> &str {
        SHELL_DESCRIPTION
    }

    fn parameters_schema(&self) -> serde_json::Value {
        self.inner.parameters_schema()
    }

    fn output_schema(&self) -> Option<serde_json::Value> {
        self.inner.output_schema()
    }

    fn param_domains(&self) -> Vec<(&'static str, zeroclaw_api::tool::OptionDomain)> {
        self.inner.param_domains()
    }

    fn invocation_triggers(&self) -> Vec<String> {
        self.inner.invocation_triggers()
    }

    async fn execute(&self, args: serde_json::Value) -> anyhow::Result<ToolResult> {
        self.execute_with_context(args, &ToolExecutionContext::current().unwrap_or_default())
            .await
    }

    async fn execute_with_context(
        &self,
        args: serde_json::Value,
        context: &ToolExecutionContext,
    ) -> anyhow::Result<ToolResult> {
        let watched = self.skills_root().map(|skills_root| {
            let session_skills = self.security.workspace_dir.join("skills");
            let mut roots = vec![skills_root.clone()];
            if session_skills != skills_root {
                roots.push(session_skills);
            }
            let before: Vec<(PathBuf, HashSet<String>)> = roots
                .into_iter()
                .map(|root| {
                    let names = skill_manifests(&root);
                    (root, names)
                })
                .collect();
            (skills_root, before)
        });
        let mut result = self.inner.execute_with_context(args, context).await?;
        if let Some((skills_root, before)) = watched {
            let mut note = String::new();
            for (scan_root, names) in &before {
                note.push_str(&self.claim_new(&skills_root, scan_root, names));
            }
            if !note.is_empty() {
                result.output.map_text(|text| format!("{text}{note}"));
            }
        }
        Ok(result)
    }
}

fn skill_manifests(root: &Path) -> HashSet<String> {
    let mut names = HashSet::new();
    let Ok(entries) = std::fs::read_dir(root) else {
        return names;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.join("SKILL.md").is_file() {
            continue;
        }
        if let Some(name) = path.file_name().and_then(|name| name.to_str()) {
            names.insert(name.to_string());
        }
    }
    names
}

fn rewritten_skill_path(
    config: &Config,
    security: &SecurityPolicy,
    skills_root: &Path,
    raw: &str,
) -> std::io::Result<Option<(String, String)>> {
    let resolved = security.resolve_session_write_path(raw);
    if let Some(rewritten) = assign_under(config, skills_root, &resolved)? {
        return Ok(Some(rewritten));
    }
    let raw_path = Path::new(raw);
    if let Ok(rest) = raw_path.strip_prefix("skills") {
        let under = skills_root.join(rest);
        if under != resolved {
            return assign_under(config, skills_root, &under);
        }
    }
    Ok(None)
}

fn assign_under(
    config: &Config,
    skills_root: &Path,
    full: &Path,
) -> std::io::Result<Option<(String, String)>> {
    let Ok(relative) = full.strip_prefix(skills_root) else {
        return Ok(None);
    };
    let mut parts = relative.components();
    let Some(name) = parts.next().and_then(|part| part.as_os_str().to_str()) else {
        return Ok(None);
    };
    let mut rest = PathBuf::new();
    for part in parts {
        rest.push(part);
    }
    if rest.as_os_str().is_empty() {
        return Ok(None);
    }
    let dest = personal_skill_directory(config, skills_root, name)?;
    if dest == skills_root.join(name) {
        return Ok(None);
    }
    let rewritten = dest.join(rest);
    let id = dest
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(name)
        .to_string();
    Ok(Some((rewritten.to_string_lossy().into_owned(), id)))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use zeroclaw_api::tool::Tool;
    use zeroclaw_config::autonomy::AutonomyLevel;
    use zeroclaw_config::policy::SecurityPolicy;
    use zeroclaw_config::schema::Config;
    use zeroclaw_tools::file_write::FileWriteTool;
    use zeroclaw_tools::wrappers::{PathGuardedTool, RateLimitedTool};

    use super::PersonalSkillShell;

    fn session_stack(
        tmp: &std::path::Path,
    ) -> (
        Config,
        Arc<SecurityPolicy>,
        std::path::PathBuf,
        std::path::PathBuf,
    ) {
        let mut config = Config::default();
        config.config_path = tmp.join("config.toml");
        let workspace = config.user_workspace_dir("ops", "hbcdc");
        let session = workspace.join("sessions").join("s1");
        std::fs::create_dir_all(&session).unwrap();
        let security = Arc::new(SecurityPolicy {
            autonomy: AutonomyLevel::Full,
            workspace_dir: session.clone(),
            allowed_roots: vec![workspace.clone()],
            ..SecurityPolicy::default()
        });
        (config, security, workspace, session)
    }

    #[tokio::test]
    async fn session_file_write_of_a_title_slug_stores_the_allocated_personal_id() {
        let tmp = tempfile::TempDir::new().unwrap();
        let (config, security, workspace, session) = session_stack(tmp.path());
        let tool = RateLimitedTool::new(
            PathGuardedTool::new(
                super::PersonalSkillPath::file_write(
                    FileWriteTool::new(security.clone()),
                    Arc::new(config.clone()),
                    security.clone(),
                    "hbcdc".to_string(),
                ),
                security.clone(),
            ),
            security,
        );
        let result = zeroclaw_api::TOOL_LOOP_USER_ATTRS
            .scope(Some(zeroclaw_api::UserAttrs::new("ops")), async {
                tool.execute(serde_json::json!({
                    "path": "skills/hfmd-cluster-surveillance/SKILL.md",
                    "content": "---\nname: 手足口病聚集性疫情研判\ndescription: 研判\n---\n\n# 研判\n"
                }))
                .await
            })
            .await
            .unwrap();

        assert!(result.success, "{}", result.error.unwrap_or_default());
        assert!(
            result
                .output
                .as_str()
                .contains("Personal skill id is ps0001"),
            "{}",
            result.output.as_str()
        );
        let stored = workspace.join("skills").join("ps0001").join("SKILL.md");
        let markdown = std::fs::read_to_string(&stored).unwrap();
        assert!(markdown.contains("name: 手足口病聚集性疫情研判"));
        assert!(
            !workspace
                .join("skills")
                .join("hfmd-cluster-surveillance")
                .exists()
        );
        assert!(
            !session
                .join("skills")
                .join("hfmd-cluster-surveillance")
                .exists()
        );
        assert_eq!(
            std::fs::read_to_string(
                config
                    .install_root_dir()
                    .join("shared")
                    .join("personal-skill-seq")
            )
            .unwrap(),
            "1"
        );
    }

    struct WriteSlug {
        root: std::path::PathBuf,
    }

    zeroclaw_api::mock_tool_attribution!(WriteSlug);

    #[async_trait::async_trait]
    impl Tool for WriteSlug {
        fn name(&self) -> &str {
            "shell"
        }

        fn description(&self) -> &str {
            "test shell"
        }

        fn parameters_schema(&self) -> serde_json::Value {
            serde_json::json!({"type": "object"})
        }

        async fn execute(
            &self,
            _args: serde_json::Value,
        ) -> anyhow::Result<zeroclaw_api::tool::ToolResult> {
            let dir = self.root.join("hfmd-cluster-surveillance");
            std::fs::create_dir_all(&dir)?;
            std::fs::write(
                dir.join("SKILL.md"),
                "---\nname: 手足口病聚集性疫情研判\ndescription: 研判\n---\n\n# 研判\n",
            )?;
            Ok(zeroclaw_api::tool::ToolResult {
                success: true,
                output: "wrote skills/hfmd-cluster-surveillance/SKILL.md".into(),
                error: None,
            })
        }
    }

    #[tokio::test]
    async fn session_shell_that_writes_a_title_slug_stores_the_allocated_personal_id() {
        let tmp = tempfile::TempDir::new().unwrap();
        let (config, security, workspace, _) = session_stack(tmp.path());
        let skills = workspace.join("skills");
        let tool = PersonalSkillShell::new(
            WriteSlug {
                root: skills.clone(),
            },
            Arc::new(config.clone()),
            security,
            "hbcdc".to_string(),
        );
        let result = zeroclaw_api::TOOL_LOOP_USER_ATTRS
            .scope(Some(zeroclaw_api::UserAttrs::new("ops")), async {
                tool.execute(serde_json::json!({"command": "write"})).await
            })
            .await
            .unwrap();

        assert!(result.success, "{}", result.error.unwrap_or_default());
        assert!(
            result
                .output
                .as_str()
                .contains("Personal skill id is ps0001"),
            "{}",
            result.output.as_str()
        );
        assert!(skills.join("ps0001").join("SKILL.md").is_file());
        assert!(!skills.join("hfmd-cluster-surveillance").exists());
        assert_eq!(
            std::fs::read_to_string(
                config
                    .install_root_dir()
                    .join("shared")
                    .join("personal-skill-seq")
            )
            .unwrap(),
            "1"
        );
    }
}
