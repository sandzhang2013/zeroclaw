import { useAgent } from '@/contexts/AgentContext';
import { workspaceRawUrl } from '@/lib/api';
import { ArtifactDownloadControl } from '@/components/ArtifactCard';
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
        const src = img.kind === 'data' ? img.src : workspaceRawUrl(agentAlias, img.path);
        const filename = imageFilename(img, i);
        const href = img.kind === 'data' ? img.src : workspaceRawUrl(agentAlias, img.path, true);
        return (
          <div key={`${img.kind}-${i}`} className="space-y-1">
            <img
              src={src}
              alt={t('workbench.chart_preview')}
              className={
                fill
                  ? 'max-h-full w-full rounded-lg border border-pc-border bg-white object-contain'
                  : 'max-h-96 w-full rounded-lg border border-pc-border bg-white object-contain'
              }
            />
            <div className="flex justify-end">
              <ArtifactDownloadControl href={href} filename={filename} labeled />
            </div>
          </div>
        );
      })}
    </div>
  );
}
