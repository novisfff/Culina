import { lazy, useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { invalidateAfterAiApprovalSettled, invalidateAfterAiMessageSent } from '../../api/cacheInvalidation';
import { api, isApiError } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type {
  AiApprovalRequest,
  AiChatAttachment,
  AiChatResponse,
  AiConversation,
  AiConversationSnapshot,
  AiConversationVisibility,
  AiInventoryCardAction,
  AiInventoryResultItem,
  AiMessage,
  AiMessagePart,
  AiProductLoopPrompt,
  AiResultCard,
  AiRunEvent,
  AiTodayRecommendationItem,
  AiTimelineEvent,
  CreateFoodPlanItemPayload,
  FoodPlanItem,
  UserSummary,
} from '../../api/types';
import type { AppNavigationTarget } from '../../app/appNavigationModel';
import { resolveMediaUrl } from '../../lib/assets';
import { abortAiStream } from '../../lib/aiStreamAbort';
import { FOOD_TYPE_LABELS } from '../../lib/ui';
import {
  AiDesktopConversationHistory,
  createPendingConversationKey,
  getConversationTitleFromMessages,
  isPendingConversationKey,
} from './AiConversationHistory';
import { AiDeleteConversationDialog } from './AiDeleteConversationDialog';
import { AiMobilePage } from './AiMobilePage';
import { AiResultCardReplacementProvider, MessageBubble, type AiApprovalDecisionSubmit, type AiHumanInputResponseSubmit, type AiResourceOptionLoader } from './AiConversationThread';
import { AiComposerAttachments } from './AiComposerAttachments';
import { AiQualityDiagnosticsModal } from './AiQualityDiagnosticsModal';
import { AiRecommendationPlanDialog, type AiRecommendationPlanRequest } from './AiRecommendationPlanDialog';
import { AiWelcomePrompt } from './AiWelcomePrompt';
import { AiVoiceInputButton } from './AiVoiceInputButton';
import { AiWorkspaceRoute } from './AiWorkspaceRoute';
import { AiDebugHost } from './views/AiDebugHost';
import { loadAiDebug } from './entries';
import {
  mergePendingApprovalsIntoMessages,
  normalizeStreamEventForFinalRun,
  attachIncludedApprovalsToMessage,
  createLocalAssistantMessage,
  appendDeltaToMessageParts,
  messageTextFromParts,
  isPendingHumanInputPart,
  hasOutputAfterHumanInputRequest,
  mergeRemoteAndLocalMessage,
  messagePartKey,
  mergeMessagePart,
  hasSuccessfulOperationResult,
  isSuccessfulOperationResultCard,
  preferredRunActivityEvent,
  runActivityCollapseKey,
  updateAiConversationSnapshot,
} from './aiWorkspaceHelpers';
import { useAiConversationLiveSync } from './useAiConversationLiveSync';
import { useAiAttachmentState } from './useAiAttachmentState';
import { NEW_AI_CONVERSATION_SCOPE, useAiConversationComposerState } from './useAiConversationComposerState';
import { useAiInventoryDraftAction } from './useAiInventoryDraftAction';
import { AiOperationRevertProvider } from '../../features/ai-auto-execution/useAiOperationRevert';
import { useAiConversationStreams } from './useAiConversationStreams';
import { useAiThinkingState } from './useAiThinkingState';
import { useAiRunCancellation } from '../../hooks/useAiRunCancellation';
import { aiThreadAutoScrollKey, latestUserMessageScrollKey, useAiThreadAutoScroll } from './useAiThreadAutoScroll';
import {
  applyAiTimelineEvent,
  createAiTimelineState,
  mergeAiTimelineReplay,
  selectAiTimelineMessages,
  type AiTimelineState,
} from './aiTimelineReducer';

const LazyAiDebugEntry = lazy(loadAiDebug);
type AiWorkspaceProps = {
  familyId?: string;
  conversations: AiConversation[];
  isLoading: boolean;
  currentUser?: UserSummary | null;
  onBackHome?: () => void;
  createFoodPlanItem?: (payload: CreateFoodPlanItemPayload) => Promise<FoodPlanItem>;
  isCreatingFoodPlanItem?: boolean;
  onNavigate?: (target: AppNavigationTarget) => void;
  /** Legacy prop retained for callers while the removed settings view settles to conversation. */
  view?: 'conversation' | 'autoExecution';
};
export { ApprovalPanel } from './AiConversationThread';
const AI_TABLET_SIDEBAR_COLLAPSE_MAX_WIDTH = 1280;

function isTabletAiWorkspaceViewport() {
  return typeof window !== 'undefined' && window.innerWidth <= AI_TABLET_SIDEBAR_COLLAPSE_MAX_WIDTH;
}

function readStoredAiSidebarCollapsed() {
  try {
    return localStorage.getItem('ai_sidebar_collapsed');
  } catch {
    return null;
  }
}

function resolveInitialAiSidebarCollapsed() {
  if (isTabletAiWorkspaceViewport()) return true;
  const stored = readStoredAiSidebarCollapsed();
  return stored === 'true';
}

function storeAiSidebarCollapsedPreference(collapsed: boolean) {
  if (isTabletAiWorkspaceViewport()) return;
  try {
    localStorage.setItem('ai_sidebar_collapsed', String(collapsed));
  } catch (e) {
    console.warn(e);
  }
}

function getLocalPendingRunId(conversationKey: string, messages: AiMessage[]) {
  return messages.find((message) => message.role === 'assistant' && message.run_id)?.run_id
    ?? conversationKey.replace(/^pending-conversation-/, '');
}

function hasRenderableMessageContent(message: AiMessage) {
  return Boolean(message.content?.trim()) || message.parts.some((part) => part.type !== 'text' || Boolean(part.text?.trim()));
}

function isActiveStreamProgressStatus(status: AiRunEvent['status']) {
  return status === 'pending' || status === 'running' || status === 'waiting';
}

function isUnfinishedConversationStatus(status: string | null | undefined) {
  return ['pending', 'running', 'waiting_approval', 'waiting_input'].includes((status ?? '').toLowerCase());
}

function isCompletedToolProgress(event: AiRunEvent) {
  return event.status === 'completed' && (event.type === 'tool' || event.type === 'script');
}

function shouldStopThinkingForPart(part: AiMessagePart) {
  if (part.type === 'draft' || part.type === 'approval_request') return true;
  if (part.type === 'human_input_request') return isPendingHumanInputPart(part);
  return part.type === 'run_activity' && part.activity ? isActiveStreamProgressStatus(part.activity.status) : false;
}

function shouldStartThinkingAfterPart(part: AiMessagePart) {
  return part.type === 'run_activity' && part.activity ? isCompletedToolProgress(part.activity) : false;
}

function isApprovalDecisionSettledPart(part: AiMessagePart, approvalId: string) {
  if (part.type === 'approval_request' && part.approval?.id === approvalId) {
    return part.approval.status !== 'pending';
  }
  if (part.type !== 'result_card' || part.card?.type !== 'operation_result') return false;
  const data = part.card.data;
  if (!data || typeof data !== 'object' || (!('approvalId' in data) && !('approval_id' in data))) return false;
  const record = data as { approvalId?: unknown; approval_id?: unknown };
  return String(record.approvalId ?? record.approval_id ?? '') === approvalId;
}

function collectSettledApprovalIds(messages: AiMessage[]) {
  const settledApprovalIds = new Set<string>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.approval?.id && part.approval.status !== 'pending') {
        settledApprovalIds.add(part.approval.id);
      }
      if (part.type === 'result_card' && part.card?.type === 'operation_result') {
        const data = part.card.data;
        const approvalId = data && typeof data === 'object' && ('approvalId' in data || 'approval_id' in data)
          ? String((data as { approvalId?: unknown; approval_id?: unknown }).approvalId
            ?? (data as { approval_id?: unknown }).approval_id
            ?? '')
          : '';
        if (approvalId) settledApprovalIds.add(approvalId);
      }
    }
  }
  return settledApprovalIds;
}

export function AiWorkspace({
  familyId = '',
  conversations,
  isLoading,
  currentUser = null,
  onBackHome,
  createFoodPlanItem,
  isCreatingFoodPlanItem = false,
  onNavigate,
}: AiWorkspaceProps) {
  const queryClient = useQueryClient();
  const [activeConversationKey, setActiveConversationKey] = useState<string | null>(conversations[0]?.id ?? null);
  const [isStartingNewConversation, setIsStartingNewConversation] = useState(false);
  const composerScopeKey = activeConversationKey ?? NEW_AI_CONVERSATION_SCOPE;
  const {
    draft,
    setDraft,
    selectScope: selectComposerScope,
    moveScope: moveComposerScope,
    clearScope: clearComposerScope,
  } = useAiConversationComposerState(composerScopeKey);
  const draftRef = useRef('');
  const submitAfterVoiceRecognitionRef = useRef(false);
  const [voiceInputStatusByComposer, setVoiceInputStatusByComposer] = useState<{
    desktop: 'idle' | 'recording' | 'recognizing';
    mobile: 'idle' | 'recording' | 'recognizing';
  }>({ desktop: 'idle', mobile: 'idle' });
  const voiceInputStatus = voiceInputStatusByComposer.desktop !== 'idle' ? voiceInputStatusByComposer.desktop : voiceInputStatusByComposer.mobile;
  const attachmentState = useAiAttachmentState(composerScopeKey);
  const moveAttachmentScope = attachmentState.moveScope;
  const clearAttachmentScope = attachmentState.clearScope;
  const [localMessagesByConversationKey, setLocalMessagesByConversationKey] = useState<Record<string, AiMessage[]>>({});
  const [timelineByConversationId, setTimelineByConversationId] = useState<Record<string, AiTimelineState>>({});
  const timelineByConversationRef = useRef<Record<string, AiTimelineState>>({});
  const replayingTimelineConversationRef = useRef<Set<string>>(new Set());
  const [runEventsById, setRunEventsById] = useState<Record<string, AiRunEvent[]>>({});
  const [recommendationPlanRequest, setRecommendationPlanRequest] = useState<AiRecommendationPlanRequest | null>(null);
  const [planFeedback, setPlanFeedback] = useState('');
  const [isQualityModalOpen, setIsQualityModalOpen] = useState(false);
  const [debugRunId, setDebugRunId] = useState<string | null>(null);
  const inventoryDraftAction = useAiInventoryDraftAction({
    setLocalMessages: (updater) => {
      setLocalMessagesByConversationKey((current) => {
        const key = activeConversationKey;
        if (!key) return current;
        const currentItems = current[key] ?? [];
        const nextItems = typeof updater === 'function' ? updater(currentItems) : updater;
        return { ...current, [key]: nextItems };
      });
    },
    setFeedback: setPlanFeedback,
  });
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(resolveInitialAiSidebarCollapsed);
  const toggleSidebar = (collapsed: boolean) => {
    setIsSidebarCollapsed(collapsed);
    storeAiSidebarCollapsedPreference(collapsed);
  };
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const desktopVoiceButtonRef = useRef<HTMLButtonElement>(null);
  const mobileVoiceButtonRef = useRef<HTMLButtonElement>(null);
  const activeConversationId = isPendingConversationKey(activeConversationKey) ? null : activeConversationKey;
  const activeLocalMessages = activeConversationKey ? localMessagesByConversationKey[activeConversationKey] ?? [] : [];
  const localPendingConversations = useMemo<AiConversation[]>(() => {
    return Object.entries(localMessagesByConversationKey)
      .filter(([key]) => isPendingConversationKey(key))
      .map(([key, messages]) => ({
        id: key,
        family_id: 'local',
        owner_user_id: currentUser?.id ?? 'local-user',
        owner_display_name: currentUser?.display_name ?? '我',
        visibility: 'private' as const,
        is_owner: true,
        mode: 'recommendation' as const,
        prompt: getConversationTitleFromMessages(messages),
        response: 'AI 正在回复',
        created_at: messages[0]?.created_at ?? new Date().toISOString(),
        created_by: currentUser?.id ?? null,
        context: {},
        title: getConversationTitleFromMessages(messages),
        summary: 'AI 正在回复',
        status: 'active',
        last_message_at: messages[messages.length - 1]?.created_at ?? messages[0]?.created_at ?? new Date().toISOString(),
        last_run_status: 'running',
      }));
  }, [currentUser?.display_name, currentUser?.id, localMessagesByConversationKey]);
  const historyConversations = useMemo(
    () => [...localPendingConversations, ...conversations],
    [conversations, localPendingConversations],
  );
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  useEffect(() => {
    selectComposerScope(composerScopeKey);
  }, [composerScopeKey, selectComposerScope]);
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 180)}px`;
    }
  }, [draft]);
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const form = e.currentTarget.form;
      if (form) {
        form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      }
    }
  };
  function mergeVoiceTranscript(current: string, text: string) {
    const transcript = text.trim();
    if (!transcript) return current;
    return current.trim() ? `${current.trimEnd()} ${transcript}` : transcript;
  }

  function handleMainVoiceTranscript(text: string, context?: { interaction: 'tap' | 'hold' }) {
    const nextDraft = mergeVoiceTranscript(draftRef.current, text);
    const shouldSubmit = context?.interaction === 'hold' || submitAfterVoiceRecognitionRef.current;
    submitAfterVoiceRecognitionRef.current = false;
    if (shouldSubmit) {
      void submitComposerMessage(nextDraft);
      return;
    }
    setDraft(nextDraft);
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  }
  const [streamProgressByRunId, setStreamProgressByRunId] = useState<Record<string, AiRunEvent[]>>({});
  const [cancellationTargetRunId, setCancellationTargetRunId] = useState<string | null>(null);
  const streamProgressRef = useRef<Record<string, AiRunEvent[]>>({});
  const streamMessageTargetRef = useRef<Record<string, string>>({});
  const streamConversationTargetRef = useRef<Record<string, string>>({});
  const requestedRunEventsRef = useRef<Set<string>>(new Set());
  const [activeStreamRunIdsByConversationKey, setActiveStreamRunIdsByConversationKey] = useState<Record<string, string>>({});
  const chatAbortByRunIdRef = useRef<Record<string, AbortController>>({});
  const clearingInaccessibleConversationRef = useRef<string | null>(null);
  const { thinkingRunIds, startThinking, stopThinking } = useAiThinkingState();
  const [deletingConversationId, setDeletingConversationId] = useState<string | null>(null);
  const [pendingDeleteConversation, setPendingDeleteConversation] = useState<AiConversation | null>(null);
  const [isMobileHistoryOpen, setIsMobileHistoryOpen] = useState(false);
  useEffect(() => {
    const serverConversationByRunId = new Map<string, AiConversation>();
    for (const conversation of conversations) {
      const activeRunId =
        isUnfinishedConversationStatus(conversation.last_run_status) && typeof conversation.context?.activeRunId === 'string'
          ? conversation.context.activeRunId
          : null;
      if (activeRunId) {
        serverConversationByRunId.set(activeRunId, conversation);
      }
    }
    if (serverConversationByRunId.size === 0) return;

    const migrations = Object.entries(localMessagesByConversationKey)
      .filter(([conversationKey]) => isPendingConversationKey(conversationKey))
      .map(([conversationKey, messages]) => {
        const runId = getLocalPendingRunId(conversationKey, messages);
        const conversation = serverConversationByRunId.get(runId);
        return conversation ? { pendingKey: conversationKey, conversationId: conversation.id, runId } : null;
      })
      .filter((item): item is { pendingKey: string; conversationId: string; runId: string } => Boolean(item));
    if (migrations.length === 0) return;

    setLocalMessagesByConversationKey((current) => {
      let changed = false;
      const next = { ...current };
      for (const migration of migrations) {
        const pendingItems = next[migration.pendingKey];
        if (!pendingItems) continue;
        const movedItems = pendingItems.map((item) => ({ ...item, conversation_id: migration.conversationId }));
        delete next[migration.pendingKey];
        next[migration.conversationId] = [
          ...(next[migration.conversationId] ?? []).filter(
            (item) => !movedItems.some((moved) =>
              item.id === moved.id
              || (moved.run_id && item.run_id === moved.run_id)
              || (moved.client_message_id && item.client_message_id === moved.client_message_id),
            ),
          ),
          ...movedItems,
        ];
        changed = true;
      }
      return changed ? next : current;
    });
    setActiveStreamRunIdsByConversationKey((current) => {
      let changed = false;
      const next = { ...current };
      for (const migration of migrations) {
        const runId = next[migration.pendingKey] ?? migration.runId;
        delete next[migration.pendingKey];
        next[migration.conversationId] = runId;
        streamConversationTargetRef.current = {
          ...streamConversationTargetRef.current,
          [migration.pendingKey]: migration.conversationId,
          [runId]: migration.conversationId,
        };
        changed = true;
      }
      return changed ? next : current;
    });
    setActiveConversationKey((current) => {
      const matched = migrations.find((migration) => migration.pendingKey === current);
      return matched ? matched.conversationId : current;
    });
    for (const migration of migrations) {
      moveComposerScope(migration.pendingKey, migration.conversationId);
      moveAttachmentScope(migration.pendingKey, migration.conversationId);
    }
  }, [conversations, localMessagesByConversationKey, moveAttachmentScope, moveComposerScope]);
  function clearInaccessibleConversation(conversationId: string) {
    if (clearingInaccessibleConversationRef.current === conversationId) return;
    clearingInaccessibleConversationRef.current = conversationId;
    const inaccessibleRunId = activeStreamRunIdsByConversationKey[conversationId];
    queryClient.removeQueries({ queryKey: queryKeys.aiMessages(conversationId) });
    queryClient.removeQueries({ queryKey: queryKeys.aiPendingApprovals(conversationId) });
    setLocalMessagesByConversationKey((current) => {
      const next = { ...current };
      delete next[conversationId];
      return next;
    });
    setTimelineByConversationId((current) => {
      if (!(conversationId in current)) return current;
      const next = { ...current };
      delete next[conversationId];
      delete timelineByConversationRef.current[conversationId];
      return next;
    });
    clearComposerScope(conversationId);
    clearAttachmentScope(conversationId);
    setActiveStreamRunIdsByConversationKey((current) => {
      const next = { ...current };
      delete next[conversationId];
      return next;
    });
    if (inaccessibleRunId) {
      stopThinking(inaccessibleRunId);
      setStreamProgressByRunId((current) => {
        const next = { ...current };
        delete next[inaccessibleRunId];
        return next;
      });
      setRunEventsById((current) => {
        const next = { ...current };
        delete next[inaccessibleRunId];
        return next;
      });
      delete streamMessageTargetRef.current[inaccessibleRunId];
      // Abort before delete so an in-flight approval/chat stream cannot settle
      // after access is revoked and rehydrate local messages via applyChatResponse.
      const controller = chatAbortByRunIdRef.current[inaccessibleRunId];
      if (controller) {
        abortAiStream(controller, { type: 'conversation_inaccessible', conversationId });
      }
      delete chatAbortByRunIdRef.current[inaccessibleRunId];
    }
    const fallbackConversation = conversations.find((item) => item.id !== conversationId) ?? null;
    setActiveConversationKey(fallbackConversation?.id ?? null);
    setIsStartingNewConversation(fallbackConversation === null);
    setPlanFeedback('该会话已取消公开');
    window.setTimeout(() => {
      if (clearingInaccessibleConversationRef.current === conversationId) {
        clearingInaccessibleConversationRef.current = null;
      }
    }, 0);
  }

  const {
    serverActiveRunId,
    isActiveConversationServerRunning,
    runningConversationKeys,
    waitingConversationKeys,
  } = useAiConversationLiveSync({
    activeConversationKey,
    activeConversationId,
    conversations,
    historyConversations,
    activeStreamRunIdsByConversationKey,
    setRunEventsById,
    isLoadingConversations: isLoading,
    onInaccessibleConversation: clearInaccessibleConversation,
  });
  const shouldRefreshActiveConversation = Boolean(
    isActiveConversationServerRunning
    || (activeConversationId && waitingConversationKeys.has(activeConversationId)),
  );
  useEffect(() => {
    if (!activeConversationKey && !isStartingNewConversation && conversations[0]) {
      setActiveConversationKey(conversations[0].id);
    }
  }, [activeConversationKey, conversations, isStartingNewConversation]);
  const messagesQuery = useQuery({
    queryKey: queryKeys.aiMessages(activeConversationId),
    queryFn: () => api.getAiMessages(activeConversationId as string),
    enabled: Boolean(activeConversationId),
    refetchInterval: shouldRefreshActiveConversation ? 1200 : false,
  });
  const remoteSnapshotMessages = useMemo<AiMessage[]>(() => {
    const data = messagesQuery.data;
    return Array.isArray(data) ? data : data?.messages ?? [];
  }, [messagesQuery.data]);
  const remoteSnapshotSequence = useMemo(() => {
    const data = messagesQuery.data;
    if (!data || Array.isArray(data)) {
      return Math.max(0, ...remoteSnapshotMessages.map((message) => Number(message.snapshot_sequence ?? 0)));
    }
    return Number(data.snapshot_sequence || 0);
  }, [messagesQuery.data, remoteSnapshotMessages]);
  useEffect(() => {
    if (!activeConversationId || messagesQuery.isError || !messagesQuery.data) return;
    const incoming = createAiTimelineState(
      Array.isArray(messagesQuery.data)
        ? messagesQuery.data
        : { ...messagesQuery.data, snapshot_sequence: remoteSnapshotSequence },
      activeConversationId,
    );
    const previous = timelineByConversationRef.current[activeConversationId];
    // A polling response can legitimately lag behind a live SSE event. Never
    // replace a newer canonical state with that stale snapshot.
    if (previous && incoming.lastSequence < previous.lastSequence) return;
    timelineByConversationRef.current = {
      ...timelineByConversationRef.current,
      [activeConversationId]: incoming,
    };
    setTimelineByConversationId((current) => ({ ...current, [activeConversationId]: incoming }));
  }, [activeConversationId, messagesQuery.data, messagesQuery.isError, remoteSnapshotSequence]);
  const aiStatusQuery = useQuery({
    queryKey: queryKeys.aiStatus(familyId),
    queryFn: api.getAiStatus,
  });
  const aiQualityMetricsQuery = useQuery({
    queryKey: queryKeys.aiQualityMetrics,
    queryFn: api.getAiQualityMetrics,
    enabled: isQualityModalOpen,
    staleTime: 60_000,
  });
  const pendingApprovalsQuery = useQuery({
    queryKey: queryKeys.aiPendingApprovals(activeConversationId),
    queryFn: () => api.getPendingAiApprovals(activeConversationId as string),
    enabled: Boolean(activeConversationId),
    refetchInterval: shouldRefreshActiveConversation ? 1800 : false,
  });
  useEffect(() => {
    if (!activeConversationId || !messagesQuery.isError) return;
    if (isApiError(messagesQuery.error) && messagesQuery.error.status === 404) {
      clearInaccessibleConversation(activeConversationId);
    }
  }, [activeConversationId, messagesQuery.error, messagesQuery.isError]);
  useEffect(() => {
    if (!activeConversationId || !pendingApprovalsQuery.isError) return;
    if (isApiError(pendingApprovalsQuery.error) && pendingApprovalsQuery.error.status === 404) {
      clearInaccessibleConversation(activeConversationId);
    }
  }, [activeConversationId, pendingApprovalsQuery.error, pendingApprovalsQuery.isError]);
  const messages = useMemo(() => {
    const canonical = activeConversationId
      ? timelineByConversationId[activeConversationId]
      : activeConversationKey
        ? timelineByConversationId[activeConversationKey]
        : undefined;
    const hasCanonicalTimeline = Boolean(
      canonical
      && (
        canonical.lastSequence > 0
        || selectAiTimelineMessages(canonical).some((message) => Number(message.timeline_position ?? 0) > 0)
      ),
    );
    const remote = hasCanonicalTimeline ? selectAiTimelineMessages(canonical as AiTimelineState) : remoteSnapshotMessages;
    if (activeLocalMessages.length === 0) return remote;
    const knownIds = new Set(remote.map((item) => item.id));
    const knownClientIds = new Set(remote.map((item) => item.client_message_id).filter(Boolean));
    const localById = new Map(activeLocalMessages.map((item) => [item.id, item]));
    const localByRunId = new Map(activeLocalMessages.filter((item) => item.run_id).map((item) => [item.run_id as string, item]));
    return [
      ...remote.map((item) => {
        if (hasCanonicalTimeline) return item;
        const local = localById.get(item.id) ?? (item.run_id ? localByRunId.get(item.run_id) : undefined);
        return local ? mergeRemoteAndLocalMessage(item, local, { preferLocalOrder: true }) : item;
      }),
      ...activeLocalMessages.filter((item) => {
        if (hasCanonicalTimeline && item.role !== 'user') return false;
        if (knownIds.has(item.id)) return false;
        if (item.run_id && remote.some((remoteItem) => remoteItem.run_id === item.run_id)) return false;
        if (item.client_message_id && knownClientIds.has(item.client_message_id)) return false;
        return true;
      }),
    ];
  }, [activeConversationId, activeConversationKey, activeLocalMessages, remoteSnapshotMessages, timelineByConversationId]);
  const settledApprovalIds = useMemo(() => collectSettledApprovalIds(messages), [messages]);
  const effectivePendingApprovals = useMemo(
    () => (pendingApprovalsQuery.data ?? []).filter((approval) => approval.status === 'pending' && !settledApprovalIds.has(approval.id)),
    [pendingApprovalsQuery.data, settledApprovalIds],
  );
  const displayedMessages = useMemo(() => {
    const canonicalState = activeConversationId
      ? timelineByConversationId[activeConversationId]
      : activeConversationKey
        ? timelineByConversationId[activeConversationKey]
        : undefined;
    const hasCanonicalTimeline = Boolean(
      canonicalState
      && (
        canonicalState.lastSequence > 0
        || selectAiTimelineMessages(canonicalState).some((message) => Number(message.timeline_position ?? 0) > 0)
      ),
    );
    const merged = hasCanonicalTimeline ? messages : mergePendingApprovalsIntoMessages(messages, effectivePendingApprovals);
    if (
      !hasCanonicalTimeline
      && activeConversationId
      && serverActiveRunId
      && isActiveConversationServerRunning
      && !merged.some((message) => message.role === 'assistant' && message.run_id === serverActiveRunId)
    ) {
      return [
        ...merged,
        {
          ...createLocalAssistantMessage(serverActiveRunId, activeConversationId),
          id: `remote-assistant-${serverActiveRunId}`,
        },
      ];
    }
    return merged;
  }, [activeConversationId, activeConversationKey, effectivePendingApprovals, isActiveConversationServerRunning, messages, serverActiveRunId, timelineByConversationId]);
  const hasPendingApproval = useMemo(() => {
    if (effectivePendingApprovals.length > 0) return true;
    return displayedMessages.some((message) => message.parts.some((part) => part.approval?.status === 'pending'));
  }, [displayedMessages, effectivePendingApprovals]);
  const hasPendingHumanInput = useMemo(
    () => displayedMessages.some((message) => message.parts.some(isPendingHumanInputPart)),
    [displayedMessages],
  );
  const activeApprovalRunId = useMemo(() => {
    const pendingApproval = effectivePendingApprovals.find((approval) => approval.run_id);
    if (pendingApproval?.run_id) return pendingApproval.run_id;
    for (const message of displayedMessages) {
      const approval = message.parts.find((part) => part.approval?.status === 'pending' && part.approval.run_id)?.approval;
      if (approval?.run_id) return approval.run_id;
    }
    return null;
  }, [displayedMessages, effectivePendingApprovals]);
  const activeHumanInputRunId = useMemo(() => {
    for (const message of displayedMessages) {
      if (message.run_id && message.parts.some(isPendingHumanInputPart)) return message.run_id;
    }
    return null;
  }, [displayedMessages]);
  const activeStreamRunId = activeConversationKey ? activeStreamRunIdsByConversationKey[activeConversationKey] ?? null : null;
  const activeVisibleRunId = activeStreamRunId ?? (isActiveConversationServerRunning ? serverActiveRunId : null);
  const streamProgress = activeStreamRunId
    ? streamProgressByRunId[activeStreamRunId] ?? []
    : activeVisibleRunId
      ? runEventsById[activeVisibleRunId] ?? []
      : [];
  const isAiUnavailable = aiStatusQuery.data?.enabled === false;
  const isAiStatusUnknown = aiStatusQuery.isError;
  const llmCapabilityState = aiStatusQuery.data?.capabilities.llm;
  const isComposerPaused = hasPendingApproval || hasPendingHumanInput || isAiUnavailable || isAiStatusUnknown;
  const composerPauseMessage = isAiStatusUnknown
    ? '暂时无法确认 AI 服务状态，请稍后重试'
    : isAiUnavailable
    ? aiStatusQuery.data?.configured === false
      ? '该功能还没有由家庭主理人配置'
      : llmCapabilityState === 'provisioning'
        ? '主对话模型正在准备中'
        : llmCapabilityState === 'budget_blocked'
          ? '主对话模型已达到用量限制'
          : llmCapabilityState === 'failed' || aiStatusQuery.data?.status === 'degraded'
            ? aiStatusQuery.data?.detail || '主对话模型暂时不可用'
            : '主对话模型未启用'
    : hasPendingApproval
      ? '请先确认上面的草稿，确认后可以继续对话。'
      : hasPendingHumanInput
        ? '请先回答上面的问题，AI 会接着处理当前任务。'
        : undefined;
  const aiStatusLabel = aiStatusQuery.isLoading
    ? 'AI 检查中'
    : isAiStatusUnknown
      ? '暂时无法确认 AI 状态'
    : !isAiUnavailable
      ? 'AI 已就绪'
      : aiStatusQuery.data?.configured === false
        ? 'AI 未配置'
        : llmCapabilityState === 'provisioning'
          ? 'AI 准备中'
          : llmCapabilityState === 'budget_blocked'
            ? 'AI 用量受限'
            : llmCapabilityState === 'failed' || aiStatusQuery.data?.status === 'degraded'
              ? 'AI 暂不可用'
              : 'AI 未启用';
  const loadResourceOptions = useCallback<AiResourceOptionLoader>(async (kind, params) => {
    if (kind === 'food') {
      const items = await api.getFoods({ q: params.query, limit: params.limit, offset: params.offset });
      return items.map((food) => ({
        id: food.id,
        label: food.name,
        description: [food.category, FOOD_TYPE_LABELS[food.type] ?? food.type].filter(Boolean).join(' · '),
        imageUrl: resolveMediaUrl(food.images?.[0], 'thumb') ?? '/assets/ai-food-ingredient-placeholder.png',
        unit: food.stock_unit,
        foodType: food.type,
        stockQuantity: food.stock_quantity,
      }));
    }
    const items = await api.getIngredients({ q: params.query, limit: params.limit, offset: params.offset });
    return items.map((ingredient) => ({
      id: ingredient.id,
      label: ingredient.name,
      description: [ingredient.category, ingredient.default_unit].filter(Boolean).join(' · '),
      imageUrl: resolveMediaUrl(ingredient.image, 'thumb') ?? '/assets/ai-food-ingredient-placeholder.png',
      unit: ingredient.default_unit,
    }));
  }, []);
  useEffect(() => {
    const remoteMessages = remoteSnapshotMessages;
    const missingRunIds = Array.from(
      new Set(
        remoteMessages
          .filter((message) => message.role === 'assistant' && message.run_id && message.run_id !== activeStreamRunId && (runEventsById[message.run_id]?.length ?? 0) === 0)
          .filter((message) => message.run_id && !requestedRunEventsRef.current.has(message.run_id))
          .map((message) => message.run_id as string),
      ),
    );
    if (missingRunIds.length === 0) return;
    for (const runId of missingRunIds) {
      requestedRunEventsRef.current.add(runId);
    }
    let isCancelled = false;
    void Promise.all(
      missingRunIds.map(async (runId) => {
        try {
          const events = await api.getAiRunEvents(runId);
          return [runId, events] as const;
        } catch {
          return [runId, [] as AiRunEvent[]] as const;
        }
      }),
    ).then((entries) => {
      if (isCancelled) return;
      setRunEventsById((current) => {
        const next = { ...current };
        for (const [runId, events] of entries) {
          next[runId] = events;
        }
        return next;
      });
    });
    return () => {
      isCancelled = true;
    };
  }, [activeStreamRunId, remoteSnapshotMessages, runEventsById]);
  function updateLocalMessages(conversationKey: string, updater: (items: AiMessage[]) => AiMessage[]) {
    setLocalMessagesByConversationKey((current) => ({
      ...current,
      [conversationKey]: updater(current[conversationKey] ?? []),
    }));
  }
  function updateStreamLocalMessages(
    conversationKey: string,
    runId: string,
    eventConversationId: string | undefined,
    updater: (items: AiMessage[], targetConversationKey: string) => AiMessage[],
  ) {
    setLocalMessagesByConversationKey((current) => {
      const mappedKey = streamConversationTargetRef.current[conversationKey] ?? streamConversationTargetRef.current[runId];
      const remoteKey = eventConversationId && !isPendingConversationKey(eventConversationId) ? eventConversationId : null;
      const targetConversationKey =
        mappedKey && current[mappedKey]
          ? mappedKey
          : remoteKey && !current[conversationKey]
            ? remoteKey
            : conversationKey;
      return {
        ...current,
        [targetConversationKey]: updater(current[targetConversationKey] ?? [], targetConversationKey),
      };
    });
  }
  function commitTimelineState(conversationId: string, state: AiTimelineState) {
    timelineByConversationRef.current = {
      ...timelineByConversationRef.current,
      [conversationId]: state,
    };
    setTimelineByConversationId((current) => ({ ...current, [conversationId]: state }));
  }
  function timelineSeedForConversation(conversationId: string): AiMessage[] {
    const cached = queryClient.getQueryData<AiConversationSnapshot | AiMessage[]>(queryKeys.aiMessages(conversationId));
    if (Array.isArray(cached)) return cached;
    if (cached && typeof cached === 'object' && Array.isArray(cached.messages)) return cached.messages;
    return localMessagesByConversationKey[conversationId] ?? [];
  }
  function applyTimelineEvent(nextEvent: AiTimelineEvent, sourceConversationKey?: string) {
    const conversationId = nextEvent.conversation_id;
    let state = timelineByConversationRef.current[conversationId];
    if (!state) {
      state = createAiTimelineState(timelineSeedForConversation(conversationId), conversationId);
      commitTimelineState(conversationId, state);
    }
    const result = applyAiTimelineEvent(state, nextEvent);
    if (!result.needsReplay) {
      commitTimelineState(conversationId, result.state);
      if (sourceConversationKey && sourceConversationKey !== conversationId && isPendingConversationKey(sourceConversationKey)) {
        commitTimelineState(sourceConversationKey, result.state);
      }
      return;
    }
    const gap = result.state.gap;
    if (!gap || replayingTimelineConversationRef.current.has(conversationId)) return;
    replayingTimelineConversationRef.current.add(conversationId);
    void api.getAiConversationEvents(conversationId, state.lastSequence).then((replay) => {
      const current = timelineByConversationRef.current[conversationId] ?? state;
      const replayed = mergeAiTimelineReplay(current, replay);
      const applied = applyAiTimelineEvent(replayed, nextEvent);
      commitTimelineState(conversationId, applied.state);
      if (sourceConversationKey && sourceConversationKey !== conversationId && isPendingConversationKey(sourceConversationKey)) {
        commitTimelineState(sourceConversationKey, applied.state);
      }
      if (applied.needsReplay) {
        void messagesQuery.refetch();
      }
    }).catch(() => {
      void messagesQuery.refetch();
    }).finally(() => {
      replayingTimelineConversationRef.current.delete(conversationId);
    });
  }

  // These adapters are intentionally limited to streams that explicitly emit
  // unsequenced message events (for example the ephemeral cooking assistant).
  // Persisted conversations render only the
  // canonical timeline state above.
  function ensureStreamingAssistantMessage(runId: string, conversationKey: string) {
    const canonicalState = timelineByConversationRef.current[conversationKey]
      ?? timelineByConversationRef.current[streamConversationTargetRef.current[runId] ?? ''];
    if (canonicalState && Object.values(canonicalState.messagesById).some(
      (message) => message.role === 'assistant' && message.run_id === runId,
    )) return;
    const messageId = `local-assistant-${runId}`;
    updateStreamLocalMessages(conversationKey, runId, undefined, (items, targetConversationKey) => {
      if (items.some((item) => item.id === messageId || item.run_id === runId)) return items;
      return [...items, createLocalAssistantMessage(runId, targetConversationKey)];
    });
  }

  function findLatestKnownMessage(messageId: string, conversationId?: string) {
    const cached = conversationId && !isPendingConversationKey(conversationId)
      ? queryClient.getQueryData<AiConversationSnapshot | AiMessage[]>(queryKeys.aiMessages(conversationId))
      : undefined;
    const cachedMessages = Array.isArray(cached) ? cached : cached?.messages ?? [];
    return cachedMessages.find((item) => item.id === messageId)
      ?? displayedMessages.find((item) => item.id === messageId)
      ?? messages.find((item) => item.id === messageId);
  }

  function applyStreamDelta(
    event: { message_id?: string; conversation_id?: string; run_id?: string; part_id?: string; delta: string },
    conversationKey: string,
  ) {
    if (!event.delta) return;
    const runId = event.run_id || activeStreamRunIdsByConversationKey[conversationKey] || 'pending';
    const activeRunId = activeStreamRunIdsByConversationKey[conversationKey];
    stopThinking(runId);
    if (activeRunId && activeRunId !== runId) stopThinking(activeRunId);
    const messageId = streamMessageTargetRef.current[runId] || event.message_id || `local-assistant-${runId}`;
    const partId = event.part_id || `local-part-${runId}`;
    const isApprovalContinuation = streamMessageTargetRef.current[runId] === messageId;
    updateStreamLocalMessages(conversationKey, runId, event.conversation_id, (items, targetConversationKey) => {
      const existingIndex = items.findIndex((item) => item.id === messageId || item.id === `local-assistant-${runId}` || item.run_id === runId);
      if (existingIndex < 0) {
        const sourceMessage = findLatestKnownMessage(messageId, event.conversation_id);
        const base = sourceMessage ?? {
          id: messageId,
          conversation_id: event.conversation_id || targetConversationKey,
          role: 'assistant' as const,
          content: '',
          content_type: 'parts' as const,
          parts: [],
          run_id: runId,
          status: 'running' as const,
          metadata: {},
          created_at: new Date().toISOString(),
        };
        const nextParts = appendDeltaToMessageParts(base.parts, event.delta, partId, false, isApprovalContinuation);
        return [...items, {
          ...base,
          id: messageId,
          conversation_id: event.conversation_id || base.conversation_id,
          content: messageTextFromParts(nextParts),
          content_type: 'parts',
          parts: nextParts,
          run_id: runId,
          status: 'running',
        }];
      }
      return items.map((item, index) => {
        if (index !== existingIndex) return item;
        const nextParts = appendDeltaToMessageParts(item.parts, event.delta, partId, false, isApprovalContinuation);
        return {
          ...item,
          id: messageId,
          conversation_id: event.conversation_id || item.conversation_id,
          content: messageTextFromParts(nextParts),
          content_type: 'parts' as const,
          parts: nextParts,
        };
      });
    });
  }

  function applyStreamPart(
    event: { message_id?: string; conversation_id?: string; run_id?: string; part: AiMessagePart },
    conversationKey: string,
  ) {
    if (!event.part?.id) return;
    const runId = event.run_id || activeStreamRunIdsByConversationKey[conversationKey] || 'pending';
    const activeRunId = activeStreamRunIdsByConversationKey[conversationKey];
    if (shouldStopThinkingForPart(event.part)) {
      stopThinking(runId);
      if (activeRunId && activeRunId !== runId) stopThinking(activeRunId);
    } else if (shouldStartThinkingAfterPart(event.part)) {
      startThinking(runId);
      if (activeRunId && activeRunId !== runId) startThinking(activeRunId);
    }
    const messageId = streamMessageTargetRef.current[runId] || event.message_id || `local-assistant-${runId}`;
    const mergePart = (parts: AiMessage['parts']) => {
      let resolvedParts = parts;
      if (event.part.type === 'result_card' && event.part.card?.type === 'operation_result') {
        const data = event.part.card.data;
        const approvalId = data && typeof data === 'object'
          ? String((data as { approvalId?: unknown; approval_id?: unknown }).approvalId ?? (data as { approval_id?: unknown }).approval_id ?? '')
          : '';
        if (approvalId) {
          resolvedParts = parts.map((part) => part.type === 'approval_request' && part.approval?.id === approvalId
            ? { ...part, approval: { ...part.approval, status: 'approved' as const, decision: 'approved' as const, submitted_values: part.approval.submitted_values ?? part.approval.initial_values } }
            : part);
        }
      }
      const index = resolvedParts.findIndex((part) => messagePartKey(part) === messagePartKey(event.part));
      if (index < 0) return [...resolvedParts, event.part];
      const merged = mergeMessagePart(resolvedParts[index], event.part);
      if (event.part.type === 'run_activity' && index < parts.length - 1) {
        return [...resolvedParts.filter((_, partIndex) => partIndex !== index), merged];
      }
      return resolvedParts.map((part, partIndex) => (partIndex === index ? merged : part));
    };
    updateStreamLocalMessages(conversationKey, runId, event.conversation_id, (items, targetConversationKey) => {
      const existingIndex = items.findIndex((item) => item.id === messageId || item.id === `local-assistant-${runId}` || item.run_id === runId);
      if (existingIndex < 0) {
        const sourceMessage = findLatestKnownMessage(messageId, event.conversation_id);
        const base = sourceMessage ?? {
          id: messageId,
          conversation_id: event.conversation_id || targetConversationKey,
          role: 'assistant' as const,
          content: '',
          content_type: 'parts' as const,
          parts: [],
          run_id: runId,
          status: 'running' as const,
          metadata: {},
          created_at: new Date().toISOString(),
        };
        const nextParts = mergePart(base.parts);
        return [...items, {
          ...base,
          id: messageId,
          conversation_id: event.conversation_id || base.conversation_id,
          content: messageTextFromParts(nextParts) || base.content,
          content_type: 'parts',
          parts: nextParts,
          run_id: runId,
          status: 'running',
        }];
      }
      return items.map((item, index) => {
        if (index !== existingIndex) return item;
        const nextParts = mergePart(item.parts);
        return {
          ...item,
          id: messageId,
          conversation_id: event.conversation_id || item.conversation_id,
          content: messageTextFromParts(nextParts),
          content_type: 'parts' as const,
          parts: nextParts,
        };
      });
    });
  }

  function applyChatResponse(response: AiChatResponse, conversationKey: string, runId: string) {
    stopThinking(runId);
    stopThinking(response.run.id);
    // The response carries the same canonical event log used by history and
    // replay. Apply it first so the final render cannot append the assistant
    // message after unrelated local items.
    if (response.timeline_events?.length) {
      [...response.timeline_events]
        .sort((a, b) => a.sequence - b.sequence)
        .forEach((event) => applyTimelineEvent(event));
    }
    const finalStreamEvents = (streamProgressRef.current[runId] ?? []).map((event) => normalizeStreamEventForFinalRun(event, response));
    const responseEventIds = new Set(response.events.map((event) => event.id));
    const mergedEvents = [...finalStreamEvents.filter((event) => !responseEventIds.has(event.id)), ...response.events];
    const targetMessageId = streamMessageTargetRef.current[response.run.id];
    const includedMessage = attachIncludedApprovalsToMessage(response.message, response.included.approvals);
    const messageWithIncludedApprovals = targetMessageId && targetMessageId !== includedMessage.id
      ? { ...includedMessage, id: targetMessageId, run_id: response.run.id }
      : includedMessage;
    const hasCanonicalEvents = Boolean(response.timeline_events?.length);
    setActiveConversationKey((current) => (current === conversationKey ? response.conversation_id : current));
    setIsStartingNewConversation(false);
    if (conversationKey !== response.conversation_id) {
      moveComposerScope(conversationKey, response.conversation_id);
      moveAttachmentScope(conversationKey, response.conversation_id);
    }
    setLocalMessagesByConversationKey((current) => {
      const currentItems = current[conversationKey] ?? [];
      const localStreamMessage = currentItems.find((item) => item.id === messageWithIncludedApprovals.id || item.id === response.message.id || item.run_id === response.run.id);
      const appendOnlyMessage = hasCanonicalEvents || !localStreamMessage?.parts.length
        ? messageWithIncludedApprovals
        : {
            ...mergeRemoteAndLocalMessage(messageWithIncludedApprovals, localStreamMessage, { preferLocalOrder: true }),
            metadata: { ...messageWithIncludedApprovals.metadata, ...localStreamMessage.metadata, streamOrderCanonical: true },
          };
      const movedItems = [
        ...currentItems
          .filter((item) => item.id !== appendOnlyMessage.id && item.id !== response.message.id && item.run_id !== response.run.id)
          .map((item) => ({ ...item, conversation_id: response.conversation_id })),
        appendOnlyMessage,
      ];
      const next = { ...current };
      delete next[conversationKey];
      next[response.conversation_id] = [
        ...(next[response.conversation_id] ?? []).filter(
          (item) => !movedItems.some((moved) =>
            moved.id === item.id
            || (moved.run_id && item.run_id === moved.run_id)
            || (moved.client_message_id && moved.client_message_id === item.client_message_id),
          ),
        ),
        ...movedItems,
      ];
      return next;
    });
    setRunEventsById((current) => ({ ...current, [response.run.id]: mergedEvents }));
    streamProgressRef.current = { ...streamProgressRef.current, [runId]: [] };
    delete streamMessageTargetRef.current[response.run.id];
    delete streamConversationTargetRef.current[conversationKey];
    delete streamConversationTargetRef.current[response.run.id];
    setActiveStreamRunIdsByConversationKey((current) => {
      const next = { ...current };
      let changed = false;
      for (const [conversationKey, activeRunId] of Object.entries(current)) {
        if (activeRunId === runId || activeRunId === response.run.id) {
          delete next[conversationKey];
          changed = true;
        }
      }
      return changed ? next : current;
    });
    setStreamProgressByRunId((current) => {
      const next = { ...current };
      delete next[runId];
      return next;
    });
    invalidateAfterAiMessageSent(queryClient, response.conversation_id);
  }
  function markStreamingAssistantStopped(runId: string | null, text = '已取消这次任务。') {
    if (!runId) return;
    stopThinking(runId);
    let marked = false;
    setLocalMessagesByConversationKey((current) => {
      const next = { ...current };
      for (const [key, items] of Object.entries(current)) {
        next[key] = items.map((item) => {
          if (item.run_id !== runId && item.id !== `local-assistant-${runId}`) return item;
          marked = true;
          if (hasSuccessfulOperationResult(item)) return { ...item, status: 'completed' as const };
          const existingText = item.parts.find((part) => part.type === 'text')?.text?.trim() || item.content;
          const nextText = text === '已取消这次任务。' ? existingText || text : text;
          const parts = item.parts.some((part) => part.type === 'text')
            ? item.parts.map((part) => part.type === 'text' ? { ...part, text: nextText } : part)
            : [...item.parts, { id: `local-failure-${runId}`, type: 'text' as const, text: nextText }];
          return { ...item, content: nextText, content_type: 'parts' as const, parts, status: 'failed' as const };
        });
      }
      return next;
    });
    if (!marked && activeConversationKey) {
      updateLocalMessages(activeConversationKey, (items) => [...items, {
        ...createLocalAssistantMessage(runId, activeConversationKey),
        content: text,
        parts: [{ id: `local-failure-${runId}`, type: 'text', text }],
        status: 'failed',
      }]);
    }
    void refreshAfterApprovalSettled();
  }
  function hasSuccessfulOperationResultForRun(runId: string | null | undefined) {
    if (!runId) return false;
    const cachedMessages = queryClient.getQueryCache()
      .findAll({ queryKey: ['ai-messages'] })
      .flatMap((query) => Array.isArray(query.state.data) ? query.state.data as AiMessage[] : []);
    const candidates = [
      ...displayedMessages,
      ...messages,
      ...Object.values(localMessagesByConversationKey).flat(),
      ...cachedMessages,
    ];
    const seen = new Set<string>();
    return candidates.some((message) => {
      if (message.run_id !== runId || seen.has(message.id)) return false;
      seen.add(message.id);
      return hasSuccessfulOperationResult(message);
    });
  }
  function streamFailureMessage(error: unknown) {
    return error instanceof Error && error.message.trim() ? error.message : 'AI 处理失败，请稍后重试。';
  }
  const runCancellation = useAiRunCancellation({
    onConfirmed: (runId, response) => {
      const normalizedEvents = response.events.map((event) => ({ ...event, run_id: runId }));
      setRunEventsById((current) => ({ ...current, [runId]: normalizedEvents }));
      normalizedEvents.forEach((event) => upsertStreamProgressEvent(event));
      setStreamProgressByRunId((current) => {
        const backendEventIds = new Set(normalizedEvents.map((event) => event.id));
        const nextEvents = [
          ...(current[runId] ?? []).filter((event) => !backendEventIds.has(event.id)),
          ...normalizedEvents,
        ];
        streamProgressRef.current = { ...streamProgressRef.current, [runId]: nextEvents };
        return { ...current, [runId]: nextEvents };
      });
      stopThinking(runId);
      delete streamMessageTargetRef.current[runId];
      delete chatAbortByRunIdRef.current[runId];
      void refreshAfterApprovalSettled();
    },
    onConflict: () => {
      void refreshAfterApprovalSettled();
    },
  });
  function upsertStreamProgressEvent(nextEvent: AiRunEvent) {
    const currentItems = streamProgressRef.current[nextEvent.run_id] ?? [];
    const nextEventKey = runActivityCollapseKey(nextEvent) || nextEvent.id;
    const nextItems = currentItems.some((item) => (runActivityCollapseKey(item) || item.id) === nextEventKey)
      ? currentItems.map((item) => ((runActivityCollapseKey(item) || item.id) === nextEventKey ? preferredRunActivityEvent(item, nextEvent) : item))
      : [...currentItems, nextEvent];
    streamProgressRef.current = { ...streamProgressRef.current, [nextEvent.run_id]: nextItems };
    setStreamProgressByRunId((current) => ({ ...current, [nextEvent.run_id]: nextItems }));
    // Explicitly materialize progress into the ephemeral local adapter. This
    // keeps non-canonical streams visible while persisted conversations still
    // render run_activity parts delivered by the timeline protocol.
    setLocalMessagesByConversationKey((current) => {
      let changed = false;
      const next = { ...current };
      for (const [conversationKey, items] of Object.entries(current)) {
        const canonical = timelineByConversationRef.current[conversationKey];
        if (canonical && Object.values(canonical.messagesById).some((message) => message.run_id === nextEvent.run_id)) continue;
        const index = items.findIndex((item) => item.role === 'assistant' && item.run_id === nextEvent.run_id);
        if (index < 0) continue;
        const message = items[index];
        const partId = `local-run-activity-${runActivityCollapseKey(nextEvent) || nextEvent.id}`;
        const part: AiMessagePart = { id: partId, type: 'run_activity', activity: nextEvent };
        const partIndex = message.parts.findIndex((item) => item.type === 'run_activity' && item.activity && runActivityCollapseKey(item.activity) === runActivityCollapseKey(nextEvent));
        const parts = partIndex < 0
          ? [...message.parts, part]
          : message.parts.map((item, itemIndex) => itemIndex === partIndex ? { ...item, activity: nextEvent } : item);
        next[conversationKey] = items.map((item, itemIndex) => itemIndex === index ? { ...message, parts, content_type: 'parts' as const } : item);
        changed = true;
      }
      return changed ? next : current;
    });
  }
  function updateThinkingForProgressEvent(nextEvent: AiRunEvent, fallbackRunId?: string | null) {
    const runIds = Array.from(new Set([nextEvent.run_id, fallbackRunId].filter((runId): runId is string => Boolean(runId))));
    if (isActiveStreamProgressStatus(nextEvent.status)) {
      runIds.forEach(stopThinking);
      return;
    }
    if (isCompletedToolProgress(nextEvent)) {
      runIds.forEach(startThinking);
    }
  }
  const {
    startChat,
    startApproval,
    startHumanInput,
    submittingApprovalIds,
    submittingHumanInputRequestIds,
    submittingHumanInputByRequestId,
  } = useAiConversationStreams({
    onTimelineEvent: applyTimelineEvent,
    activeStreamRunIdsByConversationKey,
    chatAbortByRunIdRef,
    streamMessageTargetRef,
    streamConversationTargetRef,
    setActiveStreamRunIdsByConversationKey,
    startThinking,
    stopThinking,
    ensureStreamingAssistantMessage,
    applyStreamPart,
    applyStreamDelta,
    updateThinkingForProgressEvent,
    upsertStreamProgressEvent,
    applyChatResponse,
    streamFailureMessage,
    markStreamingAssistantStopped,
    hasSuccessfulOperationResultForRun,
    clearInaccessibleConversation,
    refreshAfterApprovalSettled,
    isApprovalDecisionSettledPart,
  });
  const deleteConversationMutation = useMutation({
    mutationFn: api.deleteAiConversation,
    onSuccess: async (_, conversationId) => {
      const remainingConversations = conversations.filter((conversation) => conversation.id !== conversationId);
      if (conversationId === activeConversationId) {
        const nextConversation = remainingConversations[0] ?? null;
        setActiveConversationKey(nextConversation?.id ?? null);
        setIsStartingNewConversation(!nextConversation);
        setLocalMessagesByConversationKey((current) => {
          const next = { ...current };
          delete next[conversationId];
          return next;
        });
      }
      clearComposerScope(conversationId);
      clearAttachmentScope(conversationId);
      await queryClient.invalidateQueries({ queryKey: queryKeys.aiConversations });
      queryClient.removeQueries({ queryKey: queryKeys.aiMessages(conversationId) });
      queryClient.removeQueries({ queryKey: queryKeys.aiPendingApprovals(conversationId) });
      setPendingDeleteConversation(null);
    },
    onSettled: () => setDeletingConversationId(null),
  });
  const visibilityMutation = useMutation({
    mutationFn: ({ conversationId, visibility }: { conversationId: string; visibility: AiConversationVisibility }) =>
      api.updateAiConversationVisibility(conversationId, visibility),
    onSuccess: (updated) => {
      queryClient.setQueryData<AiConversation[]>(queryKeys.aiConversations, (items = []) =>
        items.map((item) => (item.id === updated.id ? updated : item)));
    },
    onError: (error) => {
      setPlanFeedback(isApiError(error) && error.status === 409
        ? '会话正在生成回复，请先等待完成或取消当前任务'
        : error instanceof Error ? error.message : '更新公开状态失败');
    },
  });
  const updatingConversationId = visibilityMutation.isPending
    ? visibilityMutation.variables?.conversationId ?? null
    : deletingConversationId;
  const isCurrentConversationBusy = Boolean(
    activeConversationKey
    && (
      activeStreamRunIdsByConversationKey[activeConversationKey]
      || isActiveConversationServerRunning
      || activeApprovalRunId
      || activeHumanInputRunId
    ),
  );
  const activeLocalBusyRunIds = new Set(
    [
      activeStreamRunId,
      isActiveConversationServerRunning ? serverActiveRunId : null,
      activeApprovalRunId,
      activeHumanInputRunId,
    ].filter((runId): runId is string => Boolean(runId)),
  );
  const activeSubmittingHumanInput = useMemo(() => {
    if (!activeConversationKey) return null;
    for (const [requestId, meta] of Object.entries(submittingHumanInputByRequestId)) {
      if (
        meta.conversationId === activeConversationKey
        || (meta.runId && activeLocalBusyRunIds.has(meta.runId))
      ) {
        return { requestId, ...meta };
      }
    }
    return null;
  }, [activeConversationKey, activeLocalBusyRunIds, submittingHumanInputByRequestId]);
  const isSubmittingActiveHumanInput = Boolean(activeSubmittingHumanInput);
  const humanInputMutationMessageId = activeSubmittingHumanInput?.messageId ?? null;
  const humanInputMutationRequestId = activeSubmittingHumanInput?.requestId ?? null;
  const submittingApprovalId = useMemo(() => {
    if (!activeConversationKey || submittingApprovalIds.size === 0) return null;
    for (const approvalId of submittingApprovalIds) {
      const approval = effectivePendingApprovals.find((item) => item.id === approvalId)
        ?? displayedMessages
          .flatMap((message) => message.parts)
          .map((part) => part.approval)
          .find((item) => item?.id === approvalId);
      // Only attribute approvals that belong to the active conversation's visible data.
      // Never fall back to "any sole submitting id" or "any id while a stream is active".
      if (!approval) continue;
      if (
        approval.conversation_id === activeConversationKey
        || (approval.run_id && (
          approval.run_id === activeStreamRunId
          || approval.run_id === activeApprovalRunId
          || activeLocalBusyRunIds.has(approval.run_id)
        ))
      ) {
        return approvalId;
      }
    }
    return null;
  }, [
    activeApprovalRunId,
    activeConversationKey,
    activeLocalBusyRunIds,
    activeStreamRunId,
    displayedMessages,
    effectivePendingApprovals,
    submittingApprovalIds,
  ]);
  const isSubmittingActiveApproval = Boolean(submittingApprovalId);
  const isLocalAssistantBusy = isCurrentConversationBusy;
  const effectiveWaitingConversationKeys = useMemo(() => {
    const keys = new Set(waitingConversationKeys);
    if (!activeConversationKey) return keys;
    if (isSubmittingActiveApproval || isSubmittingActiveHumanInput) {
      keys.delete(activeConversationKey);
      return keys;
    }
    if (hasPendingApproval || hasPendingHumanInput) {
      keys.add(activeConversationKey);
    }
    return keys;
  }, [
    activeConversationKey,
    hasPendingApproval,
    hasPendingHumanInput,
    isSubmittingActiveApproval,
    isSubmittingActiveHumanInput,
    waitingConversationKeys,
  ]);
  const effectiveComposerPaused = isComposerPaused;
  const activeCancellableRunId = activeStreamRunId ?? activeApprovalRunId ?? activeHumanInputRunId ?? (isActiveConversationServerRunning ? serverActiveRunId : null);
  const cancellationTargetState = cancellationTargetRunId
    ? runCancellation.getCancellationState(cancellationTargetRunId)
    : { phase: 'idle' as const, error: '' };
  const shouldRetainCancellationTarget = cancellationTargetState.phase === 'requesting' || cancellationTargetState.phase === 'cancelling';
  const cancellationRunId = activeCancellableRunId ?? (shouldRetainCancellationTarget ? cancellationTargetRunId : null);
  const cancellationState = cancellationRunId
    ? cancellationRunId === cancellationTargetRunId
      ? cancellationTargetState
      : runCancellation.getCancellationState(cancellationRunId)
    : { phase: 'idle' as const, error: '' };
  const isCancellationInFlight = cancellationState.phase === 'requesting' || cancellationState.phase === 'cancelling';
  const cancellationError = cancellationState.phase === 'failed' ? cancellationState.error : '';
  const isAssistantBusy = isCurrentConversationBusy || isCancellationInFlight;
  const thinkingMessageIds = useMemo(() => {
    if (!isSubmittingActiveHumanInput || !humanInputMutationMessageId || !humanInputMutationRequestId) {
      return new Set<string>();
    }
    const message = displayedMessages.find((item) => item.id === humanInputMutationMessageId);
    if (!message || hasOutputAfterHumanInputRequest(message, humanInputMutationRequestId)) {
      return new Set<string>();
    }
    return new Set([humanInputMutationMessageId]);
  }, [
    displayedMessages,
    humanInputMutationMessageId,
    humanInputMutationRequestId,
    isSubmittingActiveHumanInput,
  ]);
  const threadThinkingKeys = useMemo(
    () => new Set([...thinkingRunIds, ...thinkingMessageIds]),
    [thinkingMessageIds, thinkingRunIds],
  );
  const effectiveComposerPauseMessage = isSubmittingActiveHumanInput
    ? '正在提交你的回答，AI 会接着处理当前任务。'
    : isSubmittingActiveApproval
      ? '正在提交确认结果，AI 会接着处理当前任务。'
      : composerPauseMessage;
  const readyAttachments = attachmentState.readyAttachments;
  const hasReadyAttachments = readyAttachments.length > 0;
  const hasAnyAttachments = attachmentState.attachments.length > 0;
  const isVisionUnavailableForAttachments = hasAnyAttachments && aiStatusQuery.data?.enabled === true && aiStatusQuery.data.supports_vision === false;
  const isAttachmentSendBlocked = attachmentState.hasUploadingAttachment || attachmentState.hasFailedAttachment || isVisionUnavailableForAttachments;
  const canSubmitMessage = Boolean(draft.trim()) || hasReadyAttachments;

  function imageFilesFromList(files: FileList | File[]) {
    return Array.from(files).filter((file) => file.type.startsWith('image/'));
  }

  function addAttachmentFiles(files: File[]) {
    if (effectiveComposerPaused || isAssistantBusy || isLocalAssistantBusy) return;
    attachmentState.uploadFiles(imageFilesFromList(files));
  }

  const handleComposerPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = imageFilesFromList(event.clipboardData.files);
    if (files.length === 0) return;
    event.preventDefault();
    addAttachmentFiles(files);
  };

  const handleComposerDrop = (event: DragEvent<HTMLFormElement>) => {
    const files = imageFilesFromList(event.dataTransfer.files);
    if (files.length === 0) return;
    event.preventDefault();
    addAttachmentFiles(files);
  };

  function deleteConversation(conversation: AiConversation) {
    if (deleteConversationMutation.isPending) return;
    setPendingDeleteConversation(conversation);
  }
  function changeConversationVisibility(conversation: AiConversation, visibility: AiConversationVisibility) {
    if (visibilityMutation.isPending) return;
    visibilityMutation.mutate({ conversationId: conversation.id, visibility });
  }
  function confirmDeleteConversation() {
    if (!pendingDeleteConversation || deleteConversationMutation.isPending) return;
    const conversation = pendingDeleteConversation;
    setDeletingConversationId(conversation.id);
    deleteConversationMutation.mutate(conversation.id);
  }
  function startNewConversation() {
    setActiveConversationKey(null);
    setIsStartingNewConversation(true);
    setIsMobileHistoryOpen(false);
  }
  function selectConversation(conversationKey: string) {
    setActiveConversationKey(conversationKey);
    setIsStartingNewConversation(false);
    setIsMobileHistoryOpen(false);
  }
  async function submitComposerMessage(
    textOverride?: string,
    options?: {
      includeAttachments?: boolean;
      preserveDraft?: boolean;
      quick_task?: AiProductLoopPrompt['quick_task'];
      subject?: Record<string, unknown>;
    },
  ) {
    if (effectiveComposerPaused || isAssistantBusy || isLocalAssistantBusy) return;
    const text = (textOverride ?? draft).trim();
    const includeAttachments = options?.includeAttachments !== false;
    const sendableAttachments = includeAttachments ? readyAttachments.filter((item) => item.asset) : [];
    if ((!text && sendableAttachments.length === 0) || (includeAttachments && isAttachmentSendBlocked)) return;
    const clientMessageId = `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const clientRunId = `agent_run-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const conversationKey = activeConversationId ?? createPendingConversationKey(clientRunId);
    const sourceComposerScope = activeConversationId ?? NEW_AI_CONVERSATION_SCOPE;
    const messageSummary = text || `上传了 ${sendableAttachments.length} 张图片`;
    const localParts: AiMessagePart[] = [];
    if (text) {
      localParts.push({ id: `local-part-${clientMessageId}`, type: 'text', text });
    }
    for (const attachment of sendableAttachments) {
      if (!attachment.asset) continue;
      localParts.push({
        id: `local-part-${attachment.clientAttachmentId}`,
        type: 'image',
        image: {
          media_id: attachment.asset.id,
          asset: attachment.asset,
          alt: attachment.asset.alt || attachment.fileName,
        },
      });
    }
    const requestAttachments: AiChatAttachment[] = sendableAttachments
      .filter((attachment) => attachment.asset)
      .map((attachment) => ({
        type: 'image',
        media_id: attachment.asset?.id ?? '',
        client_attachment_id: attachment.clientAttachmentId,
      }));
    const tempMessage: AiMessage = {
      id: `local-${clientMessageId}`,
      conversation_id: activeConversationId ?? conversationKey,
      role: 'user',
      content: messageSummary,
      content_type: requestAttachments.length > 0 ? 'parts' : 'text',
      parts: localParts,
      status: 'completed',
      metadata: {},
      client_message_id: clientMessageId,
      created_at: new Date().toISOString(),
    };
    // Only the user input is optimistic. The assistant row is allocated by
    // the server before streaming and arrives through the canonical timeline.
    updateLocalMessages(conversationKey, (items) => [...items, tempMessage]);
    streamProgressRef.current = { ...streamProgressRef.current, [clientRunId]: [] };
    setStreamProgressByRunId((current) => ({ ...current, [clientRunId]: [] }));
    setActiveStreamRunIdsByConversationKey((current) => ({ ...current, [conversationKey]: clientRunId }));
    // Keep the local stream responsive until the server's message.created
    // anchor arrives; canonical timeline state supersedes this row immediately.
    ensureStreamingAssistantMessage(clientRunId, conversationKey);
    attachmentState.hideAttachments(sendableAttachments.map((attachment) => attachment.clientAttachmentId));
    if (sourceComposerScope !== conversationKey) {
      moveComposerScope(sourceComposerScope, conversationKey);
      moveAttachmentScope(sourceComposerScope, conversationKey);
    }
    setActiveConversationKey(conversationKey);
    setIsStartingNewConversation(false);
    if (!options?.preserveDraft) setDraft('');
    const sendAttachmentScope = conversationKey;
    try {
      await startChat({
        message: text,
        conversationKey,
        conversation_id: activeConversationId ?? undefined,
        client_message_id: clientMessageId,
        client_run_id: clientRunId,
        quick_task: options?.quick_task,
        subject: options?.subject,
        attachments: requestAttachments,
      });
      attachmentState.discardHiddenAttachments(sendableAttachments, sendAttachmentScope);
    } catch {
      attachmentState.restoreHiddenAttachments(sendableAttachments, sendAttachmentScope);
      // Keep request failures out of the form event promise; message-level state already carries visible run feedback.
    }
  }
  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (voiceInputStatus === 'recording') {
      submitAfterVoiceRecognitionRef.current = true;
      if (voiceInputStatusByComposer.desktop === 'recording') {
        desktopVoiceButtonRef.current?.click();
      } else {
        mobileVoiceButtonRef.current?.click();
      }
      return;
    }
    if (voiceInputStatus === 'recognizing') {
      submitAfterVoiceRecognitionRef.current = true;
      return;
    }
    await submitComposerMessage();
  }
  const submitApprovalDecision: AiApprovalDecisionSubmit = async (approval, decision, values, comment) => {
    if (submittingApprovalIds.has(approval.id)) return;
    if (approval.run_id) {
      streamProgressRef.current = { ...streamProgressRef.current, [approval.run_id]: [] };
      setStreamProgressByRunId((current) => ({ ...current, [approval.run_id as string]: [] }));
    }
    await startApproval({ approval, decision, values, comment });
  };
  const submitHumanInputResponse: AiHumanInputResponseSubmit = async (message, request, response) => {
    if (submittingHumanInputRequestIds.has(request.id)) return;
    if (message.run_id) {
      streamProgressRef.current = { ...streamProgressRef.current, [message.run_id]: [] };
      setStreamProgressByRunId((current) => ({ ...current, [message.run_id as string]: [] }));
    }
    await startHumanInput({ message, request, response });
  };
  function openRecommendationPlan(item: AiTodayRecommendationItem, card: AiResultCard, messageId: string, partId: string) {
    if (!item.foodId || !createFoodPlanItem) return;
    setPlanFeedback('');
    setRecommendationPlanRequest({
      recommendation: item,
      messageId,
      partId,
      cardId: card.id,
      targetDate: card.data.targetDate,
      mealType: card.data.mealType,
    });
  }
  function createInventoryOperationDraft(
    item: AiInventoryResultItem,
    action: AiInventoryCardAction,
    card: AiResultCard,
    messageId: string,
    partId: string,
  ) {
    inventoryDraftAction.createDraft({ item, action, card, messageId, partId });
  }
  async function submitRecommendationPlan(payload: CreateFoodPlanItemPayload) {
    if (!createFoodPlanItem || !recommendationPlanRequest) {
      throw new Error('餐食计划功能暂不可用。');
    }
    const name = recommendationPlanRequest.recommendation.name;
    const planItem = await createFoodPlanItem(payload);
    const updatedMessage = await api.recordAiRecommendationSelection(recommendationPlanRequest.messageId, {
      part_id: recommendationPlanRequest.partId,
      card_id: recommendationPlanRequest.cardId,
      entity_id: recommendationPlanRequest.recommendation.entityId,
      food_plan_item_id: planItem.id,
    });
    queryClient.setQueryData<AiConversationSnapshot>(
      queryKeys.aiMessages(updatedMessage.conversation_id),
      (snapshot) => updateAiConversationSnapshot(snapshot, (items) =>
        items.map((item) => (item.id === updatedMessage.id ? updatedMessage : item))),
    );
    setLocalMessagesByConversationKey((current) => {
      const next = { ...current };
      for (const [conversationKey, items] of Object.entries(current)) {
        next[conversationKey] = items.map((item) => (item.id === updatedMessage.id ? updatedMessage : item));
      }
      return next;
    });
    await queryClient.invalidateQueries({ queryKey: queryKeys.aiConversations });
    setRecommendationPlanRequest(null);
    setPlanFeedback(`${name} 已加入餐食计划`);
  }
  function replaceOperationResultCard(
    card: AiResultCard,
    messageId: string,
  ) {
    const replaceInMessages = (items: AiMessage[]) => items.map((message) => {
      if (message.id !== messageId && !message.parts.some((part) => part.card?.id === card.id)) return message;
      let changed = false;
      const parts = message.parts.map((part) => {
        if (part.type !== 'result_card' || part.card?.id !== card.id) return part;
        changed = true;
        return { ...part, card };
      });
      return changed ? { ...message, parts } : message;
    });
    const conversationId = activeConversationId;
    if (conversationId) {
      queryClient.setQueryData<AiConversationSnapshot>(
        queryKeys.aiMessages(conversationId),
        (snapshot) => updateAiConversationSnapshot(snapshot, replaceInMessages),
      );
    }
    setLocalMessagesByConversationKey((current) => Object.fromEntries(
      Object.entries(current).map(([conversationKey, items]) => [conversationKey, replaceInMessages(items)]),
    ));
  }
  async function cancelStreamingChat() {
    const runId = activeCancellableRunId;
    if (!runId) return;
    setCancellationTargetRunId(runId);
    const controller = chatAbortByRunIdRef.current[runId] ?? new AbortController();
    chatAbortByRunIdRef.current[runId] = controller;
    try {
      await runCancellation.cancelRun(runId, controller);
    } catch {
      // The shared cancellation controller keeps the stream alive and exposes
      // the backend error through cancellationState.
    }
  }
  async function refreshAfterApprovalSettled() {
    if (activeConversationId) {
      invalidateAfterAiApprovalSettled(queryClient, activeConversationId);
    }
    await Promise.all([
      messagesQuery.refetch(),
      pendingApprovalsQuery.refetch(),
      queryClient.invalidateQueries({ queryKey: queryKeys.aiConversations }),
    ]);
  }
  const latestAssistantMessageId = [...displayedMessages].reverse().find((message) => message.role === 'assistant')?.id ?? null;
  const isMessageHistoryLoading = messagesQuery.isLoading && Boolean(activeConversationId) && displayedMessages.length === 0;
  const activeThreadOutputKey =
    activeStreamRunId
    ?? (isActiveConversationServerRunning ? serverActiveRunId : null)
    ?? (isSubmittingActiveApproval ? activeApprovalRunId : null)
    ?? (isSubmittingActiveHumanInput ? activeSubmittingHumanInput?.runId ?? null : null);
  const threadAutoScroll = useAiThreadAutoScroll({
    contentKey: aiThreadAutoScrollKey(displayedMessages, streamProgress, threadThinkingKeys),
    resetKey: activeConversationKey,
    activeOutputKey: activeThreadOutputKey,
    forceScrollKey: latestUserMessageScrollKey(displayedMessages),
  });
  return (
    <AiWorkspaceRoute>
    <AiResultCardReplacementProvider onResultCard={replaceOperationResultCard}>
    <AiOperationRevertProvider>
    <main className={`ai-workspace-shell ${isSidebarCollapsed ? 'is-collapsed' : ''}`}>
      {planFeedback && (
        <div className="ai-plan-feedback" role="status">
          {planFeedback}
          <button type="button" aria-label="关闭提示" onClick={() => setPlanFeedback('')}>×</button>
        </div>
      )}
      <AiRecommendationPlanDialog
        request={recommendationPlanRequest}
        isSubmitting={isCreatingFoodPlanItem}
        onClose={() => {
          if (!isCreatingFoodPlanItem) setRecommendationPlanRequest(null);
        }}
        onSubmit={submitRecommendationPlan}
      />
      {pendingDeleteConversation && (
        <AiDeleteConversationDialog
          conversation={pendingDeleteConversation}
          isDeleting={deleteConversationMutation.isPending}
          onCancel={() => setPendingDeleteConversation(null)}
          onConfirm={confirmDeleteConversation}
        />
      )}
      <AiMobilePage
        conversations={historyConversations}
        isLoading={isLoading}
        activeConversationKey={activeConversationKey}
        runningConversationKeys={runningConversationKeys}
        waitingConversationKeys={effectiveWaitingConversationKeys}
        updatingConversationId={updatingConversationId}
        isMobileHistoryOpen={isMobileHistoryOpen}
        currentUser={currentUser}
        resourceOptionLoader={loadResourceOptions}
        messages={displayedMessages}
        runEventsById={runEventsById}
        streamProgress={streamProgress}
        thinkingRunIds={thinkingRunIds}
        thinkingMessageIds={thinkingMessageIds}
        activeAssistantRunId={activeVisibleRunId}
        activeStreamRunId={activeStreamRunId}
        submittingApprovalId={submittingApprovalId}
        draft={draft}
        attachments={attachmentState.attachments}
        canAddAttachment={attachmentState.canAddMore && !isVisionUnavailableForAttachments}
        hasUploadingAttachment={attachmentState.hasUploadingAttachment}
        hasFailedAttachment={attachmentState.hasFailedAttachment || isVisionUnavailableForAttachments}
        isSending={isAssistantBusy}
        isCancellationInFlight={isCancellationInFlight}
        cancellationError={cancellationError}
        voiceInputStatus={voiceInputStatus}
        isComposerPaused={effectiveComposerPaused}
        composerPauseMessage={effectiveComposerPauseMessage}
        messagesLoading={isMessageHistoryLoading}
        messagesError={
          messagesQuery.isError
            ? messagesQuery.error instanceof Error
              ? messagesQuery.error.message
              : '请稍后重试。'
            : undefined
        }
        onRetryMessages={() => void messagesQuery.refetch()}
        onBackHome={onBackHome}
        onOpenMobileHistory={() => setIsMobileHistoryOpen(true)}
        onCloseMobileHistory={() => setIsMobileHistoryOpen(false)}
        onStartNewConversation={startNewConversation}
        onSelectConversation={selectConversation}
        onChangeVisibility={changeConversationVisibility}
        onDeleteConversation={deleteConversation}
        onDraftChange={setDraft}
        onAttachmentFiles={addAttachmentFiles}
        onRemoveAttachment={attachmentState.removeAttachment}
        voiceButtonRef={mobileVoiceButtonRef}
        onVoiceTranscript={handleMainVoiceTranscript}
        onVoiceStateChange={(state) => setVoiceInputStatusByComposer((current) => (
          current.mobile === state.status ? current : { ...current, mobile: state.status }
        ))}
        onPasteFiles={handleComposerPaste}
        onDropFiles={handleComposerDrop}
        onPickSuggestion={setDraft}
        onSubmit={sendMessage}
        onApprovalDecision={submitApprovalDecision}
        onHumanInputResponse={submitHumanInputResponse}
        onAddRecommendationToPlan={openRecommendationPlan}
        onInventoryAction={createInventoryOperationDraft}
        isInventoryActionPending={inventoryDraftAction.isPending}
        onPromptAction={(prompt) => void submitComposerMessage(prompt, { includeAttachments: false, preserveDraft: true })}
        onProductLoopPrompt={(prompt) => void submitComposerMessage(prompt.message, {
          includeAttachments: false,
          preserveDraft: true,
          quick_task: prompt.quick_task,
          subject: prompt.subject,
        })}
        onCancelSending={cancelStreamingChat}
        onOpenRunDebug={setDebugRunId}
        onNavigate={onNavigate}
      />
      <div className="ai-desktop-view">
        <AiDesktopConversationHistory
          conversations={historyConversations}
          isLoading={isLoading}
          activeConversationKey={activeConversationKey}
          runningConversationKeys={runningConversationKeys}
          waitingConversationKeys={effectiveWaitingConversationKeys}
          updatingConversationId={updatingConversationId}
          onToggleSidebar={toggleSidebar}
          onStartNewConversation={startNewConversation}
          onSelectConversation={selectConversation}
          onChangeVisibility={changeConversationVisibility}
          onDeleteConversation={deleteConversation}
        />
        <section className="ai-main-panel">
          <div className="ai-main-head">
            <div className="ai-hero-bar">
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                {isSidebarCollapsed && (
                  <button
                    className="ai-sidebar-trigger-btn"
                    type="button"
                    title="展开侧边栏"
                    onClick={() => toggleSidebar(false)}
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="9" y1="3" x2="9" y2="21"></line></svg>
                  </button>
                )}
                <span>AI 厨房助手</span>
              </div>
              <div className="ai-workspace-header-actions"><button className={`ai-ready-pill ai-quality-trigger ${isAiUnavailable ? 'is-disabled' : ''}`} type="button" onClick={() => setIsQualityModalOpen(true)} aria-label="查看 AI 使用情况" title="查看 AI 使用情况">
                <span />{aiStatusLabel}
              </button></div>
            </div>
          </div>
          <div className="ai-thread-scroll" ref={threadAutoScroll.threadScrollRef}>
            {isMessageHistoryLoading ? (
              <p className="subtle">正在加载消息…</p>
            ) : messagesQuery.isError && activeConversationId ? (
              <div className="ai-query-empty ai-message-load-error">
                <strong>历史消息加载失败</strong>
                <span>{messagesQuery.error instanceof Error ? messagesQuery.error.message : '请稍后重试。'}</span>
                <button className="ghost-button" type="button" onClick={() => void messagesQuery.refetch()}>
                  重新加载
                </button>
              </div>
            ) : displayedMessages.length > 0 ? (
              <>
                {displayedMessages.map((message) => (
                  <MessageBubble
                    key={message.id}
                    message={message}
                    user={currentUser}
                    resourceOptionLoader={loadResourceOptions}
                    runEvents={
                      message.run_id && message.run_id === activeStreamRunId
                        ? streamProgress
                        : message.run_id
                          ? runEventsById[message.run_id] ?? (message.id.startsWith('local-') ? streamProgress : [])
                          : message.id.startsWith('local-')
                            ? streamProgress
                            : []
                    }
                    isThinking={Boolean(
                      (message.run_id && thinkingRunIds.has(message.run_id))
                      || thinkingMessageIds.has(message.id)
                      || (
                        message.role === 'assistant'
                        && message.run_id === activeVisibleRunId
                        && message.status === 'running'
                        && message.parts[message.parts.length - 1]?.type === 'result_card'
                      ),
                    )}
                    isLatestAssistant={message.id === latestAssistantMessageId}
                    activeStreamRunId={activeStreamRunId}
                    submittingApprovalId={submittingApprovalId}
                    isAssistantResponseActive={
                      message.role === 'assistant'
                      && Boolean(
                        (message.run_id && message.run_id === activeVisibleRunId)
                        || (message.id.startsWith('local-') && activeVisibleRunId),
                      )
                    }
                    onApprovalDecision={submitApprovalDecision}
                    onHumanInputResponse={submitHumanInputResponse}
                    onAddRecommendationToPlan={openRecommendationPlan}
                    onInventoryAction={createInventoryOperationDraft}
                    isInventoryActionPending={inventoryDraftAction.isPending}
                    onPromptAction={(prompt) => void submitComposerMessage(prompt, { includeAttachments: false, preserveDraft: true })}
                    onProductLoopPrompt={(prompt) => void submitComposerMessage(prompt.message, {
                      includeAttachments: false,
                      preserveDraft: true,
                      quick_task: prompt.quick_task,
                      subject: prompt.subject,
                    })}
                    isPromptActionPending={isAssistantBusy || isLocalAssistantBusy}
                    onOpenRunDebug={setDebugRunId}
                    onNavigate={onNavigate}
                    onResultCard={replaceOperationResultCard}
                  />
                ))}
              </>
            ) : (
              <AiWelcomePrompt onPickSuggestion={setDraft} />
            )}
          </div>
          {threadAutoScroll.isAutoScrollPaused ? (
            <button className="ai-thread-follow-button" type="button" onClick={threadAutoScroll.resumeAutoScroll}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 5v14" />
                <path d="m6 13 6 6 6-6" />
              </svg>
              <span>最新回复</span>
            </button>
          ) : null}
          <div className="ai-composer-dock">
            {cancellationError ? (
              <p className="ai-composer-pause-note" role="alert" aria-live="assertive">{cancellationError}</p>
            ) : null}
            {isVisionUnavailableForAttachments && <p className="ai-composer-pause-note">当前 AI 模型暂不支持图片识别，请移除图片或切换支持视觉输入的模型。</p>}
            <AiComposerAttachments
              attachments={attachmentState.attachments}
              disabled={effectiveComposerPaused || isAssistantBusy}
              onRemove={attachmentState.removeAttachment}
            />
            <form className="ai-composer" onSubmit={sendMessage} onDrop={handleComposerDrop} onDragOver={(event) => event.preventDefault()}>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/bmp"
                multiple
                hidden
                onChange={(event) => {
                  addAttachmentFiles(Array.from(event.target.files ?? []));
                  event.currentTarget.value = '';
                }}
              />
              <button
                type="button"
                className="ai-attachment-button"
                title="添加图片"
                aria-label="添加图片"
                disabled={effectiveComposerPaused || isAssistantBusy || !attachmentState.canAddMore || isVisionUnavailableForAttachments}
                onClick={() => fileInputRef.current?.click()}
              >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
              </button>
              <textarea
                ref={textareaRef}
                className="text-input"
                rows={1}
                value={draft}
                placeholder={effectiveComposerPaused ? effectiveComposerPauseMessage ?? '等待你确认草稿…' : '输入你的问题，或让 AI 帮你安排一餐…'}
                disabled={effectiveComposerPaused}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={handleComposerPaste}
              />
              <div className="ai-composer-actions">
                <AiVoiceInputButton
                  surface="main_ai"
                  className="ai-composer-voice-button"
                  disabled={effectiveComposerPaused || isAssistantBusy || isLocalAssistantBusy}
                  buttonRef={desktopVoiceButtonRef}
                  enableHoldToSend
                  onStateChange={(state) => setVoiceInputStatusByComposer((current) => (
                    current.desktop === state.status ? current : { ...current, desktop: state.status }
                  ))}
                  onTranscript={handleMainVoiceTranscript}
                />
                <button
                  className={`ai-send-button ${isAssistantBusy ? 'is-sending' : ''}`}
                  type={isAssistantBusy ? 'button' : 'submit'}
                  disabled={isCancellationInFlight || (!isAssistantBusy && (isAiUnavailable || (voiceInputStatus !== 'recording' && voiceInputStatus !== 'recognizing' && !canSubmitMessage) || isAttachmentSendBlocked || effectiveComposerPaused || isLocalAssistantBusy))}
                  aria-label={isCancellationInFlight ? '正在停止生成' : isAssistantBusy ? '中止生成' : '发送消息'}
                  aria-busy={isCancellationInFlight}
                  onClick={isAssistantBusy ? cancelStreamingChat : undefined}
                >
                  {isAssistantBusy ? (
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"></rect></svg>
                  ) : (
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg>
                  )}
                </button>
              </div>
            </form>
          </div>
        </section>
        {isQualityModalOpen && (
          <AiQualityDiagnosticsModal
            metrics={aiQualityMetricsQuery.data}
            isLoading={aiQualityMetricsQuery.isLoading || aiQualityMetricsQuery.isFetching} isError={aiQualityMetricsQuery.isError}
            onRetry={() => void aiQualityMetricsQuery.refetch()} onClose={() => setIsQualityModalOpen(false)}
          />
        )}
      </div>
      <AiDebugHost open={Boolean(debugRunId)}>
        <LazyAiDebugEntry
          runId={debugRunId}
          open={Boolean(debugRunId)}
          onClose={() => setDebugRunId(null)}
        />
      </AiDebugHost>
    </main>
    </AiOperationRevertProvider>
    </AiResultCardReplacementProvider>
    </AiWorkspaceRoute>
  );
}
