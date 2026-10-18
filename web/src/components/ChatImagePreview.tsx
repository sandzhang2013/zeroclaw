import { useEffect, useState } from 'react';
import { useAgent } from '@/contexts/AgentContext';
import { fetchWorkspaceRaw } from '@/lib/api';
import { ArtifactDownloadControl, WorkspaceDownloadButton } from '@/components/ArtifactCard';
import type { ExtractedChatImage } from '@/lib/chatImages';
import { t } from '@/lib/i18n';

function imageFilename(img: ExtractedChatImage, index: number): string {
  if (img.kind === 'path') {
    return img.path.split('/').pop() || `image-${index + 1}.png`;
  }
  const semi = img.src.indexOf(';');
  const mime = semi > 5 ? img.src.slice(5, semi) : 'image/png';
  const ext = mime === 'image/jpeg' ? 'jpg' : (mime.split('/')[1] || 'png');
  return `chart-${index + 1}.${ext}`;
}

function WorkspaceImage({
  alias,
  path,
  fill,
}: {
  alias: string;
  path: string;
  fill: boolean;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setUrl(null);
    setError(null);
    void fetchWorkspaceRaw(alias, path)
      .then((blob) => {
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
  }, [alias, path]);
  if (error) {
    return <p className="text-xs text-pc-text-muted">{error}</p>;
  }
  if (!url) return null;
  return (
    <img
      src={url}
      alt={t('workbench.chart_preview')}
      className={
        fill
          ? 'max-h-full w-full rounded-lg border border-pc-border bg-white object-contain'
          : 'max-h-96 w-full rounded-lg border border-pc-border bg-white object-contain'
      }
    />
  );
}

export function ChatImagePreview({
  images,
  caption,
  fill = false,
}: {
  images: ExtractedChatImage[];
  caption?: string;
  fill?: boolean;
}) {
  const { agentAlias } = useAgent();
  if (images.length === 0) return null;
  return (
    <div className={fill ? 'flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3' : 'mt-2 space-y-2'}>
      {caption ? (
        <p className="text-xs text-pc-text-muted">{caption}</p>
      ) : null}
      {images.map((img, i) => {
        const filename = imageFilename(img, i);
        return (
          <div key={`${img.kind}-${i}`} className="space-y-1">
            {img.kind === 'data' ? (
              <img
                src={img.src}
                alt={t('workbench.chart_preview')}
                className={
                  fill
                    ? 'max-h-full w-full rounded-lg border border-pc-border bg-white object-contain'
                    : 'max-h-96 w-full rounded-lg border border-pc-border bg-white object-contain'
                }
              />
            ) : (
              <WorkspaceImage alias={agentAlias} path={img.path} fill={fill} />
            )}
            <div className="flex justify-end">
              {img.kind === 'data' ? (
                <ArtifactDownloadControl href={img.src} filename={filename} labeled />
              ) : (
                <WorkspaceDownloadButton
                  alias={agentAlias}
                  path={img.path}
                  filename={filename}
                  labeled
                />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
