import type { WsMessage } from '../types/api';

export interface ContextLimitsState {
  maxTokens: number | null;
  modelWindow: number | null;
}

export const EMPTY_CONTEXT_LIMITS: ContextLimitsState = {
  maxTokens: null,
  modelWindow: null,
};

/** Read a done or session_start frame as one budget/capacity snapshot. */
export function contextLimitsFromDoneFrame(
  frame: Pick<WsMessage, 'max_context_tokens' | 'model_context_window'>,
): ContextLimitsState {
  return {
    maxTokens: typeof frame.max_context_tokens === 'number'
      ? frame.max_context_tokens
      : null,
    modelWindow: typeof frame.model_context_window === 'number'
      ? frame.model_context_window
      : null,
  };
}

/** Last measured context meter for one conversation. */
export interface ContextMeterSnapshot {
  maxTokens: number | null;
  modelWindow: number | null;
  inputTokens: number | null;
}

const METER_PREFIX = 'zeroclaw-context-meter:';

export function contextMeterKey(sessionId: string): string {
  return `${METER_PREFIX}${sessionId}`;
}

export function parseContextMeterSnapshot(raw: string | null): ContextMeterSnapshot | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ContextMeterSnapshot>;
    const maxTokens = typeof parsed.maxTokens === 'number' ? parsed.maxTokens : null;
    const modelWindow = typeof parsed.modelWindow === 'number' ? parsed.modelWindow : null;
    const inputTokens = typeof parsed.inputTokens === 'number' ? parsed.inputTokens : null;
    if (maxTokens === null && modelWindow === null) return null;
    return { maxTokens, modelWindow, inputTokens };
  } catch {
    return null;
  }
}

interface MeterStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadContextMeter(
  sessionId: string,
  storage: Pick<MeterStorage, 'getItem'> | null,
): ContextMeterSnapshot | null {
  if (!storage) return null;
  try {
    return parseContextMeterSnapshot(storage.getItem(contextMeterKey(sessionId)));
  } catch {
    return null;
  }
}

export function saveContextMeter(
  sessionId: string,
  snapshot: ContextMeterSnapshot,
  storage: Pick<MeterStorage, 'setItem'> | null,
): void {
  if (!storage) return;
  if (snapshot.maxTokens === null && snapshot.modelWindow === null) return;
  try {
    storage.setItem(contextMeterKey(sessionId), JSON.stringify(snapshot));
  } catch {
    // Quota or private mode: the live meter still updates for this view.
  }
}

export function browserMeterStorage(): MeterStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
