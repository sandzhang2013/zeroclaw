//! Personal skills distilled from a logged-in turn.
//!
//! The directory id comes from `shared/personal-skill-seq`, the same counter
//! the My Skills form uses. The file is a `SKILL.md` under that user's agent
//! workspace, so the plaza and the skill center never see it.

use std::io::{Read, Seek, Write};
use std::path::{Path, PathBuf};

use zeroclaw_config::schema::Config;

use super::creator::{ToolCallRecord, scrub_secrets};
use super::document::SkillDocument;
use super::frontmatter::SkillFrontmatter;

const PERSONAL_SEQ_FILE: &str = "personal-skill-seq";

/// Next `ps0001` id. The counter advances even when the caller never writes
/// the skill. An id already used under any user's skills, the plaza, or the
/// catalog is skipped.
pub fn allocate_personal_skill_id(config: &Config) -> std::io::Result<String> {
    let path = config
        .install_root_dir()
        .join("shared")
        .join(PERSONAL_SEQ_FILE);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)?;
    lock_seq(&file)?;
    use std::os::unix::io::AsRawFd;
    let _unlock = SeqUnlock(file.as_raw_fd());
    let mut buf = String::new();
    file.read_to_string(&mut buf)?;
    let current = if buf.trim().is_empty() {
        0
    } else {
        buf.trim().parse::<u64>().map_err(|err| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("personal skill id counter is invalid: {err}"),
            )
        })?
    };
    let mut next = current.checked_add(1).ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "personal skill id counter is exhausted",
        )
    })?;
    let mut skipped = 0u32;
    while personal_skill_id_taken(config, &format_personal_id(next)) {
        skipped += 1;
        if skipped > 10_000 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "personal skill id counter is exhausted",
            ));
        }
        next = next.checked_add(1).ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "personal skill id counter is exhausted",
            )
        })?;
    }
    file.seek(std::io::SeekFrom::Start(0))?;
    file.set_len(0)?;
    write!(file, "{next}")?;
    file.sync_all()?;
    Ok(format_personal_id(next))
}

/// Write one personal skill for this user and agent. Returns the `ps` id.
/// `Ok(None)` when creation is off or the turn did not run two tool calls.
pub fn create_from_turn(
    config: &Config,
    user_id: &str,
    agent_alias: &str,
    task: &str,
    tool_calls: &[ToolCallRecord],
) -> anyhow::Result<Option<String>> {
    if !config.skills.skill_creation.enabled || tool_calls.len() < 2 {
        return Ok(None);
    }
    let Ok(user_id) = zeroclaw_api::normalize_user_id(user_id) else {
        return Ok(None);
    };
    let agent_alias = agent_alias.trim();
    if agent_alias.is_empty() {
        return Ok(None);
    }
    let id = allocate_personal_skill_id(config)?;
    let skills_root = config
        .user_workspace_dir(&user_id, agent_alias)
        .join("skills");
    evict_oldest_auto_skill(&skills_root, config.skills.skill_creation.max_skills)?;
    let dir = skills_root.join(&id);
    std::fs::create_dir_all(&dir)?;
    let markdown = personal_skill_markdown(&id, task, tool_calls);
    std::fs::write(dir.join("SKILL.md"), markdown)?;
    super::cache::invalidate();
    Ok(Some(id))
}

fn format_personal_id(n: u64) -> String {
    format!("ps{n:04}")
}

/// `ps0001` onward. A new personal skill directory has to be one of these.
#[must_use]
pub fn is_allocated_personal_skill_id(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("ps") else {
        return false;
    };
    rest.len() >= 4 && rest.chars().all(|c| c.is_ascii_digit())
}

fn skill_name_key(name: &str) -> Option<&str> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
    {
        None
    } else {
        Some(name)
    }
}

fn remembered_skill_id(skills_root: &Path, requested_name: &str) -> Option<String> {
    let key = format!("{}\0{requested_name}", skills_root.display());
    skill_id_memory()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&key)
        .cloned()
}

fn remember_skill_id(skills_root: &Path, requested_name: &str, id: &str) {
    let key = format!("{}\0{requested_name}", skills_root.display());
    skill_id_memory()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(key, id.to_string());
}

fn skill_id_memory() -> &'static std::sync::Mutex<std::collections::HashMap<String, String>> {
    static MEMORY: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, String>>,
    > = std::sync::OnceLock::new();
    MEMORY.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Directory for one file inside a personal `skills/` tree.
///
/// A directory that already has `SKILL.md` keeps its name. A new skill takes
/// the next `ps` id. Repeating the same requested name in this process reuses
/// that id, so a title slug does not mint a second number.
pub fn personal_skill_directory(
    config: &Config,
    skills_root: &Path,
    requested_name: &str,
) -> std::io::Result<PathBuf> {
    let Some(requested_name) = skill_name_key(requested_name) else {
        return Ok(skills_root.join(requested_name));
    };
    if skills_root.join(requested_name).join("SKILL.md").is_file() {
        return Ok(skills_root.join(requested_name));
    }
    fresh_personal_skill_directory(config, skills_root, requested_name)
}

fn fresh_personal_skill_directory(
    config: &Config,
    skills_root: &Path,
    requested_name: &str,
) -> std::io::Result<PathBuf> {
    if let Some(id) = remembered_skill_id(skills_root, requested_name) {
        return Ok(skills_root.join(id));
    }
    let id = allocate_personal_skill_id(config)?;
    remember_skill_id(skills_root, requested_name, &id);
    let dest = skills_root.join(&id);
    let src = skills_root.join(requested_name);
    if src.is_dir() && src != dest {
        if dest.exists() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                "personal skill id directory already exists",
            ));
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::rename(&src, &dest)?;
    }
    Ok(dest)
}

/// Move a skill directory that just gained `SKILL.md` onto the next `ps` id.
/// `source` may sit in the personal skills tree or in a session directory.
/// Returns `(previous directory name, allocated id)`.
pub fn claim_fresh_personal_skill(
    config: &Config,
    skills_root: &Path,
    source: &Path,
) -> std::io::Result<(String, String)> {
    let name = source
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| skill_name_key(name).is_some())
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "skill directory name is not a single path segment",
            )
        })?;
    let name = name.to_string();
    let dest = fresh_personal_skill_directory(config, skills_root, &name)?;
    if source.exists() && source != dest {
        if dest.exists() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                "personal skill id directory already exists",
            ));
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::rename(source, &dest)?;
    }
    let id = dest
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(&name)
        .to_string();
    Ok((name, id))
}

fn personal_skill_markdown(id: &str, task: &str, tool_calls: &[ToolCallRecord]) -> String {
    let title = one_line(task, 80);
    let title = if title.is_empty() {
        id.to_string()
    } else {
        title
    };
    let description = one_line(task, 200);
    let description = if description.is_empty() {
        title.clone()
    } else {
        description
    };
    let mut body = String::from("# Procedure\n\n");
    for (index, call) in tool_calls.iter().enumerate() {
        let args = scrub_secrets(&serde_json::to_string(&call.args).unwrap_or_default());
        let args = super::creator::truncate_chars(&args, 500);
        let name = scrub_secrets(&call.name);
        body.push_str(&format!("{}. `{name}`\n\n{args}\n\n", index + 1));
    }
    SkillDocument {
        frontmatter: SkillFrontmatter {
            name: title,
            description,
            author: Some("zeroclaw-auto".to_string()),
            version: Some("0.1.0".to_string()),
            tags: vec!["auto-generated".to_string()],
            ..SkillFrontmatter::default()
        },
        body,
    }
    .serialize()
}

fn one_line(text: &str, max_chars: usize) -> String {
    let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    flat.chars().take(max_chars).collect()
}

fn evict_oldest_auto_skill(skills_root: &Path, max_skills: usize) -> std::io::Result<()> {
    if !skills_root.is_dir() {
        return Ok(());
    }
    let mut auto_skills: Vec<(PathBuf, std::time::SystemTime)> = Vec::new();
    for entry in std::fs::read_dir(skills_root)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let manifest = path.join("SKILL.md");
        let Ok(content) = std::fs::read_to_string(&manifest) else {
            continue;
        };
        if content.contains("zeroclaw-auto") || content.contains("auto-generated") {
            let modified = std::fs::metadata(&manifest)
                .and_then(|meta| meta.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            auto_skills.push((path, modified));
        }
    }
    if auto_skills.len() >= max_skills {
        auto_skills.sort_by_key(|(_, modified)| *modified);
        if let Some((oldest, _)) = auto_skills.first() {
            std::fs::remove_dir_all(oldest)?;
        }
    }
    Ok(())
}

fn personal_skill_id_taken(config: &Config, id: &str) -> bool {
    let shared = config.install_root_dir().join("shared");
    if skill_md_exists(&shared.join("skill-plaza"), id)
        || skill_md_exists(&shared.join("skill-catalog"), id)
        || review_exists(&shared.join("skill-catalog"), id)
    {
        return true;
    }
    let Ok(users) = std::fs::read_dir(config.install_root_dir().join("users")) else {
        return false;
    };
    for user in users.flatten() {
        if !user.path().is_dir() {
            continue;
        }
        let Ok(agents) = std::fs::read_dir(user.path().join("agents")) else {
            continue;
        };
        for agent in agents.flatten() {
            if skill_md_exists(&agent.path().join("workspace").join("skills"), id) {
                return true;
            }
        }
    }
    false
}

fn skill_md_exists(root: &Path, id: &str) -> bool {
    if root.join(id).join("SKILL.md").is_file() {
        return true;
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return false;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if name.eq_ignore_ascii_case(id) && path.join("SKILL.md").is_file() {
            return true;
        }
    }
    false
}

fn review_exists(catalog: &Path, id: &str) -> bool {
    if catalog.join(format!("{id}.review.json")).is_file() {
        return true;
    }
    let Ok(entries) = std::fs::read_dir(catalog) else {
        return false;
    };
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if name.eq_ignore_ascii_case(&format!("{id}.review.json")) && entry.path().is_file() {
            return true;
        }
    }
    false
}

fn lock_seq(file: &std::fs::File) -> std::io::Result<()> {
    use std::os::unix::io::AsRawFd;
    let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) };
    if rc == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

struct SeqUnlock(std::os::unix::io::RawFd);

impl Drop for SeqUnlock {
    fn drop(&mut self) {
        unsafe {
            libc::flock(self.0, libc::LOCK_UN);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skills::load_skills_for_agent_from_config;

    fn enabled_config(root: &Path, max_skills: usize) -> Config {
        let mut config = Config::default();
        config.config_path = root.join("config.toml");
        config.skills.skill_creation.enabled = true;
        config.skills.skill_creation.max_skills = max_skills;
        config
    }

    fn two_calls() -> Vec<ToolCallRecord> {
        vec![
            ToolCallRecord {
                name: "shell".into(),
                args: serde_json::json!({"cmd": "build"}),
            },
            ToolCallRecord {
                name: "http".into(),
                args: serde_json::json!({"token": "AKIAIOSFODNN7EXAMPLE"}),
            },
        ]
    }

    #[tokio::test]
    async fn logged_in_turn_writes_a_personal_skill_the_owner_can_load() {
        let tmp = tempfile::TempDir::new().unwrap();
        let config = enabled_config(tmp.path(), 500);
        let id = create_from_turn(&config, "alice", "hbcdc", "汇总本周流感", &two_calls())
            .unwrap()
            .expect("two tool calls create a skill");
        assert_eq!(id, "ps0001");

        let path = config
            .user_workspace_dir("alice", "hbcdc")
            .join("skills")
            .join("ps0001")
            .join("SKILL.md");
        let markdown = std::fs::read_to_string(&path).unwrap();
        assert!(markdown.contains("name: 汇总本周流感"));
        assert!(markdown.contains("author: zeroclaw-auto"));
        assert!(markdown.contains("`shell`"));
        assert!(!markdown.contains("AKIAIOSFODNN7EXAMPLE"));
        assert!(markdown.contains("[REDACTED_AWS_CREDENTIAL]"));
        assert!(
            !config
                .user_workspace_dir("bob", "hbcdc")
                .join("skills")
                .exists()
        );

        let alice = zeroclaw_api::TOOL_LOOP_USER_ATTRS
            .scope(Some(zeroclaw_api::UserAttrs::new("alice")), async {
                load_skills_for_agent_from_config(&config, "hbcdc")
            })
            .await;
        assert!(alice.iter().any(|skill| skill.name == "ps0001"));
        let bob = zeroclaw_api::TOOL_LOOP_USER_ATTRS
            .scope(Some(zeroclaw_api::UserAttrs::new("bob")), async {
                load_skills_for_agent_from_config(&config, "hbcdc")
            })
            .await;
        assert!(!bob.iter().any(|skill| skill.name == "ps0001"));
    }

    #[test]
    fn second_skill_keeps_a_hand_written_skill_and_the_newest_auto_skill() {
        let tmp = tempfile::TempDir::new().unwrap();
        let config = enabled_config(tmp.path(), 1);
        let notes = config
            .user_workspace_dir("alice", "hbcdc")
            .join("skills")
            .join("notes");
        std::fs::create_dir_all(&notes).unwrap();
        std::fs::write(
            notes.join("SKILL.md"),
            "---\nname: 笔记\ndescription: 手写技能\n---\n\n# 笔记\n",
        )
        .unwrap();

        let first = create_from_turn(&config, "alice", "hbcdc", "第一次", &two_calls())
            .unwrap()
            .unwrap();
        assert_eq!(first, "ps0001");
        let second = create_from_turn(&config, "alice", "hbcdc", "第二次", &two_calls())
            .unwrap()
            .unwrap();
        assert_eq!(second, "ps0002");

        let root = config.user_workspace_dir("alice", "hbcdc").join("skills");
        assert!(notes.join("SKILL.md").is_file());
        assert!(!root.join("ps0001").exists());
        assert!(root.join("ps0002").join("SKILL.md").is_file());
    }

    #[test]
    fn allocation_skips_an_id_already_on_disk() {
        let tmp = tempfile::TempDir::new().unwrap();
        let config = enabled_config(tmp.path(), 500);
        let existing = config
            .user_workspace_dir("alice", "hbcdc")
            .join("skills")
            .join("ps0001");
        std::fs::create_dir_all(&existing).unwrap();
        std::fs::write(
            existing.join("SKILL.md"),
            "---\nname: 已有\ndescription: 已有\n---\n\n# 已有\n",
        )
        .unwrap();
        let id = create_from_turn(&config, "alice", "hbcdc", "新的操作", &two_calls())
            .unwrap()
            .unwrap();
        assert_eq!(id, "ps0002");
    }

    #[test]
    fn creation_stays_off_unless_skill_creation_is_enabled() {
        let tmp = tempfile::TempDir::new().unwrap();
        let mut config = Config::default();
        config.config_path = tmp.path().join("config.toml");
        assert!(!config.skills.skill_creation.enabled);
        let created =
            create_from_turn(&config, "alice", "hbcdc", "汇总本周流感", &two_calls()).unwrap();
        assert!(created.is_none());
        assert!(
            !config
                .user_workspace_dir("alice", "hbcdc")
                .join("skills")
                .exists()
        );
    }

    #[test]
    fn a_turn_without_a_platform_user_does_not_write_a_skill() {
        let tmp = tempfile::TempDir::new().unwrap();
        let config = enabled_config(tmp.path(), 500);
        let created =
            create_from_turn(&config, "  ", "hbcdc", "汇总本周流感", &two_calls()).unwrap();
        assert!(created.is_none());
        assert!(
            !config
                .user_workspace_dir("alice", "hbcdc")
                .join("skills")
                .exists()
        );
    }

    #[test]
    fn a_new_title_slug_takes_one_personal_id_and_reuses_it() {
        let tmp = tempfile::TempDir::new().unwrap();
        let config = enabled_config(tmp.path(), 500);
        let root = config.user_workspace_dir("alice", "hbcdc").join("skills");
        std::fs::create_dir_all(&root).unwrap();
        let first = personal_skill_directory(&config, &root, "hfmd-cluster-surveillance").unwrap();
        let second = personal_skill_directory(&config, &root, "hfmd-cluster-surveillance").unwrap();
        assert_eq!(first, root.join("ps0001"));
        assert_eq!(second, first);
        assert!(!root.join("hfmd-cluster-surveillance").exists());
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

    #[test]
    fn an_existing_skill_directory_keeps_its_name() {
        let tmp = tempfile::TempDir::new().unwrap();
        let config = enabled_config(tmp.path(), 500);
        let root = config.user_workspace_dir("alice", "hbcdc").join("skills");
        let notes = root.join("notes");
        std::fs::create_dir_all(&notes).unwrap();
        std::fs::write(
            notes.join("SKILL.md"),
            "---\nname: 笔记\ndescription: 手写技能\n---\n\n# 笔记\n",
        )
        .unwrap();
        let dir = personal_skill_directory(&config, &root, "notes").unwrap();
        assert_eq!(dir, notes);
        assert!(
            !config
                .install_root_dir()
                .join("shared")
                .join("personal-skill-seq")
                .exists()
        );
    }

    #[test]
    fn a_just_written_slug_directory_is_renamed_to_the_personal_id() {
        let tmp = tempfile::TempDir::new().unwrap();
        let config = enabled_config(tmp.path(), 500);
        let root = config.user_workspace_dir("alice", "hbcdc").join("skills");
        let slug = root.join("hfmd-cluster-surveillance");
        std::fs::create_dir_all(&slug).unwrap();
        std::fs::write(
            slug.join("SKILL.md"),
            "---\nname: 手足口\ndescription: 研判\n---\n\n# 研判\n",
        )
        .unwrap();
        let (previous, id) = claim_fresh_personal_skill(&config, &root, &slug).unwrap();
        assert_eq!(previous, "hfmd-cluster-surveillance");
        assert_eq!(id, "ps0001");
        assert!(!slug.exists());
        assert!(root.join("ps0001").join("SKILL.md").is_file());
    }

    #[test]
    fn one_tool_call_does_not_create_a_skill() {
        let tmp = tempfile::TempDir::new().unwrap();
        let config = enabled_config(tmp.path(), 500);
        let created =
            create_from_turn(&config, "alice", "hbcdc", "只调了一次", &two_calls()[..1]).unwrap();
        assert!(created.is_none());
        assert!(
            !config
                .user_workspace_dir("alice", "hbcdc")
                .join("skills")
                .exists()
        );
    }
}
