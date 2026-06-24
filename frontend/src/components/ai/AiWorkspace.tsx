import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { invalidateAfterAiApprovalSettled, invalidateAfterAiMessageSent } from '../../api/cacheInvalidation';
import { api } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type {
  AiApprovalRequest,
  AiApprovalDecisionResponse,
  AiChatAttachment,
  AiChatResponse,
  AiConversation,
  AiHumanInputRequest,
  AiInventoryOperationAction,
  AiInventoryResultItem,
  AiMessage,
  AiMessagePart,
  AiResultCard,
  AiRunEvent,
  AiTodayRecommendationItem,
  CreateFoodPlanItemPayload,
  FoodPlanItem,
  UserSummary,
} from '../../api/types';
import { resolveAssetUrl } from '../../lib/assets';
import { FOOD_TYPE_LABELS } from '../../lib/ui';
import {
  AiDesktopConversationHistory,
  createPendingConversationKey,
  getConversationTitleFromMessages,
  isPendingConversationKey,
} from './AiConversationHistory';
import { AiDeleteConversationDialog } from './AiDeleteConversationDialog';
import { AiMobilePage } from './AiMobilePage';
import { MessageBubble, type AiApprovalDecisionSubmit, type AiHumanInputResponseSubmit, type AiResourceOptionLoader } from './AiConversationThread';
import { AiComposerAttachments } from './AiComposerAttachments';
import { AiQualityDiagnosticsModal } from './AiQualityDiagnosticsModal';
import { AiRecommendationPlanDialog, type AiRecommendationPlanRequest } from './AiRecommendationPlanDialog';
import { AiWelcomePrompt } from './AiWelcomePrompt';
import {
  mergePendingApprovalsIntoMessages,
  normalizeStreamEventForFinalRun,
  attachIncludedApprovalsToMessage,
  createLocalAssistantMessage,
  appendDeltaToMessageParts,
  messageTextFromParts,
  isPendingHumanInputPart,
} from './aiWorkspaceHelpers';
import { useAiConversationLiveSync } from './useAiConversationLiveSync';
import { useAiAttachmentState } from './useAiAttachmentState';
import { useAiInventoryDraftAction } from './useAiInventoryDraftAction';
import { useAiThinkingState } from './useAiThinkingState';
type AiWorkspaceProps = {
  conversations: AiConversation[];
  isLoading: boolean;
  currentUser?: UserSummary | null;
  onBackHome?: () => void;
  createFoodPlanItem?: (payload: CreateFoodPlanItemPayload) => Promise<FoodPlanItem>;
  isCreatingFoodPlanItem?: boolean;
};
export { ApprovalPanel } from './AiConversationThread';
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

function shouldStopThinkingForPart(part: AiMessagePart) {
  if (part.type === 'draft' || part.type === 'approval_request' || part.type === 'human_input_request') {
    return true;
  }
  return part.type === 'run_activity' && part.activity ? isActiveStreamProgressStatus(part.activity.status) : false;
}

export function AiWorkspace({
  conversations,
  isLoading,
  currentUser = null,
  onBackHome,
  createFoodPlanItem,
  isCreatingFoodPlanItem = false,
}: AiWorkspaceProps) {
  const queryClient = useQueryClient();
  const [activeConversationKey, setActiveConversationKey] = useState<string | null>(conversations[0]?.id ?? null);
  const [isStartingNewConversation, setIsStartingNewConversation] = useState(false);
  const [draft, setDraft] = useState('');
  const attachmentState = useAiAttachmentState();
  const [localMessagesByConversationKey, setLocalMessagesByConversationKey] = useState<Record<string, AiMessage[]>>({});
  const [runEventsById, setRunEventsById] = useState<Record<string, AiRunEvent[]>>({});
  const [recommendationPlanRequest, setRecommendationPlanRequest] = useState<AiRecommendationPlanRequest | null>(null);
  const [planFeedback, setPlanFeedback] = useState('');
  const [streamError, setStreamError] = useState('');
  const [isQualityModalOpen, setIsQualityModalOpen] = useState(false);
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
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => {
    try {
      const stored = localStorage.getItem('ai_sidebar_collapsed');
      if (stored !== null) {
        return stored === 'true';
      }
      return typeof window !== 'undefined' ? window.innerWidth <= 1280 : false;
    } catch {
      return typeof window !== 'undefined' ? window.innerWidth <= 1280 : false;
    }
  });
  const toggleSidebar = (collapsed: boolean) => {
    setIsSidebarCollapsed(collapsed);
    try {
      localStorage.setItem('ai_sidebar_collapsed', String(collapsed));
    } catch (e) {
      console.warn(e);
    }
  };
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const activeConversationId = isPendingConversationKey(activeConversationKey) ? null : activeConversationKey;
  const activeLocalMessages = activeConversationKey ? localMessagesByConversationKey[activeConversationKey] ?? [] : [];
  const localPendingConversations = useMemo<AiConversation[]>(() => {
    return Object.entries(localMessagesByConversationKey)
      .filter(([key]) => isPendingConversationKey(key))
      .map(([key, messages]) => ({
        id: key,
        family_id: 'local',
        mode: 'recommendation' as const,
        prompt: getConversationTitleFromMessages(messages),
        response: 'AI 正在后台回复',
        created_at: messages[0]?.created_at ?? new Date().toISOString(),
        created_by: currentUser?.id ?? null,
        context: {},
        title: getConversationTitleFromMessages(messages),
        summary: 'AI 正在后台回复',
        status: 'active',
        last_message_at: messages[messages.length - 1]?.created_at ?? messages[0]?.created_at ?? new Date().toISOString(),
        last_run_status: 'running',
      }));
  }, [currentUser?.id, localMessagesByConversationKey]);
  const historyConversations = useMemo(
    () => [...localPendingConversations, ...conversations],
    [conversations, localPendingConversations],
  );
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
  const [streamProgressByRunId, setStreamProgressByRunId] = useState<Record<string, AiRunEvent[]>>({});
  const streamProgressRef = useRef<Record<string, AiRunEvent[]>>({});
  const streamMessageTargetRef = useRef<Record<string, string>>({});
  const streamConversationTargetRef = useRef<Record<string, string>>({});
  const requestedRunEventsRef = useRef<Set<string>>(new Set());
  const [activeStreamRunIdsByConversationKey, setActiveStreamRunIdsByConversationKey] = useState<Record<string, string>>({});
  const chatAbortByRunIdRef = useRef<Record<string, AbortController>>({});
  const { thinkingRunIds, startThinking, stopThinking } = useAiThinkingState();
  const [deletingConversationId, setDeletingConversationId] = useState<string | null>(null);
  const [pendingDeleteConversation, setPendingDeleteConversation] = useState<AiConversation | null>(null);
  const [isMobileHistoryOpen, setIsMobileHistoryOpen] = useState(false);
  useEffect(() => {
    const serverConversationByRunId = new Map<string, AiConversation>();
    for (const conversation of conversations) {
      const activeRunId = typeof conversation.context?.activeRunId === 'string' ? conversation.context.activeRunId : null;
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
  }, [conversations, localMessagesByConversationKey]);
  const {
    serverActiveRunId,
    isActiveConversationServerRunning,
    runningConversationKeys,
  } = useAiConversationLiveSync({
    activeConversationKey,
    activeConversationId,
    conversations,
    historyConversations,
    activeStreamRunIdsByConversationKey,
    setRunEventsById,
  });
  useEffect(() => {
    if (!activeConversationKey && !isStartingNewConversation && conversations[0]) {
      setActiveConversationKey(conversations[0].id);
    }
  }, [activeConversationKey, conversations, isStartingNewConversation]);
  const messagesQuery = useQuery({
    queryKey: queryKeys.aiMessages(activeConversationId),
    queryFn: () => api.getAiMessages(activeConversationId as string),
    enabled: Boolean(activeConversationId),
    refetchInterval: isActiveConversationServerRunning ? 1200 : false,
  });
  const aiStatusQuery = useQuery({
    queryKey: queryKeys.aiStatus,
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
    refetchInterval: isActiveConversationServerRunning ? 1800 : false,
  });
  const messages = useMemo(() => {
    const remote = messagesQuery.data ?? [];
    if (activeLocalMessages.length === 0) return remote;
    const localById = new Map(activeLocalMessages.map((item) => [item.id, item]));
    const localAssistantByRunId = new Map(
      activeLocalMessages
        .filter((item) => item.role === 'assistant' && item.run_id)
        .map((item) => [item.run_id as string, item]),
    );
    const knownIds = new Set(remote.map((item) => item.id));
    const knownClientIds = new Set(remote.map((item) => item.client_message_id).filter(Boolean));
    const remoteAssistantRunIds = new Set(
      remote
        .filter((item) => item.role === 'assistant' && item.run_id)
        .map((item) => item.run_id as string),
    );
    return [
      ...remote.map((item) => {
        const localByRunId = item.role === 'assistant' && item.run_id ? localAssistantByRunId.get(item.run_id) : undefined;
        const matchingLocal = localById.get(item.id) ?? localByRunId;
        if (!matchingLocal) return item;
        if (item.role === 'assistant' && item.run_id && hasRenderableMessageContent(item) && !hasRenderableMessageContent(matchingLocal)) {
          return item;
        }
        return matchingLocal;
      }),
      ...activeLocalMessages.filter((item) => {
        if (knownIds.has(item.id)) return false;
        if (item.client_message_id && knownClientIds.has(item.client_message_id)) return false;
        if (item.role === 'assistant' && item.run_id && remoteAssistantRunIds.has(item.run_id)) return false;
        return true;
      }),
    ];
  }, [activeLocalMessages, messagesQuery.data]);
  const displayedMessages = useMemo(() => {
    const merged = mergePendingApprovalsIntoMessages(messages, pendingApprovalsQuery.data ?? []);
    if (
      activeConversationId &&
      serverActiveRunId &&
      isActiveConversationServerRunning &&
      !merged.some((message) => message.role === 'assistant' && message.run_id === serverActiveRunId)
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
  }, [activeConversationId, isActiveConversationServerRunning, messages, pendingApprovalsQuery.data, serverActiveRunId]);
  const hasPendingApproval = useMemo(() => {
    if ((pendingApprovalsQuery.data ?? []).some((approval) => approval.status === 'pending')) return true;
    return displayedMessages.some((message) => message.parts.some((part) => part.approval?.status === 'pending'));
  }, [displayedMessages, pendingApprovalsQuery.data]);
  const hasPendingHumanInput = useMemo(
    () => displayedMessages.some((message) => message.parts.some(isPendingHumanInputPart)),
    [displayedMessages],
  );
  const activeApprovalRunId = useMemo(() => {
    const pendingApproval = (pendingApprovalsQuery.data ?? []).find((approval) => approval.status === 'pending' && approval.run_id);
    if (pendingApproval?.run_id) return pendingApproval.run_id;
    for (const message of displayedMessages) {
      const approval = message.parts.find((part) => part.approval?.status === 'pending' && part.approval.run_id)?.approval;
      if (approval?.run_id) return approval.run_id;
    }
    return null;
  }, [displayedMessages, pendingApprovalsQuery.data]);
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
  const isComposerPaused = hasPendingApproval || hasPendingHumanInput || isAiUnavailable;
  const composerPauseMessage = isAiUnavailable
    ? aiStatusQuery.data?.detail || 'AI 模型未配置，暂时不能发送消息。'
    : hasPendingApproval
      ? '请先确认上面的草稿，确认后可以继续对话。'
      : hasPendingHumanInput
        ? '请先回答上面的问题，AI 会接着处理当前任务。'
      : undefined;
  const aiStatusLabel = isAiUnavailable ? 'AI 未配置' : aiStatusQuery.isLoading ? 'AI 检查中' : 'AI 已就绪';
  const loadResourceOptions = useCallback<AiResourceOptionLoader>(async (kind, params) => {
    if (kind === 'food') {
      const items = await api.getFoods({ q: params.query, limit: params.limit, offset: params.offset });
      return items.map((food) => ({
        id: food.id,
        label: food.name,
        description: [food.category, FOOD_TYPE_LABELS[food.type] ?? food.type].filter(Boolean).join(' · '),
        imageUrl: resolveAssetUrl(food.images?.[0]?.url) ?? '/assets/ai-food-ingredient-placeholder.png',
      }));
    }
    const items = await api.getIngredients({ q: params.query, limit: params.limit, offset: params.offset });
    return items.map((ingredient) => ({
      id: ingredient.id,
      label: ingredient.name,
      description: [ingredient.category, ingredient.default_unit].filter(Boolean).join(' · '),
      imageUrl: resolveAssetUrl(ingredient.image?.url) ?? '/assets/ai-food-ingredient-placeholder.png',
      unit: ingredient.default_unit,
    }));
  }, []);
  useEffect(() => {
    const remoteMessages = messagesQuery.data ?? [];
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
  }, [activeStreamRunId, messagesQuery.data, runEventsById]);
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
  function ensureStreamingAssistantMessage(runId: string, conversationKey: string) {
    const messageId = `local-assistant-${runId}`;
    updateStreamLocalMessages(conversationKey, runId, undefined, (items, targetConversationKey) => {
      if (items.some((item) => item.id === messageId || item.run_id === runId)) return items;
      return [...items, createLocalAssistantMessage(runId, targetConversationKey)];
    });
  }
  function applyChatResponse(response: AiChatResponse, conversationKey: string, runId: string) {
    stopThinking(runId);
    stopThinking(response.run.id);
    const finalStreamEvents = (streamProgressRef.current[runId] ?? []).map((event) => normalizeStreamEventForFinalRun(event, response));
    const responseEventIds = new Set(response.events.map((event) => event.id));
    const mergedEvents = [...finalStreamEvents.filter((event) => !responseEventIds.has(event.id)), ...response.events];
    const targetMessageId = streamMessageTargetRef.current[response.run.id];
    const includedMessage = attachIncludedApprovalsToMessage(response.message, response.included.approvals);
    const messageWithIncludedApprovals = targetMessageId && targetMessageId !== includedMessage.id
      ? { ...includedMessage, id: targetMessageId, run_id: response.run.id }
      : includedMessage;
    const mergeWithLocalStreamParts = (localMessage: AiMessage | undefined): AiMessage => {
      if (!localMessage?.parts.length) return messageWithIncludedApprovals;
      const finalPartsById = new Map(messageWithIncludedApprovals.parts.map((part) => [part.id, part]));
      const localPartIds = new Set(localMessage.parts.map((part) => part.id));
      const parts = [
        ...localMessage.parts.map((localPart) => {
          const finalPart = finalPartsById.get(localPart.id);
          if (!finalPart) return localPart;
          if (
            finalPart.type === 'text'
            && localPart.type === 'text'
            && (localPart.text?.length ?? 0) > (finalPart.text?.length ?? 0)
          ) {
            return { ...finalPart, text: localPart.text };
          }
          return finalPart;
        }),
        ...messageWithIncludedApprovals.parts.filter((part) => !localPartIds.has(part.id)),
      ];
      return {
        ...messageWithIncludedApprovals,
        parts,
        content_type: 'parts',
        content: messageTextFromParts(parts) || messageWithIncludedApprovals.content,
      };
    };
    setActiveConversationKey((current) => (current === conversationKey ? response.conversation_id : current));
    setIsStartingNewConversation(false);
    setLocalMessagesByConversationKey((current) => {
      const currentItems = current[conversationKey] ?? [];
      const localStreamMessage = currentItems.find((item) => item.id === messageWithIncludedApprovals.id || item.id === response.message.id || item.run_id === response.run.id);
      const appendOnlyMessage = mergeWithLocalStreamParts(localStreamMessage);
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
    queryClient.setQueryData<AiMessage[]>(queryKeys.aiMessages(response.conversation_id), (items = []) => [
      ...items.filter((item) => item.id !== messageWithIncludedApprovals.id && item.id !== response.message.id && item.run_id !== response.run.id),
      messageWithIncludedApprovals,
    ]);
    setRunEventsById((current) => ({ ...current, [response.run.id]: mergedEvents }));
    streamProgressRef.current = { ...streamProgressRef.current, [runId]: [] };
    delete streamMessageTargetRef.current[response.run.id];
    delete streamConversationTargetRef.current[conversationKey];
    delete streamConversationTargetRef.current[response.run.id];
    setStreamProgressByRunId((current) => {
      const next = { ...current };
      delete next[runId];
      return next;
    });
    invalidateAfterAiMessageSent(queryClient, response.conversation_id);
  }
  function applyApprovalDecisionResponse(response: AiApprovalDecisionResponse, conversationKey: string) {
    const nextApproval = response.approval;
    const replaceApproval = (message: AiMessage): AiMessage => {
      let changed = false;
      const parts = message.parts.map((part) => {
        if (part.type !== 'approval_request' || part.approval?.id !== nextApproval.id) return part;
        changed = true;
        return { ...part, approval: nextApproval };
      });
      if (!changed) return message;
      const hasPendingApproval = parts.some((part) => part.approval?.status === 'pending');
      return {
        ...message,
        content_type: 'parts',
        parts,
        status: hasPendingApproval ? 'waiting_approval' : message.status === 'waiting_approval' ? 'completed' : message.status,
      };
    };
    setLocalMessagesByConversationKey((current) => {
      const next = { ...current };
      for (const [key, items] of Object.entries(current)) {
        if (key !== conversationKey && key !== nextApproval.conversation_id) continue;
        next[key] = items.map(replaceApproval);
      }
      return next;
    });
    queryClient.setQueryData<AiMessage[]>(queryKeys.aiMessages(nextApproval.conversation_id), (items = []) => items.map(replaceApproval));
    queryClient.setQueryData<AiApprovalRequest[]>(queryKeys.aiPendingApprovals(nextApproval.conversation_id), (items = []) =>
      items
        .map((item) => (item.id === nextApproval.id ? nextApproval : item))
        .filter((item) => item.status === 'pending'),
    );
  }
  function applyStreamDelta(event: { message_id?: string; conversation_id?: string; run_id?: string; part_id?: string; delta: string }, conversationKey: string) {
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
      if (existingIndex === -1) {
        const sourceMessage =
          conversationKey === activeConversationKey
            ? displayedMessages.find((item) => item.id === messageId) ?? messages.find((item) => item.id === messageId)
            : undefined;
        if (sourceMessage) {
          const nextParts = appendDeltaToMessageParts(sourceMessage.parts, event.delta, partId, false, isApprovalContinuation);
          return [
            ...items,
            {
              ...sourceMessage,
              content: messageTextFromParts(nextParts),
              content_type: 'parts',
              parts: nextParts,
              run_id: runId,
              status: 'running',
            },
          ];
        }
        return [
          ...items,
          {
            id: messageId,
            conversation_id: event.conversation_id || targetConversationKey,
            role: 'assistant',
            content: event.delta,
            content_type: 'parts',
            parts: [{ id: partId, type: 'text', text: event.delta }],
            run_id: runId,
            status: 'running',
            metadata: {},
            created_at: new Date().toISOString(),
          },
        ];
      }
      return items.map((item, index) => {
        if (index !== existingIndex) return item;
        const nextParts = appendDeltaToMessageParts(item.parts, event.delta, partId, false, isApprovalContinuation);
        return {
          ...item,
          id: messageId,
          conversation_id: event.conversation_id || item.conversation_id,
          content: messageTextFromParts(nextParts),
          parts: nextParts,
        };
      });
    });
    if (event.conversation_id && !isPendingConversationKey(event.conversation_id)) {
      queryClient.setQueryData<AiMessage[]>(queryKeys.aiMessages(event.conversation_id), (items = []) => items);
    }
  }
  function applyStreamPart(event: { message_id?: string; conversation_id?: string; run_id?: string; part: AiMessagePart }, conversationKey: string) {
    if (!event.part?.id) return;
    const runId = event.run_id || activeStreamRunIdsByConversationKey[conversationKey] || 'pending';
    const activeRunId = activeStreamRunIdsByConversationKey[conversationKey];
    if (shouldStopThinkingForPart(event.part)) {
      stopThinking(runId);
      if (activeRunId && activeRunId !== runId) stopThinking(activeRunId);
    }
    const messageId = streamMessageTargetRef.current[runId] || event.message_id || `local-assistant-${runId}`;
    updateStreamLocalMessages(conversationKey, runId, event.conversation_id, (items, targetConversationKey) => {
      const existingIndex = items.findIndex((item) => item.id === messageId || item.id === `local-assistant-${runId}` || item.run_id === runId);
      if (existingIndex === -1) {
        return [
          ...items,
          {
            id: messageId,
            conversation_id: event.conversation_id || targetConversationKey,
            role: 'assistant',
            content: '',
            content_type: 'parts',
            parts: [event.part],
            run_id: runId,
            status: 'running',
            metadata: {},
            created_at: new Date().toISOString(),
          },
        ];
      }
      return items.map((item, index) => {
        if (index !== existingIndex) return item;
        const existingPartIndex = item.parts.findIndex((part) => part.id === event.part.id);
        const nextParts = existingPartIndex >= 0
          ? item.parts.map((part, partIndex) => (partIndex === existingPartIndex ? event.part : part))
          : [...item.parts, event.part];
        return {
          ...item,
          id: messageId,
          conversation_id: event.conversation_id || item.conversation_id,
          content: messageTextFromParts(nextParts),
          content_type: 'parts',
          parts: nextParts,
        };
      });
    });
    if (event.conversation_id && !isPendingConversationKey(event.conversation_id)) {
      queryClient.setQueryData<AiMessage[]>(queryKeys.aiMessages(event.conversation_id), (items = []) => items);
    }
  }
  function markStreamingAssistantStopped(runId: string | null, text = '已取消这次任务。') {
    if (!runId) return;
    stopThinking(runId);
    const markItems = (items: AiMessage[]) =>
      items.map((item) => {
        if (item.run_id !== runId && item.id !== `local-assistant-${runId}`) return item;
        const textPart = item.parts.find((part) => part.type === 'text');
        const nextText = text === '已取消这次任务。' ? textPart?.text?.trim() || item.content || text : text;
        return {
          ...item,
          content: nextText,
          status: 'failed' as const,
          parts: item.parts.some((part) => part.type === 'text')
            ? item.parts.map((part) => (part.type === 'text' ? { ...part, text: nextText } : part))
            : [{ id: `local-cancel-part-${runId}`, type: 'text' as const, text: nextText }, ...item.parts],
        };
      });
    setLocalMessagesByConversationKey((current) => Object.fromEntries(Object.entries(current).map(([key, items]) => [key, markItems(items)])));
    const conversationIds = new Set([activeConversationId, ...conversations.map((conversation) => conversation.id), ...Object.keys(localMessagesByConversationKey).filter((key) => !isPendingConversationKey(key))].filter((id): id is string => Boolean(id)));
    for (const conversationId of conversationIds) {
      queryClient.setQueryData<AiMessage[]>(queryKeys.aiMessages(conversationId), (items = []) => markItems(items));
    }
  }
  function streamFailureMessage(error: unknown) {
    return error instanceof Error && error.message.trim() ? error.message : 'AI 后续处理失败，请稍后重试。';
  }
  function upsertStreamProgressEvent(nextEvent: AiRunEvent) {
    if (isActiveStreamProgressStatus(nextEvent.status)) {
      stopThinking(nextEvent.run_id);
    }
    const currentItems = streamProgressRef.current[nextEvent.run_id] ?? [];
    const nextItems = currentItems.some((item) => item.id === nextEvent.id)
      ? currentItems.map((item) => (item.id === nextEvent.id ? nextEvent : item))
      : [...currentItems, nextEvent];
    streamProgressRef.current = { ...streamProgressRef.current, [nextEvent.run_id]: nextItems };
    setStreamProgressByRunId((current) => ({ ...current, [nextEvent.run_id]: nextItems }));
  }
  const chatMutation = useMutation({
    mutationFn: (payload: { message: string; conversationKey: string; conversation_id?: string; client_message_id?: string; client_run_id: string; quick_task?: string; subject?: Record<string, unknown>; attachments?: AiChatAttachment[] }) => {
      setStreamError('');
      const controller = new AbortController();
      chatAbortByRunIdRef.current = { ...chatAbortByRunIdRef.current, [payload.client_run_id]: controller };
      startThinking(payload.client_run_id);
      const { conversationKey, ...requestPayload } = payload;
      return api.streamChatAi(requestPayload, {
        signal: controller.signal,
        onProgress: (event) => {
          const eventRunId = 'run_id' in event && typeof event.run_id === 'string' && event.run_id !== 'pending' ? event.run_id : payload.client_run_id ?? 'pending';
          const nextEvent: AiRunEvent = {
            id: 'id' in event && typeof event.id === 'string' ? event.id : `stream-${event.internal_code}-${Date.now()}`,
            run_id: eventRunId,
            type: event.type,
            internal_code: event.internal_code,
            user_message: event.user_message,
            status: event.status,
            created_at: 'created_at' in event && typeof event.created_at === 'string' ? event.created_at : new Date().toISOString(),
          };
          if (isActiveStreamProgressStatus(nextEvent.status)) {
            stopThinking(payload.client_run_id);
          }
          ensureStreamingAssistantMessage(eventRunId, conversationKey);
          upsertStreamProgressEvent(nextEvent);
        },
        onMessagePart: (event) => applyStreamPart(event, conversationKey),
        onMessageDelta: (event) => applyStreamDelta(event, conversationKey),
      }).then((response) => {
        applyChatResponse(response, conversationKey, payload.client_run_id);
        return response;
      });
    },
    onSettled: (_data, _error, variables) => {
      if (!variables) return;
      stopThinking(variables.client_run_id);
      const { [variables.client_run_id]: _removed, ...remainingControllers } = chatAbortByRunIdRef.current;
      chatAbortByRunIdRef.current = remainingControllers;
      setActiveStreamRunIdsByConversationKey((current) => {
        const next = { ...current };
        let changed = false;
        for (const [conversationKey, runId] of Object.entries(current)) {
          if (conversationKey === variables.conversationKey || runId === variables.client_run_id) {
            delete next[conversationKey];
            changed = true;
          }
        }
        return changed ? next : current;
      });
      delete streamConversationTargetRef.current[variables.conversationKey];
      delete streamConversationTargetRef.current[variables.client_run_id];
    },
  });
  const approvalStreamMutation = useMutation({
    mutationFn: async (payload: { approval: Parameters<AiApprovalDecisionSubmit>[0]; decision: 'approved' | 'rejected'; values: Record<string, unknown>; comment?: string }) => {
      setStreamError('');
      const controller = new AbortController();
      const conversationKey = payload.approval.conversation_id;
      const runId = payload.approval.run_id;
      const isRunAlreadyStreaming = Boolean(runId && activeStreamRunIdsByConversationKey[conversationKey] === runId);
      const decisionPayload = {
        decision: payload.decision,
        draft_version: payload.approval.draft_version,
        values: payload.values,
        comment: payload.comment,
      };
      const decisionResponse = await api.decideAiApproval(payload.approval.conversation_id, payload.approval.id, decisionPayload);
      applyApprovalDecisionResponse(decisionResponse, conversationKey);
      void refreshAfterApprovalSettled();
      if (!runId || isRunAlreadyStreaming) {
        return decisionResponse;
      }
      if (payload.approval.run_id) {
        chatAbortByRunIdRef.current = { ...chatAbortByRunIdRef.current, [payload.approval.run_id]: controller };
        setActiveStreamRunIdsByConversationKey((current) => ({ ...current, [conversationKey]: payload.approval.run_id as string }));
        startThinking(payload.approval.run_id);
        if (payload.approval.message_id) {
          streamMessageTargetRef.current = { ...streamMessageTargetRef.current, [payload.approval.run_id]: payload.approval.message_id };
        } else {
          ensureStreamingAssistantMessage(payload.approval.run_id, conversationKey);
        }
      }
      void api.streamAiApprovalDecision(
        payload.approval.conversation_id,
        payload.approval.id,
        decisionPayload,
        {
          signal: controller.signal,
          onProgress: (event) => {
            const eventRunId = 'run_id' in event && typeof event.run_id === 'string' && event.run_id !== 'pending' ? event.run_id : payload.approval.run_id ?? 'pending';
            const nextEvent: AiRunEvent = {
              id: 'id' in event && typeof event.id === 'string' ? event.id : `approval-stream-${event.internal_code}-${Date.now()}`,
              run_id: eventRunId,
              type: event.type,
              internal_code: event.internal_code,
              user_message: event.user_message,
            status: event.status,
            created_at: 'created_at' in event && typeof event.created_at === 'string' ? event.created_at : new Date().toISOString(),
          };
          if (!streamMessageTargetRef.current[eventRunId]) {
            ensureStreamingAssistantMessage(eventRunId, conversationKey);
          }
          if (isActiveStreamProgressStatus(nextEvent.status)) {
            stopThinking(payload.approval.run_id);
          }
          upsertStreamProgressEvent(nextEvent);
        },
          onMessagePart: (event) => applyStreamPart(event, conversationKey),
          onMessageDelta: (event) => applyStreamDelta(event, conversationKey),
          onResponse: (response) => applyChatResponse(response, conversationKey, payload.approval.run_id ?? response.run.id),
        },
      ).then((response) => {
        applyChatResponse(response, payload.approval.conversation_id, payload.approval.run_id ?? response.run.id);
      }).catch((error) => {
        const message = streamFailureMessage(error);
        setStreamError(message);
        stopThinking(payload.approval.run_id);
        applyApprovalDecisionResponse(decisionResponse, conversationKey);
        markStreamingAssistantStopped(payload.approval.run_id ?? null, `AI 后续处理失败：${message}`);
        void refreshAfterApprovalSettled();
      }).finally(() => {
        const activeRunId = payload.approval.run_id;
        if (!activeRunId) return;
        stopThinking(activeRunId);
        const { [activeRunId]: _removed, ...remainingControllers } = chatAbortByRunIdRef.current;
        chatAbortByRunIdRef.current = remainingControllers;
        setActiveStreamRunIdsByConversationKey((current) => {
          if (current[payload.approval.conversation_id] !== activeRunId) return current;
          const next = { ...current };
          delete next[payload.approval.conversation_id];
          return next;
        });
        void refreshAfterApprovalSettled();
      });
      return decisionResponse;
    },
    onSettled: () => {
      void refreshAfterApprovalSettled();
    },
  });
  const humanInputMutation = useMutation({
    mutationFn: (payload: { message: AiMessage; request: AiHumanInputRequest; response: { selected_option_ids?: string[]; text?: string } }) => {
      setStreamError('');
      const controller = new AbortController();
      const conversationKey = payload.message.conversation_id;
      const runId = payload.message.run_id;
      if (runId) {
        chatAbortByRunIdRef.current = { ...chatAbortByRunIdRef.current, [runId]: controller };
        streamMessageTargetRef.current = { ...streamMessageTargetRef.current, [runId]: payload.message.id };
        setActiveStreamRunIdsByConversationKey((current) => ({ ...current, [conversationKey]: runId }));
        startThinking(runId);
      }
      return api.streamAiHumanInputResponse(payload.message.conversation_id, payload.request.id, payload.response, {
        signal: controller.signal,
        onProgress: (event) => {
          const eventRunId = 'run_id' in event && typeof event.run_id === 'string' && event.run_id !== 'pending' ? event.run_id : runId ?? 'pending';
          const nextEvent: AiRunEvent = {
            id: 'id' in event && typeof event.id === 'string' ? event.id : `human-input-stream-${event.internal_code}-${Date.now()}`,
            run_id: eventRunId,
            type: event.type,
            internal_code: event.internal_code,
            user_message: event.user_message,
            status: event.status,
            created_at: 'created_at' in event && typeof event.created_at === 'string' ? event.created_at : new Date().toISOString(),
          };
          if (!streamMessageTargetRef.current[eventRunId]) {
            ensureStreamingAssistantMessage(eventRunId, conversationKey);
          }
          if (isActiveStreamProgressStatus(nextEvent.status)) {
            stopThinking(runId);
          }
          upsertStreamProgressEvent(nextEvent);
        },
        onMessagePart: (event) => applyStreamPart(event, conversationKey),
        onMessageDelta: (event) => applyStreamDelta(event, conversationKey),
      }).then((response) => {
        applyChatResponse(response, payload.message.conversation_id, runId ?? response.run.id);
        return response;
      });
    },
    onSettled: (_data, _error, variables) => {
      const runId = variables?.message.run_id;
      if (!runId || !variables) return;
      stopThinking(runId);
      const { [runId]: _removed, ...remainingControllers } = chatAbortByRunIdRef.current;
      chatAbortByRunIdRef.current = remainingControllers;
      setActiveStreamRunIdsByConversationKey((current) => {
        if (current[variables.message.conversation_id] !== runId) return current;
        const next = { ...current };
        delete next[variables.message.conversation_id];
        return next;
      });
    },
    onError: (error, variables) => {
      const message = streamFailureMessage(error);
      setStreamError(message);
      stopThinking(variables?.message.run_id);
      markStreamingAssistantStopped(variables?.message.run_id ?? null, `AI 后续处理失败：${message}`);
    },
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
      await queryClient.invalidateQueries({ queryKey: queryKeys.aiConversations });
      queryClient.removeQueries({ queryKey: queryKeys.aiMessages(conversationId) });
      queryClient.removeQueries({ queryKey: queryKeys.aiPendingApprovals(conversationId) });
      setPendingDeleteConversation(null);
    },
    onSettled: () => setDeletingConversationId(null),
  });
  const isLocalAssistantBusy = chatMutation.isPending || approvalStreamMutation.isPending || humanInputMutation.isPending;
  const isSubmittingActiveApproval = approvalStreamMutation.isPending && Boolean(activeApprovalRunId);
  const isSubmittingActiveHumanInput = humanInputMutation.isPending && Boolean(activeHumanInputRunId);
  const isActiveConversationLocalBusy = Boolean(activeStreamRunId) || isActiveConversationServerRunning || isSubmittingActiveApproval || isSubmittingActiveHumanInput;
  const isAnotherConversationRunning = isLocalAssistantBusy && !isActiveConversationLocalBusy;
  const isAssistantBusy = Boolean(activeVisibleRunId) || Boolean(activeApprovalRunId) || Boolean(activeHumanInputRunId);
  const effectiveComposerPaused = isComposerPaused || isAnotherConversationRunning;
  const effectiveComposerPauseMessage = isSubmittingActiveHumanInput
    ? '正在提交你的回答，AI 会接着处理当前任务。'
    : isSubmittingActiveApproval
      ? '正在提交确认结果，AI 会接着处理当前任务。'
      : isAnotherConversationRunning
        ? '另一个会话正在后台回复，可以切回历史查看进度。'
        : composerPauseMessage;
  const activeCancellableRunId = activeStreamRunId ?? activeApprovalRunId ?? activeHumanInputRunId ?? (isActiveConversationServerRunning ? serverActiveRunId : null);
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
  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (effectiveComposerPaused || isAssistantBusy || isLocalAssistantBusy) return;
    const text = draft.trim();
    const sendableAttachments = readyAttachments.filter((item) => item.asset);
    if ((!text && sendableAttachments.length === 0) || isAttachmentSendBlocked) return;
    const clientMessageId = `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const clientRunId = `agent_run-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const conversationKey = activeConversationId ?? createPendingConversationKey(clientRunId);
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
    const assistantMessage = createLocalAssistantMessage(clientRunId, conversationKey);
    updateLocalMessages(conversationKey, (items) => [...items, tempMessage, assistantMessage]);
    streamProgressRef.current = { ...streamProgressRef.current, [clientRunId]: [] };
    streamMessageTargetRef.current = {};
    setStreamProgressByRunId((current) => ({ ...current, [clientRunId]: [] }));
    setActiveStreamRunIdsByConversationKey((current) => ({ ...current, [conversationKey]: clientRunId }));
    setActiveConversationKey(conversationKey);
    setIsStartingNewConversation(false);
    setDraft('');
    attachmentState.hideAttachments(sendableAttachments.map((attachment) => attachment.clientAttachmentId));
    try {
      await chatMutation.mutateAsync({
        message: text,
        conversationKey,
        conversation_id: activeConversationId ?? undefined,
        client_message_id: clientMessageId,
        client_run_id: clientRunId,
        attachments: requestAttachments,
      });
      attachmentState.discardHiddenAttachments(sendableAttachments);
    } catch {
      attachmentState.restoreHiddenAttachments(sendableAttachments);
      // The mutation state renders the request error; keep it out of the form event promise.
    }
  }
  const submitApprovalDecision: AiApprovalDecisionSubmit = async (approval, decision, values, comment) => {
    if (approvalStreamMutation.isPending) return;
    if (approval.run_id) {
      streamProgressRef.current = { ...streamProgressRef.current, [approval.run_id]: [] };
    }
    if (approval.run_id) {
      setStreamProgressByRunId((current) => ({ ...current, [approval.run_id as string]: [] }));
    }
    await approvalStreamMutation.mutateAsync({ approval, decision, values, comment });
  };
  const submitHumanInputResponse: AiHumanInputResponseSubmit = async (message, request, response) => {
    if (humanInputMutation.isPending) return;
    if (message.run_id) {
      streamProgressRef.current = { ...streamProgressRef.current, [message.run_id]: [] };
      setStreamProgressByRunId((current) => ({ ...current, [message.run_id as string]: [] }));
    }
    await humanInputMutation.mutateAsync({ message, request, response });
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
    action: AiInventoryOperationAction,
    card: AiResultCard,
    messageId: string,
    partId: string,
  ) {
    inventoryDraftAction.createDraft({ item, action, card, messageId, partId });
  }
  async function submitRecommendationPlan(payload: CreateFoodPlanItemPayload) {
    if (!createFoodPlanItem || !recommendationPlanRequest) {
      throw new Error('菜单计划功能暂不可用。');
    }
    const name = recommendationPlanRequest.recommendation.name;
    const planItem = await createFoodPlanItem(payload);
    const updatedMessage = await api.recordAiRecommendationSelection(recommendationPlanRequest.messageId, {
      part_id: recommendationPlanRequest.partId,
      card_id: recommendationPlanRequest.cardId,
      entity_id: recommendationPlanRequest.recommendation.entityId,
      food_plan_item_id: planItem.id,
    });
    queryClient.setQueryData<AiMessage[]>(
      queryKeys.aiMessages(updatedMessage.conversation_id),
      (items = []) => items.map((item) => (item.id === updatedMessage.id ? updatedMessage : item)),
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
    setPlanFeedback(`${name} 已加入菜单计划`);
  }
  async function cancelStreamingChat() {
    const runId = activeCancellableRunId;
    if (runId) {
      stopThinking(runId);
      try {
        const result = await api.cancelAiRun(runId);
        setRunEventsById((current) => ({ ...current, [runId]: result.events }));
        setStreamProgressByRunId((current) => ({ ...current, [runId]: [...(current[runId] ?? []), ...result.events] }));
      } catch {
        setStreamProgressByRunId((current) => ({
          ...current,
          [runId]: [
            ...(current[runId] ?? []),
            {
            id: `stream-cancel-fallback-${Date.now()}`,
            run_id: runId,
            type: 'cancel',
            internal_code: 'server_cancel_unavailable',
            user_message: '已停止等待这次任务',
            status: 'failed',
            created_at: new Date().toISOString(),
            },
          ],
        }));
      }
    }
    markStreamingAssistantStopped(runId);
    if (runId) {
      chatAbortByRunIdRef.current[runId]?.abort();
    }
    if (runId) {
      delete streamMessageTargetRef.current[runId];
    }
    setStreamProgressByRunId((current) => ({
      ...current,
      [runId ?? 'pending']: [
        ...(current[runId ?? 'pending'] ?? []),
        {
        id: `stream-cancel-${Date.now()}`,
        run_id: runId ?? 'pending',
        type: 'cancel',
        internal_code: 'client_abort',
        user_message: '已取消这次任务',
        status: 'failed',
        created_at: new Date().toISOString(),
        },
      ],
    }));
    void refreshAfterApprovalSettled();
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
  return (
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
      <AiMobilePage
        conversations={historyConversations}
        isLoading={isLoading}
        activeConversationKey={activeConversationKey}
        runningConversationKeys={runningConversationKeys}
        isMobileHistoryOpen={isMobileHistoryOpen}
        currentUser={currentUser}
        resourceOptionLoader={loadResourceOptions}
        messages={displayedMessages}
        runEventsById={runEventsById}
        streamProgress={streamProgress}
        thinkingRunIds={thinkingRunIds}
        activeAssistantRunId={activeVisibleRunId}
        draft={draft}
        attachments={attachmentState.attachments}
        canAddAttachment={attachmentState.canAddMore && !isVisionUnavailableForAttachments}
        hasUploadingAttachment={attachmentState.hasUploadingAttachment}
        hasFailedAttachment={attachmentState.hasFailedAttachment || isVisionUnavailableForAttachments}
        isSending={isAssistantBusy}
        isComposerPaused={effectiveComposerPaused}
        composerPauseMessage={effectiveComposerPauseMessage}
        sendError={chatMutation.isError ? chatMutation.error.message : undefined}
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
        onDraftChange={setDraft}
        onAttachmentFiles={addAttachmentFiles}
        onRemoveAttachment={attachmentState.removeAttachment}
        onPasteFiles={handleComposerPaste}
        onDropFiles={handleComposerDrop}
        onPickSuggestion={setDraft}
        onSubmit={sendMessage}
        onApprovalDecision={submitApprovalDecision}
        onHumanInputResponse={submitHumanInputResponse}
        onAddRecommendationToPlan={openRecommendationPlan}
        onInventoryAction={createInventoryOperationDraft}
        isInventoryActionPending={inventoryDraftAction.isPending}
        onCancelSending={cancelStreamingChat}
      />
      <div className="ai-desktop-view">
        <AiDesktopConversationHistory
          conversations={historyConversations}
          isLoading={isLoading}
          activeConversationKey={activeConversationKey}
          runningConversationKeys={runningConversationKeys}
          deletingConversationId={deletingConversationId}
          onToggleSidebar={toggleSidebar}
          onStartNewConversation={startNewConversation}
          onSelectConversation={selectConversation}
          onDeleteConversation={deleteConversation}
        />
        {pendingDeleteConversation && (
          <AiDeleteConversationDialog
            conversation={pendingDeleteConversation}
            isDeleting={deleteConversationMutation.isPending}
            onCancel={() => setPendingDeleteConversation(null)}
            onConfirm={confirmDeleteConversation}
          />
        )}
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
              <button className={`ai-ready-pill ai-quality-trigger ${isAiUnavailable ? 'is-disabled' : ''}`} type="button" onClick={() => setIsQualityModalOpen(true)} aria-label="查看 AI 质量诊断" title="查看 AI 质量诊断">
                <span />{aiStatusLabel}
              </button>
            </div>
          </div>
          <div className="ai-thread-scroll">
            {isMessageHistoryLoading ? (
              <p className="subtle">正在加载消息...</p>
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
                    isThinking={Boolean(message.run_id && thinkingRunIds.has(message.run_id))}
                    isLatestAssistant={message.id === latestAssistantMessageId}
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
                  />
                ))}
              </>
            ) : (
              <AiWelcomePrompt onPickSuggestion={setDraft} />
            )}
          </div>
          <div className="ai-composer-dock">
            {chatMutation.isError && <p className="form-error">{chatMutation.error.message}</p>}
            {streamError && <p className="form-error">{streamError}</p>}
            {effectiveComposerPaused && <p className="ai-composer-pause-note">{effectiveComposerPauseMessage}</p>}
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
                placeholder={effectiveComposerPaused ? effectiveComposerPauseMessage ?? '等待你确认草稿...' : '输入你的问题，或让 AI 帮你安排一餐...'}
                disabled={effectiveComposerPaused}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={handleComposerPaste}
              />
              <div className="ai-composer-actions">
                <button
                  className={`ai-send-button ${isAssistantBusy ? 'is-sending' : ''}`}
                  type={isAssistantBusy ? 'button' : 'submit'}
                  disabled={!isAssistantBusy && (isAiUnavailable || !canSubmitMessage || isAttachmentSendBlocked || effectiveComposerPaused || isLocalAssistantBusy)}
                  aria-label={isAssistantBusy ? '中止生成' : '发送消息'}
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
    </main>
  );
}
