import { useEffect, useState } from 'react';
import { getTurnFeedback, putTurnFeedback, type TurnFeedbackEntry } from '@/lib/api';
import type { DislikeReason, TurnVerdict } from '@/lib/turnFeedback';

const EVENT = 'zeroclaw-turn-feedback';

let cache: TurnFeedbackEntry[] | null = null;
let inflight: Promise<TurnFeedbackEntry[]> | null = null;

function publish(entries: TurnFeedbackEntry[]) {
  cache = entries;
  window.dispatchEvent(new Event(EVENT));
}

export function loadTurnFeedback(): Promise<TurnFeedbackEntry[]> {
  if (cache) return Promise.resolve(cache);
  if (!inflight) {
    inflight = getTurnFeedback()
      .then((body) => {
        cache = body.entries;
        inflight = null;
        return cache;
      })
      .catch((error) => {
        inflight = null;
        throw error;
      });
  }
  return inflight;
}

export function saveTurnFeedback(body: {
  sessionId: string;
  messageKey: string;
  verdict: TurnVerdict | null;
  reason?: DislikeReason | null;
  comment?: string;
}): Promise<void> {
  return putTurnFeedback({
    session_id: body.sessionId,
    message_key: body.messageKey,
    verdict: body.verdict,
    reason: body.reason ?? null,
    comment: body.comment ?? '',
  }).then((saved) => {
    publish(saved.entries);
  });
}

export function useTurnFeedback(): TurnFeedbackEntry[] {
  const [entries, setEntries] = useState<TurnFeedbackEntry[]>(cache ?? []);
  useEffect(() => {
    let live = true;
    loadTurnFeedback()
      .then((rows) => {
        if (live) setEntries(rows);
      })
      .catch(() => {
        /* the buttons stay quiet until a later save */
      });
    const onChange = () => setEntries(cache ?? []);
    window.addEventListener(EVENT, onChange);
    return () => {
      live = false;
      window.removeEventListener(EVENT, onChange);
    };
  }, []);
  return entries;
}
