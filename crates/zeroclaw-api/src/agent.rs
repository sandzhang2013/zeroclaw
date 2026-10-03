use crate::model_provider::ConversationMessage;
use std::path::Path;
use crate::plan::PlanEntry;
use std::fmt;

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

/// Provenance of a token count carried on a history-trim event. Lets clients
/// distinguish provider-reported usage from a local estimate and from a mix of
/// the two (the reported-budget trim path scales an estimate to a
/// provider-reported figure).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TokenCountSource {
    /// Count comes from provider-reported usage.
    Provider,
    /// Count is locally estimated.
    #[serde(rename = "estimate")]
    Estimated,
    /// Count is calibrated from provider-reported usage and a local estimate.
    Calibrated,
}

impl TokenCountSource {
    /// Wire value used by the WS, SSE, RPC, and ACP surfaces.
    pub fn as_str(&self) -> &'static str {
        match self {
            TokenCountSource::Provider => "provider",
            TokenCountSource::Estimated => "estimate",
            TokenCountSource::Calibrated => "calibrated",
        }
    }
}

#[non_exhaustive]
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
    /// the configured turn limit. Surfaces a user-visible "context was cut
    /// here" marker so trimming is never silent. Emitted whenever a trim occurs.
    HistoryTrimmed {
        dropped_messages: usize,
        dropped_turns: usize,
        kept_turns: usize,
        reason: String,
        /// Configured context token budget in effect at trim time. `None` for
        /// message-limit trims, which carry no token accounting.
        token_budget: Option<u64>,
        /// Token count before trimming.
        tokens_before: Option<u64>,
        /// Token count after trimming.
        tokens_after: Option<u64>,
        /// Provenance of `tokens_before`.
        tokens_before_source: Option<TokenCountSource>,
        /// Provenance of `tokens_after`.
        tokens_after_source: Option<TokenCountSource>,
        /// The retained provider-facing request cannot be brought under the
        /// configured budget because only the protected newest turn (plus
        /// tool schemas) remains. History MAY have been trimmed on the way to
        /// that floor, so this flag — not `dropped_messages == 0` — is the
        /// authoritative "unsatisfiable" signal. `None`/absent for ordinary
        /// trims.
        unsatisfiable_floor: Option<bool>,
        /// Native RPC-only provider context captured by the owning turn before
        /// the trim is announced. Wire and observer adapters deliberately
        /// ignore this field; it is never serialized as a turn event.
        retained_context: Option<RetainedContextSnapshot>,
    },
    /// Per-LLM-call token usage and cost; a turn may emit several, one per
    /// model call. `None` means "unavailable for this call", not zero.
    /// The `provider_ref` and `model` identify the provider and model used
    /// for cost attribution and context window resolution.
    ///
    /// For vision routing and reliable fallback, these carry the actual served
    /// provider and model. For dynamic routing models (e.g. `openrouter/auto`)
    /// where the provider selects the concrete model and the `ModelProvider`
    /// trait cannot expose the response-reported model, `model` carries the
    /// requested routing model (e.g. `openrouter/auto`) rather than the
    /// upstream-selected concrete model. This is a known limitation of the
    /// current provider trait.
    Usage {
        input_tokens: Option<u64>,
        /// Tokens served from the provider's prompt cache (e.g. Anthropic
        /// `cache_read_input_tokens`, OpenAI `cached_tokens`). Subset of
        /// `input_tokens` — adding would double-count.
        cached_input_tokens: Option<u64>,
        output_tokens: Option<u64>,
        cost_usd: Option<f64>,
        /// Proactive trim threshold resolved for the provider/model route that
        /// produced this usage sample. Zero means proactive trimming is disabled.
        context_token_budget: Option<u64>,
        /// Configured full context capacity for that same provider/model route.
        /// `None` means the runtime used the compatibility fallback because no
        /// authoritative capacity was configured.
        model_context_window: Option<u64>,
        /// The `<type>.<alias>` config reference of the provider that served
        /// this call. Used for accurate context window resolution and cost
        /// attribution when vision routing or provider switches are active.
        provider_ref: String,
        /// The model that actually served this call. When vision routing or
        /// a reliable fallback selects a different model, this carries the
        /// served model — not the turn-start model.
        model: String,
        /// Whether this usage event corresponds to the semantically accepted
        /// response (`true`) or a rejected physical attempt (`false`). Rejected
        /// attempts are billing-only telemetry; they do not update the accepted
        /// context snapshot (ACP session token count, context-meter ceiling).
        accepted: bool,
    },
}

/// Provider-facing context captured at a trim boundary. This remains attached
/// to the internal turn event so the serial RPC consumer can persist it before
/// forwarding the public trim notice without borrowing the live agent again.
#[derive(Clone)]
pub struct RetainedContextSnapshot {
    pub retained_messages: Vec<ConversationMessage>,
    pub breadcrumb: bool,
}

impl fmt::Debug for RetainedContextSnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RetainedContextSnapshot")
            .field("retained_messages", &self.retained_messages.len())
            .field("breadcrumb", &self.breadcrumb)
            .finish()
    }
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
