/** Caps aligned with `AGENT_WORKSPACE_UPLOAD_CAP` and a Cursor-like attach bar. */
export const CHAT_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
export const CHAT_UPLOAD_MAX_FILES = 8;

const VISION_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

export function safeUploadFileName(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop()?.trim() || 'file';
  const cleaned = base.replace(/[^\w.\u4e00-\u9fff-]+/g, '_').replace(/^\.+/u, '_') || 'file';
  return cleaned.slice(0, 120);
}

export function uniqueUploadFileName(existing: Iterable<string>, name: string): string {
  const safe = safeUploadFileName(name);
  const taken = new Set(existing);
  if (!taken.has(safe)) return safe;
  const dot = safe.lastIndexOf('.');
  const stem = dot > 0 ? safe.slice(0, dot) : safe;
  const ext = dot > 0 ? safe.slice(dot) : '';
  let n = 2;
  while (taken.has(`${stem}-${n}${ext}`)) n += 1;
  return `${stem}-${n}${ext}`;
}

export function sessionUploadWorkspacePath(sessionId: string, filename: string): string {
  return `sessions/${sessionId}/uploads/${safeUploadFileName(filename)}`;
}

export function cwdRelativeUploadPath(filename: string): string {
  return `uploads/${safeUploadFileName(filename)}`;
}

export function isVisionImage(mime: string, filename: string): boolean {
  const m = (mime || '').toLowerCase();
  if (m.startsWith('image/') && m !== 'image/svg+xml') return true;
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return VISION_EXT.has(ext);
}

export function composeUploadMessage(
  text: string,
  files: Array<{ cwdRel: string; filename: string; mime: string }>,
): string {
  if (files.length === 0) return text.trim();
  const names = files.map((f) => f.filename).join('\n');
  const markers = files
    .flatMap((f) => {
      const rows = [`[FILE:${f.cwdRel}]`];
      if (isVisionImage(f.mime, f.filename)) rows.push(`[IMAGE:${f.cwdRel}]`);
      return rows;
    })
    .join('\n');
  const block = [names, markers].filter(Boolean).join('\n');
  const trimmed = text.trim();
  return trimmed ? `${trimmed}\n\n${block}` : block;
}

/** User-bubble text: filenames only. Path markers stay on the payload sent to the agent. */
export function displayUploadMessage(content: string): string {
  return content
    .replace(/\[IMAGE:[^\]]*\]/g, '')
    .replace(/\[FILE:[^\]]*\]/g, '')
    .replace(/Attached files \(paths are relative to the current session workspace\):\n?/g, '')
    .replace(/^- (?:uploads|sessions\/[^/\n]+\/uploads)\/(.+)$/gm, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
