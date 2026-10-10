import type { TurnFeedbackReview } from '@/lib/api';

export interface FeedbackExportLabels {
  turns: string;
  like: string;
  dislike: string;
  unrated: string;
  time: string;
  user: string;
  verdict: string;
  reason: string;
  comment: string;
  session: string;
  sessionId: string;
  excerpt: string;
}

export interface FeedbackExportRow {
  updatedAt: string;
  userId: string;
  verdict: string;
  reason: string;
  comment: string;
  sessionTitle: string;
  sessionId: string;
  excerpt: string;
}

function csvField(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replaceAll('"', '""')}"`;
  return value;
}

function csvLine(cells: string[]): string {
  return cells.map(csvField).join(',');
}

/** Spreadsheet of the coverage totals plus every submitted rating. */
export function feedbackReviewCsv(
  review: Pick<TurnFeedbackReview, 'coverage'>,
  rows: FeedbackExportRow[],
  labels: FeedbackExportLabels,
): string {
  const lines = [
    csvLine([labels.turns, String(review.coverage.turns)]),
    csvLine([labels.like, String(review.coverage.like)]),
    csvLine([labels.dislike, String(review.coverage.dislike)]),
    csvLine([labels.unrated, String(review.coverage.unrated)]),
    '',
    csvLine([
      labels.time,
      labels.user,
      labels.verdict,
      labels.reason,
      labels.comment,
      labels.session,
      labels.sessionId,
      labels.excerpt,
    ]),
    ...rows.map((row) => csvLine([
      row.updatedAt,
      row.userId,
      row.verdict,
      row.reason,
      row.comment,
      row.sessionTitle,
      row.sessionId,
      row.excerpt,
    ])),
  ];
  return `${lines.join('\n')}\n`;
}

export interface UsageExportLabels {
  day: string;
  user: string;
  sessions: string;
  asks: string;
  replies: string;
}

export interface UsageExportRow {
  day: string;
  userId: string;
  sessions: number;
  asks: number;
  replies: number;
}

/** One row per user per Beijing day. */
export function usageDailyCsv(rows: UsageExportRow[], labels: UsageExportLabels): string {
  const lines = [
    csvLine([labels.day, labels.user, labels.sessions, labels.asks, labels.replies]),
    ...rows.map((row) => csvLine([
      row.day,
      row.userId,
      String(row.sessions),
      String(row.asks),
      String(row.replies),
    ])),
  ];
  return `${lines.join('\n')}\n`;
}
