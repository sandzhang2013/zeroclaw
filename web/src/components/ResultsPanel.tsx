import { useMemo, useState } from 'react';
import { CheckCircle2, Loader2, Wrench } from 'lucide-react';
import { useAgent } from '@/contexts/AgentContext';
import { t } from '@/lib/i18n';

const PREVIEW_CHARS = 400;

/**
 * Right-hand results pane for the workbench. Lists tool outputs from the
 * current session so they sit beside the transcript instead of only inline.
 */
export function ResultsPanel() {
  const { messages } = useAgent();
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

  return (
    <aside
      className="flex flex-col w-72 xl:w-80 shrink-0 border-l border-pc-border bg-pc-surface min-h-0"
      aria-label={t('workbench.results')}
    >
      <div className="px-3 h-10 flex items-center border-b border-pc-border shrink-0">
        <span className="text-xs font-medium text-pc-text">{t('workbench.results')}</span>
        {items.length > 0 && (
          <span className="ml-auto text-[10px] tabular-nums text-pc-text-faint">{items.length}</span>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-2">
        {items.length === 0 && (
          <p className="px-2 py-6 text-xs text-pc-text-muted text-center">
            {t('workbench.results_empty')}
          </p>
        )}
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
              className="w-full text-left rounded-[var(--radius-md)] border border-pc-border bg-pc-elevated p-2.5 hover:border-pc-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pc-focus)]"
            >
              <div className="flex items-center gap-2 mb-1">
                <Wrench className="h-3.5 w-3.5 shrink-0 text-pc-accent" aria-hidden />
                <span className="font-mono text-[11px] text-pc-text truncate">{item.name}</span>
                <span className="ml-auto shrink-0">
                  {item.running ? (
                    <Loader2 className="h-3 w-3 animate-spin text-pc-text-muted" aria-label={t('workbench.results_running')} />
                  ) : (
                    <CheckCircle2 className="h-3 w-3 text-status-success" aria-hidden />
                  )}
                </span>
              </div>
              {item.running ? (
                <p className="text-[11px] text-pc-text-muted">{t('workbench.results_running')}</p>
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
    </aside>
  );
}

export default ResultsPanel;
