import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { invalidateAfterAiMessageSent } from '../../api/cacheInvalidation';
import { api } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type { AiApprovalRequest, AiChatResponse, AiConversation, AiMessage, AiRunEvent, UserSummary } from '../../api/types';
import { resolveAssetUrl } from '../../lib/assets';
import { EmptyState, WorkspaceModal } from '../ui-kit';
import { AiMobilePage, AI_WELCOME_SUGGESTIONS } from './AiMobilePage';
import { MessageBubble, type AiApprovalDecisionSubmit, type AiResourceOptionLoader } from './AiConversationThread';

type AiWorkspaceProps = {
  conversations: AiConversation[];
  isLoading: boolean;
  currentUser?: UserSummary | null;
  onBackHome?: () => void;
};

export { ApprovalPanel } from './AiConversationThread';

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="m19 6-1 14H6L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  );
}

function mergePendingApprovalsIntoMessages(messages: AiMessage[], approvals: AiApprovalRequest[]): AiMessage[] {
  const embeddedApprovalIds = new Set(
    messages.flatMap((message) => message.parts.map((part) => part.approval?.id).filter((id): id is string => Boolean(id))),
  );
  const missingApprovals = approvals.filter((approval) => !embeddedApprovalIds.has(approval.id));
  if (missingApprovals.length === 0) return messages;

  const approvalsByMessageId = new Map<string, AiApprovalRequest[]>();
  for (const approval of missingApprovals) {
    if (!approval.message_id) continue;
    const items = approvalsByMessageId.get(approval.message_id) ?? [];
    items.push(approval);
    approvalsByMessageId.set(approval.message_id, items);
  }

  const merged = messages.map((message) => {
    const messageApprovals = approvalsByMessageId.get(message.id) ?? [];
    if (messageApprovals.length === 0) return message;
    approvalsByMessageId.delete(message.id);
    return {
      ...message,
      content_type: 'parts',
      parts: [
        ...message.parts,
        ...messageApprovals.map((approval) => ({
          id: `restored-approval-part-${approval.id}`,
          type: 'approval_request' as const,
          approval,
        })),
      ],
    };
  });

  const orphanedApprovalGroups = new Map<string, AiApprovalRequest[]>();
  for (const approval of missingApprovals) {
    if (approval.message_id && !approvalsByMessageId.has(approval.message_id)) continue;
    const groupId = approval.message_id ?? `restored-approval-message-${approval.id}`;
    orphanedApprovalGroups.set(groupId, [...(orphanedApprovalGroups.get(groupId) ?? []), approval]);
  }
  const syntheticMessages = Array.from(orphanedApprovalGroups, ([messageId, messageApprovals]): AiMessage => {
    const firstApproval = messageApprovals[0];
    return {
      id: messageId,
      conversation_id: firstApproval.conversation_id,
      role: 'assistant',
      content: firstApproval.instruction || '请确认以下操作。',
      content_type: 'parts',
      parts: messageApprovals.map((approval) => ({
        id: `restored-approval-part-${approval.id}`,
        type: 'approval_request',
        approval,
      })),
      run_id: firstApproval.run_id,
      status: 'completed',
      metadata: { restoredApproval: true },
      created_at: firstApproval.created_at,
    };
  });

  return [...merged, ...syntheticMessages];
}

function normalizeStreamEventForFinalRun(event: AiRunEvent, response: AiChatResponse): AiRunEvent {
  const status =
    response.run.status === 'completed' && (event.status === 'pending' || event.status === 'running')
      ? 'completed'
      : event.status;
  return { ...event, run_id: response.run.id, status };
}

function attachIncludedApprovalsToMessage(message: AiMessage, approvals: AiApprovalRequest[]): AiMessage {
  const relatedApprovals = approvals.filter((approval) => {
    if (approval.message_id) return approval.message_id === message.id;
    if (approval.run_id && message.run_id) return approval.run_id === message.run_id;
    return approval.conversation_id === message.conversation_id;
  });
  if (relatedApprovals.length === 0) return message;
  const embeddedApprovalIds = new Set(message.parts.map((part) => part.approval?.id).filter((id): id is string => Boolean(id)));
  const missingApprovals = relatedApprovals.filter((approval) => !embeddedApprovalIds.has(approval.id));
  if (missingApprovals.length === 0) return message;
  return {
    ...message,
    content_type: 'parts',
    parts: [
      ...message.parts,
      ...missingApprovals.map((approval) => ({
        id: `included-approval-part-${approval.id}`,
        type: 'approval_request' as const,
        approval,
      })),
    ],
  };
}

function createLocalAssistantMessage(runId: string, conversationId: string | null): AiMessage {
  return {
    id: `local-assistant-${runId}`,
    conversation_id: conversationId || 'pending',
    role: 'assistant',
    content: '',
    content_type: 'parts',
    parts: [],
    run_id: runId,
    status: 'running',
    metadata: {},
    created_at: new Date().toISOString(),
  };
}

function appendAssistantDelta(currentText: string, delta: string, shouldSeparate: boolean) {
  if (!shouldSeparate || !currentText.trim() || currentText.endsWith('\n\n') || delta.startsWith('\n')) {
    return `${currentText}${delta}`;
  }
  return `${currentText}\n\n${delta}`;
}

function messageTextFromParts(parts: AiMessage['parts']) {
  return parts
    .filter((part) => part.type === 'text' && part.text?.trim())
    .map((part) => part.text?.trim() ?? '')
    .join('\n\n');
}

function appendDeltaToMessageParts(
  parts: AiMessage['parts'],
  delta: string,
  partId: string,
  shouldSeparate: boolean,
  appendAfterNonText: boolean,
) {
  if (appendAfterNonText) {
    const existingContinuation = parts.find((part) => part.type === 'text' && part.id === partId);
    if (existingContinuation) {
      return parts.map((part) =>
        part.id === partId && part.type === 'text'
          ? { ...part, text: appendAssistantDelta(part.text ?? '', delta, false) }
          : part,
      );
    }
    return [...parts, { id: partId, type: 'text' as const, text: delta }];
  }
  return parts.some((part) => part.type === 'text')
    ? parts.map((part) => (part.type === 'text' ? { ...part, id: partId || part.id, text: appendAssistantDelta(part.text ?? '', delta, shouldSeparate) } : part))
    : [{ id: partId, type: 'text' as const, text: delta }, ...parts];
}

export function AiWorkspace({ conversations, isLoading, currentUser = null, onBackHome }: AiWorkspaceProps) {
  const queryClient = useQueryClient();
  const [activeConversationId, setActiveConversationId] = useState<string | null>(conversations[0]?.id ?? null);
  const [isStartingNewConversation, setIsStartingNewConversation] = useState(false);
  const [draft, setDraft] = useState('');
  const [localMessages, setLocalMessages] = useState<AiMessage[]>([]);
  const [runEventsById, setRunEventsById] = useState<Record<string, AiRunEvent[]>>({});
  const [streamProgress, setStreamProgress] = useState<AiRunEvent[]>([]);
  const streamProgressRef = useRef<AiRunEvent[]>([]);
  const streamDeltaBoundaryRef = useRef<Record<string, number>>({});
  const streamMessageTargetRef = useRef<Record<string, string>>({});
  const requestedRunEventsRef = useRef<Set<string>>(new Set());
  const [activeStreamRunId, setActiveStreamRunId] = useState<string | null>(null);
  const chatAbortRef = useRef<AbortController | null>(null);
  const [deletingConversationId, setDeletingConversationId] = useState<string | null>(null);
  const [pendingDeleteConversation, setPendingDeleteConversation] = useState<AiConversation | null>(null);
  const [isMobileHistoryOpen, setIsMobileHistoryOpen] = useState(false);

  useEffect(() => {
    if (!activeConversationId && !isStartingNewConversation && conversations[0]) {
      setActiveConversationId(conversations[0].id);
    }
  }, [activeConversationId, conversations, isStartingNewConversation]);

  const messagesQuery = useQuery({
    queryKey: queryKeys.aiMessages(activeConversationId),
    queryFn: () => api.getAiMessages(activeConversationId as string),
    enabled: Boolean(activeConversationId),
  });
  const aiStatusQuery = useQuery({
    queryKey: queryKeys.aiStatus,
    queryFn: api.getAiStatus,
  });
  const pendingApprovalsQuery = useQuery({
    queryKey: queryKeys.aiPendingApprovals(activeConversationId),
    queryFn: () => api.getPendingAiApprovals(activeConversationId as string),
    enabled: Boolean(activeConversationId),
  });

  const messages = useMemo(() => {
    const remote = messagesQuery.data ?? [];
    if (localMessages.length === 0) return remote;
    const localById = new Map(localMessages.map((item) => [item.id, item]));
    const knownIds = new Set(remote.map((item) => item.id));
    const knownClientIds = new Set(remote.map((item) => item.client_message_id).filter(Boolean));
    return [
      ...remote.map((item) => localById.get(item.id) ?? item),
      ...localMessages.filter((item) => {
        if (knownIds.has(item.id)) return false;
        if (item.client_message_id && knownClientIds.has(item.client_message_id)) return false;
        return true;
      }),
    ];
  }, [localMessages, messagesQuery.data]);

  const displayedMessages = useMemo(
    () => mergePendingApprovalsIntoMessages(messages, pendingApprovalsQuery.data ?? []),
    [messages, pendingApprovalsQuery.data],
  );
  const hasPendingApproval = useMemo(() => {
    if ((pendingApprovalsQuery.data ?? []).some((approval) => approval.status === 'pending')) return true;
    return displayedMessages.some((message) => message.parts.some((part) => part.approval?.status === 'pending'));
  }, [displayedMessages, pendingApprovalsQuery.data]);
  const activeApprovalRunId = useMemo(() => {
    const pendingApproval = (pendingApprovalsQuery.data ?? []).find((approval) => approval.status === 'pending' && approval.run_id);
    if (pendingApproval?.run_id) return pendingApproval.run_id;
    for (const message of displayedMessages) {
      const approval = message.parts.find((part) => part.approval?.status === 'pending' && part.approval.run_id)?.approval;
      if (approval?.run_id) return approval.run_id;
    }
    return null;
  }, [displayedMessages, pendingApprovalsQuery.data]);
  const isAiUnavailable = aiStatusQuery.data?.enabled === false;
  const isComposerPaused = hasPendingApproval || isAiUnavailable;
  const composerPauseMessage = isAiUnavailable
    ? aiStatusQuery.data?.detail || 'AI 模型未配置，暂时不能发送消息。'
    : hasPendingApproval
      ? '请先确认上面的草稿，确认后可以继续对话。'
      : undefined;
  const aiStatusLabel = isAiUnavailable ? 'AI 未配置' : aiStatusQuery.isLoading ? 'AI 检查中' : 'AI 已就绪';
  const loadResourceOptions = useCallback<AiResourceOptionLoader>(async (kind, params) => {
    if (kind === 'food') {
      const items = await api.getFoods({ q: params.query, limit: params.limit, offset: params.offset });
      return items.map((food) => ({
        id: food.id,
        label: food.name,
        description: [food.category, food.type].filter(Boolean).join(' · '),
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

  function ensureStreamingAssistantMessage(runId: string) {
    const messageId = `local-assistant-${runId}`;
    setLocalMessages((items) => {
      if (items.some((item) => item.id === messageId || item.run_id === runId)) return items;
      return [...items, createLocalAssistantMessage(runId, activeConversationId)];
    });
  }

  function applyChatResponse(response: AiChatResponse) {
    const finalStreamEvents = streamProgressRef.current.map((event) => normalizeStreamEventForFinalRun(event, response));
    const responseEventIds = new Set(response.events.map((event) => event.id));
    const mergedEvents = [...finalStreamEvents.filter((event) => !responseEventIds.has(event.id)), ...response.events];
    const targetMessageId = streamMessageTargetRef.current[response.run.id];
    const includedMessage = attachIncludedApprovalsToMessage(response.message, response.included.approvals);
    const messageWithIncludedApprovals = targetMessageId && targetMessageId !== includedMessage.id
      ? { ...includedMessage, id: targetMessageId, run_id: response.run.id }
      : includedMessage;
    setActiveConversationId(response.conversation_id);
    setIsStartingNewConversation(false);
    setLocalMessages((items) => [
      ...items.filter((item) => item.id !== messageWithIncludedApprovals.id && item.id !== response.message.id && item.run_id !== response.run.id),
      messageWithIncludedApprovals,
    ]);
    setRunEventsById((current) => ({ ...current, [response.run.id]: mergedEvents }));
    streamProgressRef.current = [];
    streamDeltaBoundaryRef.current = {};
    delete streamMessageTargetRef.current[response.run.id];
    setStreamProgress([]);
    invalidateAfterAiMessageSent(queryClient, response.conversation_id);
  }

  function applyStreamDelta(event: { message_id?: string; conversation_id?: string; run_id?: string; part_id?: string; delta: string }) {
    if (!event.delta) return;
    const runId = event.run_id || activeStreamRunId || 'pending';
    const messageId = streamMessageTargetRef.current[runId] || event.message_id || `local-assistant-${runId}`;
    const partId = event.part_id || `local-part-${runId}`;
    const isApprovalContinuation = streamMessageTargetRef.current[runId] === messageId;
    setLocalMessages((items) => {
      const existingIndex = items.findIndex((item) => item.id === messageId || item.id === `local-assistant-${runId}` || item.run_id === runId);
      if (existingIndex === -1) {
        const sourceMessage = displayedMessages.find((item) => item.id === messageId) ?? messages.find((item) => item.id === messageId);
        if (sourceMessage) {
          const textPart = sourceMessage.parts.find((part) => part.type === 'text');
          const currentText = textPart?.text ?? sourceMessage.content ?? '';
          const hasNonTextParts = sourceMessage.parts.some((part) => part.type !== 'text');
          const progressCount = streamProgressRef.current.filter((progress) => progress.run_id === runId).length + (runEventsById[runId]?.length ?? 0);
          const shouldSeparate = hasNonTextParts || progressCount > 0;
          const nextParts = appendDeltaToMessageParts(sourceMessage.parts, event.delta, partId, shouldSeparate, isApprovalContinuation && hasNonTextParts);
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
            conversation_id: event.conversation_id || activeConversationId || 'pending',
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
        const textPart = item.parts.find((part) => part.type === 'text');
        const currentText = textPart?.text ?? item.content ?? '';
        const hasNonTextParts = item.parts.some((part) => part.type !== 'text');
        const progressCount = runId
          ? streamProgressRef.current.filter((progress) => progress.run_id === runId).length + (runEventsById[runId]?.length ?? 0)
          : 0;
        const boundaryKey = `${messageId}:${runId}`;
        const lastSeparatedProgressCount = streamDeltaBoundaryRef.current[boundaryKey] ?? 0;
        const shouldSeparate = (hasNonTextParts && !currentText.includes('\n\n')) || progressCount > lastSeparatedProgressCount;
        const willInsertSeparator = shouldSeparate && Boolean(currentText.trim()) && !currentText.endsWith('\n\n') && !event.delta.startsWith('\n');
        const nextText = appendAssistantDelta(currentText, event.delta, shouldSeparate);
        if (willInsertSeparator && progressCount > 0) {
          streamDeltaBoundaryRef.current = { ...streamDeltaBoundaryRef.current, [boundaryKey]: progressCount };
        }
        const nextParts = appendDeltaToMessageParts(item.parts, event.delta, partId, shouldSeparate, isApprovalContinuation && hasNonTextParts);
        return {
          ...item,
          id: messageId,
          conversation_id: event.conversation_id || item.conversation_id,
          content: messageTextFromParts(nextParts),
          parts: nextParts,
        };
      });
    });
  }

  function markStreamingAssistantStopped(runId: string | null, text = '已取消这次任务。') {
    if (!runId) return;
    setLocalMessages((items) =>
      items.map((item) => {
        if (item.run_id !== runId && item.id !== `local-assistant-${runId}`) return item;
        const textPart = item.parts.find((part) => part.type === 'text');
        const nextText = textPart?.text?.trim() || item.content || text;
        return {
          ...item,
          content: nextText,
          status: 'failed',
          parts: item.parts.some((part) => part.type === 'text')
            ? item.parts.map((part) => (part.type === 'text' ? { ...part, text: nextText } : part))
            : [{ id: `local-cancel-part-${runId}`, type: 'text' as const, text: nextText }, ...item.parts],
        };
      }),
    );
  }

  function upsertStreamProgressEvent(nextEvent: AiRunEvent) {
    const currentItems = streamProgressRef.current;
    const nextItems = currentItems.some((item) => item.id === nextEvent.id)
      ? currentItems.map((item) => (item.id === nextEvent.id ? nextEvent : item))
      : [...currentItems, nextEvent];
    streamProgressRef.current = nextItems;
    setStreamProgress(nextItems);
  }

  const chatMutation = useMutation({
    mutationFn: (payload: { message: string; conversation_id?: string; client_message_id?: string; client_run_id?: string; quick_task?: string; subject?: Record<string, unknown> }) => {
      const controller = new AbortController();
      chatAbortRef.current = controller;
      return api.streamChatAi(payload, {
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
          ensureStreamingAssistantMessage(eventRunId);
          upsertStreamProgressEvent(nextEvent);
        },
        onMessageDelta: applyStreamDelta,
      });
    },
    onSuccess: (response) => {
      applyChatResponse(response);
    },
    onSettled: () => {
      chatAbortRef.current = null;
      setActiveStreamRunId(null);
    },
  });

  const approvalStreamMutation = useMutation({
    mutationFn: (payload: { approval: Parameters<AiApprovalDecisionSubmit>[0]; decision: 'approved' | 'rejected'; values: Record<string, unknown>; comment?: string }) => {
      const controller = new AbortController();
      chatAbortRef.current = controller;
      if (payload.approval.run_id) {
        setActiveStreamRunId(payload.approval.run_id);
        if (payload.approval.message_id) {
          streamMessageTargetRef.current = { ...streamMessageTargetRef.current, [payload.approval.run_id]: payload.approval.message_id };
        } else {
          ensureStreamingAssistantMessage(payload.approval.run_id);
        }
      }
      return api.streamAiApprovalDecision(
        payload.approval.conversation_id,
        payload.approval.id,
        {
          decision: payload.decision,
          draft_version: payload.approval.draft_version,
          values: payload.values,
          comment: payload.comment,
        },
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
              ensureStreamingAssistantMessage(eventRunId);
            }
            upsertStreamProgressEvent(nextEvent);
          },
          onMessageDelta: applyStreamDelta,
        },
      );
    },
    onSuccess: (response) => {
      applyChatResponse(response);
    },
    onSettled: () => {
      chatAbortRef.current = null;
      setActiveStreamRunId(null);
      void refreshAfterApprovalSettled();
    },
  });

  const retryMutation = useMutation({
    mutationFn: api.retryAiRun,
    onSuccess: applyChatResponse,
  });

  const regenerateMutation = useMutation({
    mutationFn: (payload: { messageId: string; partId: string }) => api.regenerateAiPart(payload.messageId, payload.partId),
    onSuccess: applyChatResponse,
  });

  const deleteConversationMutation = useMutation({
    mutationFn: api.deleteAiConversation,
    onSuccess: async (_, conversationId) => {
      const remainingConversations = conversations.filter((conversation) => conversation.id !== conversationId);
      if (conversationId === activeConversationId) {
        const nextConversation = remainingConversations[0] ?? null;
        setActiveConversationId(nextConversation?.id ?? null);
        setIsStartingNewConversation(!nextConversation);
        setLocalMessages([]);
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.aiConversations });
      queryClient.removeQueries({ queryKey: queryKeys.aiMessages(conversationId) });
      queryClient.removeQueries({ queryKey: queryKeys.aiPendingApprovals(conversationId) });
      setPendingDeleteConversation(null);
    },
    onSettled: () => setDeletingConversationId(null),
  });

  const isAssistantBusy = chatMutation.isPending || approvalStreamMutation.isPending || Boolean(activeStreamRunId) || Boolean(activeApprovalRunId);
  const activeCancellableRunId = activeStreamRunId ?? activeApprovalRunId;

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
    setActiveConversationId(null);
    setIsStartingNewConversation(true);
    setLocalMessages([]);
    setIsMobileHistoryOpen(false);
  }

  function selectConversation(conversationId: string) {
    setActiveConversationId(conversationId);
    setIsStartingNewConversation(false);
    setLocalMessages([]);
    setIsMobileHistoryOpen(false);
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isComposerPaused || isAssistantBusy) return;
    const text = draft.trim();
    if (!text) return;
    const clientMessageId = `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const clientRunId = `agent_run-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const tempMessage: AiMessage = {
      id: `local-${clientMessageId}`,
      conversation_id: activeConversationId ?? 'pending',
      role: 'user',
      content: text,
      content_type: 'text',
      parts: [{ id: `local-part-${clientMessageId}`, type: 'text', text }],
      status: 'completed',
      metadata: {},
      client_message_id: clientMessageId,
      created_at: new Date().toISOString(),
    };
    const assistantMessage = createLocalAssistantMessage(clientRunId, activeConversationId);
    setLocalMessages((items) => [...items, tempMessage, assistantMessage]);
    streamProgressRef.current = [];
    streamDeltaBoundaryRef.current = {};
    streamMessageTargetRef.current = {};
    setStreamProgress([]);
    setActiveStreamRunId(clientRunId);
    setDraft('');
    try {
      await chatMutation.mutateAsync({
        message: text,
        conversation_id: activeConversationId ?? undefined,
        client_message_id: clientMessageId,
        client_run_id: clientRunId,
      });
    } catch {
      // The mutation state renders the request error; keep it out of the form event promise.
    }
  }

  function retryRun(runId: string) {
    if (retryMutation.isPending) return;
    retryMutation.mutate(runId);
  }

  function regeneratePart(messageId: string, partId: string) {
    if (regenerateMutation.isPending) return;
    regenerateMutation.mutate({ messageId, partId });
  }

  const submitApprovalDecision: AiApprovalDecisionSubmit = async (approval, decision, values, comment) => {
    if (approvalStreamMutation.isPending) return;
    streamProgressRef.current = [];
    streamDeltaBoundaryRef.current = {};
    setStreamProgress([]);
    await approvalStreamMutation.mutateAsync({ approval, decision, values, comment });
  };

  async function cancelStreamingChat() {
    const runId = activeCancellableRunId;
    if (runId) {
      try {
        const result = await api.cancelAiRun(runId);
        setRunEventsById((current) => ({ ...current, [runId]: result.events }));
        setStreamProgress((items) => [...items, ...result.events]);
      } catch {
        setStreamProgress((items) => [
          ...items,
          {
            id: `stream-cancel-fallback-${Date.now()}`,
            run_id: runId,
            type: 'cancel',
            internal_code: 'server_cancel_unavailable',
            user_message: '已停止等待这次任务',
            status: 'failed',
            created_at: new Date().toISOString(),
          },
        ]);
      }
    }
    markStreamingAssistantStopped(runId);
    chatAbortRef.current?.abort();
    if (runId) {
      delete streamMessageTargetRef.current[runId];
    }
    setStreamProgress((items) => [
      ...items,
      {
        id: `stream-cancel-${Date.now()}`,
        run_id: runId ?? 'pending',
        type: 'cancel',
        internal_code: 'client_abort',
        user_message: '已取消这次任务',
        status: 'failed',
        created_at: new Date().toISOString(),
      },
    ]);
    void refreshAfterApprovalSettled();
  }

  async function refreshAfterApprovalSettled() {
    await Promise.all([
      messagesQuery.refetch(),
      pendingApprovalsQuery.refetch(),
      queryClient.invalidateQueries({ queryKey: queryKeys.aiConversations }),
    ]);
  }

  const latestAssistantMessageId = [...displayedMessages].reverse().find((message) => message.role === 'assistant')?.id ?? null;

  return (
    <main className="ai-workspace-shell">
      <AiMobilePage
        conversations={conversations}
        isLoading={isLoading}
        activeConversationId={activeConversationId}
        isMobileHistoryOpen={isMobileHistoryOpen}
        currentUser={currentUser}
        resourceOptionLoader={loadResourceOptions}
        messages={displayedMessages}
        runEventsById={runEventsById}
        streamProgress={streamProgress}
        activeStreamRunId={activeStreamRunId}
        draft={draft}
        isSending={isAssistantBusy}
        isComposerPaused={isComposerPaused}
        composerPauseMessage={composerPauseMessage}
        sendError={chatMutation.isError ? chatMutation.error.message : undefined}
        onBackHome={onBackHome}
        onOpenMobileHistory={() => setIsMobileHistoryOpen(true)}
        onCloseMobileHistory={() => setIsMobileHistoryOpen(false)}
        onStartNewConversation={startNewConversation}
        onSelectConversation={selectConversation}
        onDraftChange={setDraft}
        onPickSuggestion={setDraft}
        onSubmit={sendMessage}
        onApprovalDecision={submitApprovalDecision}
        onRetryRun={retryRun}
        onRegeneratePart={regeneratePart}
        onCancelSending={cancelStreamingChat}
      />

      <div className="ai-desktop-view">
        <aside className="ai-side-panel">
          <div className="ai-side-head">
            <div>
              <span>AI Workspace</span>
              <h2>历史记录</h2>
            </div>
            <button className="ai-new-chat" type="button" onClick={startNewConversation}>
              + 新会话
            </button>
          </div>
          <div className="ai-conversation-list">
            {isLoading ? (
              <p className="subtle">正在加载会话...</p>
            ) : conversations.length > 0 ? (
              conversations.map((conversation) => (
                <div key={conversation.id} className={`ai-conversation-item ${conversation.id === activeConversationId ? 'active' : ''}`}>
                  <button className="ai-conversation-main" type="button" onClick={() => selectConversation(conversation.id)}>
                    <strong>{conversation.title || conversation.prompt || 'AI 会话'}</strong>
                  </button>
                  <button
                    className="ai-conversation-delete"
                    type="button"
                    aria-label={`删除会话：${conversation.title || conversation.prompt || 'AI 会话'}`}
                    title="删除"
                    disabled={deletingConversationId === conversation.id}
                    onClick={() => deleteConversation(conversation)}
                  >
                    <TrashIcon />
                  </button>
                </div>
              ))
            ) : (
              <EmptyState title="还没有会话" description="先发起一个问题。" />
            )}
          </div>
        </aside>

        {pendingDeleteConversation && (
          <div className="workspace-overlay-root ai-delete-confirm-root">
            <div className="workspace-overlay-backdrop" onClick={() => {
              if (!deleteConversationMutation.isPending) setPendingDeleteConversation(null);
            }} />
            <WorkspaceModal
              title="删除这条历史？"
              eyebrow="确认操作"
              description="删除后，这条会话和相关消息将从历史记录中移除。"
              closeLabel="取消"
              closeAriaLabel="取消删除"
              className="ai-delete-confirm-modal"
              onClose={() => {
                if (!deleteConversationMutation.isPending) setPendingDeleteConversation(null);
              }}
            >
              <div className="ai-delete-confirm-body">
                <div className="ai-delete-confirm-icon" aria-hidden="true">
                  <TrashIcon />
                </div>
                <div>
                  <span>将删除</span>
                  <strong>{pendingDeleteConversation.title || pendingDeleteConversation.prompt || 'AI 会话'}</strong>
                </div>
              </div>
              <div className="ai-delete-confirm-actions">
                <button className="ghost-button" type="button" disabled={deleteConversationMutation.isPending} onClick={() => setPendingDeleteConversation(null)}>
                  取消
                </button>
                <button className="solid-button danger" type="button" disabled={deleteConversationMutation.isPending} onClick={confirmDeleteConversation}>
                  {deleteConversationMutation.isPending ? '删除中...' : '确认删除'}
                </button>
              </div>
            </WorkspaceModal>
          </div>
        )}

        <section className="ai-main-panel">
          <div className="ai-main-head">
            <div className="ai-hero-bar">
              <span>AI 厨房助手</span>
              <span className={`ai-ready-pill ${isAiUnavailable ? 'is-disabled' : ''}`}><span />{aiStatusLabel}</span>
            </div>
          </div>
          <div className="ai-thread-scroll">
            {messagesQuery.isLoading && activeConversationId ? (
              <p className="subtle">正在加载消息...</p>
            ) : displayedMessages.length > 0 ? (
              <>
                {displayedMessages.map((message) => (
                  <MessageBubble
                    key={message.id}
                    message={message}
                    user={currentUser}
                    resourceOptionLoader={loadResourceOptions}
                    runEvents={message.run_id && message.run_id === activeStreamRunId ? streamProgress : message.run_id ? runEventsById[message.run_id] ?? [] : message.id.startsWith('local-') ? streamProgress : []}
                    isLatestAssistant={message.id === latestAssistantMessageId}
                    onApprovalDecision={submitApprovalDecision}
                    onRetryRun={retryRun}
                    onRegeneratePart={regeneratePart}
                  />
                ))}
              </>
            ) : (
              <div className="ai-empty-prompt">
                <section className="ai-welcome-card">
                  <div className="ai-welcome-visual" aria-hidden="true">
                    <img src="/assets/bot_area.webp" alt="" />
                  </div>
                  <div className="ai-welcome-copy">
                    <strong>你好，我是你的 AI 厨房助手 👋</strong>
                    <span>我可以帮你根据现有食材推荐菜谱、安排晚餐、分析临期食材、生成采购清单。</span>
                  </div>
                </section>
                <div className="ai-welcome-suggestions" aria-label="快捷问题">
                  {AI_WELCOME_SUGGESTIONS.map((suggestion) => (
                    <button key={suggestion} type="button" onClick={() => setDraft(suggestion)}>
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="ai-composer-dock">
            {chatMutation.isError && <p className="form-error">{chatMutation.error.message}</p>}
            {retryMutation.isError && <p className="form-error">{retryMutation.error.message}</p>}
            {regenerateMutation.isError && <p className="form-error">{regenerateMutation.error.message}</p>}
            {isComposerPaused && <p className="ai-composer-pause-note">{composerPauseMessage}</p>}
            <form className="ai-composer" onSubmit={sendMessage}>
              <textarea
                className="text-input"
                rows={2}
                value={draft}
                placeholder={isComposerPaused ? composerPauseMessage ?? '等待你确认草稿...' : '输入你的问题，或让 AI 帮你安排一餐...'}
                disabled={isComposerPaused}
                onChange={(event) => setDraft(event.target.value)}
              />
              <div className="ai-composer-meta">
                <span>{draft.length}/2000</span>
                <button
                  className={`ai-send-button ${isAssistantBusy ? 'is-sending' : ''}`}
                  type={isAssistantBusy ? 'button' : 'submit'}
                  disabled={isAiUnavailable || (isComposerPaused && !activeCancellableRunId)}
                  aria-label={isAssistantBusy ? '中止生成' : '发送消息'}
                  onClick={isAssistantBusy ? cancelStreamingChat : undefined}
                >
                  {isAssistantBusy ? <span className="ai-stop-icon" aria-hidden="true" /> : '↗'}
                </button>
              </div>
            </form>
            <p className="ai-disclaimer">AI 可能会出错，请核对重要信息</p>
          </div>
        </section>
      </div>
    </main>
  );
}
