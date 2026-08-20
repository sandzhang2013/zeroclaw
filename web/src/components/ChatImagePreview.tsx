import { useAgent } from '@/contexts/AgentContext';
import { workspaceRawUrl } from '@/lib/api';
import type { ExtractedChatImage } from '@/lib/chatImages';
import { t } from '@/lib/i18n';

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
        return (
          <img
            key={`${img.kind}-${i}`}
            src={src}
            alt={t('workbench.chart_preview')}
            className={
              fill
                ? 'max-h-full w-full rounded-lg border border-pc-border bg-white object-contain'
                : 'max-h-96 w-full rounded-lg border border-pc-border bg-white object-contain'
            }
          />
        );
      })}
    </div>
  );
}
