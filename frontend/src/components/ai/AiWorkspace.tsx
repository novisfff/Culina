import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { invalidateAfterAiMessageSent } from '../../api/cacheInvalidation';
import { api } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type { AiConversation, AiMessage, UserSummary } from '../../api/types';
import { EmptyState, WorkspaceModal } from '../ui-kit';
import { AiMobilePage, AI_WELCOME_SUGGESTIONS } from './AiMobilePage';
import { ApprovalPanel, MessageBubble } from './AiConversationThread';

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

export function AiWorkspace({ conversations, isLoading, currentUser = null, onBackHome }: AiWorkspaceProps) {
  const queryClient = useQueryClient();
  const [activeConversationId, setActiveConversationId] = useState<string | null>(conversations[0]?.id ?? null);
  const [isStartingNewConversation, setIsStartingNewConversation] = useState(false);
  const [draft, setDraft] = useState('');
  const [localMessages, setLocalMessages] = useState<AiMessage[]>([]);
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

  const approvalIdsInMessages = useMemo(() => {
    const ids = new Set<string>();
    for (const message of messages) {
      for (const part of message.parts) {
        if (part.approval) ids.add(part.approval.id);
      }
    }
    return ids;
  }, [messages]);

  const restoredPendingApprovals = (pendingApprovalsQuery.data ?? []).filter((approval) => !approvalIdsInMessages.has(approval.id));

  const chatMutation = useMutation({
    mutationFn: api.chatAi,
    onSuccess: (response) => {
      setActiveConversationId(response.conversation_id);
      setIsStartingNewConversation(false);
      setLocalMessages((items) => [...items.filter((item) => item.id !== response.message.id), response.message]);
      invalidateAfterAiMessageSent(queryClient, response.conversation_id);
    },
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
    const text = draft.trim();
    if (!text) return;
    const clientMessageId = `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
    setDraft('');
    await chatMutation.mutateAsync({
      message: text,
      conversation_id: activeConversationId ?? undefined,
      client_message_id: clientMessageId,
    });
  }

  return (
    <main className="ai-workspace-shell">
      <AiMobilePage
        conversations={conversations}
        isLoading={isLoading}
        activeConversationId={activeConversationId}
        isMobileHistoryOpen={isMobileHistoryOpen}
        currentUser={currentUser}
        messages={messages}
        restoredPendingApprovals={restoredPendingApprovals}
        draft={draft}
        isSending={chatMutation.isPending}
        sendError={chatMutation.isError ? chatMutation.error.message : undefined}
        onBackHome={onBackHome}
        onOpenMobileHistory={() => setIsMobileHistoryOpen(true)}
        onCloseMobileHistory={() => setIsMobileHistoryOpen(false)}
        onStartNewConversation={startNewConversation}
        onSelectConversation={selectConversation}
        onDraftChange={setDraft}
        onPickSuggestion={setDraft}
        onSubmit={sendMessage}
        onApprovalSettled={() => void messagesQuery.refetch()}
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
            ) : messages.length > 0 ? (
              <>
                {messages.map((message) => (
                  <MessageBubble key={message.id} message={message} user={currentUser} onApprovalSettled={() => void messagesQuery.refetch()} />
                ))}
              </>
            ) : restoredPendingApprovals.length > 0 ? (
              <section className="ai-pending-approval-restore">
                <strong>待处理确认</strong>
                {restoredPendingApprovals.map((approval) => (
                  <ApprovalPanel key={approval.id} approval={approval} onSettled={() => void pendingApprovalsQuery.refetch()} />
                ))}
              </section>
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
            {messages.length > 0 && restoredPendingApprovals.length > 0 && (
              <section className="ai-pending-approval-restore">
                <strong>待处理确认</strong>
                {restoredPendingApprovals.map((approval) => (
                  <ApprovalPanel key={approval.id} approval={approval} onSettled={() => void pendingApprovalsQuery.refetch()} />
                ))}
              </section>
            )}
          </div>
          <div className="ai-composer-dock">
            {chatMutation.isError && <p className="form-error">{chatMutation.error.message}</p>}
            <form className="ai-composer" onSubmit={sendMessage}>
              <textarea className="text-input" rows={2} value={draft} placeholder="输入你的问题，或让 AI 帮你安排一餐..." onChange={(event) => setDraft(event.target.value)} />
              <div className="ai-composer-meta">
                <span>{draft.length}/2000</span>
                <button className="ai-send-button" type="submit" disabled={chatMutation.isPending} aria-label="发送消息">
                  {chatMutation.isPending ? '...' : '↗'}
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
