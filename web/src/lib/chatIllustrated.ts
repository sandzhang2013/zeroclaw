/** Raster charts stay in the transcript. HTML/PDF/canvas reports belong in the right pane. */

import { artifactKind, type ToolArtifactInfo } from './artifactKind.ts';
import { splitChatHtmlBlocks } from './chatHtmlPreview.ts';
import { looksLikeChatImages } from './chatImages.ts';

export interface IllustratedToolCall {
  artifact?: ToolArtifactInfo;
  output?: string;
  name?: string;
  args?: unknown;
}

export interface IllustratedMessage {
  id: string;
  role: 'user' | 'agent';
  content?: string;
  notice?: boolean;
  ephemeral?: boolean;
  toolCall?: IllustratedToolCall;
}

export function isInlineChatImage(toolCall: IllustratedToolCall | undefined): boolean {
  if (!toolCall) return false;
  if (toolCall.artifact && artifactKind(toolCall.artifact.mime, toolCall.artifact.filename) === 'image') {
    return true;
  }
  return looksLikeChatImages(toolCall.output);
}

/** Agent reply that is only an HTML document: show in results, not as an empty bubble. */
export function isHtmlReportOnlyMessage(msg: IllustratedMessage): boolean {
  if (msg.toolCall || msg.role !== 'agent') return false;
  const { markdown, htmlBlocks } = splitChatHtmlBlocks(msg.content ?? '');
  return htmlBlocks.length > 0 && !markdown.trim();
}

export function isIllustratedToolCall(toolCall: IllustratedToolCall | undefined): boolean {
  return isInlineChatImage(toolCall);
}

export function visibleChatMessages<T extends IllustratedMessage>(
  messages: T[],
  showToolActivity: boolean,
): T[] {
  return messages.filter((msg) => {
    if (isHtmlReportOnlyMessage(msg)) return false;
    return showToolActivity || !msg.toolCall || isIllustratedToolCall(msg.toolCall);
  });
}

function canJoinIllustratedBubble(prev: IllustratedMessage, next: IllustratedMessage): boolean {
  if (prev.role !== 'agent' || next.role !== 'agent') return false;
  if (prev.notice || next.notice || prev.ephemeral || next.ephemeral) return false;
  if (prev.toolCall && !isIllustratedToolCall(prev.toolCall)) return false;
  if (next.toolCall && !isIllustratedToolCall(next.toolCall)) return false;
  return true;
}

/** Consecutive agent text + visual tool results share one bubble. User rows stay solo. */
export function groupIllustratedBubbles<T extends IllustratedMessage>(
  messages: T[],
  showToolActivity: boolean,
): T[][] {
  const groups: T[][] = [];
  for (const msg of visibleChatMessages(messages, showToolActivity)) {
    const last = groups.at(-1);
    const prev = last?.at(-1);
    if (last && prev && canJoinIllustratedBubble(prev, msg)) {
      last.push(msg);
    } else {
      groups.push([msg]);
    }
  }
  return groups;
}

export function shouldAttachStreamingToGroup(group: IllustratedMessage[] | undefined): boolean {
  if (!group?.length) return false;
  const last = group.at(-1);
  if (!last || last.role !== 'agent' || last.notice || last.ephemeral) return false;
  return !last.toolCall || isIllustratedToolCall(last.toolCall);
}
