import { useMemo, useState } from 'react';
import { CheckCircle2, File, Loader2, Sparkles, Wrench } from 'lucide-react';
import { useAgent } from '@/contexts/AgentContext';
import { t } from '@/lib/i18n';

const PREVIEW_CHARS = 400;

/**
 * Right-hand results pane for the workbench. Lists tool outputs from the
 * current session so they sit beside the transcript instead of only inline.
 */
export function ResultsPanel() {
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
      }))
  ), [messages]);

  const running = typing || items.some((item) => item.running);

  return (
    <aside
      className="flex flex-col flex-1 min-w-0 min-h-0 bg-pc-base/80"
      aria-label={t('workbench.results')}
    >
      <div className="flex w-full min-w-0 items-center justify-between border-b border-pc-border px-4 py-3 overflow-hidden shrink-0">
        <span className="text-sm font-semibold text-pc-text">{t('workbench.results')}</span>
        {items.length > 0 && (
          <span className="text-[11px] tabular-nums text-pc-text-faint">{items.length}</span>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {items.length === 0 ? (
          running ? (
            <div className="flex items-center justify-center h-full w-full">
              <div className="relative flex flex-col items-center justify-center">
                <div className="relative flex items-center justify-center mb-8">
                  <div className="absolute size-20 rounded-full border border-pc-text/20 animate-ping" />
                  <div className="relative z-10 bg-pc-surface p-4 rounded-full border border-pc-border">
                    <Sparkles className="size-8 text-pc-text" />
                  </div>
                </div>
                <p className="text-sm font-medium text-pc-text">{t('workbench.results_creating')}</p>
                <p className="text-xs mt-1 text-pc-text-muted">{t('workbench.results_running')}</p>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-full w-full">
              <div className="text-center text-pc-text-muted">
                <File className="size-12 mx-auto mb-3 opacity-50" />
                <p className="text-sm">{t('workbench.results_empty_title')}</p>
                <p className="text-xs mt-1">{t('workbench.results_empty')}</p>
              </div>
            </div>
          )
        ) : (
          <div className="p-3 space-y-2">
            {items.map((item) => {
              const open = openId === item.id;
              const preview = item.output
                ? (item.output.length > PREVIEW_CHARS ? `${item.output.slice(0, PREVIEW_CHARS)}…` : item.output)
                : '';
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setOpenId(open ? null : item.id)}
                  className="w-full text-left rounded-lg border border-pc-border bg-pc-surface p-3 hover:bg-[var(--pc-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pc-focus)]"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <Wrench className="h-4 w-4 shrink-0 text-pc-text-muted" aria-hidden />
                    <span className="text-sm text-pc-text truncate">{item.name}</span>
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
                  ) : (
                    <pre className={[
                      'text-[11px] font-mono text-pc-text-secondary whitespace-pre-wrap break-all',
                      open ? '' : 'line-clamp-6',
                    ].join(' ')}>
                      {open ? item.output : preview}
                    </pre>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}

export default ResultsPanel;
