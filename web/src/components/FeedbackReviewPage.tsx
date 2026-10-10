import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, getSessionMessages, getSessions, getTurnFeedbackReview, type TurnFeedbackReview, type TurnFeedbackReviewEntry } from '@/lib/api';
import { t } from '@/lib/i18n';
import { DISLIKE_REASONS, type DislikeReason } from '@/lib/turnFeedback';
import type { SessionMessageRow } from '@/types/api';
import { PageHeader } from '@/components/ui';
import { feedbackReviewCsv, type FeedbackExportLabels, type FeedbackExportRow } from '@/lib/feedbackExport';

type Filter = 'all' | 'like' | 'dislike' | DislikeReason;

const REASON_KEY: Record<DislikeReason, string> = {
  wrong_data: 'workbench.feedback_reason_wrong_data',
  unhelpful: 'workbench.feedback_reason_unhelpful',
  unsafe: 'workbench.feedback_reason_unsafe',
  other: 'workbench.feedback_reason_other',
};

function reasonCount(review: TurnFeedbackReview, reason: DislikeReason): number {
  return review.summary[reason];
}

function rowKey(entry: TurnFeedbackReviewEntry): string {
  return `${entry.user_id}:${entry.session_id}:${entry.updated_at}:${entry.excerpt}`;
}

function sessionTitle(names: Record<string, string>, sessionId: string): string {
  return names[sessionId] || names[`gw_${sessionId}`] || '';
}

function exportLabels(): FeedbackExportLabels {
  return {
    turns: t('workbench.feedback_review_turns'),
    like: t('workbench.feedback_like'),
    dislike: t('workbench.feedback_dislike'),
    unrated: t('workbench.feedback_review_unrated'),
    time: t('workbench.feedback_review_col_time'),
    user: t('workbench.feedback_review_col_user'),
    verdict: t('workbench.feedback_review_col_verdict'),
    reason: t('workbench.feedback_review_col_reason'),
    comment: t('workbench.feedback_review_col_comment'),
    session: t('workbench.feedback_review_col_session'),
    sessionId: t('workbench.feedback_review_col_session_id'),
    excerpt: t('workbench.feedback_review_col_excerpt'),
  };
}

function exportRows(review: TurnFeedbackReview, names: Record<string, string>): FeedbackExportRow[] {
  return review.entries.map((entry) => ({
    updatedAt: entry.updated_at.replace('T', ' ').slice(0, 16),
    userId: entry.user_id,
    verdict: entry.verdict === 'like' ? t('workbench.feedback_like') : t('workbench.feedback_dislike'),
    reason: entry.reason ? t(REASON_KEY[entry.reason]) : '',
    comment: entry.comment ?? '',
    sessionTitle: sessionTitle(names, entry.session_id),
    sessionId: entry.session_id,
    excerpt: entry.excerpt,
  }));
}

function downloadReview(review: TurnFeedbackReview, names: Record<string, string>) {
  const csv = `\uFEFF${feedbackReviewCsv(review, exportRows(review, names), exportLabels())}`;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `feedback-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function roleLabel(role: string): string {
  if (role === 'user') return t('workbench.feedback_review_role_user');
  if (role === 'assistant' || role === 'agent') return t('workbench.feedback_review_role_assistant');
  return role;
}

export function FeedbackReviewPage() {
  const [review, setReview] = useState<TurnFeedbackReview | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('dislike');
  const [query, setQuery] = useState('');
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<SessionMessageRow[] | null>(null);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getTurnFeedbackReview()
      .then((body) => {
        if (live) setReview(body);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setError(err instanceof ApiError ? err.message : t('workbench.feedback_review_load_failed'));
      });
    getSessions()
      .then((sessions) => {
        if (!live) return;
        const next: Record<string, string> = {};
        for (const session of sessions) {
          const name = session.name?.trim();
          if (!name) continue;
          next[session.session_id] = name;
          next[session.session_key] = name;
        }
        setNames(next);
      })
      .catch(() => { /* titles are optional; the session id still identifies the row */ });
    return () => {
      live = false;
    };
  }, []);

  const rows = useMemo(() => {
    let entries = review?.entries ?? [];
    if (filter === 'like' || filter === 'dislike') {
      entries = entries.filter((entry) => entry.verdict === filter);
    } else if (filter !== 'all') {
      entries = entries.filter((entry) => entry.reason === filter);
    }
    const needle = query.trim().toLowerCase();
    if (!needle) return entries;
    return entries.filter((entry) => {
      const title = sessionTitle(names, entry.session_id);
      return [entry.session_id, entry.user_id, entry.comment ?? '', entry.excerpt, title]
        .join(' ')
        .toLowerCase()
        .includes(needle);
    });
  }, [review, filter, query, names]);

  const openTranscript = (entry: TurnFeedbackReviewEntry) => {
    const key = rowKey(entry);
    if (openKey === key) {
      setOpenKey(null);
      return;
    }
    setOpenKey(key);
    setTranscript(null);
    setTranscriptError(null);
    getSessionMessages(entry.session_id)
      .then((body) => {
        setTranscript(body.messages);
      })
      .catch((err: unknown) => {
        setTranscriptError(err instanceof ApiError ? err.message : t('workbench.feedback_review_transcript_failed'));
      });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-pc-border bg-pc-surface px-6 py-4">
        <PageHeader
          title={t('workbench.feedback_review')}
          description={t('workbench.feedback_review_hint')}
          actions={review ? (
            <button
              type="button"
              onClick={() => downloadReview(review, names)}
              className="h-8 rounded-[8px] border border-pc-border px-3 text-sm text-pc-text hover:bg-[var(--pc-hover)]"
            >
              {t('workbench.feedback_review_export')}
            </button>
          ) : null}
        />
        {review ? (
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <CoverageStat label={t('workbench.feedback_review_turns')} value={review.coverage.turns} />
            <CoverageStat label={t('workbench.feedback_like')} value={review.coverage.like} />
            <CoverageStat label={t('workbench.feedback_dislike')} value={review.coverage.dislike} />
            <CoverageStat label={t('workbench.feedback_review_unrated')} value={review.coverage.unrated} />
          </div>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {error ? <p className="mb-3 text-xs text-status-error">{error}</p> : null}
        {review ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <FilterChip
                active={filter === 'all'}
                label={`${t('workbench.feedback_review_all')} ${review.summary.like + review.summary.dislike}`}
                onClick={() => setFilter('all')}
              />
              <FilterChip
                active={filter === 'dislike'}
                label={`${t('workbench.feedback_dislike')} ${review.summary.dislike}`}
                onClick={() => setFilter('dislike')}
              />
              <FilterChip
                active={filter === 'like'}
                label={`${t('workbench.feedback_like')} ${review.summary.like}`}
                onClick={() => setFilter('like')}
              />
              {DISLIKE_REASONS.map((reason) => (
                <FilterChip
                  key={reason}
                  active={filter === reason}
                  label={`${t(REASON_KEY[reason])} ${reasonCount(review, reason)}`}
                  onClick={() => setFilter(reason)}
                />
              ))}
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('workbench.feedback_review_search')}
                className="ml-auto h-8 min-w-56 rounded-full border border-pc-border bg-pc-input px-3 text-sm text-pc-text placeholder:text-pc-text-faint focus-visible:border-pc-accent focus-visible:outline-none"
              />
            </div>
            {rows.length === 0 ? (
              <p className="mt-6 text-sm text-pc-text-muted">{t('workbench.feedback_review_empty')}</p>
            ) : (
              <ul className="mt-4 space-y-2">
                {rows.map((entry) => {
                  const key = rowKey(entry);
                  const title = sessionTitle(names, entry.session_id);
                  const open = openKey === key;
                  return (
                    <li key={key} className="rounded-xl border border-pc-border bg-pc-elevated px-3 py-3">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-pc-text-muted">
                        <span className="font-medium text-pc-text">{entry.user_id}</span>
                        <span>{entry.verdict === 'like' ? t('workbench.feedback_like') : t('workbench.feedback_dislike')}</span>
                        {entry.reason ? <span>{t(REASON_KEY[entry.reason])}</span> : null}
                        <span className="ml-auto tabular-nums">{entry.updated_at.replace('T', ' ').slice(0, 16)}</span>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                        <span className="text-pc-text-muted">{t('workbench.feedback_review_session')}</span>
                        {title ? <span className="font-medium text-pc-text">{title}</span> : null}
                        <code className="font-mono text-pc-text">{entry.session_id}</code>
                        <Link
                          to={`/dashboard?tab=sessions&q=${encodeURIComponent(entry.session_id)}`}
                          className="text-pc-accent hover:underline"
                        >
                          {t('workbench.feedback_review_open_sessions')}
                        </Link>
                        <button
                          type="button"
                          onClick={() => openTranscript(entry)}
                          className="text-pc-accent hover:underline"
                        >
                          {t('workbench.feedback_review_transcript')}
                        </button>
                      </div>
                      {entry.comment ? (
                        <p className="mt-2 text-sm text-pc-text">{entry.comment}</p>
                      ) : null}
                      {entry.excerpt ? (
                        <p className="mt-2 line-clamp-3 text-xs leading-5 text-pc-text-muted">{entry.excerpt}</p>
                      ) : null}
                      {open ? (
                        <div className="mt-3 max-h-80 overflow-y-auto rounded-lg border border-pc-border bg-pc-surface px-3 py-2">
                          {transcriptError ? (
                            <p className="text-xs text-status-error">{transcriptError}</p>
                          ) : transcript === null ? (
                            <p className="text-xs text-pc-text-muted">{t('agent.session_loading')}</p>
                          ) : transcript.length === 0 ? (
                            <p className="text-xs text-pc-text-muted">{t('workbench.feedback_review_transcript_empty')}</p>
                          ) : (
                            <ul className="space-y-2">
                              {transcript.map((message, index) => (
                                <li key={`${message.created_at ?? ''}:${index}`} className="text-xs leading-5">
                                  <span className="font-medium text-pc-text">{roleLabel(message.role)}</span>
                                  <p className="whitespace-pre-wrap text-pc-text-muted">{message.content}</p>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        ) : error ? null : (
          <p className="text-sm text-pc-text-muted">{t('agent.session_loading')}</p>
        )}
      </div>
    </div>
  );
}

function CoverageStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-pc-border bg-pc-elevated px-3 py-2">
      <div className="text-xs text-pc-text-muted">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums text-pc-text">{value}</div>
    </div>
  );
}

function FilterChip({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={[
        'rounded-full border px-3 py-1.5 text-sm',
        active
          ? 'border-pc-accent bg-pc-accent/10 text-pc-text'
          : 'border-pc-border text-pc-text-secondary hover:bg-[var(--pc-hover)]',
      ].join(' ')}
    >
      {label}
    </button>
  );
}
