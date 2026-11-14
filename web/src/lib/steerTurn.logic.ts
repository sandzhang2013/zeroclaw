// Mid-turn follow-up. The composer stays open while a turn is answering.
// A send on that turn steers the same turn; the next step picks it up.
// This module is the record of that interaction. The page and the regression
// cases both call it.

import { groupIllustratedBubbles, streamingGroupIndex, type IllustratedMessage } from './chatIllustrated.ts';
import {
  indexBeforeLatestSteer,
  initialTurnStreamState,
  interruptedContent,
  outboundSendStream,
  reduceTurnFrame,
  replyAfterSealedAnswer,
  sealLiveAnswer,
  shouldOpenAnswerAfterSteer,
  type TurnStreamState,
} from '../contexts/turnStream.logic.ts';

export interface SteerComposerInput {
  connected: boolean;
  hydrated: boolean;
  typing: boolean;
  draft: string;
  uploading: boolean;
  /** A skill chip or a finished attachment can send with an empty draft. */
  hasSendPayload: boolean;
  modelLoading: boolean;
  /** No catalog yet and no current model, so the picker has nothing to open. */
  modelUnavailable: boolean;
}

export interface SteerComposer {
  textareaDisabled: boolean;
  placeholderKey: 'agent.connecting' | 'agent.session_loading' | 'agent.steer_placeholder' | 'agent.type_message';
  autonomyDisabled: boolean;
  modelDisabled: boolean;
  stopVisible: boolean;
  sendDisabled: boolean;
}

/** What the composer offers while a turn is, or is not, running. */
export function steerComposer(input: SteerComposerInput): SteerComposer {
  const textareaDisabled = !input.connected || !input.hydrated;
  let placeholderKey: SteerComposer['placeholderKey'] = 'agent.type_message';
  if (!input.connected) placeholderKey = 'agent.connecting';
  else if (!input.hydrated) placeholderKey = 'agent.session_loading';
  else if (input.typing) placeholderKey = 'agent.steer_placeholder';
  const draftEmpty = input.draft.trim().length === 0 && !input.hasSendPayload;
  return {
    textareaDisabled,
    placeholderKey,
    autonomyDisabled: !input.connected || input.typing,
    modelDisabled: input.modelLoading || input.typing || input.modelUnavailable,
    stopVisible: input.typing,
    sendDisabled: textareaDisabled || input.uploading || draftEmpty,
  };
}

/** The follow-up caption stays only while that turn is still running. */
export function steerCaptionVisible(typing: boolean, steersNextStep: boolean | undefined): boolean {
  return typing && steersNextStep === true;
}

/** Drop the caption once the turn ends. The follow-up text itself stays. */
export function clearFinishedSteerMarks<T extends { steersNextStep?: boolean }>(messages: readonly T[]): T[] {
  if (!messages.some((row) => row.steersNextStep)) return messages as T[];
  return messages.map((row) => (row.steersNextStep ? { ...row, steersNextStep: undefined } : row));
}

/** Where the live stream is drawn. A follow-up that already opened the next
 *  answer forces the stream under that follow-up. */
export function liveAnswerGroupIndex(
  typing: boolean,
  followUpAnswer: boolean,
  groups: IllustratedMessage[][],
): number {
  if (!typing || followUpAnswer) return -1;
  return streamingGroupIndex(groups);
}

/** Live thinking scrolls inside its own box. A finished transcript grows in
 *  the message list so the list scrollbar can move past it. */
export function thinkingTranscriptClass(live: boolean): string {
  return live ? 'max-h-60 overflow-auto [overflow-anchor:none]' : '';
}

/** The message list is the scroller. It must be allowed to shrink. */
export function chatTranscriptClass(compact: boolean): string {
  return `min-h-0 flex-1 overflow-y-auto p-4 pb-8 [overflow-anchor:none] ${compact ? 'space-y-1.5' : 'space-y-2'}`;
}

export function composerDockClass(): string {
  return 'shrink-0 px-4 pb-3 pt-1';
}

export interface SteerSend {
  steering: boolean;
  stream: TurnStreamState;
}

/** A send during a running turn keeps the live stream and is marked as a steer. */
export function noteOutgoingSend(typing: boolean, stream: TurnStreamState): SteerSend {
  return {
    steering: typing,
    stream: outboundSendStream(stream, typing),
  };
}

export interface SealedSteerAnswer {
  content: string;
  rawContent: string;
  thinking?: string;
}

export interface AbsorbedSteerThinking {
  opened: boolean;
  stream: TurnStreamState;
  followUpPending: boolean;
  sealedRaw: string;
  /** Present only when the previous step already had visible answer text. */
  sealed: SealedSteerAnswer | null;
}

/** Fold one thinking frame. If the follow-up is waiting on a step that already
 *  wrote text or called a tool, that step closes first. Thinking with no
 *  answer text does not become a bubble. */
export function absorbSteerThinking(input: {
  stream: TurnStreamState;
  followUpPending: boolean;
  sealedRaw: string;
  thinking?: string;
}): AbsorbedSteerThinking {
  let stream = input.stream;
  let followUpPending = input.followUpPending;
  let sealedRaw = input.sealedRaw;
  let sealed: SealedSteerAnswer | null = null;
  let opened = false;
  if (shouldOpenAnswerAfterSteer(stream, followUpPending)) {
    opened = true;
    const frozen = sealLiveAnswer(stream);
    followUpPending = false;
    if (frozen?.content) {
      sealedRaw += frozen.rawContent;
      sealed = frozen;
    }
    stream = initialTurnStreamState();
  }
  stream = reduceTurnFrame(stream, { type: 'thinking', content: input.thinking }).state;
  return { opened, stream, followUpPending, sealedRaw, sealed };
}

/** Remove an answer that was already shown from the turn's combined final text. */
export function steeredFinalContent(content: string, sealedRaw: string): string {
  if (!sealedRaw) return content;
  return replyAfterSealedAnswer(content, sealedRaw);
}

export interface SteerRow {
  id: string;
  role: 'user' | 'agent';
  content: string;
  thinking?: string;
  steersNextStep?: boolean;
}

export interface SteerTranscript {
  messages: SteerRow[];
  stream: TurnStreamState;
  typing: boolean;
  followUpPending: boolean;
  followUpAnswer: boolean;
  sealedRaw: string;
}

export type SteerPlayEvent =
  | { type: 'send'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'chunk'; content: string }
  | { type: 'tool' }
  | { type: 'done'; full: string }
  | { type: 'stop'; note: string };

export function initialSteerTranscript(): SteerTranscript {
  return {
    messages: [],
    stream: initialTurnStreamState(),
    typing: false,
    followUpPending: false,
    followUpAnswer: false,
    sealedRaw: '',
  };
}

function rowId(state: SteerTranscript): string {
  return `m${state.messages.length + 1}`;
}

function insertSealed(state: SteerTranscript, sealed: SealedSteerAnswer): SteerRow[] {
  const row: SteerRow = {
    id: rowId(state),
    role: 'agent',
    content: sealed.content,
    ...(sealed.thinking ? { thinking: sealed.thinking } : {}),
  };
  const index = indexBeforeLatestSteer(state.messages);
  return [...state.messages.slice(0, index), row, ...state.messages.slice(index)];
}

/** Replay the follow-up interaction. Tool cards are omitted; a tool event
 *  only records that this step already called one. */
export function playSteer(events: readonly SteerPlayEvent[]): SteerTranscript {
  let state = initialSteerTranscript();
  for (const event of events) {
    state = applySteerEvent(state, event);
  }
  return state;
}

function applySteerEvent(state: SteerTranscript, event: SteerPlayEvent): SteerTranscript {
  switch (event.type) {
    case 'send': {
      const noted = noteOutgoingSend(state.typing, state.stream);
      return {
        ...state,
        stream: noted.stream,
        typing: true,
        followUpPending: noted.steering ? true : false,
        followUpAnswer: noted.steering ? state.followUpAnswer : false,
        sealedRaw: noted.steering ? state.sealedRaw : '',
        messages: [
          ...state.messages,
          {
            id: rowId(state),
            role: 'user',
            content: event.content,
            ...(noted.steering ? { steersNextStep: true } : {}),
          },
        ],
      };
    }
    case 'thinking': {
      const absorbed = absorbSteerThinking({
        stream: state.stream,
        followUpPending: state.followUpPending,
        sealedRaw: state.sealedRaw,
        thinking: event.content,
      });
      const messages = absorbed.sealed ? insertSealed(state, absorbed.sealed) : state.messages;
      return {
        ...state,
        messages,
        stream: absorbed.stream,
        typing: true,
        followUpPending: absorbed.followUpPending,
        followUpAnswer: absorbed.opened ? true : state.followUpAnswer,
        sealedRaw: absorbed.sealedRaw,
      };
    }
    case 'chunk':
      return {
        ...state,
        typing: true,
        stream: reduceTurnFrame(state.stream, { type: 'chunk', content: event.content }).state,
      };
    case 'tool':
      return {
        ...state,
        typing: true,
        stream: reduceTurnFrame(state.stream, { type: 'tool_call', hasName: true }).state,
      };
    case 'done': {
      const folded = reduceTurnFrame(state.stream, { type: 'done', full_response: event.full });
      const messages = [...state.messages];
      if (folded.completion?.kind === 'commit') {
        const content = steeredFinalContent(folded.completion.content, state.sealedRaw);
        const thinking = folded.completion.thinking;
        if (content || thinking) {
          messages.push({
            id: `m${messages.length + 1}`,
            role: 'agent',
            content,
            ...(thinking ? { thinking } : {}),
          });
        }
      }
      return {
        messages: clearFinishedSteerMarks(messages),
        stream: folded.state,
        typing: false,
        followUpPending: false,
        followUpAnswer: false,
        sealedRaw: '',
      };
    }
    case 'stop': {
      const thinking = (state.stream.pendingThinking || state.stream.capturedThinking).trim();
      const messages: SteerRow[] = [
        ...state.messages,
        {
          id: rowId(state),
          role: 'agent',
          content: interruptedContent(state.stream.pendingContent, event.note),
          ...(thinking ? { thinking } : {}),
        },
      ];
      return {
        messages: clearFinishedSteerMarks(messages),
        stream: initialTurnStreamState(),
        typing: false,
        followUpPending: false,
        followUpAnswer: false,
        sealedRaw: '',
      };
    }
    default:
      return state;
  }
}

/** Outline of the transcript plus where the live stream would be drawn. */
export function steerOutline(state: SteerTranscript): {
  rows: Array<{ role: SteerRow['role']; content: string; thinking?: string; caption: boolean }>;
  streamIndex: number;
  pending: string;
  pendingThinking: string;
} {
  const groups = groupIllustratedBubbles(state.messages, false);
  return {
    rows: state.messages.map((row) => ({
      role: row.role,
      content: row.content,
      ...(row.thinking ? { thinking: row.thinking } : {}),
      caption: steerCaptionVisible(state.typing, row.steersNextStep),
    })),
    streamIndex: liveAnswerGroupIndex(state.typing, state.followUpAnswer, groups),
    pending: state.stream.pendingContent,
    pendingThinking: state.stream.pendingThinking,
  };
}
