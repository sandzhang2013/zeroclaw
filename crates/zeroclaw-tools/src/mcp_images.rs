//! Persist MCP `tools/call` image parts into the session workspace so the
//! model history keeps a path, not a base64 blob.

use base64::Engine;
use serde_json::json;
use std::path::{Path, PathBuf};
use uuid::Uuid;
use zeroclaw_api::agent::guess_file_mime;
use zeroclaw_api::tool::ToolOutput;

const CHARTS_DIR: &str = "charts";
const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;
/// One MCP `tools/call` may persist at most this many raster images.
/// Matches the workbench attach-bar file cap so a single tool result cannot
/// fill the session workspace.
const MAX_IMAGES_PER_CALL: usize = 8;

struct McpImage {
    mime: String,
    bytes: Vec<u8>,
}

fn mime_of(row: &serde_json::Map<String, serde_json::Value>) -> String {
    row.get("mimeType")
        .or_else(|| row.get("mime_type"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string()
}

fn collect_images(value: &serde_json::Value, out: &mut Vec<McpImage>) {
    // Keep one extra slot so the caller can tell the result was truncated
    // without decoding the rest of a large payload.
    if out.len() > MAX_IMAGES_PER_CALL {
        return;
    }
    match value {
        serde_json::Value::Array(items) => {
            for item in items {
                collect_images(item, out);
                if out.len() > MAX_IMAGES_PER_CALL {
                    return;
                }
            }
        }
        serde_json::Value::Object(row) => {
            let type_name = row
                .get("type")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .to_ascii_lowercase();
            if type_name == "image"
                && out.len() <= MAX_IMAGES_PER_CALL
                && let Some(image) = decode_image_row(row)
            {
                out.push(image);
            }
            if out.len() > MAX_IMAGES_PER_CALL {
                return;
            }
            for child in row.values() {
                collect_images(child, out);
                if out.len() > MAX_IMAGES_PER_CALL {
                    return;
                }
            }
        }
        _ => {}
    }
}

fn decode_image_row(row: &serde_json::Map<String, serde_json::Value>) -> Option<McpImage> {
    let data = row.get("data").and_then(serde_json::Value::as_str)?.trim();
    if data.is_empty() {
        return None;
    }
    let (mime, payload) = if let Some(rest) = data.strip_prefix("data:") {
        let (declared, b64) = rest.split_once(";base64,")?;
        (declared.trim().to_string(), b64)
    } else {
        (mime_of(row), data)
    };
    if !mime.starts_with("image/") {
        return None;
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload.trim())
        .ok()?;
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return None;
    }
    if !is_persistable_raster_mime(&mime) {
        return None;
    }
    Some(McpImage { mime, bytes })
}

/// Raster charts only. SVG is XML and can carry script; it must not be saved
/// as an inline `image/svg+xml` preview.
fn is_persistable_raster_mime(mime: &str) -> bool {
    let base = mime
        .split(';')
        .next()
        .unwrap_or(mime)
        .trim()
        .to_ascii_lowercase();
    matches!(
        base.as_str(),
        "image/png" | "image/jpeg" | "image/jpg" | "image/gif" | "image/webp"
    )
}

fn collect_text(value: &serde_json::Value) -> String {
    let Some(content) = value.get("content").and_then(serde_json::Value::as_array) else {
        return String::new();
    };
    let mut parts = Vec::new();
    for item in content {
        let Some(row) = item.as_object() else {
            continue;
        };
        if row.get("type").and_then(serde_json::Value::as_str) != Some("text") {
            continue;
        }
        if let Some(text) = row.get("text").and_then(serde_json::Value::as_str) {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                parts.push(trimmed.to_string());
            }
        }
    }
    parts.join("\n")
}

fn ext_for_mime(mime: &str) -> &'static str {
    match mime.split(';').next().unwrap_or(mime).trim() {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => "png",
    }
}

fn safe_stem(tool_name: &str) -> String {
    let tail = tool_name.rsplit("__").next().unwrap_or(tool_name);
    let stem: String = tail
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(40)
        .collect();
    if stem.is_empty() {
        "chart".to_string()
    } else {
        stem
    }
}

fn has_image_parts(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Array(items) => items.iter().any(has_image_parts),
        serde_json::Value::Object(row) => {
            let type_name = row
                .get("type")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .to_ascii_lowercase();
            if type_name == "image"
                && row
                    .get("data")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|s| !s.trim().is_empty())
            {
                return true;
            }
            row.values().any(has_image_parts)
        }
        _ => false,
    }
}

/// Drop MCP image payloads from history when they cannot be saved.
pub fn mcp_history_without_images(raw_json: &str) -> Option<String> {
    let parsed: serde_json::Value = serde_json::from_str(raw_json.trim()).ok()?;
    if !has_image_parts(&parsed) {
        return None;
    }
    let caption = collect_text(&parsed);
    Some(if caption.is_empty() {
        "Tool returned a chart, but it was not saved to the workspace.".to_string()
    } else {
        caption
    })
}

/// Rewrite an MCP `tools/call` JSON result that contains image parts.
///
/// Returns `None` when there are no persistable images so callers keep the
/// original pretty-printed JSON. On success the LLM-facing text cites
/// `[IMAGE:charts/…]` relative paths and structured output uses `written: true`.
pub fn materialize_mcp_images(
    raw_json: &str,
    workspace_dir: &Path,
    tool_name: &str,
) -> Option<ToolOutput> {
    let parsed: serde_json::Value = serde_json::from_str(raw_json.trim()).ok()?;
    let mut images = Vec::new();
    collect_images(&parsed, &mut images);
    if images.is_empty() {
        return None;
    }
    let truncated = images.len() > MAX_IMAGES_PER_CALL;
    images.truncate(MAX_IMAGES_PER_CALL);

    let charts = workspace_dir.join(CHARTS_DIR);
    std::fs::create_dir_all(&charts).ok()?;
    if !charts.starts_with(workspace_dir) {
        return None;
    }

    let caption = collect_text(&parsed);
    let mut markers = Vec::new();
    let mut first_artifact: Option<(PathBuf, String, String, u64)> = None;

    for image in images {
        let ext = ext_for_mime(&image.mime);
        let filename = format!("{}-{}.{ext}", safe_stem(tool_name), Uuid::new_v4().simple());
        let abs = charts.join(&filename);
        if !abs.starts_with(workspace_dir) {
            continue;
        }
        if std::fs::write(&abs, &image.bytes).is_err() {
            continue;
        }
        let rel = format!("{CHARTS_DIR}/{filename}");
        markers.push(format!("[IMAGE:{rel}]"));
        if first_artifact.is_none() {
            first_artifact = Some((
                abs,
                filename,
                if image.mime.is_empty() {
                    guess_file_mime(&rel)
                } else {
                    image.mime
                },
                image.bytes.len() as u64,
            ));
        }
    }

    if markers.is_empty() {
        return None;
    }

    let title = caption.lines().next().unwrap_or("").trim().to_string();
    let mut text = if caption.is_empty() {
        "Chart saved to the workspace.".to_string()
    } else {
        caption
    };
    text.push('\n');
    text.push_str(&markers.join("\n"));
    if truncated {
        text.push_str(&format!(
            "\nOnly the first {MAX_IMAGES_PER_CALL} images were saved."
        ));
    }

    let Some((path, filename, mime, bytes)) = first_artifact else {
        return Some(ToolOutput::text(text));
    };
    let display_title = if title.is_empty() {
        filename.clone()
    } else {
        title
    };
    Some(ToolOutput::json_with_text(
        json!({
            "written": true,
            "path": path.to_string_lossy(),
            "filename": filename,
            "title": display_title,
            "mimeType": mime,
            "bytes": bytes,
        }),
        text,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const TINY_PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    #[test]
    fn leaves_text_only_results_untouched() {
        let raw = serde_json::to_string_pretty(&json!({
            "content": [{ "type": "text", "text": "ok" }]
        }))
        .unwrap();
        let dir = tempfile::tempdir().unwrap();
        assert!(
            materialize_mcp_images(&raw, dir.path(), "disease-report__list_diseases").is_none()
        );
    }

    #[test]
    fn writes_image_and_keeps_relative_marker() {
        let raw = serde_json::to_string_pretty(&json!({
            "content": [
                { "type": "text", "text": "湖北省新冠趋势" },
                { "type": "image", "mimeType": "image/png", "data": TINY_PNG }
            ]
        }))
        .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let out = materialize_mcp_images(&raw, dir.path(), "disease-report__trend_chart")
            .expect("image should materialize");
        assert!(out.as_str().contains("湖北省新冠趋势"));
        assert!(out.as_str().contains("[IMAGE:charts/"));
        assert!(
            !out.as_str().contains(TINY_PNG),
            "base64 must not remain in history text"
        );
        let data = out.data().expect("written artifact");
        assert_eq!(data["written"], json!(true));
        assert_eq!(data["title"], json!("湖北省新冠趋势"));
        let path = data["path"].as_str().expect("path");
        assert!(Path::new(path).exists());
        assert!(path.contains("/charts/"));
        assert_eq!(data["mimeType"], json!("image/png"));
    }

    #[test]
    fn caps_images_written_per_call() {
        let content: Vec<serde_json::Value> = (0..MAX_IMAGES_PER_CALL + 1)
            .map(|_| {
                json!({
                    "type": "image",
                    "mimeType": "image/png",
                    "data": TINY_PNG
                })
            })
            .collect();
        let raw = serde_json::to_string(&json!({ "content": content })).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let out = materialize_mcp_images(&raw, dir.path(), "trend_chart")
            .expect("capped images should still materialize");
        assert_eq!(
            out.as_str().matches("[IMAGE:charts/").count(),
            MAX_IMAGES_PER_CALL
        );
        assert!(out.as_str().contains(&format!(
            "Only the first {MAX_IMAGES_PER_CALL} images were saved."
        )));
        let written = std::fs::read_dir(dir.path().join(CHARTS_DIR))
            .unwrap()
            .count();
        assert_eq!(written, MAX_IMAGES_PER_CALL);
        assert!(
            !out.as_str().contains(TINY_PNG),
            "base64 must not remain in history text"
        );
    }

    #[test]
    fn rejects_oversized_image() {
        let huge = "A".repeat(MAX_IMAGE_BYTES * 2);
        let raw = serde_json::to_string(&json!({
            "content": [{ "type": "image", "mimeType": "image/png", "data": huge }]
        }))
        .unwrap();
        let dir = tempfile::tempdir().unwrap();
        assert!(materialize_mcp_images(&raw, dir.path(), "trend_chart").is_none());
        let stripped = mcp_history_without_images(&raw).expect("oversized image still stripped");
        assert!(!stripped.contains(&huge));
        assert!(!stripped.contains("image/png"));
    }

    #[test]
    fn refuses_svg_xml_images() {
        let svg = "PHN2Zy48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+";
        let raw = serde_json::to_string(&json!({
            "content": [{ "type": "image", "mimeType": "image/svg+xml", "data": svg }]
        }))
        .unwrap();
        let dir = tempfile::tempdir().unwrap();
        assert!(materialize_mcp_images(&raw, dir.path(), "trend_chart").is_none());
        assert!(!dir.path().join("charts").exists());
        let stripped = mcp_history_without_images(&raw).expect("svg payload stripped");
        assert!(!stripped.contains(svg));
        assert!(!stripped.contains("image/svg+xml"));
    }

    #[test]
    fn refuses_svg_data_uri_images() {
        let raw = serde_json::to_string(&json!({
            "content": [{
                "type": "image",
                "data": "data:image/svg+xml;base64,PHN2Zy48L3N2Zz4="
            }]
        }))
        .unwrap();
        let dir = tempfile::tempdir().unwrap();
        assert!(materialize_mcp_images(&raw, dir.path(), "trend_chart").is_none());
    }

    #[test]
    fn strips_unsaved_image_from_history() {
        let raw = serde_json::to_string_pretty(&json!({
            "content": [
                { "type": "text", "text": "趋势图" },
                { "type": "image", "mimeType": "image/png", "data": TINY_PNG }
            ]
        }))
        .unwrap();
        let stripped = mcp_history_without_images(&raw).expect("image payload stripped");
        assert_eq!(stripped, "趋势图");
        assert!(!stripped.contains(TINY_PNG));
    }
}
