/** Pull images out of tool output so MCP trend charts render in the workbench. */

const IMAGE_MARKER_RE = /\[IMAGE:([^\]]+)\]/g;

export type ExtractedChatImage =
  | { kind: 'data'; src: string }
  | { kind: 'path'; path: string };

function isSvgMimeOrPath(mimeOrSrc: string, path = ''): boolean {
  const m = mimeOrSrc.toLowerCase();
  const p = path.toLowerCase();
  return m.includes('svg+xml') || m.startsWith('image/svg') || p.endsWith('.svg');
}

export function extractImageMarkers(text: string): ExtractedChatImage[] {
  const out: ExtractedChatImage[] = [];
  for (const match of text.matchAll(IMAGE_MARKER_RE)) {
    const inner = (match[1] ?? '').trim();
    if (!inner) continue;
    if (inner.startsWith('data:')) {
      if (!inner.startsWith('data:image/') || isSvgMimeOrPath(inner)) continue;
      out.push({ kind: 'data', src: inner });
      continue;
    }
    if (
      inner.startsWith('http://')
      || inner.startsWith('https://')
      || inner.startsWith('/')
      || inner.includes('..')
      || inner.includes('\\')
      || isSvgMimeOrPath('', inner)
    ) {
      continue;
    }
    out.push({ kind: 'path', path: inner });
  }
  return out;
}

function pushImagePart(row: Record<string, unknown>, out: ExtractedChatImage[]): void {
  const type = typeof row.type === 'string' ? row.type.toLowerCase() : '';
  if (type !== 'image') return;
  const mime = (
    (typeof row.mimeType === 'string' && row.mimeType)
    || (typeof row.mime_type === 'string' && row.mime_type)
    || ''
  ).trim();
  const data = typeof row.data === 'string' ? row.data.trim() : '';
  if (!data) return;
  if (isSvgMimeOrPath(mime, '')) return;
  if (data.startsWith('data:image/')) {
    if (isSvgMimeOrPath(data)) return;
    out.push({ kind: 'data', src: data });
    return;
  }
  if (!mime.startsWith('image/')) return;
  out.push({ kind: 'data', src: `data:${mime};base64,${data.replace(/\s/g, '')}` });
}

function walkMcpImages(value: unknown, out: ExtractedChatImage[]): void {
  if (!value) return;
  if (Array.isArray(value)) {
    for (const item of value) walkMcpImages(item, out);
    return;
  }
  if (typeof value !== 'object') return;
  const row = value as Record<string, unknown>;
  pushImagePart(row, out);
  for (const child of Object.values(row)) {
    if (child && typeof child === 'object') walkMcpImages(child, out);
  }
}

function parseLeadingJson(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/** MCP `tools/call` result: `{ content: [{ type: "image", mimeType, data }] }`. */
export function extractMcpToolImages(text: string): ExtractedChatImage[] {
  const parsed = parseLeadingJson(text);
  if (parsed == null) return [];
  const out: ExtractedChatImage[] = [];
  walkMcpImages(parsed, out);
  return out;
}

export function extractMcpToolText(text: string): string {
  const parsed = parseLeadingJson(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '';
  const content = (parsed as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (row.type !== 'text' || typeof row.text !== 'string') continue;
    const line = row.text.trim();
    if (line) parts.push(line);
  }
  return parts.join('\n');
}

export function extractToolImages(output: string | undefined): ExtractedChatImage[] {
  if (!output) return [];
  const mcp = extractMcpToolImages(output);
  if (mcp.length > 0) return mcp;
  return extractImageMarkers(output);
}

/** Cheap pre-check so chat filters skip a JSON.parse on every tool message. */
export function looksLikeChatImages(output: string | undefined): boolean {
  if (!output) return false;
  if (output.includes('[IMAGE:')) return true;
  const trimmed = output.trim();
  const lower = trimmed.toLowerCase();
  return (trimmed.startsWith('{') || trimmed.startsWith('['))
    && lower.includes('"image"')
    && lower.includes('"data"');
}

export function stripImageMarkers(text: string): string {
  return text.replace(IMAGE_MARKER_RE, '').trim();
}
