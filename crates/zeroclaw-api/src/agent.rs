use std::path::Path;

use crate::plan::PlanEntry;

/// Guess a MIME type from a filename. Used for workspace file cards and the
/// raw-file HTTP response. Unknown extensions stay `application/octet-stream`.
#[must_use]
pub fn guess_file_mime(filename: &str) -> String {
    let ext = Path::new(filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        // SVG can carry script. Never advertise it as an inline image type.
        "svg" => "application/octet-stream",
        "pdf" => "application/pdf",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "doc" => "application/msword",
        "xls" => "application/vnd.ms-excel",
        "ppt" => "application/vnd.ms-powerpoint",
        "txt" | "md" => "text/plain",
        "json" => "application/json",
        "csv" => "text/csv",
        _ => "application/octet-stream",
    }
    .to_string()
}

/// Structured metadata for a tool that produced a file artifact (e.g.
/// `deliver_file` or `file_write`). Carried on [`TurnEvent::ToolResult`] so a
/// channel attaches the file from typed fields instead of parsing a text
/// trailer out of the free-form `output` string. Trailer parsing let a crafted
/// filename forge the delivered path (arbitrary-file-read / confused-deputy class).
#[derive(Debug, Clone, PartialEq)]
pub struct ToolArtifact {
    /// Absolute path of the delivered file on the agent host.
    pub path: String,
    /// Stable citation URI the client can reference (e.g. `attachment://…`).
    pub uri: String,
    /// Original filename.
    pub filename: String,
    /// Human-readable chat label; defaults to the filename.
    pub title: String,
    /// MIME type.
    pub mime: String,
    /// Size in bytes.
    pub size: u64,
}

impl ToolArtifact {
    /// Build from a tool's structured `output_data` when it declares a delivered
    /// file (`delivered: true` with a non-empty `path`) or a workspace write
    /// (`written: true`). Returns `None` for any other structured output.
    pub fn from_output_data(data: &serde_json::Value) -> Option<Self> {
        Self::from_flagged_file(data, "delivered")
            .or_else(|| Self::from_flagged_file(data, "written"))
    }

    /// ACP `deliver_file` convention (`delivered: true`). Prefer
    /// [`Self::from_output_data`] at new call sites.
    pub fn from_delivered_data(data: &serde_json::Value) -> Option<Self> {
        Self::from_flagged_file(data, "delivered")
    }

    fn from_flagged_file(data: &serde_json::Value, flag: &str) -> Option<Self> {
        if data.get(flag).and_then(serde_json::Value::as_bool) != Some(true) {
            return None;
        }
        let field = |key: &str| {
            data.get(key)
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_string()
        };
        let path = field("path");
        if path.is_empty() {
            return None;
        }
        let filename = {
            let named = field("filename");
            if named.is_empty() {
                Path::new(&path)
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default()
            } else {
                named
            }
        };
        let title = {
            let titled = field("title");
            if titled.is_empty() {
                filename.clone()
            } else {
                titled
            }
        };
        let mime = {
            let declared = field("mimeType");
            if declared.is_empty() {
                guess_file_mime(&filename)
            } else {
                declared
            }
        };
        Some(Self {
            uri: field("uri"),
            filename,
            title,
            mime,
            size: data
                .get("bytes")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0),
            path,
        })
    }
}

#[derive(Debug, Clone)]
pub enum TurnEvent {
    /// A text chunk from the LLM response (may arrive many times).
    Chunk {
        delta: String,
    },
    /// A reasoning/thinking chunk from a thinking model (may arrive many times).
    Thinking {
        delta: String,
    },
    /// The agent is invoking a tool.
    ToolCall {
        /// Stable correlation ID shared with the matching [`TurnEvent::ToolResult`].
        id: String,
        name: String,
        args: serde_json::Value,
    },
    /// A tool has returned a result.
    ToolResult {
        /// Stable correlation ID shared with the originating [`TurnEvent::ToolCall`].
        id: String,
        name: String,
        output: String,
        /// Typed metadata for a file-producing tool (e.g. `deliver_file`), so
        /// channels attach the file structurally instead of parsing `output`.
        /// `None` for ordinary tools.
        artifact: Option<ToolArtifact>,
    },
    Plan {
        entries: Vec<PlanEntry>,
    },
    ApprovalRequest {
        /// Correlation ID. The matching response frame must echo it.
        request_id: String,
        tool_name: String,
        /// Human-readable, secret-redacted summary of the tool arguments.
        /// Synthesised by `crate::approval::summarize_args`; never the raw
        /// `args` value.
        arguments_summary: String,
        /// How long the channel will wait before auto-denying.
        timeout_secs: u64,
    },
    /// Older whole turns were dropped to fit either the context token budget or
    /// the configured message limit. Surfaces a user-visible "context was cut
    /// here" marker so trimming is never silent. Emitted whenever a trim occurs.
    HistoryTrimmed {
        dropped_messages: usize,
        kept_turns: usize,
        reason: String,
    },
    /// Per-LLM-call token usage and cost; a turn may emit several, one per
    /// model call. `None` means "unavailable for this call", not zero.
    Usage {
        input_tokens: Option<u64>,
        /// Tokens served from the provider's prompt cache (e.g. Anthropic
        /// `cache_read_input_tokens`, OpenAI `cached_tokens`). These count
        /// toward the context window and must be added to `input_tokens` to
        /// get the true total context size.
        cached_input_tokens: Option<u64>,
        output_tokens: Option<u64>,
        cost_usd: Option<f64>,
    },
}

#[cfg(test)]
mod plan_event_tests {
    use super::*;
    use crate::plan::{PlanEntry, PlanPriority, PlanStatus};

    #[test]
    fn plan_turn_event_carries_entries() {
        let ev = TurnEvent::Plan {
            entries: vec![PlanEntry {
                content: "Step one".to_string(),
                status: PlanStatus::Pending,
                priority: PlanPriority::Medium,
                active_form: None,
            }],
        };
        match ev {
            TurnEvent::Plan { entries } => {
                assert_eq!(entries.len(), 1);
                assert_eq!(entries[0].content, "Step one");
            }
            _ => panic!("expected TurnEvent::Plan"),
        }
    }
}

#[cfg(test)]
mod tool_artifact_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn projects_delivered_data_into_typed_fields() {
        let data = json!({
            "delivered": true,
            "uri": "attachment://deliver/report.pdf",
            "path": "/ws/uploads/ab.pdf",
            "filename": "report.pdf",
            "title": "Quarterly report",
            "mimeType": "application/pdf",
            "bytes": 1234,
        });
        let a = ToolArtifact::from_delivered_data(&data).expect("delivered data yields artifact");
        assert_eq!(a.path, "/ws/uploads/ab.pdf");
        assert_eq!(a.uri, "attachment://deliver/report.pdf");
        assert_eq!(a.filename, "report.pdf");
        assert_eq!(a.title, "Quarterly report");
        assert_eq!(a.mime, "application/pdf");
        assert_eq!(a.size, 1234);
    }

    #[test]
    fn non_delivered_data_is_ignored() {
        // Ordinary structured tool output must not be mistaken for a file artifact.
        assert!(ToolArtifact::from_delivered_data(&json!({"result": 42})).is_none());
        assert!(
            ToolArtifact::from_delivered_data(&json!({"delivered": false, "path": "/x"})).is_none()
        );
    }

    #[test]
    fn delivered_without_path_is_ignored() {
        assert!(ToolArtifact::from_delivered_data(&json!({"delivered": true})).is_none());
        assert!(
            ToolArtifact::from_delivered_data(&json!({"delivered": true, "path": ""})).is_none()
        );
    }

    #[test]
    fn projects_file_write_data_without_confusing_deliver_file() {
        let data = json!({
            "written": true,
            "path": "/ws/sessions/s1/login.html",
            "filename": "login.html",
            "mimeType": "text/html",
            "bytes": 94,
        });
        let a = ToolArtifact::from_output_data(&data).expect("written file is an artifact");
        assert_eq!(a.path, "/ws/sessions/s1/login.html");
        assert_eq!(a.filename, "login.html");
        assert_eq!(a.mime, "text/html");
        assert_eq!(a.size, 94);
        assert!(a.uri.is_empty());
        assert!(ToolArtifact::from_delivered_data(&data).is_none());
    }

    #[test]
    fn guess_file_mime_covers_preview_and_office_types() {
        assert_eq!(guess_file_mime("a.HTML"), "text/html");
        assert_eq!(guess_file_mime("p.png"), "image/png");
        assert_eq!(guess_file_mime("icon.SVG"), "application/octet-stream");
        assert_eq!(guess_file_mime("r.pdf"), "application/pdf");
        assert!(guess_file_mime("t.docx").contains("wordprocessingml"));
        assert_eq!(guess_file_mime("x.bin"), "application/octet-stream");
        assert_eq!(guess_file_mime("a.htm"), "text/html");
        assert_eq!(guess_file_mime("p.jpeg"), "image/jpeg");
        assert_eq!(guess_file_mime("p.gif"), "image/gif");
        assert_eq!(guess_file_mime("p.webp"), "image/webp");
        assert!(guess_file_mime("a.xlsx").contains("spreadsheetml"));
        assert!(guess_file_mime("a.pptx").contains("presentationml"));
        assert_eq!(guess_file_mime("legacy.doc"), "application/msword");
        assert_eq!(guess_file_mime("noext"), "application/octet-stream");
    }
}
