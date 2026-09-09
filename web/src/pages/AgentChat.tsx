import { memo, useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { ArrowUp, Square, User, AlertCircle, Copy, Check, X, Trash2, Minimize2, Maximize2, ChevronDown, Wrench, PanelRightClose, PanelRightOpen, Plus, Mic, Loader2, Pencil, FolderOpen, ImagePlus, Sparkles } from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AgentProvider, useAgent, type ChatMessage } from '@/contexts/AgentContext';
import { labelForProviderRef, resolveProviderRefArg } from '@/contexts/modelPicker.logic';
import SessionPicker from '@/components/SessionPicker';
import { useDraft } from '@/hooks/useDraft';
import { t, getLocale } from '@/lib/i18n';
import {
  COMMANDS,
  helpText,
  isSlashCommand,
  matchCommands,
  parseCommand,
  type CommandSpec,
} from '@/lib/slashCommands';
import ToolCallCard from '@/components/ToolCallCard';
import { ArtifactCard } from '@/components/ArtifactCard';
import { OutlineEditModal } from '@/components/OutlineEditModal';
import { SavePersonalSkillModal } from '@/components/SavePersonalSkillModal';
import { ThinkingTranscript } from '@/components/ThinkingTranscript';
import ApprovalBanner from '@/components/ApprovalBanner';
import { AutonomySelect } from '@/components/AutonomySelect';
import { ApiError, savePersonalSkill, uploadAgentWorkspaceFile, uploadChatImage } from '@/lib/api';
import {
  DEFAULT_WORKBENCH_AUTONOMY,
  loadWorkbenchAutonomy,
  saveWorkbenchAutonomy,
  clampWorkbenchAutonomy,
  maxAutonomyForRole,
  type WorkbenchAutonomy,
} from '@/lib/workbenchAutonomy';
import {
  CHAT_UPLOAD_MAX_BYTES,
  CHAT_UPLOAD_MAX_FILES,
  composeUploadMessage,
  cwdRelativeUploadPath,
  displayUploadMessage,
  sessionUploadWorkspacePath,
  uniqueUploadFileName,
} from '@/lib/chatUpload';
import { splitChatHtmlBlocks } from '@/lib/chatHtmlPreview';
import { artifactKind } from '@/lib/artifactKind';
import { groupIllustratedBubbles, shouldAttachStreamingToGroup } from '@/lib/chatIllustrated';
import { extractMcpToolText, extractToolImages, stripImageMarkers } from '@/lib/chatImages';
import { ChatImagePreview } from '@/components/ChatImagePreview';
import { sanitizeSessionTitle, stripSessionTitleTimestamp } from '@/lib/workbenchSession';
import { composeOutlineContinuePrompt, shouldShowOutlineEditButton } from '@/lib/outlineDraft';
import { composeHomeMessage, parseHomeSkillDisplay, titleFromUserMessage, type HomeSkillRef } from '@/lib/homeSend';
import {
  inferHomeSkillFromMessages,
  resolveActiveHomeSkill,
  shouldRestoreHomeSkill,
} from '@/lib/homeSessionSkill';
import { HomeSkillChip } from '@/components/HomeSkillChip';
import { homeCapIcon } from '@/lib/workbenchHomeCatalog';
import {
  draftPersonalSkill,
  shouldShowSaveSkillButton,
  skillSlug,
  type PersonalSkillDraft,
} from '@/lib/personalSkill';
import { basePath } from '@/lib/basePath';

const DRAFT_KEY_PREFIX = 'agent-chat';

function AgentAvatar({ className }: { className: string }) {
  return (
    <img
      src={`${basePath}/_app/agent-avatar.png`}
      alt=""
      className={`shrink-0 object-contain ${className}`}
    />
  );
}

type PendingAttach = {
  id: string;
  filename: string;
  size: number;
  mime: string;
  cwdRel: string;
  workspacePath: string;
  status: 'uploading' | 'ready' | 'error';
  previewUrl?: string;
};

// Open chat links in a new tab so navigation never replaces the live chat
// page. In-page anchors (e.g. GFM footnote refs) keep default navigation.
const markdownComponents: Components = {
  a: ({ node: _node, href, ...props }) =>
    href?.startsWith('#') ? (
      <a {...props} href={href} />
    ) : (
      <a {...props} href={href} target="_blank" rel="noopener noreferrer" />
    ),
};

/** Format token count with commas (e.g., 12345 -> "12,345"). */
function fmtTokens(n: number): string {
  return n.toLocaleString();
}

function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 10_000) return `${Math.round(n / 1_000)}k`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

/** Compact context meter for the composer toolbar, next to the model picker. */
function ContextMeter({
  contextMaxTokens,
  contextInputTokens,
}: {
  contextMaxTokens: number | null;
  contextInputTokens: number | null;
}) {
  if (!contextMaxTokens) return null;

  const used = contextInputTokens ?? 0;
  const max = contextMaxTokens;
  const pct = max > 0 ? Math.min((used / max) * 100, 100) : 0;
  const full = `ctx: ${fmtTokens(used)} / ${fmtTokens(max)}  ${pct.toFixed(0)}%`;

  return (
    <span
      className="inline-flex items-center gap-1.5 text-[11px] tabular-nums text-pc-text-muted"
      title={full}
    >
      <span className="h-1 w-10 overflow-hidden rounded-full bg-pc-border">
        <span
          className="block h-full rounded-full"
          style={{
            width: `${pct}%`,
            background: pct >= 95 ? 'var(--color-status-error)' : pct >= 80 ? 'var(--color-status-warning)' : 'var(--pc-accent)',
          }}
        />
      </span>
      <span className="whitespace-nowrap">{compactTokens(used)}/{compactTokens(max)} {pct.toFixed(0)}%</span>
    </span>
  );
}

/**
 * Dashboard chat at `/agent/:alias`. Stays inside the ops Layout.
 * The CDC workbench (`/workbench/:alias`) is a separate full-viewport surface.
 */
export default function AgentChat() {
  const { alias } = useParams<{ alias: string }>();
  if (!alias) {
    return <Navigate to="/agents" replace />;
  }
  const agentAlias = decodeURIComponent(alias);
  return (
    <AgentProvider agentAlias={agentAlias}>
      <div className="flex h-full min-h-0 flex-1 flex-col">
        <AgentChatInner agentAlias={agentAlias} />
      </div>
    </AgentProvider>
  );
}

/** Status snapshot a chat pane pushes up to the workbench sidebar. */
export interface AgentChatStatus {
  typing: boolean;
  messageCount: number;
  /** First user-message preview, used as the session label. */
  preview?: string;
}

/**
 * Full chat view for a single agent. Must be rendered inside an
 * `<AgentProvider>` (it calls `useAgent()` internally). Exported so the
 * multi-agent `ChatWorkspace` can mount one instance per open chat and keep
 * them all alive simultaneously.
 *
 * `onStatus` lets the host (the workbench) observe live typing / message-count
 * changes per pane without itself subscribing to the agent context — used to
 * drive the streaming and unread indicators in the left sidebar.
 */
export function AgentChatInner({
  agentAlias,
  onStatus,
  sessionTitle,
  onRenameSession,
  rightPanelCollapsed,
  onToggleRightPanel,
  initialPrompt,
  onInitialPromptConsumed,
  initialAutonomy,
  initialFiles,
  autonomyScope,
  userRole,
  sessionSkill,
  onClearSessionSkill,
  onRestoreSessionSkill,
}: {
  agentAlias: string;
  onStatus?: (s: AgentChatStatus) => void;
  sessionTitle?: string;
  onRenameSession?: (name: string) => void;
  rightPanelCollapsed?: boolean;
  onToggleRightPanel?: () => void;
  initialPrompt?: string;
  onInitialPromptConsumed?: () => void;
  initialAutonomy?: WorkbenchAutonomy;
  initialFiles?: File[];
  autonomyScope?: string;
  userRole?: string;
  sessionSkill?: HomeSkillRef;
  onClearSessionSkill?: () => void;
  onRestoreSessionSkill?: (skill: HomeSkillRef) => void;
}) {
  const {
    messages,
    sendMessage,
    connected,
    error,
    typing,
    streamingContent,
    streamingThinking,
    currentModel,
    availableModels,
    modelLabels,
    switchModel,
    modelLoading,
    deleteMessage,
    clearAllMessages,
    startNewSession,
    hydrated,
    addLocalMessage,
    abortSession,
    pendingApproval,
    respondToApproval,
    contextMaxTokens,
    contextInputTokens,
    sessionId,
  } = useAgent();

  // Keyed by conversation, not just alias: with the same agent open in two
  // panes an alias-only key would make both share one draft.
  const draftKey = `${DRAFT_KEY_PREFIX}.${agentAlias}.${sessionId}`;
  const { draft, saveDraft, clearDraft } = useDraft(draftKey);
  const [input, setInput] = useState(draft);
  const inputValueRef = useRef(input);
  const writeInput = useCallback((value: string) => {
    inputValueRef.current = value;
    setInput(value);
  }, []);
  const saveDraftRef = useRef(saveDraft);
  saveDraftRef.current = saveDraft;
  const applyInput = useCallback((next: string | ((prev: string) => string)) => {
    const value = typeof next === 'function' ? next(inputValueRef.current) : next;
    writeInput(value);
    saveDraftRef.current(value);
  }, [writeInput]);
  const isWorkbench = Boolean(onRenameSession || onToggleRightPanel || autonomyScope);
  const [skillDismissed, setSkillDismissed] = useState(false);
  useEffect(() => {
    setSkillDismissed(false);
  }, [autonomyScope, sessionSkill?.id, sessionSkill?.label]);
  const inferredSkill = useMemo(
    () => inferHomeSkillFromMessages(messages),
    [messages],
  );
  const activeSkill = resolveActiveHomeSkill({
    sessionSkill,
    inferredSkill,
    dismissed: skillDismissed,
  });
  useEffect(() => {
    const restore = shouldRestoreHomeSkill({
      dismissed: skillDismissed,
      sessionSkill,
      inferredSkill,
    });
    if (restore) onRestoreSessionSkill?.(restore);
  }, [skillDismissed, sessionSkill, inferredSkill, onRestoreSessionSkill]);
  const [outlineDraft, setOutlineDraft] = useState<string | null>(null);
  const [skillDraft, setSkillDraft] = useState<PersonalSkillDraft | null>(null);
  const [skillSaving, setSkillSaving] = useState(false);
  const [skillError, setSkillError] = useState<string | null>(null);
  const [skillNotice, setSkillNotice] = useState<string | null>(null);
  const persistAutonomyScope = autonomyScope ?? sessionId;
  const maxAutonomy = maxAutonomyForRole(userRole);
  const [autonomy, setAutonomy] = useState<WorkbenchAutonomy>(() =>
    clampWorkbenchAutonomy(
      initialAutonomy
        ?? loadWorkbenchAutonomy(persistAutonomyScope)
        ?? DEFAULT_WORKBENCH_AUTONOMY,
      maxAutonomy,
    ),
  );
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  // Slash-command autocomplete popover (#7137). Shown while the input begins
  // with a single '/' and the token still matches at least one command.
  const [showCommandHint, setShowCommandHint] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [compact, setCompact] = useState(() => {
    try { return localStorage.getItem('zeroclaw_chat_compact') === '1'; } catch { return false; }
  });
  // Tool execution is plumbing, not chat. Default off so tool_call /
  // tool_result frames do not surface inline in the conversation transcript.
  // Toggleable from the chat toolbar (Wrench button). The WebSocket lives in
  // AgentContext, which always pushes tool cards into messages; this toggle
  // filters them at render time so toggling on retroactively reveals prior
  // tool activity.
  const [showToolActivity, setShowToolActivity] = useState(() => {
    try { return localStorage.getItem('zeroclaw_show_tool_activity') === '1'; } catch { return false; }
  });

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const consumedInitialRef = useRef(false);
  const wasTypingRef = useRef(false);
  const [attachments, setAttachments] = useState<PendingAttach[]>([]);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const [dragOver, setDragOver] = useState(false);
  const [renamingTitle, setRenamingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const titleInputRef = useRef<HTMLInputElement>(null);
  const [attachHint, setAttachHint] = useState<string | null>(null);

  useEffect(() => {
    if (renamingTitle) {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    }
  }, [renamingTitle]);

  useEffect(() => {
    writeInput(draft);
  }, [draftKey, draft, writeInput]);

  function startTitleRename() {
    if (!onRenameSession) return;
    setTitleDraft(sanitizeSessionTitle(sessionTitle) ?? (sessionTitle?.trim() || ''));
    setRenamingTitle(true);
  }

  function submitTitleRename() {
    if (!renamingTitle) return;
    const next = sanitizeSessionTitle(titleDraft);
    setRenamingTitle(false);
    if (next && onRenameSession) onRenameSession(next);
  }

  // Report live status up to the workbench (sidebar indicators + session title).
  useEffect(() => {
    const first = messages.find((m) => m.role === 'user' && !m.ephemeral && !m.notice);
    const preview = first
      ? (sanitizeSessionTitle(titleFromUserMessage(first.content, sessionSkill?.label)) ?? undefined)
      : undefined;
    onStatus?.({ typing, messageCount: messages.length, preview });
  }, [typing, messages, onStatus, sessionSkill?.label]);

  const headingTitle =
    sanitizeSessionTitle(sessionTitle)
    ?? sanitizeSessionTitle(sessionSkill?.label)
    ?? (sessionTitle?.trim() || agentAlias);
  // Scroll to bottom on new messages / streaming.
  // Note: WebSocket lifecycle, hydration, and tool_call/tool_result handling
  // moved to AgentContext (PR #6101). Tool activity is filtered at render
  // time below using `showToolActivity`, not at the message-handler layer.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, typing, streamingContent, streamingThinking]);

  useEffect(() => {
    const finished = wasTypingRef.current && !typing;
    wasTypingRef.current = typing;
    if (!finished || !connected) return;
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [typing, connected]);

  // Close model dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
        setShowModelDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  /**
   * Slash-command dispatcher (#7137). Returns true when `trimmed` was handled
   * as a command (and therefore must NOT be sent to the model as a prompt).
   * Commands drive existing session primitives — clear/reset and model switch —
   * and surface their feedback as local info messages, never to the gateway.
   */
  const runCommand = useCallback((trimmed: string): boolean => {
    if (!isSlashCommand(trimmed)) return false;

    const { command, args } = parseCommand(trimmed);
    switch (command) {
      case 'help':
        addLocalMessage(helpText());
        return true;

      case 'clear':
        clearAllMessages();
        addLocalMessage(t('agent.cmd_cleared'));
        return true;

      // Was an alias for /clear, which deleted the conversation. Now that an
      // agent can hold several, "new" means what it says: start another one and
      // leave this one on the gateway (issue #7543).
      case 'new':
        if (!startNewSession()) {
          addLocalMessage(t('agent.sessions_unavailable'));
        }
        return true;

      case 'model': {
        const name = args.trim();
        const currentLabel = currentModel
          ? labelForProviderRef(currentModel, modelLabels)
          : null;
        if (!name) {
          const current = currentLabel
            ? t('agent.cmd_model_current').replace('{model}', currentLabel)
            : t('agent.cmd_model_none');
          const list = availableModels.length > 0
            ? `\n${t('agent.cmd_model_available').replace('{models}', availableModels.map((ref) => labelForProviderRef(ref, modelLabels)).join(', '))}`
            : '';
          addLocalMessage(`${current}${list}`);
          return true;
        }
        if (name === currentModel || name === currentLabel) {
          addLocalMessage(t('agent.cmd_model_current').replace('{model}', currentLabel ?? name));
          return true;
        }
        const target = resolveProviderRefArg(name, availableModels, modelLabels);
        if (availableModels.length > 0 && !target) {
          addLocalMessage(
            t('agent.cmd_model_unknown')
              .replace('{model}', name)
              .replace('{models}', availableModels.map((ref) => labelForProviderRef(ref, modelLabels)).join(', ')),
          );
          return true;
        }
        const ref = target ?? name;
        // switchModel silently no-ops while another switch is in flight, which
        // looks like the command was ignored. Surface that state explicitly. #7137
        if (modelLoading) {
          addLocalMessage(t('agent.cmd_model_busy'));
          return true;
        }
        addLocalMessage(
          t('agent.cmd_model_switching').replace('{model}', labelForProviderRef(ref, modelLabels)),
        );
        void switchModel(ref).catch(() => {
          addLocalMessage(
            t('agent.cmd_model_failed').replace('{model}', labelForProviderRef(ref, modelLabels)),
          );
        });
        return true;
      }

      default:
        addLocalMessage(t('agent.cmd_unknown').replace('{cmd}', `/${command}`));
        return true;
    }
  }, [addLocalMessage, clearAllMessages, startNewSession, currentModel, availableModels, modelLabels, switchModel, modelLoading]);

  const handleSend = () => {
    const trimmed = input.trim();
    const ready = attachments.filter((a) => a.status === 'ready');
    if (attachments.some((a) => a.status === 'uploading')) return;

    if (isSlashCommand(trimmed)) {
      runCommand(trimmed);
      setShowCommandHint(false);
      writeInput('');
      clearDraft();
      if (inputRef.current) {
        inputRef.current.style.height = 'auto';
        inputRef.current.focus();
      }
      return;
    }

    if (!connected) return;
    if (!trimmed && ready.length === 0) return;

    const text = trimmed.startsWith('//') ? trimmed.slice(1) : trimmed;
    const tagged = activeSkill
      ? composeHomeMessage({
          userText: text,
          skill: activeSkill,
          locale: getLocale(),
          includePrompt: false,
        })
      : text;
    const payload = ready.length
      ? composeUploadMessage(
          tagged,
          ready.map((a) => ({ cwdRel: a.cwdRel, filename: a.filename, mime: a.mime })),
        )
      : tagged;
    sendMessage(payload, clampWorkbenchAutonomy(autonomy, maxAutonomy));
    setAttachments((prev) => {
      for (const a of prev) {
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      }
      return [];
    });
    setAttachHint(null);
    setShowCommandHint(false);
    writeInput('');
    clearDraft();
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
      inputRef.current.focus();
    }
  };

  const addFiles = useCallback(
    async (fileList: File[]): Promise<Array<{ cwdRel: string; filename: string; mime: string }>> => {
      if (fileList.length === 0) return [];
      setAttachHint(null);
      const prev = attachmentsRef.current;
      let room = Math.max(0, CHAT_UPLOAD_MAX_FILES - prev.length);
      if (fileList.length > room) setAttachHint(t('workbench.attach_too_many'));
      const jobs: Array<{ id: string; file: File; filename: string; path: string }> = [];
      const extras: PendingAttach[] = [];
      const used = prev.map((a) => a.filename);
      for (const file of fileList) {
        if (room <= 0) break;
        if (file.size > CHAT_UPLOAD_MAX_BYTES) {
          setAttachHint(t('workbench.attach_too_large').replace('{name}', file.name));
          continue;
        }
        const filename = uniqueUploadFileName(used, file.name);
        used.push(filename);
        const id = crypto.randomUUID();
        const path = sessionUploadWorkspacePath(sessionId, filename);
        jobs.push({ id, file, filename, path });
        extras.push({
          id,
          filename,
          size: file.size,
          mime: file.type,
          cwdRel: cwdRelativeUploadPath(filename),
          workspacePath: path,
          status: 'uploading',
          previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
        });
        room -= 1;
      }
      if (extras.length === 0) return [];
      setAttachments((cur) => [...cur, ...extras]);
      const uploaded: Array<{ cwdRel: string; filename: string; mime: string }> = [];
      for (const job of jobs) {
        try {
          await uploadAgentWorkspaceFile(agentAlias, job.path, job.file);
          setAttachments((cur) =>
            cur.map((a) => (a.id === job.id ? { ...a, status: 'ready' } : a)),
          );
          uploaded.push({
            cwdRel: cwdRelativeUploadPath(job.filename),
            filename: job.filename,
            mime: job.file.type,
          });
        } catch {
          setAttachments((cur) =>
            cur.map((a) => (a.id === job.id ? { ...a, status: 'error' } : a)),
          );
          setAttachHint(t('workbench.attach_failed').replace('{name}', job.file.name));
        }
      }
      return uploaded;
    },
    [agentAlias, sessionId],
  );

  useEffect(() => {
    if (consumedInitialRef.current) return;
    const trimmed = (initialPrompt ?? '').trim();
    const files = initialFiles ?? [];
    const bootstrapping = initialPrompt !== undefined || files.length > 0;
    if (!bootstrapping) return;
    if (!trimmed && files.length === 0) {
      consumedInitialRef.current = true;
      onInitialPromptConsumed?.();
      return;
    }
    if (isSlashCommand(trimmed) && files.length === 0) {
      consumedInitialRef.current = true;
      runCommand(trimmed);
      onInitialPromptConsumed?.();
      return;
    }
    if (!connected) return;
    consumedInitialRef.current = true;
    void (async () => {
      const ready = files.length > 0 ? await addFiles(files) : [];
      const text = trimmed.startsWith('//') ? trimmed.slice(1) : trimmed;
      if (!text && ready.length === 0) {
        onInitialPromptConsumed?.();
        return;
      }
      const payload = ready.length ? composeUploadMessage(text, ready) : text;
      sendMessage(payload, clampWorkbenchAutonomy(autonomy, maxAutonomy));
      setAttachments((prev) => {
        for (const a of prev) {
          if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
        }
        return [];
      });
      onInitialPromptConsumed?.();
    })();
  }, [initialPrompt, initialFiles, connected, runCommand, sendMessage, onInitialPromptConsumed, autonomy, addFiles]);

  const removeAttachment = (id: string) => {
    setAttachments((prev) => {
      const target = prev.find((a) => a.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
  };

  const isComposingRef = useRef(false);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && showCommandHint) {
      setShowCommandHint(false);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !isComposingRef.current) {
      e.preventDefault();
      handleSend();
    }
  };

  const [uploading, setUploading] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const uploadImages = useCallback(async (files: Iterable<File>) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    setUploading(true);
    try {
      for (const file of list) {
        if (file.type && !file.type.startsWith('image/')) {
          addLocalMessage(t('agent.upload_not_image').replace('{name}', file.name));
          continue;
        }
        try {
          const res = await uploadChatImage(agentAlias, file);
          applyInput((prev) => `${prev && !prev.endsWith(' ') ? `${prev} ` : prev}${res.marker} `);
        } catch (err) {
          const message = err instanceof ApiError
            ? err.envelope.message
            : err instanceof Error ? err.message : String(err);
          addLocalMessage(t('agent.upload_failed').replace('{error}', message));
        }
      }
    } finally {
      setUploading(false);
      inputRef.current?.focus();
    }
  }, [agentAlias, addLocalMessage, applyInput]);

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    applyInput(value);
    // Show the command popover while typing the command token (a single
    // leading '/' with no space yet). Hide once the user moves to arguments or
    // the token no longer matches any command.
    const showHint = /^\/[^/\s]*$/.test(value) && matchCommands(value.slice(1)).length > 0;
    setShowCommandHint(showHint);
    e.target.style.height = 'auto';
    e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
  };

  // Apply a command from the autocomplete popover: fill the input with the
  // command and a trailing space (for arg-taking commands) or dispatch it
  // immediately when it takes no further input.
  const applyCommandHint = useCallback((spec: CommandSpec) => {
    setShowCommandHint(false);
    const takesArgs = spec.usage.includes('[');
    applyInput(`/${spec.name}${takesArgs ? ' ' : ''}`);
    inputRef.current?.focus();
  }, [applyInput]);

  const matchedCommands: CommandSpec[] = /^\/[^/\s]*$/.test(input)
    ? matchCommands(input.slice(1))
    : COMMANDS.slice();

  const handleEditOutline = useCallback((content: string) => {
    const text = content.trim();
    if (!text) return;
    setOutlineDraft(text);
  }, []);

  const handleOpenSaveSkill = useCallback((assistantText: string, userText: string) => {
    const draft = draftPersonalSkill({ userText, assistantText });
    setSkillError(null);
    setSkillDraft(draft);
  }, []);

  const handleSaveSkill = useCallback(async () => {
    if (!skillDraft) return;
    const name = skillSlug(skillDraft.name);
    if (!name) return;
    setSkillSaving(true);
    setSkillError(null);
    try {
      await savePersonalSkill({
        agent: agentAlias,
        name,
        description: skillDraft.description,
        body: skillDraft.body,
      });
      setSkillDraft(null);
      setSkillNotice(t('workbench.save_skill_done'));
    } catch (err) {
      setSkillError(err instanceof ApiError ? err.message : t('workbench.save_skill_failed'));
    } finally {
      setSkillSaving(false);
    }
  }, [agentAlias, skillDraft]);

  const handleCopy = useCallback((msgId: string, content: string) => {
    const onSuccess = () => {
      setCopiedId(msgId);
      setTimeout(() => setCopiedId((prev) => (prev === msgId ? null : prev)), 2000);
    };

    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(content).then(onSuccess).catch(() => {
        fallbackCopy(content) && onSuccess();
      });
    } else {
      fallbackCopy(content) && onSuccess();
    }
  }, []);

  const handleDeleteMessage = useCallback((msgId: string) => {
    deleteMessage(msgId);
  }, [deleteMessage]);

  const handleClearAll = useCallback(() => {
    clearAllMessages();
  }, [clearAllMessages]);

  // Stop button: POST /api/sessions/{id}/abort. The gateway cancels the
  // in-flight turn, the WS handler sends an `error` frame which our
  // onMessage handler already maps to typing=false.
  const handleAbort = useCallback(async () => {
    try {
      await abortSession();
    } catch {
      // Best-effort: surface nothing if the abort itself fails. The
      // user can retry, and any leaked typing state clears on the next
      // server frame.
    }
  }, [abortSession]);

  const toggleCompact = useCallback(() => {
    setCompact((prev) => {
      const next = !prev;
      try { localStorage.setItem('zeroclaw_chat_compact', next ? '1' : '0'); } catch { /* noop */ }
      return next;
    });
  }, []);

  const toggleToolActivity = useCallback(() => {
    setShowToolActivity((prev) => {
      const next = !prev;
      try { localStorage.setItem('zeroclaw_show_tool_activity', next ? '1' : '0'); } catch { /* noop */ }
      return next;
    });
  }, []);

  /**
   * Fallback copy using a temporary textarea for HTTP contexts
   * where navigator.clipboard is unavailable.
   */
  function fallbackCopy(text: string): boolean {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand('copy');
      return true;
    } catch {
      return false;
    } finally {
      document.body.removeChild(textarea);
    }
  }

  const handleModelSwitch = async (model: string) => {
    setShowModelDropdown(false);
    if (model === currentModel) return;
    try {
      await switchModel(model);
    } catch {
      // Error is already set by switchModel internally
    }
  };

  return (
    /* translate="no" / notranslate (#7057): browser auto-translation (e.g.
       Chrome → Google Translate) rewrites text nodes into <font> wrappers.
       React reconciliation then trips "Failed to execute 'removeChild' on
       'Node'" and unmounts the view. The crash repro surface spans every
       dynamic-text region on this page: streaming output, ReactMarkdown
       message bodies, the {error} banner above the toolbar, and
       ApprovalBanner (whose <pre>{argumentsSummary}</pre> and per-second
       remainingSec re-render are at least as crash-prone as streaming).
       Hoisting the opt-out to the outermost container covers all of them
       with a single ancestor. Static UI chrome here localizes through
       t() i18n, so losing browser translation on it is intentional. */
    <div
      translate="no"
      className="notranslate relative flex h-full min-h-0 flex-col bg-pc-surface"
      onDragEnter={(e) => {
        e.preventDefault();
        if (e.dataTransfer.types.includes('Files')) setDragOver(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        if (e.dataTransfer.types.includes('Files')) setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        void addFiles([...e.dataTransfer.files]);
      }}
    >
      <OutlineEditModal
        open={outlineDraft != null}
        value={outlineDraft ?? ''}
        onChange={(text) => setOutlineDraft(text)}
        onClose={() => setOutlineDraft(null)}
        onContinue={() => {
          if (!outlineDraft?.trim()) return;
          sendMessage(composeOutlineContinuePrompt(outlineDraft));
          setOutlineDraft(null);
        }}
        busy={!connected || typing}
      />
      <SavePersonalSkillModal
        open={skillDraft != null}
        draft={skillDraft ?? { name: '', description: '', body: '' }}
        onChange={(next) => setSkillDraft(next)}
        onClose={() => {
          setSkillDraft(null);
          setSkillError(null);
        }}
        onSave={() => { void handleSaveSkill(); }}
        busy={skillSaving}
        error={skillError}
      />
      {dragOver && (
        <div className="pointer-events-none absolute inset-3 z-40 flex items-center justify-center rounded-xl border-2 border-dashed border-pc-accent bg-pc-accent/10">
          <p className="text-sm font-medium text-pc-accent">{t('workbench.attach_drop')}</p>
        </div>
      )}
      <div className="flex w-full min-w-0 items-center justify-between border-b border-pc-border px-4 py-3 overflow-hidden shrink-0">
        <div className="flex items-center gap-3 flex-1 min-w-0 overflow-hidden">
          <AgentAvatar className="h-9 w-9" />
          <div className="flex flex-col min-w-0 flex-1 overflow-hidden">
            {renamingTitle ? (
              <input
                ref={titleInputRef}
                value={titleDraft}
                aria-label={t('workbench.rename_session')}
                onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    submitTitleRename();
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setRenamingTitle(false);
                  }
                }}
                onBlur={submitTitleRename}
                placeholder={t('workbench.session_name_placeholder')}
                className="h-7 w-full max-w-md rounded-md border border-pc-border bg-pc-input px-2 text-sm font-semibold text-pc-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pc-focus)]"
              />
            ) : (
              <div className="flex min-w-0 items-center gap-1">
                <h2 className="text-sm font-semibold min-w-0 truncate text-pc-text" title={headingTitle}>
                  {headingTitle}
                </h2>
                {onRenameSession && (
                  <button
                    type="button"
                    onClick={startTitleRename}
                    aria-label={t('workbench.rename_session')}
                    title={t('workbench.rename_session')}
                    className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-pc-text-muted hover:bg-[var(--pc-hover)] hover:text-pc-text"
                  >
                    <Pencil className="size-3.5" />
                  </button>
                )}
              </div>
            )}
            {headingTitle !== agentAlias && (
              <p className="text-xs text-pc-text-muted truncate">{agentAlias}</p>
            )}
          </div>
        </div>
        <div className="flex items-center shrink-0 ml-2 gap-0.5">
          {!isWorkbench && (
            <>
              <SessionPicker agentAlias={agentAlias} />
              <Link
                to={`/agent/${encodeURIComponent(agentAlias)}/workspace`}
                className="inline-flex items-center gap-1 px-2 h-6 rounded-[var(--radius-md)] text-xs font-medium text-pc-text-secondary transition-colors hover:text-pc-text hover:bg-[var(--pc-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pc-focus)]"
                title={t('agentchat.open_workspace')}
              >
                <FolderOpen className="h-3.5 w-3.5" />
                {t('agentchat.files')}
              </Link>
            </>
          )}
          <button
            type="button"
            onClick={toggleCompact}
            aria-label={t('agent.compact_mode')}
            title={t('agent.compact_mode')}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-pc-text-muted hover:bg-[var(--pc-hover)] hover:text-pc-text"
          >
            {compact ? <Maximize2 className="h-4 w-4" /> : <Minimize2 className="h-4 w-4" />}
          </button>
          <button
            type="button"
            onClick={toggleToolActivity}
            aria-label={showToolActivity ? t('agent.tool_activity_hide') : t('agent.tool_activity_show')}
            aria-pressed={showToolActivity}
            title={showToolActivity ? t('agent.tool_activity_hide') : t('agent.tool_activity_show')}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-pc-text-muted hover:bg-[var(--pc-hover)] hover:text-pc-text"
          >
            <Wrench className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={handleClearAll}
            disabled={messages.length === 0}
            aria-label={t('agent.clear_all')}
            title={t('agent.clear_all')}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-pc-text-muted hover:bg-status-error/15 hover:text-status-error disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-pc-text-muted"
          >
            <Trash2 className="h-4 w-4" />
          </button>
          {onToggleRightPanel && (
            <button
              type="button"
              onClick={onToggleRightPanel}
              aria-label={rightPanelCollapsed ? t('workbench.expand_right') : t('workbench.collapse_right')}
              title={rightPanelCollapsed ? t('workbench.expand_right') : t('workbench.collapse_right')}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-pc-text-muted hover:bg-[var(--pc-hover)] hover:text-pc-text"
            >
              {rightPanelCollapsed ? <PanelRightOpen className="h-4 w-4" /> : <PanelRightClose className="h-4 w-4" />}
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="px-4 py-2 border-b border-status-error/20 bg-status-error/10 text-status-error flex items-center gap-2 text-sm animate-fade-in">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}
      {skillNotice && (
        <div className="px-4 py-2 border-b border-pc-border bg-pc-elevated text-pc-text-secondary flex items-center justify-between gap-2 text-sm animate-fade-in">
          <span>{skillNotice}</span>
          <button
            type="button"
            onClick={() => setSkillNotice(null)}
            className="text-xs text-pc-text-muted hover:text-pc-text"
          >
            {t('common.close')}
          </button>
        </div>
      )}

      {/* Messages area. */}
      <div
        className={`flex-1 overflow-y-auto p-4 pb-8 ${compact ? 'space-y-1.5' : 'space-y-2'}`}
      >
        {messages.length === 0 && !initialPrompt && (
          <div className="flex flex-col items-center justify-center h-full text-center animate-fade-in text-pc-text-muted">
            <AgentAvatar className="mb-4 h-14 w-14" />
            {hydrated ? (
              <>
                <p className="text-base font-semibold mb-1 text-pc-text">{isWorkbench ? t('workbench.brand') : t('agentchat.empty_title')}</p>
                <p className="text-sm text-pc-text-muted">{t('agent.start_conversation')}</p>
              </>
            ) : (
              <p className="text-sm text-pc-text-muted">{t('agent.session_loading')}</p>
            )}
          </div>
        )}

        {(() => {
          const bubbles = groupIllustratedBubbles(messages, showToolActivity);
          const last = bubbles.at(-1);
          const streamInLast = Boolean(typing && shouldAttachStreamingToGroup(last));
          const lastUser = [...messages].reverse().find((m) => m.role === 'user');
          const lastUserText = lastUser ? messageModelText(lastUser) : '';
          return (
            <>
              {bubbles.map((items, idx) => {
                const prev = bubbles[idx - 1];
                const previousUserText = prev?.[0]?.role === 'user'
                  ? messageModelText(prev[0])
                  : '';
                return (
                <MessageItem
                  key={items.map((m) => m.id).join(':')}
                  items={items}
                  idx={idx}
                  compact={compact}
                  showToolActivity={showToolActivity}
                  isCopied={items.some((m) => copiedId === m.id)}
                  previousUserText={previousUserText}
                  lastUserText={lastUserText}
                  onCopy={handleCopy}
                  onEditOutline={handleEditOutline}
                  onSaveSkill={handleOpenSaveSkill}
                  onDelete={handleDeleteMessage}
                  streaming={streamInLast && idx === bubbles.length - 1
                    ? { content: streamingContent, thinking: streamingThinking }
                    : null}
                />
                );
              })}
              {typing && !streamInLast && (
                <div className="flex items-start gap-3 animate-fade-in">
                  <AgentAvatar className="h-8 w-8" />
                  {streamingContent || streamingThinking ? (
                    <div className="min-w-0 flex-1 rounded-[var(--radius-lg)] px-4 py-3 border border-pc-border bg-pc-elevated text-pc-text">
                      {streamingThinking && (
                        <ThinkingTranscript
                          text={streamingThinking}
                          live
                          open={!streamingContent}
                        />
                      )}
                      {streamingContent && <p className="text-sm whitespace-pre-wrap break-words leading-relaxed">{streamingContent}</p>}
                    </div>
                  ) : (
                    <div className="rounded-[var(--radius-lg)] px-4 py-3 border border-pc-border bg-pc-elevated flex items-center gap-1.5">
                      <span className="bounce-dot w-1.5 h-1.5 rounded-full bg-pc-accent" />
                      <span className="bounce-dot w-1.5 h-1.5 rounded-full bg-pc-accent" />
                      <span className="bounce-dot w-1.5 h-1.5 rounded-full bg-pc-accent" />
                    </div>
                  )}
                </div>
              )}
            </>
          );
        })()}

        <div ref={messagesEndRef} />
      </div>

      {/* Tool approval banner — supervised-mode consent prompt (#6522). */}
      {pendingApproval && (
        <ApprovalBanner pending={pendingApproval} onRespond={respondToApproval} />
      )}

      {/* Input area */}
      <div className="px-4 pb-3 pt-1">
        {showCommandHint && matchedCommands.length > 0 && (
          <div className="relative max-w-4xl mx-auto">
            <div
              className="absolute bottom-1 left-0 rounded-lg border shadow-md z-50 py-1 min-w-[260px] overflow-hidden"
              style={{ background: 'var(--pc-bg-elevated)', borderColor: 'var(--pc-border)' }}
            >
              <div
                className="px-3 py-1 text-[10px] uppercase tracking-wide"
                style={{ color: 'var(--pc-text-faint)' }}
              >
                {t('agent.cmd_hint_title')}
              </div>
              {matchedCommands.map((spec) => (
                <button
                  key={spec.name}
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); applyCommandHint(spec); }}
                  className="w-full text-left px-3 py-2 text-xs transition-colors flex items-center gap-2"
                  style={{ color: 'var(--pc-text-primary)' }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--pc-bg-surface)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                >
                  <span className="font-mono font-medium" style={{ color: 'var(--pc-accent)' }}>{spec.usage}</span>
                  <span className="truncate" style={{ color: 'var(--pc-text-muted)' }}>{t(spec.descriptionKey)}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="max-w-4xl mx-auto">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              void addFiles([...(e.target.files ?? [])]);
              e.target.value = '';
            }}
          />
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) void uploadImages(e.target.files);
              e.target.value = '';
            }}
          />
          <div className="relative flex w-full min-w-0 flex-col rounded-2xl border border-pc-border bg-pc-elevated px-3 pt-3 pb-2">
            {attachments.length > 0 && (
              <ul className="mb-2 flex flex-wrap gap-1.5">
                {attachments.map((file) => (
                  <li
                    key={file.id}
                    className="flex max-w-full items-center gap-1.5 rounded-md border border-pc-border bg-pc-surface px-2 py-1 text-xs text-pc-text"
                  >
                    {file.previewUrl ? (
                      <img src={file.previewUrl} alt="" className="size-6 rounded object-cover" />
                    ) : null}
                    {file.status === 'uploading' ? (
                      <Loader2 className="size-3.5 shrink-0 animate-spin text-pc-text-muted" />
                    ) : null}
                    <span className="min-w-0 truncate" title={file.filename}>
                      {file.filename}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeAttachment(file.id)}
                      className="inline-flex size-5 items-center justify-center rounded text-pc-text-muted hover:bg-[var(--pc-hover)] hover:text-pc-text"
                      aria-label={t('workbench.attach_remove')}
                      title={t('workbench.attach_remove')}
                    >
                      <X className="size-3" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex min-w-0 items-start gap-2">
              {activeSkill ? (
                <HomeSkillChip
                  label={activeSkill.label}
                  icon={homeCapIcon(activeSkill.icon ?? '')}
                  onClear={() => {
                    setSkillDismissed(true);
                    onClearSessionSkill?.();
                  }}
                />
              ) : null}
            <textarea
              ref={inputRef}
              rows={1}
              value={input}
              onChange={handleTextareaChange}
              onKeyDown={handleKeyDown}
              onPaste={(e) => {
                const files = [...e.clipboardData.files];
                if (files.length === 0) return;
                e.preventDefault();
                void addFiles(files);
              }}
              onCompositionStart={() => { isComposingRef.current = true; }}
              onCompositionEnd={() => { isComposingRef.current = false; }}
              placeholder={!connected
                ? t('agent.connecting')
                : !hydrated
                  ? t('agent.session_loading')
                  : typing
                    ? t('agent.running')
                    : t('agent.type_message')}
              disabled={!connected || typing || !hydrated}
              className="min-w-0 flex-1 bg-transparent text-sm resize-none text-pc-text placeholder:text-pc-text-muted outline-none focus:outline-none focus-visible:outline-none disabled:opacity-40"
              style={{ minHeight: '2.5rem', maxHeight: '10rem', paddingTop: '2px', paddingBottom: '8px' }}
            />
            </div>
            <div className="flex w-full min-w-0 items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={!connected || typing || !hydrated}
                  className="flex-shrink-0 inline-flex size-8 items-center justify-center rounded-md text-pc-text-muted hover:bg-[var(--pc-hover)] hover:text-pc-text disabled:opacity-40"
                  aria-label={t('workbench.attach_file')}
                  title={t('workbench.attach_file')}
                >
                  <Plus className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => imageInputRef.current?.click()}
                  disabled={!connected || typing || !hydrated || uploading}
                  className="flex-shrink-0 inline-flex size-8 items-center justify-center rounded-md text-pc-text-muted hover:bg-[var(--pc-hover)] hover:text-pc-text disabled:opacity-40"
                  aria-label={t('agent.attach_image')}
                  title={t('agent.attach_image')}
                >
                  {uploading
                    ? <Loader2 className="h-4 w-4 animate-spin" />
                    : <ImagePlus className="h-4 w-4" />}
                </button>
                <AutonomySelect
                  value={autonomy}
                  maxLevel={maxAutonomy}
                  disabled={!connected || typing}
                  onChange={(level) => {
                    const next = clampWorkbenchAutonomy(level, maxAutonomy);
                    setAutonomy(next);
                    saveWorkbenchAutonomy(persistAutonomyScope, next);
                  }}
                />
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <span
                  className="inline-flex size-4 shrink-0 rounded-full border-2"
                  style={typing
                    ? { borderColor: 'var(--pc-accent)' }
                    : connected
                      ? { borderColor: 'var(--color-status-success)' }
                      : { borderColor: 'var(--color-status-error)' }
                  }
                  title={typing
                    ? t('agent.running')
                    : connected
                      ? t('agent.connected_status')
                      : t('agent.disconnected_status')}
                />
                <div className="flex items-center gap-1.5">
                  <div className="relative" ref={modelDropdownRef}>
                    <button
                      type="button"
                      onClick={() => setShowModelDropdown((v) => !v)}
                      disabled={modelLoading || typing || (availableModels.length === 0 && currentModel === null)}
                      className="flex items-center gap-1 rounded-md px-1.5 py-1 text-sm text-pc-text-secondary hover:bg-[var(--pc-hover)] hover:text-pc-text disabled:opacity-50"
                    >
                      <span className="max-w-[12rem] truncate">
                        {modelLoading
                          ? t('agent.model_switching')
                          : (currentModel
                            ? labelForProviderRef(currentModel, modelLabels)
                            : (availableModels.length === 0 ? t('agent.model_loading') : t('agent.select_model')))}
                      </span>
                      <ChevronDown className="h-3 w-3 shrink-0" />
                    </button>
                    {showModelDropdown && availableModels.length > 0 && (
                      <div className="absolute bottom-[calc(100%+8px)] right-0 z-50 max-h-60 min-w-[200px] overflow-y-auto rounded-[var(--radius-md)] border border-pc-border bg-pc-elevated py-1 shadow-[var(--pc-shadow-md)]">
                        {availableModels.map((model) => {
                          const isActive = model === currentModel;
                          return (
                            <button
                              key={model}
                              type="button"
                              onClick={() => handleModelSwitch(model)}
                              className={`w-full text-left px-3 py-2 text-xs transition-colors ${
                                isActive
                                  ? 'text-pc-accent bg-pc-accent/10'
                                  : 'text-pc-text hover:bg-[var(--pc-hover)]'
                              }`}
                            >
                              {labelForProviderRef(model, modelLabels)}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  <ContextMeter contextMaxTokens={contextMaxTokens} contextInputTokens={contextInputTokens} />
                </div>
                <button
                  type="button"
                  disabled
                  className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-pc-text-muted opacity-60"
                  aria-label={t('workbench.voice_input')}
                  title={t('workbench.voice_soon')}
                >
                  <Mic className="h-4 w-4" />
                </button>
                {typing ? (
                  <button
                    type="button"
                    onClick={handleAbort}
                    className="flex-shrink-0 inline-flex size-8 items-center justify-center rounded-full bg-status-error text-white hover:opacity-90 disabled:opacity-40"
                    aria-label={t('agent.stop')}
                    title={t('agent.stop')}
                  >
                    <Square className="h-3.5 w-3.5" fill="currentColor" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleSend}
                    disabled={
                      !connected
                      || !hydrated
                      || attachments.some((a) => a.status === 'uploading')
                      || (!input.trim() && attachments.filter((a) => a.status === 'ready').length === 0)
                    }
                    className="flex-shrink-0 inline-flex size-8 items-center justify-center rounded-full bg-pc-text text-pc-base hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
                    aria-label={t('agent.send')}
                  >
                    <ArrowUp className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
          </div>
          {attachHint && (
            <p className="mt-1 text-[11px] text-status-error">{attachHint}</p>
          )}
        </div>
      </div>
    </div>
  );
}

// Channel-user (and some agent) messages arrive with a leading
// `[YYYY-MM-DD HH:MM:SS TZ]` prefix, or the runtime enrichment
// `[CURRENT DATE & TIME: …]` stored in session history. The bubble shows its
// own wall-clock caption; a bracketed datetime mid-message is left intact.
function stripServerTimestamp(content: string): string {
  return stripSessionTitleTimestamp(content);
}

// Each chat message is rendered through this memoized component so that
// typing into the input does not re-render every existing message (and
// re-run ReactMarkdown on each one). Keep the prop surface small and pass
// `isCopied` rather than the parent's full copiedId so only the affected
// row re-renders when the copy indicator flips. See #5125.
interface MessageItemProps {
  items?: ChatMessage[];
  idx: number;
  compact: boolean;
  showToolActivity: boolean;
  isCopied: boolean;
  previousUserText?: string;
  lastUserText?: string;
  onCopy: (id: string, content: string) => void;
  onEditOutline: (content: string) => void;
  onSaveSkill: (assistantText: string, userText: string) => void;
  onDelete: (id: string) => void;
  streaming?: { content: string; thinking: string } | null;
}

function ChatMarkdown({ content, compact }: { content: string; compact: boolean }) {
  const { markdown } = splitChatHtmlBlocks(stripImageMarkers(content));
  const images = extractToolImages(content);
  return (
    <>
      {markdown ? (
        <div className={`${compact ? 'text-xs' : 'text-sm'} break-words leading-relaxed chat-markdown`}>
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{markdown}</ReactMarkdown>
        </div>
      ) : null}
      <ChatImagePreview images={images} />
    </>
  );
}

function messageModelText(msg: ChatMessage | undefined): string {
  if (!msg) return '';
  const cleanContent = msg.local || msg.ephemeral ? msg.content : stripServerTimestamp(msg.content);
  return msg.role === 'user' ? displayUploadMessage(cleanContent) : cleanContent;
}

function messageDisplayText(msg: ChatMessage | undefined): string {
  if (!msg) return '';
  const raw = messageModelText(msg);
  if (msg.role === 'user') return parseHomeSkillDisplay(raw).visible;
  if (msg.role !== 'agent') return raw;
  return splitChatHtmlBlocks(stripImageMarkers(raw)).markdown;
}

function MessageBody({
  msg,
  compact,
  showToolActivity,
  hideImageCaption,
}: {
  msg: ChatMessage;
  compact: boolean;
  showToolActivity: boolean;
  hideImageCaption: boolean;
}) {
  const isUser = msg.role === 'user';
  const raw = messageModelText(msg);
  const attached = isUser ? parseHomeSkillDisplay(raw) : null;
  const shownContent = isUser ? (attached?.visible ?? '') : messageDisplayText(msg);
  const userLong = isUser && (
    Boolean(attached?.skillLabel)
    || shownContent.includes('\n')
    || shownContent.length > 40
  );
  if (msg.toolCall) {
    const imageArtifact = msg.toolCall.artifact
      && artifactKind(msg.toolCall.artifact.mime, msg.toolCall.artifact.filename) === 'image'
      ? msg.toolCall.artifact
      : undefined;
    return (
      <>
        {showToolActivity && <ToolCallCard toolCall={msg.toolCall} />}
        {imageArtifact && (
          <div className={showToolActivity ? 'mt-2' : ''}>
            <ArtifactCard artifact={imageArtifact} />
          </div>
        )}
        {!imageArtifact && (
          <ChatImagePreview
            images={extractToolImages(msg.toolCall.output)}
            caption={hideImageCaption ? undefined : extractMcpToolText(msg.toolCall.output ?? '')}
          />
        )}
      </>
    );
  }
  if (msg.markdown) {
    return <ChatMarkdown content={shownContent} compact={compact} />;
  }
  return (
    <div className={isUser && attached?.skillLabel ? 'text-left' : undefined}>
      {attached?.skillLabel ? (
        <HomeSkillChip label={attached.skillLabel} />
      ) : null}
      {shownContent ? (
        <p className={`${attached?.skillLabel ? 'mt-1.5 ' : ''}${compact ? 'text-xs' : 'text-sm'} whitespace-pre-wrap break-words leading-relaxed ${isUser ? (userLong ? 'text-left' : 'text-right') : ''}`}>{shownContent}</p>
      ) : null}
    </div>
  );
}

const MessageItem = memo(function MessageItem({
  items,
  idx,
  compact,
  showToolActivity,
  isCopied,
  previousUserText,
  lastUserText,
  onCopy,
  onEditOutline,
  onSaveSkill,
  onDelete,
  streaming,
}: MessageItemProps) {
  const rows = items ?? [];
  const msg = rows[0];
  if (!msg) return null;
  const shownContent = rows.map(messageDisplayText).filter((text) => text.trim()).join('\n\n');
  const groupHasProse = rows.some((row) => !row.toolCall && (
    messageDisplayText(row).trim()
    || Boolean(parseHomeSkillDisplay(messageModelText(row)).skillLabel)
  ));
  const isUser = msg.role === 'user';
  const attachedSkill = isUser && rows.some((row) => parseHomeSkillDisplay(messageModelText(row)).skillLabel);
  const userLong = isUser && (attachedSkill || shownContent.includes('\n') || shownContent.length > 40);
  const stamp = rows.at(-1) ?? msg;

  return (
    <div
      className={`group relative z-0 hover:z-30 flex items-start ${compact ? 'gap-2' : 'gap-3'} ${
        isUser ? 'justify-end animate-slide-in-right' : 'animate-slide-in-left'
      }`}
      style={{ animationDelay: `${Math.min(idx * 30, 200)}ms` }}
    >
      {!isUser && !compact && (
        msg.notice ? (
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-status-warning/30 bg-status-warning/10">
            <AlertCircle className="h-4 w-4 text-status-warning" />
          </div>
        ) : (
          <AgentAvatar className="h-8 w-8" />
        )
      )}
      <div className={isUser ? 'relative max-w-[75%] min-w-0' : 'relative min-w-0 flex-1'}>
        <div
          className={`${isUser ? `w-fit max-w-full ml-auto ${userLong ? 'text-left' : 'text-right'}` : 'w-full'} ${compact ? 'rounded-[var(--radius-md)] px-3 py-1.5 border' : 'rounded-[var(--radius-lg)] px-4 py-3 border'} text-pc-text ${
            msg.notice
              ? 'bg-status-warning/5 border-status-warning/30'
              : isUser
              ? 'bg-pc-accent/10 border-pc-accent/20'
              : 'bg-pc-elevated border-pc-border'
          }`}
        >
          <div className="space-y-2">
            {rows.map((row) => (
              <div key={row.id}>
                {row.thinking && (
                  <ThinkingTranscript text={row.thinking} />
                )}
                <MessageBody
                  msg={row}
                  compact={compact}
                  showToolActivity={showToolActivity}
                  hideImageCaption={groupHasProse}
                />
              </div>
            ))}
            {streaming && (streaming.thinking || streaming.content) && (
              <div>
                {streaming.thinking && (
                  <ThinkingTranscript
                    text={streaming.thinking}
                    live
                    open={!streaming.content}
                  />
                )}
                {streaming.content && (
                  <p className={`${compact ? 'text-xs' : 'text-sm'} whitespace-pre-wrap break-words leading-relaxed`}>{streaming.content}</p>
                )}
              </div>
            )}
            {streaming && !streaming.thinking && !streaming.content && (
              <div className="flex items-center gap-1.5">
                <span className="bounce-dot w-1.5 h-1.5 rounded-full bg-pc-accent" />
                <span className="bounce-dot w-1.5 h-1.5 rounded-full bg-pc-accent" />
                <span className="bounce-dot w-1.5 h-1.5 rounded-full bg-pc-accent" />
              </div>
            )}
            {(() => {
              const showOutline = shouldShowOutlineEditButton({
                isAssistant: !isUser,
                streaming: Boolean(streaming),
                hasProse: groupHasProse,
                content: shownContent,
                previousUserText: previousUserText ?? '',
              });
              const showSave = shouldShowSaveSkillButton({
                isAssistant: !isUser,
                streaming: Boolean(streaming),
                hasProse: groupHasProse,
                content: shownContent,
                isError: rows.some((row) => row.notice)
                  || shownContent.startsWith(t('agent.error_prefix')),
              });
              if (!showOutline && !showSave) return null;
              return (
            <div className="mt-3 flex flex-wrap gap-2">
            {showOutline ? (
              <button
                type="button"
                onClick={() => onEditOutline(shownContent)}
                className="inline-flex h-8 items-center gap-1.5 rounded-[8px] border border-pc-border px-2.5 text-xs font-medium text-pc-text-secondary hover:bg-[var(--pc-hover)] hover:text-pc-text"
              >
                <Pencil className="size-3.5" />
                {t('workbench.edit_outline')}
              </button>
            ) : null}
            {showSave ? (
              <button
                type="button"
                onClick={() => onSaveSkill(shownContent, lastUserText ?? previousUserText ?? '')}
                className="inline-flex h-8 items-center gap-1.5 rounded-[8px] border border-pc-border px-2.5 text-xs font-medium text-pc-text-secondary hover:bg-[var(--pc-hover)] hover:text-pc-text"
              >
                <Sparkles className="size-3.5" />
                {t('workbench.save_skill')}
              </button>
            ) : null}
            </div>
              );
            })()}
          </div>
        </div>
        <div
          className={[
            'absolute top-full z-20 mt-0.5 flex items-center gap-1 rounded-md bg-pc-surface/95 px-1 py-0.5',
            'opacity-0 group-hover:opacity-100 transition-opacity',
            msg.role === 'user' ? 'right-0' : 'left-0',
          ].join(' ')}
        >
          <span className="px-1 text-[10px] tabular-nums text-pc-text-faint whitespace-nowrap">
            {stamp.timestamp.toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
          </span>
          <button
            onClick={() => onCopy(msg.id, shownContent)}
            aria-label={t('agent.copy_message')}
            className="p-1 rounded-[var(--radius-sm)] text-pc-text-muted hover:text-pc-text transition-colors"
          >
            {isCopied ? (
              <Check className="h-3.5 w-3.5 text-status-success" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            onClick={() => {
              for (const row of rows) onDelete(row.id);
            }}
            aria-label={t('agent.delete_message')}
            className="p-1 rounded-[var(--radius-sm)] text-pc-text-muted hover:text-status-error transition-colors"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      {isUser && !compact && (
        <div className="flex-shrink-0 w-8 h-8 rounded-[var(--radius-md)] flex items-center justify-center border bg-pc-accent/15 border-pc-accent/30">
          <User className="h-4 w-4 text-pc-accent" />
        </div>
      )}
    </div>
  );
});
