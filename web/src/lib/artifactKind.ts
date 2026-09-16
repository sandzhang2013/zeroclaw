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

/**
 * Browse path for the workbench artifacts pane. Session-relative and
 * `sessions/<id>/…` paths pass through. A host-absolute path is accepted
 * only when it still ends in `sessions/<id>/…` (file_write used to emit
 * the real disk path). Traversal and other host paths stay rejected.
 */
export function workspaceBrowsePath(path: string): string | undefined {
  const n = path.trim().replace(/\\/g, '/');
  if (!n || n.includes('..')) return undefined;
  const session = n.match(/(?:^|\/)(sessions\/[^/]+\/.+)$/);
  if (session?.[1]) return session[1];
  if (n.startsWith('/') || n.includes(':')) return undefined;
  return n;
}

/** Accept WS/API artifact JSON. Reject path traversal and host-absolute paths. */
export function parseToolArtifact(raw: unknown): ToolArtifactInfo | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const rawPath = typeof o.path === 'string' ? o.path : '';
  const path = workspaceBrowsePath(rawPath);
  if (!path) return undefined;
  const filename = typeof o.filename === 'string' && o.filename.trim()
    ? o.filename.trim()
    : (path.split('/').pop() || path);
  const title = typeof o.title === 'string' && o.title.trim() ? o.title.trim() : filename;
  const mime = typeof o.mime === 'string' ? o.mime.trim() : '';
  const size = typeof o.size === 'number' && Number.isFinite(o.size) ? o.size : 0;
  return { path, filename, title, mime, size };
}

/** Lower rank sorts first in the 产物 list: reports, then office, then other, then dirs. */
export function artifactListRank(kind: string, name: string): number {
  if (kind === 'dir') return 40;
  switch (artifactKind('', name)) {
    case 'html':
      return 0;
    case 'image':
      return 1;
    case 'pdf':
      return 2;
    case 'office':
      return 10;
    default:
      return 20;
  }
}

export function sortArtifactEntries<T extends { kind: string; name: string }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => {
    const d = artifactListRank(a.kind, a.name) - artifactListRank(b.kind, b.name);
    return d !== 0 ? d : a.name.localeCompare(b.name, 'zh');
  });
}
