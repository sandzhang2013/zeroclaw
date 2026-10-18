import { Download, FileSpreadsheet, FileText, Maximize2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAgent } from '@/contexts/AgentContext';
import { downloadWorkspaceRaw, fetchWorkspaceRaw } from '@/lib/api';
import { artifactKind, type ToolArtifactInfo } from '@/lib/artifactKind';
import { htmlPreviewSrcDoc, HTML_PREVIEW_SANDBOX } from '@/lib/chatHtmlPreview';
import { t } from '@/lib/i18n';

export function downloadUtf8File(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.click();
  URL.revokeObjectURL(url);
}

const downloadControlClass =
  'inline-flex h-7 shrink-0 items-center gap-1 rounded-[8px] px-1.5 text-pc-text-muted hover:bg-[var(--pc-hover)] hover:text-pc-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pc-focus)]';

export function ArtifactDownloadControl({
  href,
  filename,
  labeled = false,
  onClick,
}: {
  href?: string;
  filename: string;
  labeled?: boolean;
  onClick?: () => void;
}) {
  const body = (
    <>
      <Download className="size-3.5" />
      {labeled ? <span className="text-[11px]">{t('workbench.artifact_download')}</span> : null}
    </>
  );
  if (href) {
    return (
      <a
        href={href}
        download={filename}
        className={downloadControlClass}
        aria-label={t('workbench.artifact_download')}
        title={t('workbench.artifact_download')}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {body}
      </a>
    );
  }
  return (
    <button
      type="button"
      className={downloadControlClass}
      aria-label={t('workbench.artifact_download')}
      title={t('workbench.artifact_download')}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {body}
    </button>
  );
}

/** Sandboxed preview for HTML the model put in a chat fence (trend charts, etc.). */
export function HtmlSrcDocPreview({
  html,
  title,
  className,
}: {
  html: string;
  title?: string;
  className?: string;
}) {
  return (
    <iframe
      title={title ?? t('workbench.html_preview')}
      srcDoc={htmlPreviewSrcDoc(html)}
      sandbox={HTML_PREVIEW_SANDBOX}
      referrerPolicy="no-referrer"
      className={className ?? 'mt-2 block h-80 w-full rounded-lg border-0 bg-white'}
    />
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function OfficeIcon({ filename }: { filename: string }) {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'xlsx' || ext === 'xls') {
    return <FileSpreadsheet className="size-8 text-pc-text-muted" />;
  }
  return <FileText className="size-8 text-pc-text-muted" />;
}

export function WorkspaceDownloadButton({
  alias,
  path,
  filename,
  labeled = false,
}: {
  alias: string;
  path: string;
  filename: string;
  labeled?: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <ArtifactDownloadControl
        filename={filename}
        labeled={labeled}
        onClick={() => {
          setError(null);
          void downloadWorkspaceRaw(alias, path, filename).catch((err: unknown) => {
            setError(err instanceof Error ? err.message : String(err));
          });
        }}
      />
      {error ? (
        <span className="max-w-40 truncate text-[11px] text-pc-text-muted" title={error}>
          {error}
        </span>
      ) : null}
    </span>
  );
}

function useWorkspacePreview(alias: string, path: string, asText: boolean) {
  const [url, setUrl] = useState<string | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setUrl(null);
    setHtml(null);
    setError(null);
    void fetchWorkspaceRaw(alias, path)
      .then(async (blob) => {
        if (cancelled) return;
        if (asText) {
          const text = await blob.text();
          if (!cancelled) setHtml(text);
          return;
        }
        const next = URL.createObjectURL(blob);
        if (cancelled) {
          URL.revokeObjectURL(next);
          return;
        }
        objectUrl = next;
        setUrl(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [alias, path, asText]);
  return { url, html, error };
}

export function ArtifactCard({
  artifact,
  fill = false,
  expanded = false,
  onToggleExpand,
}: {
  artifact: ToolArtifactInfo;
  fill?: boolean;
  expanded?: boolean;
  onToggleExpand?: () => void;
}) {
  const { agentAlias } = useAgent();
  const kind = artifactKind(artifact.mime, artifact.filename);
  const preview = useWorkspacePreview(agentAlias, artifact.path, kind === 'html');
  const iframeFill = fill || expanded;

  return (
    <div
      className={[
        'overflow-hidden bg-pc-surface',
        expanded
          ? 'fixed inset-0 z-50 flex flex-col'
          : fill
            ? 'flex h-full min-h-0 flex-col'
            : 'rounded-lg border border-pc-border',
      ].join(' ')}
      role={expanded ? 'dialog' : undefined}
      aria-modal={expanded ? true : undefined}
    >
      <div
        className="flex shrink-0 cursor-zoom-in select-none items-center gap-2 border-b border-pc-border px-3 py-2"
        onDoubleClick={onToggleExpand}
        title={expanded ? t('workbench.artifact_collapse') : t('workbench.artifact_expand')}
      >
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-pc-text">
          {artifact.title || artifact.filename}
        </span>
        {artifact.size > 0 && (
          <span className="shrink-0 text-[11px] tabular-nums text-pc-text-faint">
            {formatBytes(artifact.size)}
          </span>
        )}
        {onToggleExpand && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleExpand();
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            className="inline-flex size-7 items-center justify-center rounded-[8px] text-pc-text-muted hover:bg-[var(--pc-hover)] hover:text-pc-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pc-focus)]"
            aria-label={expanded ? t('workbench.artifact_collapse') : t('workbench.artifact_expand')}
            title={expanded ? t('workbench.artifact_collapse') : t('workbench.artifact_expand')}
          >
            {expanded ? <X className="size-3.5" /> : <Maximize2 className="size-3.5" />}
          </button>
        )}
        <WorkspaceDownloadButton
          alias={agentAlias}
          path={artifact.path}
          filename={artifact.filename}
          labeled={fill || expanded}
        />
      </div>
      {preview.error ? (
        <p className="px-3 py-4 text-xs text-pc-text-muted">{preview.error}</p>
      ) : null}
      {kind === 'html' && preview.html != null && (
        iframeFill ? (
          <div className="relative min-h-0 flex-1">
            <iframe
              title={artifact.title}
              srcDoc={htmlPreviewSrcDoc(preview.html)}
              sandbox={HTML_PREVIEW_SANDBOX}
              referrerPolicy="no-referrer"
              className="absolute inset-0 h-full w-full border-0 bg-white"
            />
          </div>
        ) : (
          <iframe
            title={artifact.title}
            srcDoc={htmlPreviewSrcDoc(preview.html)}
            sandbox={HTML_PREVIEW_SANDBOX}
            referrerPolicy="no-referrer"
            className="block h-80 w-full border-0 bg-white"
          />
        )
      )}
      {kind === 'image' && preview.url && (
        <div
          className={[
            'flex items-center justify-center bg-pc-base p-2',
            iframeFill ? 'min-h-0 flex-1' : 'max-h-80',
          ].join(' ')}
          onDoubleClick={onToggleExpand}
        >
          <img
            src={preview.url}
            alt={artifact.title}
            className={iframeFill ? 'max-h-full max-w-full object-contain' : 'max-h-80 max-w-full object-contain'}
          />
        </div>
      )}
      {kind === 'pdf' && preview.url && (
        iframeFill ? (
          <div className="relative min-h-0 flex-1">
            <iframe title={artifact.title} src={preview.url} className="absolute inset-0 h-full w-full border-0 bg-white" />
          </div>
        ) : (
          <iframe title={artifact.title} src={preview.url} className="block h-96 w-full border-0 bg-white" />
        )
      )}
      {kind === 'office' && (
        <div className={['flex flex-col items-center gap-2 px-3 py-6 text-center', iframeFill ? 'min-h-0 flex-1 justify-center' : ''].join(' ')}>
          <OfficeIcon filename={artifact.filename} />
          <p className="text-sm text-pc-text">{artifact.filename}</p>
          <p className="text-xs text-pc-text-muted">{t('workbench.artifact_office_hint')}</p>
          <WorkspaceDownloadButton
            alias={agentAlias}
            path={artifact.path}
            filename={artifact.filename}
            labeled
          />
        </div>
      )}
    </div>
  );
}

export default ArtifactCard;
