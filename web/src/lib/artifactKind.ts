export type ArtifactKind = 'html' | 'image' | 'pdf' | 'office' | 'other';

export interface ToolArtifactInfo {
  path: string;
  filename: string;
  title: string;
  mime: string;
  size: number;
}

const OFFICE_EXT = new Set(['docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt']);

function extOf(filename: string): string {
  const i = filename.lastIndexOf('.');
  return i >= 0 ? filename.slice(i + 1).toLowerCase() : '';
}

/** Classify a workspace file for native preview vs download. */
export function artifactKind(mime: string, filename: string): ArtifactKind {
  const m = (mime || '').toLowerCase();
  const ext = extOf(filename);
  if (m.startsWith('text/html') || ext === 'html' || ext === 'htm') return 'html';
  if (m.startsWith('image/svg') || m.includes('svg+xml') || ext === 'svg') return 'other';
  if (m.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) {
    return 'image';
  }
  if (m === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (m.includes('officedocument') || m.includes('msword') || m.includes('ms-excel')
    || m.includes('ms-powerpoint') || OFFICE_EXT.has(ext)) {
    return 'office';
  }
  return 'other';
}

/** Charts, pages, images, and PDFs that the workbench can show as a preview. */
export function isVisualArtifact(artifact?: ToolArtifactInfo | null): boolean {
  if (!artifact) return false;
  const kind = artifactKind(artifact.mime, artifact.filename);
  return kind === 'html' || kind === 'image' || kind === 'pdf';
}

/** Accept WS/API artifact JSON. Reject path traversal and host-absolute paths. */
export function parseToolArtifact(raw: unknown): ToolArtifactInfo | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const path = typeof o.path === 'string' ? o.path.trim() : '';
  if (!path || path.includes('..') || path.startsWith('/') || path.includes('\\')) {
    return undefined;
  }
  const filename = typeof o.filename === 'string' && o.filename.trim()
    ? o.filename.trim()
    : (path.split('/').pop() || path);
  const title = typeof o.title === 'string' && o.title.trim() ? o.title.trim() : filename;
  const mime = typeof o.mime === 'string' ? o.mime.trim() : '';
  const size = typeof o.size === 'number' && Number.isFinite(o.size) ? o.size : 0;
  return { path, filename, title, mime, size };
}
