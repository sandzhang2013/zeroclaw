/** Child-side helpers for docs/集成/iframe-bridge.js `ai:ask`. */

const DATA_OPEN = '[分析数据，勿向用户复述]';
const DATA_CLOSE = '[/分析数据]';

export type IframeBridge = {
  embedded?: boolean;
  on: (handler: (msg: { type: string; payload: unknown }) => unknown) => () => void;
  emit: (type: string, payload?: unknown) => Promise<unknown>;
};

declare global {
  interface Window {
    ScIframeBridge?: IframeBridge;
  }
}

export type ParsedAsk = {
  content: string;
  msgId?: string;
  modelText: string;
  title: string;
};

export type AskPlan =
  | { action: 'reject'; reason: string }
  | { action: 'replay'; sessionId: string }
  | ({ action: 'send' } & ParsedAsk);

export function isEmbeddedFrame(win: {
  parent?: unknown;
  opener?: unknown;
} | null | undefined): boolean {
  if (!win) return false;
  return win.parent !== win || Boolean(win.opener);
}

export function composeModelText(content: string, provideData: unknown): string {
  const visible = content.trim();
  const hidden = serializeProvideData(provideData);
  if (!hidden) return visible;
  return `${DATA_OPEN}\n${hidden}\n${DATA_CLOSE}\n${visible}`;
}

/** Drop the hidden analysis block so bubbles and titles stay on `content`. */
export function stripProvideData(text: string): string {
  const pattern = new RegExp(
    `${escapeRegExp(DATA_OPEN)}\\n[\\s\\S]*?\\n${escapeRegExp(DATA_CLOSE)}\\n?`,
    'g',
  );
  return text.replace(pattern, '');
}

export function planIframeAsk(payload: unknown, seen: ReadonlyMap<string, string>): AskPlan {
  const parsed = parseAsk(payload);
  if ('reason' in parsed) return { action: 'reject', reason: parsed.reason };
  if (parsed.msgId) {
    const prior = seen.get(parsed.msgId);
    if (prior) return { action: 'replay', sessionId: prior };
  }
  return { action: 'send', ...parsed };
}

function parseAsk(payload: unknown): ParsedAsk | { reason: string } {
  if (!payload || typeof payload !== 'object') return { reason: '缺少 content' };
  const raw = payload as { content?: unknown; provideData?: unknown; msgId?: unknown };
  if (typeof raw.content !== 'string' || !raw.content.trim()) return { reason: '缺少 content' };
  const content = raw.content.trim();
  const msgId = typeof raw.msgId === 'string' && raw.msgId.trim() ? raw.msgId.trim() : undefined;
  return {
    content,
    msgId,
    modelText: composeModelText(content, raw.provideData),
    title: content.split('\n')[0] ?? content,
  };
}

function serializeProvideData(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  try {
    const text = JSON.stringify(value);
    return text && text !== 'null' && text !== '{}' && text !== '[]' ? text : '';
  } catch {
    return '';
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
