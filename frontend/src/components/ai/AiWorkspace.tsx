import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { invalidateAfterAiMessageSent } from '../../api/cacheInvalidation';
import { api } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type { AiApprovalRequest, AiChatResponse, AiConversation, AiMessage, AiRunEvent, UserSummary } from '../../api/types';
import { EmptyState, WorkspaceModal } from '../ui-kit';
import { AiMobilePage, AI_WELCOME_SUGGESTIONS } from './AiMobilePage';
import { MessageBubble } from './AiConversationThread';

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

export function AiWorkspace({ conversations, isLoading, currentUser = null, onBackHome }: AiWorkspaceProps) {
  const queryClient = useQueryClient();
  const [activeConversationId, setActiveConversationId] = useState<string | null>(conversations[0]?.id ?? null);
  const [isStartingNewConversation, setIsStartingNewConversation] = useState(false);
  const [draft, setDraft] = useState('');
  const [localMessages, setLocalMessages] = useState<AiMessage[]>([]);
  const [runEventsById, setRunEventsById] = useState<Record<string, AiRunEvent[]>>({});
  const [streamProgress, setStreamProgress] = useState<AiRunEvent[]>([]);
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
  const pendingApprovalsQuery = useQuery({
    queryKey: queryKeys.aiPendingApprovals(activeConversationId),
    queryFn: () => api.getPendingAiApprovals(activeConversationId as string),
    enabled: Boolean(activeConversationId),
  });

  const messages = useMemo(() => {
    const remote = messagesQuery.data ?? [];
    if (localMessages.length === 0) return remote;
    const knownIds = new Set(remote.map((item) => item.id));
    const knownClientIds = new Set(remote.map((item) => item.client_message_id).filter(Boolean));
    return [
      ...remote,
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

  function ensureStreamingAssistantMessage(runId: string) {
    const messageId = `local-assistant-${runId}`;
    setLocalMessages((items) => {
      if (items.some((item) => item.id === messageId || item.run_id === runId)) return items;
      return [
        ...items,
        {
          id: messageId,
          conversation_id: activeConversationId || 'pending',
          role: 'assistant',
          content: '',
          content_type: 'parts',
          parts: [],
          run_id: runId,
          status: 'running',
          metadata: {},
          created_at: new Date().toISOString(),
        },
      ];
    });
  }

  function applyChatResponse(response: AiChatResponse) {
    setActiveConversationId(response.conversation_id);
    setIsStartingNewConversation(false);
    setLocalMessages((items) => [
      ...items.filter((item) => item.id !== response.message.id && item.run_id !== response.run.id),
      response.message,
    ]);
    setRunEventsById((current) => ({ ...current, [response.run.id]: response.events }));
    setStreamProgress([]);
    invalidateAfterAiMessageSent(queryClient, response.conversation_id);
  }

  function applyStreamDelta(event: { message_id?: string; conversation_id?: string; run_id?: string; part_id?: string; delta: string }) {
    if (!event.delta) return;
    const runId = event.run_id || activeStreamRunId || 'pending';
    const messageId = event.message_id || `local-assistant-${runId}`;
    const partId = event.part_id || `local-part-${runId}`;
    setLocalMessages((items) => {
      const existingIndex = items.findIndex((item) => item.id === messageId || item.id === `local-assistant-${runId}` || item.run_id === runId);
      if (existingIndex === -1) {
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
        const nextText = `${textPart?.text ?? item.content ?? ''}${event.delta}`;
        return {
          ...item,
          id: messageId,
          conversation_id: event.conversation_id || item.conversation_id,
          content: nextText,
          parts: item.parts.some((part) => part.type === 'text')
            ? item.parts.map((part) => (part.type === 'text' ? { ...part, id: event.part_id || part.id, text: nextText } : part))
            : [{ id: partId, type: 'text', text: nextText }, ...item.parts],
        };
      });
    });
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
          setStreamProgress((items) => [...items, nextEvent]);
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
    if (hasPendingApproval || chatMutation.isPending) return;
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
    setLocalMessages((items) => [...items, tempMessage]);
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

  async function cancelStreamingChat() {
    const runId = activeStreamRunId;
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
    chatAbortRef.current?.abort();
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
        messages={displayedMessages}
        runEventsById={runEventsById}
        streamProgress={streamProgress}
        activeStreamRunId={activeStreamRunId}
        draft={draft}
        isSending={chatMutation.isPending}
        isComposerPaused={hasPendingApproval}
        sendError={chatMutation.isError ? chatMutation.error.message : undefined}
        onBackHome={onBackHome}
        onOpenMobileHistory={() => setIsMobileHistoryOpen(true)}
        onCloseMobileHistory={() => setIsMobileHistoryOpen(false)}
        onStartNewConversation={startNewConversation}
        onSelectConversation={selectConversation}
        onDraftChange={setDraft}
        onPickSuggestion={setDraft}
        onSubmit={sendMessage}
        onApprovalSettled={() => void refreshAfterApprovalSettled()}
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
              <span className="ai-ready-pill"><span />AI 已就绪</span>
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
                    runEvents={message.run_id && message.run_id === activeStreamRunId ? streamProgress : message.run_id ? runEventsById[message.run_id] ?? [] : message.id.startsWith('local-') ? streamProgress : []}
                    isLatestAssistant={message.id === latestAssistantMessageId}
                    onApprovalSettled={() => void refreshAfterApprovalSettled()}
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
            {hasPendingApproval && <p className="ai-composer-pause-note">请先确认上面的草稿，确认后可以继续对话。</p>}
            <form className="ai-composer" onSubmit={sendMessage}>
              <textarea
                className="text-input"
                rows={2}
                value={draft}
                placeholder={hasPendingApproval ? '等待你确认草稿...' : '输入你的问题，或让 AI 帮你安排一餐...'}
                disabled={hasPendingApproval}
                onChange={(event) => setDraft(event.target.value)}
              />
              <div className="ai-composer-meta">
                <span>{draft.length}/2000</span>
                <button
                  className={`ai-send-button ${chatMutation.isPending ? 'is-sending' : ''}`}
                  type={chatMutation.isPending ? 'button' : 'submit'}
                  disabled={hasPendingApproval}
                  aria-label={chatMutation.isPending ? '中止生成' : '发送消息'}
                  onClick={chatMutation.isPending ? cancelStreamingChat : undefined}
                >
                  {chatMutation.isPending ? <span className="ai-stop-icon" aria-hidden="true" /> : '↗'}
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
