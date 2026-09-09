import { useLayoutEffect, useRef } from 'react';
import { t } from '@/lib/i18n';
import { shouldFollowThinkingScroll } from '@/lib/thinkingScroll';

export function ThinkingTranscript({
  text,
  live = false,
  open,
}: {
  text: string;
  live?: boolean;
  open?: boolean;
}) {
  const ref = useRef<HTMLPreElement>(null);
  const followRef = useRef(true);

  useLayoutEffect(() => {
    if (live) followRef.current = true;
  }, [live]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !live || !followRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [text, live, open]);

  return (
    <details className="mb-2" open={open}>
      <summary className="text-xs cursor-pointer select-none text-pc-text-muted">
        {t('agentchat.thinking')}{live && open !== false ? '...' : ''}
      </summary>
      <pre
        ref={ref}
        onScroll={() => {
          const el = ref.current;
          if (!el) return;
          followRef.current = shouldFollowThinkingScroll({
            scrollTop: el.scrollTop,
            clientHeight: el.clientHeight,
            scrollHeight: el.scrollHeight,
          });
        }}
        className="text-xs mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words leading-relaxed [overflow-anchor:none] p-2 rounded-[var(--radius-sm)] text-pc-text-muted bg-pc-code"
      >
        {text}
      </pre>
    </details>
  );
}
