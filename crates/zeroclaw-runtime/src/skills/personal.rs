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
