import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp,
  CheckCircle2,
  File,
  FileText,
  Folder,
  Loader2,
  RefreshCw,
  Sparkles,
  Wrench,
} from 'lucide-react';
import { useAgent } from '@/contexts/AgentContext';
import {
  ApiError,
  listAgentWorkspace,
  readAgentWorkspaceFile,
  type BrowseEntry,
} from '@/lib/api';
import { ArtifactCard, HtmlSrcDocPreview } from '@/components/ArtifactCard';
import { artifactKind, isVisualArtifact, type ToolArtifactInfo } from '@/lib/artifactKind';
import type { CanvasFramePreview } from '@/lib/canvasFrame';
import { canvasPreviewFromToolCall } from '@/lib/canvasFrame';
import { ChatImagePreview } from '@/components/ChatImagePreview';
import { extractMcpToolText, extractToolImages, type ExtractedChatImage } from '@/lib/chatImages';
import { t } from '@/lib/i18n';

const PREVIEW_CHARS = 400;

type RightTab = 'results' | 'artifacts';

function sessionArtifactRoot(sessionId: string): string {
  return `sessions/${sessionId}`;
}

function formatBytes(n?: number): string {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function isDbNoise(name: string): boolean {
  return name === 'sessions.db' || name.endsWith('.db-wal') || name.endsWith('.db-shm');
}

function pathUnderSessionRoot(path: string, root: string): { rel: string; name: string } | null {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
  const prefix = `${root}/`;
  if (normalized === root) return null;
  if (normalized.startsWith(prefix)) {
    const rest = normalized.slice(prefix.length);
    if (!rest) return null;
    const i = rest.lastIndexOf('/');
    return i < 0 ? { rel: '', name: rest } : { rel: rest.slice(0, i), name: rest.slice(i + 1) };
  }
  if (!normalized.includes('/')) return { rel: '', name: normalized };
  return null;
}

function latestResultsPreview(
  messages: Array<{
    toolCall?: {
      name?: string;
      args?: unknown;
      output?: string;
      canvas?: CanvasFramePreview;
      artifact?: ToolArtifactInfo;
    };
  }>,
): { kind: 'canvas'; canvas: CanvasFramePreview } | { kind: 'images'; images: ExtractedChatImage[]; caption: string } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const toolCall = messages[i]?.toolCall;
    const canvas = canvasPreviewFromToolCall(toolCall);
    if (canvas) return { kind: 'canvas', canvas };
    const images = extractToolImages(toolCall?.output);
    if (images.length > 0) {
      return { kind: 'images', images, caption: extractMcpToolText(toolCall?.output ?? '') };
    }
    const artifact = toolCall?.artifact;
    if (artifact && isVisualArtifact(artifact) && artifactKind(artifact.mime, artifact.filename) === 'image') {
      return {
        kind: 'images',
        images: [{ kind: 'path', path: artifact.path }],
        caption: extractMcpToolText(toolCall?.output ?? '') || artifact.title,
      };
    }
  }
  return null;
}

function latestMessageArtifact(
  messages: Array<{ toolCall?: { artifact?: ToolArtifactInfo } }>,
): ToolArtifactInfo | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const artifact = messages[i]?.toolCall?.artifact;
    if (artifact) return artifact;
  }
  return null;
}

/**
 * Right-hand workbench pane: tool results plus files written in this session.
 */
export function ResultsPanel() {
  const [tab, setTab] = useState<RightTab>('results');
  const { messages } = useAgent();
  const resultCount = useMemo(
    () => messages.filter((m) => m.toolCall).length,
    [messages],
  );
  const lastArtifact = useMemo(() => latestMessageArtifact(messages), [messages]);
  const lastPreview = useMemo(() => latestResultsPreview(messages), [messages]);
  const lastArtifactPath = lastArtifact?.path ?? '';

  useEffect(() => {
    if (lastPreview) setTab('results');
    else if (lastArtifactPath) setTab('artifacts');
  }, [lastPreview, lastArtifactPath]);

  return (
    <aside
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-pc-base/80"
      aria-label={t('workbench.results')}
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-pc-border px-3 py-2">
        <div
          role="tablist"
          className="inline-flex min-w-0 flex-1 items-center rounded-full p-0.5"
          style={{ background: 'color-mix(in srgb, var(--pc-text-primary) 8%, transparent)' }}
        >
          <TabButton
            id="results"
            active={tab === 'results'}
            label={t('workbench.tab_results')}
            count={resultCount}
            onClick={() => setTab('results')}
          />
          <TabButton
            id="artifacts"
            active={tab === 'artifacts'}
            label={t('workbench.tab_artifacts')}
            onClick={() => setTab('artifacts')}
          />
        </div>
      </div>
      {tab === 'results' ? <ResultsList preview={lastPreview} /> : <ArtifactsList lastArtifact={lastArtifact} />}
    </aside>
  );
}

function TabButton({
  id,
  active,
  label,
  count,
  onClick,
}: {
  id: string;
  active: boolean;
  label: string;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      id={`workbench-right-tab-${id}`}
      onClick={onClick}
      className={[
        'inline-flex min-w-0 flex-1 items-center justify-center gap-1 rounded-full px-3 py-1.5 text-sm font-medium transition-colors',
        active ? 'bg-pc-text text-pc-base' : 'text-pc-text-muted hover:text-pc-text',
      ].join(' ')}
    >
      <span className="truncate">{label}</span>
      {count != null && count > 0 && (
        <span className={['tabular-nums text-[11px]', active ? 'opacity-70' : 'text-pc-text-faint'].join(' ')}>
          {count}
        </span>
      )}
    </button>
  );
}

function ResultsList({
  preview,
}: {
  preview: { kind: 'canvas'; canvas: CanvasFramePreview } | { kind: 'images'; images: ExtractedChatImage[]; caption: string } | null;
}) {
  const { messages, typing } = useAgent();
  const [openId, setOpenId] = useState<string | null>(null);

  const items = useMemo(() => (
    messages
      .filter((m) => m.toolCall)
      .map((m) => ({
        id: m.id,
        name: m.toolCall!.name,
        output: m.toolCall!.output,
        running: m.toolCall!.output === undefined,
        visual: !!canvasPreviewFromToolCall(m.toolCall)
          || extractToolImages(m.toolCall!.output).length > 0
          || isVisualArtifact(m.toolCall!.artifact),
        caption: extractMcpToolText(m.toolCall!.output ?? ''),
      }))
  ), [messages]);

  const running = typing || items.some((item) => item.running);

  return (
    <div className="flex min-h-0 flex-1 flex-col" role="tabpanel" aria-labelledby="workbench-right-tab-results">
      {preview?.kind === 'canvas' && (
        <div className="h-56 shrink-0 overflow-hidden border-b border-pc-border bg-white">
          <HtmlSrcDocPreview
            html={preview.canvas.content}
            title={preview.canvas.canvasId}
            className="block h-full w-full border-0 bg-white"
          />
        </div>
      )}
      {preview?.kind === 'images' && (
        <div className="max-h-[40%] min-h-40 shrink-0 overflow-auto border-b border-pc-border p-2">
          <ChatImagePreview images={preview.images} caption={preview.caption} />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {items.length === 0 ? (
          running ? (
            <div className="flex h-full w-full items-center justify-center">
              <div className="relative flex flex-col items-center justify-center">
                <div className="relative mb-8 flex items-center justify-center">
                  <div className="absolute size-20 animate-ping rounded-full border border-pc-text/20" />
                  <div className="relative z-10 rounded-full border border-pc-border bg-pc-surface p-4">
                    <Sparkles className="size-8 text-pc-text" />
                  </div>
                </div>
                <p className="text-sm font-medium text-pc-text">{t('workbench.results_creating')}</p>
                <p className="mt-1 text-xs text-pc-text-muted">{t('workbench.results_running')}</p>
              </div>
            </div>
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              <div className="text-center text-pc-text-muted">
                <File className="mx-auto mb-3 size-12 opacity-50" />
                <p className="text-sm">{t('workbench.results_empty_title')}</p>
                <p className="mt-1 text-xs">{t('workbench.results_empty')}</p>
              </div>
            </div>
          )
        ) : (
          <div className="space-y-2 p-3">
            {preview && (
              <p className="px-0.5 text-[11px] font-medium uppercase tracking-wide text-pc-text-faint">
                {t('workbench.results_all')}
              </p>
            )}
            {items.map((item) => {
              const open = openId === item.id;
              const snippet = item.output
                ? (item.output.length > PREVIEW_CHARS ? `${item.output.slice(0, PREVIEW_CHARS)}…` : item.output)
                : '';
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setOpenId(open ? null : item.id)}
                  className="w-full rounded-lg border border-pc-border bg-pc-surface p-3 text-left hover:bg-[var(--pc-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pc-focus)]"
                >
                  <div className="mb-1 flex items-center gap-2">
                    <Wrench className="h-4 w-4 shrink-0 text-pc-text-muted" aria-hidden />
                    <span className="truncate text-sm text-pc-text">{item.name}</span>
                    <span className="ml-auto shrink-0">
                      {item.running ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-pc-text-muted" aria-label={t('workbench.results_running')} />
                      ) : (
                        <CheckCircle2 className="h-3.5 w-3.5 text-status-success" aria-hidden />
                      )}
                    </span>
                  </div>
                  {item.running ? (
                    <p className="text-xs text-pc-text-muted">{t('workbench.results_running')}</p>
                  ) : item.visual ? (
                    <p className="text-xs text-pc-text-muted">{item.caption || t('workbench.chart_generated')}</p>
                  ) : (
                    <pre className={[
                      'whitespace-pre-wrap break-all font-mono text-[11px] text-pc-text-secondary',
                      open ? '' : 'line-clamp-6',
                    ].join(' ')}>
                      {open ? item.output : snippet}
                    </pre>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function ArtifactsList({ lastArtifact }: { lastArtifact: ToolArtifactInfo | null }) {
  const { agentAlias, sessionId, typing } = useAgent();
  const root = sessionArtifactRoot(sessionId);
  const [rel, setRel] = useState('');
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [previewName, setPreviewName] = useState<string | null>(null);
  const [previewArtifact, setPreviewArtifact] = useState<ToolArtifactInfo | null>(null);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [previewBinary, setPreviewBinary] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const wasTyping = useRef(typing);
  const openedArtifactPath = useRef<string | null>(null);

  const listPath = rel ? `${root}/${rel}` : root;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listAgentWorkspace(agentAlias, listPath);
      setEntries((res.entries ?? []).filter((e) => !isDbNoise(e.name)));
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 400)) {
        setEntries([]);
      } else {
        setEntries([]);
      }
    } finally {
      setLoading(false);
    }
  }, [agentAlias, listPath]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (wasTyping.current && !typing) void load();
    wasTyping.current = typing;
  }, [typing, load]);

  const openDir = (name: string) => {
    setExpanded(false);
    setPreviewName(null);
    setPreviewArtifact(null);
    setPreviewText(null);
    setRel((cur) => (cur ? `${cur}/${name}` : name));
  };

  const goUp = () => {
    setExpanded(false);
    setPreviewName(null);
    setPreviewArtifact(null);
    setPreviewText(null);
    setRel((cur) => {
      const i = cur.lastIndexOf('/');
      return i <= 0 ? '' : cur.slice(0, i);
    });
  };

  const openFile = useCallback(async (name: string, size?: number, explicitPath?: string) => {
    const path = explicitPath ?? (rel ? `${root}/${rel}/${name}` : `${root}/${name}`);
    setPreviewName(name);
    setPreviewText(null);
    setPreviewBinary(false);
    const kind = artifactKind('', name);
    if (kind !== 'other') {
      setPreviewArtifact({
        path,
        filename: name,
        title: name,
        mime: '',
        size: size ?? 0,
      });
      return;
    }
    setPreviewArtifact(null);
    try {
      const file = await readAgentWorkspaceFile(agentAlias, path);
      if (file.is_text) {
        setPreviewText(file.content);
        setPreviewBinary(false);
      } else {
        setPreviewBinary(true);
      }
    } catch {
      setPreviewBinary(true);
    }
  }, [agentAlias, rel, root]);

  useEffect(() => {
    if (!lastArtifact?.path || openedArtifactPath.current === lastArtifact.path) return;
    openedArtifactPath.current = lastArtifact.path;
    const located = pathUnderSessionRoot(lastArtifact.path, root);
    if (located) setRel(located.rel);
    setPreviewName(lastArtifact.filename);
    setPreviewText(null);
    setPreviewBinary(false);
    if (artifactKind(lastArtifact.mime, lastArtifact.filename) !== 'other') {
      setPreviewArtifact(lastArtifact);
    } else {
      void openFile(lastArtifact.filename, lastArtifact.size, lastArtifact.path);
    }
  }, [lastArtifact, openFile, root]);

  useEffect(() => {
    if (loading || previewName) return;
    const first = entries.find((e) => e.kind === 'file' && artifactKind('', e.name) !== 'other');
    if (first) void openFile(first.name, first.size);
  }, [loading, entries, previewName, openFile]);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" role="tabpanel" aria-labelledby="workbench-right-tab-artifacts">
      <div className="flex shrink-0 items-center gap-1 border-b border-pc-border px-2 py-1.5">
        <button
          type="button"
          onClick={goUp}
          disabled={!rel}
          className="inline-flex size-7 items-center justify-center rounded-[8px] text-pc-text-muted hover:bg-[var(--pc-hover)] hover:text-pc-text disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pc-focus)]"
          aria-label={t('workbench.artifacts_up')}
          title={t('workbench.artifacts_up')}
        >
          <ArrowUp className="size-3.5" />
        </button>
        <span className="min-w-0 flex-1 truncate text-[11px] text-pc-text-faint" title={rel || '.'}>
          {rel || '.'}
        </span>
        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex size-7 items-center justify-center rounded-[8px] text-pc-text-muted hover:bg-[var(--pc-hover)] hover:text-pc-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pc-focus)]"
          aria-label={t('workbench.artifacts_refresh')}
          title={t('workbench.artifacts_refresh')}
        >
          <RefreshCw className={['size-3.5', loading ? 'animate-spin' : ''].join(' ')} />
        </button>
      </div>
      <div className="max-h-48 shrink-0 overflow-y-auto">
        {loading && entries.length === 0 ? (
          <div className="flex items-center justify-center py-6 text-pc-text-muted">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : entries.length === 0 ? (
          <div className="px-3 py-6 text-center text-pc-text-muted">
            <p className="text-sm">{t('workbench.artifacts_empty_title')}</p>
            <p className="mt-1 text-xs">{t('workbench.artifacts_empty')}</p>
          </div>
        ) : (
          <ul className="p-2">
            {entries.map((entry) => (
              <li key={`${entry.kind}:${entry.name}`}>
                <button
                  type="button"
                  onClick={() => (entry.kind === 'dir' ? openDir(entry.name) : void openFile(entry.name, entry.size))}
                  className={[
                    'flex w-full items-center gap-2 rounded-[10px] px-2 py-2 text-left text-sm hover:bg-[var(--pc-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pc-focus)]',
                    previewName === entry.name ? 'bg-[var(--pc-hover)]' : '',
                  ].join(' ')}
                >
                  {entry.kind === 'dir' ? (
                    <Folder className="size-4 shrink-0 text-pc-text-muted" />
                  ) : (
                    <FileText className="size-4 shrink-0 text-pc-text-muted" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-pc-text">{entry.name}</span>
                  {entry.kind === 'file' && (
                    <span className="shrink-0 text-[11px] tabular-nums text-pc-text-faint">
                      {formatBytes(entry.size)}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden border-t border-pc-border">
        {previewArtifact ? (
          <ArtifactCard
            artifact={previewArtifact}
            fill
            expanded={expanded}
            onToggleExpand={() => setExpanded((v) => !v)}
          />
        ) : previewName ? (
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            <p className="mb-2 truncate text-xs font-medium text-pc-text">{previewName}</p>
            {previewBinary ? (
              <p className="text-xs text-pc-text-muted">{t('workbench.artifacts_binary')}</p>
            ) : previewText == null ? (
              <Loader2 className="size-4 animate-spin text-pc-text-muted" />
            ) : (
              <pre className="whitespace-pre-wrap break-all font-mono text-[11px] text-pc-text-secondary">
                {previewText}
              </pre>
            )}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center text-center text-pc-text-muted">
            <div>
              <FileText className="mx-auto mb-2 size-8 opacity-40" />
              <p className="text-sm">{t('workbench.artifact_preview_empty')}</p>
              <p className="mt-1 text-xs">{t('workbench.artifact_preview_empty_hint')}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default ResultsPanel;
