//! Canonical filenames + scaffold subdirs for the Agent Skills spec.

/// Canonical manifest filename per the open Agent Skills spec.
pub const SKILL_MANIFEST_FILENAME: &str = "SKILL.md";

/// Sidecar that keeps a skill installed but out of the next turn's prompt.
pub const SKILL_DISABLED_MARKER: &str = ".disabled";

/// Pre-spec manifest filenames still accepted by the audit loader for
/// back-compat with installed skills. Never written by the service.
pub const SKILL_DEPRECATED_MANIFESTS: &[&str] = &["SKILL.toml", "manifest.toml"];

/// Optional standard subdirs scaffolded under each new skill directory.
/// Match the canonical agentskills.io layout (`scripts/`, `references/`,
/// `assets/`).
pub const SKILL_SCAFFOLD_SUBDIRS: &[&str] = &["scripts", "references", "assets"];

/// Archive root under the shared workspace where deleted skills are moved
/// (when `RemoveMode::Archive` is selected). Mirrors the agent-workspace
/// archive convention.
pub const SKILL_ARCHIVE_DIR_NAME: &str = "_deleted";
