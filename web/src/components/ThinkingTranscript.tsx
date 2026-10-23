import { useEffect, useLayoutEffect, useState, useRef } from 'react';
import { t } from '@/lib/i18n';
import { collapseChatBlankRuns } from '@/lib/chatDisplay';
import { elapsedThinkingSeconds, shouldFollowThinkingScroll } from '@/lib/thinkingScroll';

function useThinkingSeconds(startedAt: number | undefined, frozen: number | undefined): number | undefined {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (frozen != null || startedAt == null) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [startedAt, frozen]);
  if (frozen != null) return frozen;
  if (startedAt == null) return undefined;
  return elapsedThinkingSeconds(startedAt, now);
}

function ThinkingSummary({ live, seconds }: { live: boolean; seconds?: number }) {
  const duration = seconds == null
    ? null
    : t('agentchat.thinking_seconds').replace('{n}', String(seconds));
  return (
    <span className="inline-flex items-center gap-1.5 align-middle">
      <span className={live ? 'thinking-live-label' : undefined}>{t('agentchat.thinking')}</span>
      {duration && <span className="tabular-nums">{duration}</span>}
      {live && seconds == null && (
        <span className="thinking-live-dots" aria-hidden="true">
          <span className="bounce-dot" />
          <span className="bounce-dot" />
          <span className="bounce-dot" />
        </span>
      )}
    </span>
  );
}

export function ThinkingTranscript({
  text,
  live = false,
  open,
  startedAt,
  seconds,
}: {
  text: string;
  live?: boolean;
  open?: boolean;
  /** Wall clock of the first thinking frame. The live label counts up from here. */
  startedAt?: number;
  /** Frozen whole seconds for a finished turn. Ignored while `live` is set. */
  seconds?: number;
}) {
  // While the turn is live, ignore a frozen snapshot so the label keeps moving.
  const shownSeconds = useThinkingSeconds(live ? startedAt : undefined, live ? undefined : seconds);
  const shownText = collapseChatBlankRuns(text);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const ref = useRef<HTMLPreElement>(null);
  const followRef = useRef(true);
  // Collapse once when the answer starts. After that the disclosure stays
  // under the reader's control, so a finished turn can still be opened.
  const releasedRef = useRef(false);
  const applyingRef = useRef(false);

  useLayoutEffect(() => {
    if (live) followRef.current = true;
  }, [live]);

  useLayoutEffect(() => {
    const el = detailsRef.current;
    if (!el || releasedRef.current || open == null) return;
    applyingRef.current = true;
    el.open = open;
    applyingRef.current = false;
    if (!open) releasedRef.current = true;
  }, [open]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !live || !followRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [shownText, live, open]);

  return (
    <details
      ref={detailsRef}
      className="mb-2"
      onToggle={() => {
        if (!applyingRef.current) releasedRef.current = true;
      }}
    >
      <summary className="text-xs cursor-pointer select-none text-pc-text-muted">
        <ThinkingSummary live={live} seconds={shownSeconds} />
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
        {shownText}
      </pre>
    </details>
  );
}
