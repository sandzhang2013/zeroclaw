//! macOS sandbox-exec (Seatbelt) sandbox backend.

use crate::security::traits::Sandbox;
use std::path::{Path, PathBuf};
use std::process::Command;

pub(super) const SANDBOX_EXEC_PATH: &str = "/usr/bin/sandbox-exec";

#[derive(Debug, Clone)]
pub struct SeatbeltSandbox {
    /// Directory where per-session policy files are stored.
    policy_dir: PathBuf,
    /// Path to the generated policy file for this session.
    policy_path: PathBuf,
}

impl SeatbeltSandbox {
    /// Create a new Seatbelt sandbox, generating a per-session policy file.
    /// Returns an error if `sandbox-exec` is not available or the policy file
    /// cannot be written.
    pub fn new() -> std::io::Result<Self> {
        Self::with_workspace(None)
    }

    /// Create a new Seatbelt sandbox for the provided workspace root.
    /// If no workspace is provided, falls back to the process current
    /// directory for compatibility with direct construction.
    pub fn with_workspace(workspace: Option<&Path>) -> std::io::Result<Self> {
        Self::with_roots(workspace, &[], &[], &[])
    }

    /// Workspace plus the same extra-root tiers `SecurityPolicy` grants
    /// `file_read` / `file_write`. Session cwd is the write jail; skill
    /// directories typically arrive as read-only or read-write extras.
    pub fn with_roots(
        workspace: Option<&Path>,
        read_write: &[PathBuf],
        read_only: &[PathBuf],
        write_only: &[PathBuf],
    ) -> std::io::Result<Self> {
        if !Self::is_installed() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "sandbox-exec not found (requires macOS)",
            ));
        }

        let policy_dir = std::env::temp_dir().join("zeroclaw-seatbelt");
        std::fs::create_dir_all(&policy_dir)?;

        let session_id = uuid::Uuid::new_v4();
        let policy_path = policy_dir.join(format!("{session_id}.sb"));

        let workspace = workspace
            .map(Path::to_path_buf)
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/tmp")));
        let policy = generate_policy_with_roots(&workspace, read_write, read_only, write_only);
        std::fs::write(&policy_path, &policy)?;

        Ok(Self {
            policy_dir,
            policy_path,
        })
    }

    /// Probe if sandbox-exec is available (for auto-detection).
    pub fn probe() -> std::io::Result<Self> {
        Self::new()
    }

    /// Check if `sandbox-exec` is available on this system.
    fn is_installed() -> bool {
        Path::new(SANDBOX_EXEC_PATH).is_file()
    }

    /// Return the path to the generated policy file.
    pub fn policy_path(&self) -> &Path {
        &self.policy_path
    }

    /// Return the policy directory path.
    pub fn policy_dir(&self) -> &Path {
        &self.policy_dir
    }
}

impl Drop for SeatbeltSandbox {
    fn drop(&mut self) {
        // Clean up the per-session policy file
        let _ = std::fs::remove_file(&self.policy_path);
    }
}

impl Sandbox for SeatbeltSandbox {
    fn wrap_command(&self, cmd: &mut Command) -> std::io::Result<()> {
        let program = cmd.get_program().to_string_lossy().to_string();
        let args: Vec<String> = cmd
            .get_args()
            .map(|s| s.to_string_lossy().to_string())
            .collect();
        let current_dir = cmd.get_current_dir().map(Path::to_path_buf);

        // Use the same fixed system binary checked by availability detection.
        // Resolving a bare name through PATH would happen before Seatbelt is
        // active and could select an attacker-controlled workspace executable.
        let mut sandbox_cmd = Command::new(SANDBOX_EXEC_PATH);
        sandbox_cmd.arg("-f");
        sandbox_cmd.arg(&self.policy_path);
        sandbox_cmd.arg(&program);
        sandbox_cmd.args(&args);
        if let Some(current_dir) = current_dir {
            sandbox_cmd.current_dir(current_dir);
        }

        *cmd = sandbox_cmd;
        Ok(())
    }

    fn is_available(&self) -> bool {
        Self::is_installed() && self.policy_path.exists()
    }

    fn name(&self) -> &str {
        "sandbox-exec"
    }

    fn description(&self) -> &str {
        "macOS Seatbelt sandbox (built-in sandbox-exec)"
    }
}

fn seatbelt_string_literal(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '\\' => escaped.push_str(r"\\"),
            '"' => escaped.push_str(r#"\""#),
            '\n' => escaped.push_str(r"\n"),
            '\r' => escaped.push_str(r"\r"),
            '\t' => escaped.push_str(r"\t"),
            c if c.is_control() => escaped.push('?'),
            c => escaped.push(c),
        }
    }
    escaped
}

fn generate_policy(workspace: &Path) -> String {
    generate_policy_with_roots(workspace, &[], &[], &[])
}

fn seatbelt_subpath(path: &Path) -> Option<String> {
    if path.as_os_str().is_empty() {
        return None;
    }
    let rendered = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    Some(seatbelt_string_literal(&rendered.to_string_lossy()))
}

fn extra_root_rules(kind: &str, paths: &[&Path]) -> String {
    let mut out = String::new();
    for path in paths {
        let Some(literal) = seatbelt_subpath(path) else {
            continue;
        };
        out.push_str(&format!("(allow file-{kind}* (subpath \"{literal}\"))\n"));
    }
    out
}

fn generate_policy_with_roots(
    workspace: &Path,
    read_write: &[PathBuf],
    read_only: &[PathBuf],
    write_only: &[PathBuf],
) -> String {
    let workspace_str = seatbelt_string_literal(&workspace.to_string_lossy());
    let read_paths: Vec<&Path> = read_only
        .iter()
        .chain(read_write.iter())
        .map(PathBuf::as_path)
        .collect();
    let write_paths: Vec<&Path> = read_write
        .iter()
        .chain(write_only.iter())
        .map(PathBuf::as_path)
        .collect();
    let extra_reads = extra_root_rules("read", &read_paths);
    let extra_writes = extra_root_rules("write", &write_paths);
    format!(
        r#"(version 1)

;; Deny everything by default
(deny default)

;; ── Process execution ──────────────────────────────────────
;; Allow basic process operations needed for command execution
(allow process-exec)
(allow process-fork)
(allow signal (target self))

;; ── Filesystem reads ───────────────────────────────────────
;; Allow reading system libraries, frameworks, and executables
(allow file-read*
    (subpath "/usr")
    (subpath "/bin")
    (subpath "/sbin")
    (subpath "/Library")
    (subpath "/System")
    (subpath "/private/var")
    (subpath "/dev")
    (subpath "/etc")
    (subpath "/Applications")
    (subpath "/opt")
    (subpath "/nix")
    (literal "/")
    (subpath "/var"))

;; Allow reading the workspace
(allow file-read* (subpath "{workspace}"))
{extra_reads}
;; Allow reading temp directories (needed for policy file itself)
(allow file-read* (subpath "/tmp"))
(allow file-read* (subpath "/private/tmp"))
(allow file-read*
    (regex #"^/private/var/folders/"))

;; Allow reading user home for tool configs
(allow file-read*
    (regex #"^/Users/[^/]+/\\."))

;; ── Filesystem writes ──────────────────────────────────────
;; Only allow writes to workspace and temp directories
(allow file-write*
    (subpath "{workspace}"))
{extra_writes}(allow file-write*
    (subpath "/tmp")
    (subpath "/private/tmp"))
(allow file-write*
    (regex #"^/private/var/folders/"))
(allow file-write* (subpath "/dev/null"))
(allow file-write* (subpath "/dev/tty"))

;; ── Network ────────────────────────────────────────────────
;; Deny all network by default (inherited from deny default)
;; Allow DNS resolution only
(allow network-outbound
    (remote unix-socket (path-literal "/var/run/mDNSResponder")))
(allow system-socket)

;; Allow localhost connections only (for local dev servers).
;; Note: macOS sandbox-exec only accepts "localhost:*" or "*:port" in
;; (remote ip ...) filters — raw IP addresses cause the entire policy
;; to fail to parse.
(allow network-outbound
    (remote ip "localhost:*"))

;; ── Mach / IPC ─────────────────────────────────────────────
;; Allow basic mach services needed for process execution
(allow mach-lookup
    (global-name "com.apple.system.logger")
    (global-name "com.apple.system.notification_center")
    (global-name "com.apple.SecurityServer")
    (global-name "com.apple.CoreServices.coreservicesd"))

;; ── Sysctl / misc ──────────────────────────────────────────
(allow sysctl-read)
(allow mach-task-name)
"#,
        workspace = workspace_str,
        extra_reads = extra_reads,
        extra_writes = extra_writes,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seatbelt_sandbox_name() {
        let sandbox = SeatbeltSandbox {
            policy_dir: PathBuf::from("/tmp/test-seatbelt"),
            policy_path: PathBuf::from("/tmp/test-seatbelt/test.sb"),
        };
        assert_eq!(sandbox.name(), "sandbox-exec");
    }

    #[test]
    fn seatbelt_description_mentions_macos() {
        let sandbox = SeatbeltSandbox {
            policy_dir: PathBuf::from("/tmp/test-seatbelt"),
            policy_path: PathBuf::from("/tmp/test-seatbelt/test.sb"),
        };
        assert!(sandbox.description().contains("macOS"));
        assert!(sandbox.description().contains("Seatbelt"));
    }

    #[test]
    fn generate_policy_contains_workspace_path() {
        let workspace = PathBuf::from("/Users/test/project");
        let policy = generate_policy(&workspace);
        assert!(policy.contains("/Users/test/project"));
    }

    #[test]
    fn generate_policy_escapes_workspace_path_string_literal() {
        let workspace = PathBuf::from("/tmp/zc\"quote\\slash\nnewline");
        let policy = generate_policy(&workspace);

        assert!(policy.contains(r#"(subpath "/tmp/zc\"quote\\slash\nnewline")"#));
        assert!(!policy.contains("zc\"quote\\slash\nnewline"));
    }

    #[test]
    fn generate_policy_uses_provided_workspace_for_access_rules() {
        let workspace = PathBuf::from("/tmp/zeroclaw-seatbelt-test-workspace");
        let policy = generate_policy(&workspace);

        assert!(
            policy.contains(
                r#"(allow file-read* (subpath "/tmp/zeroclaw-seatbelt-test-workspace"))"#
            )
        );
        assert!(policy.contains(r#"(subpath "/tmp/zeroclaw-seatbelt-test-workspace")"#));
    }

    #[test]
    fn generate_policy_denies_by_default() {
        let workspace = PathBuf::from("/tmp/workspace");
        let policy = generate_policy(&workspace);
        assert!(policy.contains("(deny default)"));
    }

    #[test]
    fn generate_policy_allows_workspace_writes() {
        let workspace = PathBuf::from("/home/user/code");
        let policy = generate_policy(&workspace);
        assert!(policy.contains("(allow file-write*"));
        assert!(policy.contains("/home/user/code"));
    }

    #[test]
    fn generate_policy_restricts_network() {
        let workspace = PathBuf::from("/tmp/workspace");
        let policy = generate_policy(&workspace);
        assert!(policy.contains("localhost"));
        assert!(!policy.contains("127.0.0.1"));
        assert!(!policy.contains("(allow network*)"));
    }

    #[test]
    fn generate_policy_allows_system_reads() {
        let workspace = PathBuf::from("/tmp/workspace");
        let policy = generate_policy(&workspace);
        assert!(policy.contains("(subpath \"/usr\")"));
        assert!(policy.contains("(subpath \"/bin\")"));
        assert!(policy.contains("(subpath \"/System\")"));
    }

    #[test]
    fn generate_policy_allows_process_execution() {
        let workspace = PathBuf::from("/tmp/workspace");
        let policy = generate_policy(&workspace);
        assert!(policy.contains("(allow process-exec)"));
        assert!(policy.contains("(allow process-fork)"));
    }

    #[test]
    fn seatbelt_wrap_command_prepends_sandbox_exec() {
        let dir = tempfile::tempdir().unwrap();
        let policy_path = dir.path().join("test.sb");
        std::fs::write(&policy_path, "(version 1)\n(deny default)").unwrap();

        let sandbox = SeatbeltSandbox {
            policy_dir: dir.path().to_path_buf(),
            policy_path: policy_path.clone(),
        };

        let mut cmd = Command::new("echo");
        cmd.arg("hello");
        sandbox.wrap_command(&mut cmd).unwrap();

        assert_eq!(cmd.get_program(), SANDBOX_EXEC_PATH);
        let args: Vec<String> = cmd
            .get_args()
            .map(|s| s.to_string_lossy().to_string())
            .collect();
        assert!(args.contains(&"-f".to_string()));
        assert!(args.contains(&policy_path.to_string_lossy().to_string()));
        assert!(args.contains(&"echo".to_string()));
        assert!(args.contains(&"hello".to_string()));
    }

    #[test]
    fn seatbelt_wrap_command_preserves_original_args() {
        let dir = tempfile::tempdir().unwrap();
        let policy_path = dir.path().join("test.sb");
        std::fs::write(&policy_path, "(version 1)").unwrap();

        let sandbox = SeatbeltSandbox {
            policy_dir: dir.path().to_path_buf(),
            policy_path,
        };

        let mut cmd = Command::new("ls");
        cmd.arg("-la");
        cmd.arg("/workspace");
        sandbox.wrap_command(&mut cmd).unwrap();

        let args: Vec<String> = cmd
            .get_args()
            .map(|s| s.to_string_lossy().to_string())
            .collect();

        assert!(
            args.contains(&"ls".to_string()),
            "original program must be passed as argument"
        );
        assert!(
            args.contains(&"-la".to_string()),
            "original args must be preserved"
        );
        assert!(
            args.contains(&"/workspace".to_string()),
            "original args must be preserved"
        );
    }

    #[test]
    fn seatbelt_wrap_command_preserves_current_dir() {
        let dir = tempfile::tempdir().unwrap();
        let policy_path = dir.path().join("test.sb");
        std::fs::write(&policy_path, "(version 1)").unwrap();

        let sandbox = SeatbeltSandbox {
            policy_dir: dir.path().to_path_buf(),
            policy_path,
        };
        let workspace = dir.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();

        let mut cmd = Command::new("pwd");
        cmd.current_dir(&workspace);
        sandbox.wrap_command(&mut cmd).unwrap();

        assert_eq!(cmd.get_current_dir(), Some(workspace.as_path()));
    }

    #[test]
    fn seatbelt_wrap_command_ignores_workspace_launcher_on_relative_path() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let policy_path = dir.path().join("test.sb");
        std::fs::write(&policy_path, "(version 1)").unwrap();
        let fake_launcher = dir.path().join("sandbox-exec");
        std::fs::write(&fake_launcher, "#!/bin/sh\nexit 99\n").unwrap();
        std::fs::set_permissions(&fake_launcher, std::fs::Permissions::from_mode(0o755)).unwrap();

        let sandbox = SeatbeltSandbox {
            policy_dir: dir.path().to_path_buf(),
            policy_path,
        };
        let mut cmd = Command::new("/bin/echo");
        cmd.arg("safe");
        cmd.current_dir(dir.path());
        cmd.env("PATH", ".:/usr/bin:/bin");
        sandbox.wrap_command(&mut cmd).unwrap();

        assert!(fake_launcher.is_file());
        assert_eq!(cmd.get_program(), SANDBOX_EXEC_PATH);
        assert_eq!(cmd.get_current_dir(), Some(dir.path()));
    }

    #[test]
    fn seatbelt_wrapped_command_executes_in_current_dir() {
        if !SeatbeltSandbox::is_installed() {
            return;
        }

        let workspace = tempfile::tempdir().unwrap();
        let sandbox = SeatbeltSandbox::with_workspace(Some(workspace.path())).unwrap();
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "pwd"]);
        cmd.current_dir(workspace.path());
        sandbox.wrap_command(&mut cmd).unwrap();

        let output = cmd.output().unwrap();
        assert!(
            output.status.success(),
            "sandboxed pwd failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let actual = PathBuf::from(String::from_utf8(output.stdout).unwrap().trim());
        assert_eq!(
            actual.canonicalize().unwrap(),
            workspace.path().canonicalize().unwrap()
        );
    }

    #[test]
    fn seatbelt_policy_file_cleanup_on_drop() {
        let dir = tempfile::tempdir().unwrap();
        let policy_path = dir.path().join("session.sb");
        std::fs::write(&policy_path, "(version 1)").unwrap();
        assert!(policy_path.exists());

        {
            let _sandbox = SeatbeltSandbox {
                policy_dir: dir.path().to_path_buf(),
                policy_path: policy_path.clone(),
            };
        }

        assert!(
            !policy_path.exists(),
            "policy file should be cleaned up on drop"
        );
    }

    #[test]
    fn seatbelt_new_fails_if_not_installed() {
        let result = SeatbeltSandbox::new();
        match result {
            Ok(sandbox) => {
                assert_eq!(sandbox.name(), "sandbox-exec");
                assert!(sandbox.policy_path().exists());
            }
            Err(e) => {
                assert!(
                    e.kind() == std::io::ErrorKind::NotFound
                        || e.kind() == std::io::ErrorKind::PermissionDenied
                );
            }
        }
    }

    #[test]
    fn seatbelt_is_available_checks_policy_file() {
        let dir = tempfile::tempdir().unwrap();
        let policy_path = dir.path().join("test.sb");

        let sandbox = SeatbeltSandbox {
            policy_dir: dir.path().to_path_buf(),
            policy_path: policy_path.clone(),
        };

        if Path::new(SANDBOX_EXEC_PATH).is_file() {
            assert!(
                !sandbox.is_available(),
                "should be false without policy file"
            );
        }

        std::fs::write(&policy_path, "(version 1)").unwrap();
        if Path::new(SANDBOX_EXEC_PATH).is_file() {
            assert!(sandbox.is_available(), "should be true with policy file");
        }
    }

    #[test]
    fn generate_policy_is_valid_sb_format() {
        let workspace = PathBuf::from("/tmp/workspace");
        let policy = generate_policy(&workspace);
        assert!(policy.starts_with("(version 1)"));
        let open = policy.chars().filter(|c| *c == '(').count();
        let close = policy.chars().filter(|c| *c == ')').count();
        assert_eq!(open, close, "parentheses must be balanced in .sb policy");
    }

    #[test]
    fn generate_policy_grants_skill_dir_read_without_write() {
        let workspace = PathBuf::from("/tmp/session-cwd");
        let skills = PathBuf::from("/tmp/agent-workspace/skills");
        let policy = generate_policy_with_roots(&workspace, &[], &[skills.clone()], &[]);
        assert!(policy.contains(r#"(allow file-read* (subpath "/tmp/agent-workspace/skills"))"#));
        assert!(!policy.contains(r#"(allow file-write* (subpath "/tmp/agent-workspace/skills"))"#));
        let open = policy.chars().filter(|c| *c == '(').count();
        let close = policy.chars().filter(|c| *c == ')').count();
        assert_eq!(open, close, "parentheses must be balanced in .sb policy");
    }

    #[test]
    fn generate_policy_grants_read_write_extra_root() {
        let workspace = PathBuf::from("/tmp/session-cwd");
        let agent = PathBuf::from("/tmp/agent-workspace");
        let policy = generate_policy_with_roots(&workspace, &[agent.clone()], &[], &[]);
        assert!(policy.contains(r#"(allow file-read* (subpath "/tmp/agent-workspace"))"#));
        assert!(policy.contains(r#"(allow file-write* (subpath "/tmp/agent-workspace"))"#));
    }

    #[test]
    fn seatbelt_can_read_skill_script_outside_session_cwd() {
        if !SeatbeltSandbox::is_installed() {
            return;
        }

        // tempfile lives under /var/folders, which the base policy already
        // allows. Use a path under the crate so session-only jail is real.
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("seatbelt-skill-{}", uuid::Uuid::new_v4()));
        let session = root.join("sessions").join("s1");
        let skills = root.join("skills").join("report");
        std::fs::create_dir_all(&session).unwrap();
        std::fs::create_dir_all(&skills).unwrap();
        let script = skills.join("gen.py");
        std::fs::write(&script, "print('ok')\n").unwrap();
        let script = script.canonicalize().unwrap();
        struct Cleanup(PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = Cleanup(root);

        let blocked = SeatbeltSandbox::with_workspace(Some(&session)).unwrap();
        let mut denied = Command::new("/bin/cat");
        denied.arg(&script);
        denied.current_dir(&session);
        blocked.wrap_command(&mut denied).unwrap();
        let denied_out = denied.output().unwrap();
        assert!(
            !denied_out.status.success(),
            "session-only seatbelt must not read the skill script"
        );

        let allowed =
            SeatbeltSandbox::with_roots(Some(&session), &[], &[skills.clone()], &[]).unwrap();
        let mut ok = Command::new("/bin/cat");
        ok.arg(&script);
        ok.current_dir(&session);
        allowed.wrap_command(&mut ok).unwrap();
        let ok_out = ok.output().unwrap();
        assert!(
            ok_out.status.success(),
            "skill-dir extra root must allow reading the script: {}",
            String::from_utf8_lossy(&ok_out.stderr)
        );
        assert_eq!(String::from_utf8_lossy(&ok_out.stdout), "print('ok')\n");
    }
}
