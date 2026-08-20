/** Parse Live Canvas tool args for workbench preview. */

export interface CanvasFramePreview {
  canvasId: string;
  contentType: string;
  content: string;
}

const CANVAS_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_CANVAS_CONTENT = 256 * 1024;

/** `canvas` render calls only. Unknown ids are ignored so we never fetch arbitrary paths. */
export function canvasIdFromToolArgs(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null;
  const o = args as Record<string, unknown>;
  if (o.action !== 'render') return null;
  const raw = typeof o.canvas_id === 'string' && o.canvas_id.trim() ? o.canvas_id.trim() : 'default';
  return CANVAS_ID_RE.test(raw) ? raw : null;
}

/** Chart HTML/SVG is already on the tool call; do not round-trip `/api/canvas` (pairing-gated). */
export function canvasFrameFromToolArgs(args: unknown): CanvasFramePreview | null {
  const canvasId = canvasIdFromToolArgs(args);
  if (!canvasId || !args || typeof args !== 'object') return null;
  const o = args as Record<string, unknown>;
  const contentType = typeof o.content_type === 'string' && o.content_type.trim()
    ? o.content_type.trim()
    : 'html';
  const content = typeof o.content === 'string' ? o.content : '';
  if (!content || content.length > MAX_CANVAS_CONTENT) return null;
  if (contentType !== 'html' && contentType !== 'svg') return null;
  return { canvasId, contentType, content };
}

export function canvasPreviewFromToolCall(toolCall?: {
  name?: string;
  args?: unknown;
  canvas?: CanvasFramePreview;
} | null): CanvasFramePreview | null {
  if (!toolCall) return null;
  if (toolCall.canvas) return toolCall.canvas;
  if (toolCall.name !== 'canvas') return null;
  return canvasFrameFromToolArgs(toolCall.args);
}
