import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { invalidateAfterAiApprovalSettled, invalidateAfterAiMessageSent } from '../../api/cacheInvalidation';
import { api } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type { AiApprovalRequest, AiConversation, AiGeneratedRecipeDraft, AiMessage, AiResultCard, Difficulty, UserSummary } from '../../api/types';
import { resolveAssetUrl } from '../../lib/assets';
import { avatarColor, initials } from '../../lib/ui';
import { EmptyState, WorkspaceModal } from '../ui-kit';

type AiWorkspaceProps = {
  conversations: AiConversation[];
  isLoading: boolean;
  currentUser?: UserSummary | null;
  onBackHome?: () => void;
};

const WELCOME_SUGGESTIONS = [
  '今晚用现有食材做什么？',
  '帮我安排三天晚餐',
  '快过期食材怎么处理？',
];

function resolveAiAvatarUrl(url: string | null | undefined) {
  return resolveAssetUrl(url) ?? null;
}

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

function formatMessageTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function ResultCard({ card }: { card: AiResultCard }) {
  if (card.type === 'today_recommendation') {
    const recommendations = card.data.recommendations ?? [];
    const context = card.data.contextSummary ?? {};
    return (
      <article className="ai-result-card">
        <div className="inline-between">
          <h3>{card.title}</h3>
          <span className="subtle">
            库存 {context.inventoryCount ?? 0} · 临期 {context.expiringCount ?? 0}
          </span>
        </div>
        <div className="ai-recommendation-list">
          {recommendations.map((item) => (
            <section key={item.title} className="ai-recommendation-item">
              <strong>{item.title}</strong>
              <p>{item.reason}</p>
              {item.evidence.length > 0 && (
                <div className="ai-evidence-row">
                  {item.evidence.map((evidence) => (
                    <span key={`${item.title}-${evidence.label}`} className="ai-evidence-pill">
                      {evidence.label}
                      {evidence.detail ? ` · ${evidence.detail}` : ''}
                    </span>
                  ))}
                </div>
              )}
            </section>
          ))}
        </div>
      </article>
    );
  }

  if (card.type === 'recipe_draft') {
    const draft = card.data.draft as AiGeneratedRecipeDraft | undefined;
    return (
      <article className="ai-result-card ai-recipe-draft-card">
        <div className="inline-between">
          <h3>{card.title}</h3>
          <span className="subtle">{String(card.data.summary ?? '')}</span>
        </div>
        {draft && (
          <div className="ai-recipe-draft-summary">
            <span>{draft.servings} 人份</span>
            <span>{draft.prep_minutes} 分钟</span>
            <span>{draft.difficulty}</span>
            <span>{draft.ingredient_items.length} 个食材</span>
            <span>{draft.steps.length} 个步骤</span>
          </div>
        )}
      </article>
    );
  }

  if (card.type === 'approval_request') {
    const statusText = typeof card.data.status === 'string' ? card.data.status : 'pending';
    const instruction = typeof card.data.instruction === 'string' ? card.data.instruction : '等待你确认后再执行写入。';
    return (
      <article className="ai-result-card ai-approval-card">
        <div className="inline-between">
          <h3>{card.title}</h3>
          <span className={`ai-approval-status status-${statusText}`}>{statusText}</span>
        </div>
        <p>{instruction}</p>
      </article>
    );
  }

  return (
    <article className="ai-result-card ai-error-card">
      <h3>{card.title}</h3>
      <p>{String(card.data.message ?? '请稍后重试。')}</p>
    </article>
  );
}

function cloneRecipeDraft(value: AiGeneratedRecipeDraft): AiGeneratedRecipeDraft {
  return JSON.parse(JSON.stringify(value)) as AiGeneratedRecipeDraft;
}

function blankRecipeDraft(): AiGeneratedRecipeDraft {
  return {
    title: '',
    servings: 2,
    prep_minutes: 20,
    difficulty: 'easy',
    ingredient_items: [{ ingredient_id: null, ingredient_name: '', quantity: 1, unit: '份', note: '' }],
    steps: [{ title: '备菜', text: '', icon: 'pan', summary: '', estimated_minutes: 5, tip: '', key_points: [] }],
    tips: '',
    scene_tags: [],
    media_ids: [],
  };
}

function getApprovalRecipe(approval: AiApprovalRequest): AiGeneratedRecipeDraft {
  return approval.submitted_values.recipe ?? approval.initial_values.recipe ?? blankRecipeDraft();
}

export function ApprovalPanel({ approval, onSettled }: { approval: AiApprovalRequest; onSettled: () => void }) {
  const [recipe, setRecipe] = useState<AiGeneratedRecipeDraft>(() => cloneRecipeDraft(getApprovalRecipe(approval)));
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const decisionMutation = useMutation({
    mutationFn: (payload: { decision: 'approved' | 'rejected' }) =>
      api.decideAiApproval(approval.conversation_id, approval.id, {
        decision: payload.decision,
        draft_version: approval.draft_version,
        values: { recipe },
        comment,
      }),
    onSuccess: (response) => {
      setRecipe(cloneRecipeDraft(response.approval.submitted_values.recipe ?? response.draft.payload));
      const operationStatus = typeof response.operation?.status === 'string' ? response.operation.status : '';
      const operationError = typeof response.operation?.error_message === 'string' ? response.operation.error_message : '';
      setError(operationStatus === 'failed' ? operationError || '业务写入失败，草稿已保留。' : null);
      invalidateAfterAiApprovalSettled(queryClient, approval.conversation_id);
      onSettled();
    },
    onError: (reason) => setError(reason instanceof Error ? reason.message : '提交失败'),
  });

  useEffect(() => {
    if (approval.status !== 'pending') {
      setRecipe(cloneRecipeDraft(getApprovalRecipe(approval)));
    }
  }, [approval]);

  const currentApproval = decisionMutation.data?.approval ?? approval;
  const readonly = currentApproval.status !== 'pending';
  const updateIngredient = (index: number, patch: Partial<AiGeneratedRecipeDraft['ingredient_items'][number]>) => {
    setRecipe((current) => ({
      ...current,
      ingredient_items: current.ingredient_items.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)),
    }));
  };
  const updateStep = (index: number, patch: Partial<AiGeneratedRecipeDraft['steps'][number]>) => {
    setRecipe((current) => ({
      ...current,
      steps: current.steps.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)),
    }));
  };

  return (
    <section className="ai-approval-panel">
      <div className="inline-between">
        <div>
          <h3>{currentApproval.title}</h3>
          <p>{currentApproval.instruction}</p>
        </div>
        <span className={`ai-approval-status status-${currentApproval.status}`}>{readonly ? currentApproval.status : '待确认'}</span>
      </div>
      <div className="ai-recipe-editor">
        <label>
          菜谱名
          <input className="text-input" value={recipe.title} disabled={readonly} onChange={(event) => setRecipe({ ...recipe, title: event.target.value })} />
        </label>
        <div className="ai-editor-grid">
          <label>
            份量
            <input className="text-input" type="number" min={1} value={recipe.servings} disabled={readonly} onChange={(event) => setRecipe({ ...recipe, servings: Number(event.target.value) || 1 })} />
          </label>
          <label>
            时间
            <input className="text-input" type="number" min={0} value={recipe.prep_minutes} disabled={readonly} onChange={(event) => setRecipe({ ...recipe, prep_minutes: Number(event.target.value) || 0 })} />
          </label>
          <label>
            难度
            <select className="text-input" value={recipe.difficulty} disabled={readonly} onChange={(event) => setRecipe({ ...recipe, difficulty: event.target.value as Difficulty })}>
              <option value="easy">easy</option>
              <option value="medium">medium</option>
              <option value="hard">hard</option>
            </select>
          </label>
        </div>
        <div className="ai-editor-section">
          <div className="inline-between">
            <strong>食材</strong>
            {!readonly && (
              <button className="ghost-button" type="button" onClick={() => setRecipe({ ...recipe, ingredient_items: [...recipe.ingredient_items, { ingredient_id: null, ingredient_name: '', quantity: 1, unit: '份', note: '' }] })}>
                添加
              </button>
            )}
          </div>
          {recipe.ingredient_items.map((item, index) => (
            <div className="ai-ingredient-row" key={`${item.ingredient_name}-${index}`}>
              <input className="text-input" value={item.ingredient_name} disabled={readonly} placeholder="食材" onChange={(event) => updateIngredient(index, { ingredient_name: event.target.value })} />
              <input className="text-input" type="number" min={0.1} step={0.1} value={item.quantity} disabled={readonly} onChange={(event) => updateIngredient(index, { quantity: Number(event.target.value) || 1 })} />
              <input className="text-input" value={item.unit} disabled={readonly} placeholder="单位" onChange={(event) => updateIngredient(index, { unit: event.target.value })} />
              <input className="text-input" value={item.note} disabled={readonly} placeholder="备注" onChange={(event) => updateIngredient(index, { note: event.target.value })} />
              {!readonly && recipe.ingredient_items.length > 1 && (
                <button className="ghost-button" type="button" onClick={() => setRecipe({ ...recipe, ingredient_items: recipe.ingredient_items.filter((_, itemIndex) => itemIndex !== index) })}>
                  删除
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="ai-editor-section">
          <div className="inline-between">
            <strong>步骤</strong>
            {!readonly && (
              <button className="ghost-button" type="button" onClick={() => setRecipe({ ...recipe, steps: [...recipe.steps, { title: `步骤 ${recipe.steps.length + 1}`, text: '', icon: 'pan', summary: '', estimated_minutes: 5, tip: '', key_points: [] }] })}>
                添加
              </button>
            )}
          </div>
          {recipe.steps.map((step, index) => (
            <div className="ai-step-row" key={`${step.title}-${index}`}>
              <input className="text-input" value={step.title} disabled={readonly} placeholder="标题" onChange={(event) => updateStep(index, { title: event.target.value })} />
              <div className="ai-editor-grid">
                <input className="text-input" value={step.summary ?? ''} disabled={readonly} placeholder="摘要" onChange={(event) => updateStep(index, { summary: event.target.value })} />
                <input className="text-input" type="number" min={1} value={step.estimated_minutes ?? ''} disabled={readonly} placeholder="分钟" onChange={(event) => updateStep(index, { estimated_minutes: Number(event.target.value) || null })} />
                <input className="text-input" value={step.icon ?? 'pan'} disabled={readonly} placeholder="图标" onChange={(event) => updateStep(index, { icon: event.target.value })} />
              </div>
              <textarea className="text-input" rows={3} value={step.text} disabled={readonly} placeholder="步骤说明" onChange={(event) => updateStep(index, { text: event.target.value })} />
              <input className="text-input" value={step.tip ?? ''} disabled={readonly} placeholder="小技巧" onChange={(event) => updateStep(index, { tip: event.target.value })} />
              <input
                className="text-input"
                value={(step.key_points ?? []).join('、')}
                disabled={readonly}
                placeholder="关键点，用顿号分隔"
                onChange={(event) => updateStep(index, { key_points: event.target.value.split(/[、,，]/).map((item) => item.trim()).filter(Boolean) })}
              />
              {!readonly && recipe.steps.length > 1 && (
                <button className="ghost-button" type="button" onClick={() => setRecipe({ ...recipe, steps: recipe.steps.filter((_, itemIndex) => itemIndex !== index) })}>
                  删除步骤
                </button>
              )}
            </div>
          ))}
        </div>
        <label>
          场景标签
          <input
            className="text-input"
            value={(recipe.scene_tags ?? []).join('、')}
            disabled={readonly}
            onChange={(event) => setRecipe({ ...recipe, scene_tags: event.target.value.split(/[、,，]/).map((item) => item.trim()).filter(Boolean) })}
          />
        </label>
        <label>
          小贴士
          <textarea className="text-input" rows={2} value={recipe.tips} disabled={readonly} onChange={(event) => setRecipe({ ...recipe, tips: event.target.value })} />
        </label>
        <label>
          备注
          <input className="text-input" value={comment} disabled={readonly} onChange={(event) => setComment(event.target.value)} />
        </label>
      </div>
      {error && <p className="form-error">{error}</p>}
      {!readonly && (
        <div className="ai-approval-actions">
          <button className="ghost-button" type="button" disabled={decisionMutation.isPending} onClick={() => decisionMutation.mutate({ decision: 'rejected' })}>
            {currentApproval.reject_label}
          </button>
          <button className="solid-button" type="button" disabled={decisionMutation.isPending} onClick={() => decisionMutation.mutate({ decision: 'approved' })}>
            {decisionMutation.isPending ? '提交中...' : currentApproval.approve_label}
          </button>
        </div>
      )}
    </section>
  );
}

function MessageBubble({ message, user, onApprovalSettled }: { message: AiMessage; user: UserSummary | null; onApprovalSettled: () => void }) {
  const isUser = message.role === 'user';
  const userName = user?.display_name || user?.username || '我';
  const userAvatarUrl = resolveAiAvatarUrl(user?.avatar_image?.url);
  const messageTime = formatMessageTime(message.created_at);
  return (
    <article className={`ai-message ai-message-${message.role}`}>
      <div className={isUser ? 'ai-message-avatar ai-message-avatar-user' : 'ai-message-avatar ai-message-avatar-assistant'} aria-hidden="true">
        {isUser ? (
          userAvatarUrl ? (
            <img className="ai-user-avatar-image" src={userAvatarUrl} alt="" />
          ) : (
            <span className="ai-user-avatar-fallback" style={{ backgroundColor: avatarColor(user?.avatar_seed || userName) }}>
              {initials(userName)}
            </span>
          )
        ) : (
          <img src="/assets/chatbot.png" alt="" />
        )}
      </div>
      <div className="ai-message-content">
        <div className="ai-message-role">{isUser ? userName : 'AI 厨房助手'}</div>
        <div className="ai-message-body">
          {message.parts.map((part) => {
            if (part.type === 'text') {
              return <p key={part.id}>{part.text}</p>;
            }
            if ((part.type === 'result_card' || part.type === 'error_recovery') && part.card) {
              return <ResultCard key={part.id} card={part.card} />;
            }
            if (part.type === 'approval_request' && part.approval) {
              return <ApprovalPanel key={part.id} approval={part.approval} onSettled={onApprovalSettled} />;
            }
            return null;
          })}
          {messageTime && (
            <span className="ai-message-time">
              {messageTime}
              {isUser && <span className="ai-message-sent-mark" aria-label="已发送">✓✓</span>}
            </span>
          )}
        </div>
      </div>
    </article>
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
      <aside className="ai-side-panel">
        <div className="ai-side-head">
          <div>
            <span>AI Workspace</span>
            <h2>历史记录</h2>
          </div>
          <button
            className="ai-new-chat"
            type="button"
            onClick={startNewConversation}
          >
            + 新会话
          </button>
        </div>
        <div className="ai-conversation-list">
          {isLoading ? (
            <p className="subtle">正在加载会话...</p>
          ) : conversations.length > 0 ? (
            conversations.map((conversation) => (
              <div
                key={conversation.id}
                className={`ai-conversation-item ${conversation.id === activeConversationId ? 'active' : ''}`}
              >
                <button
                  className="ai-conversation-main"
                  type="button"
                  onClick={() => selectConversation(conversation.id)}
                >
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
          <div
            className="workspace-overlay-backdrop"
            onClick={() => {
              if (!deleteConversationMutation.isPending) setPendingDeleteConversation(null);
            }}
          />
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
              <button
                className="ghost-button"
                type="button"
                disabled={deleteConversationMutation.isPending}
                onClick={() => setPendingDeleteConversation(null)}
              >
                取消
              </button>
              <button
                className="solid-button danger"
                type="button"
                disabled={deleteConversationMutation.isPending}
                onClick={confirmDeleteConversation}
              >
                {deleteConversationMutation.isPending ? '删除中...' : '确认删除'}
              </button>
            </div>
          </WorkspaceModal>
        </div>
      )}

      {isMobileHistoryOpen && (
        <div className="ai-mobile-history-root">
          <button
            className="ai-mobile-history-backdrop"
            type="button"
            aria-label="关闭历史记录"
            onClick={() => setIsMobileHistoryOpen(false)}
          />
          <aside className="ai-mobile-history-panel" aria-label="AI 历史记录">
            <div className="ai-mobile-history-head">
              <div>
                <span>历史记录</span>
                <strong>AI 厨房助手</strong>
              </div>
              <button className="ai-mobile-icon-button" type="button" aria-label="关闭" onClick={() => setIsMobileHistoryOpen(false)}>
                ×
              </button>
            </div>
            <button className="ai-mobile-new-chat" type="button" onClick={startNewConversation}>
              新会话
            </button>
            <div className="ai-mobile-conversation-list">
              {isLoading ? (
                <p className="subtle">正在加载会话...</p>
              ) : conversations.length > 0 ? (
                conversations.map((conversation) => (
                  <button
                    key={conversation.id}
                    className={conversation.id === activeConversationId ? 'ai-mobile-conversation active' : 'ai-mobile-conversation'}
                    type="button"
                    onClick={() => selectConversation(conversation.id)}
                  >
                    <strong>{conversation.title || conversation.prompt || 'AI 会话'}</strong>
                    <span>{conversation.summary || conversation.response || '等待继续对话'}</span>
                  </button>
                ))
              ) : (
                <EmptyState title="还没有会话" description="先发起一个问题。" />
              )}
            </div>
          </aside>
        </div>
      )}

      <section className="ai-main-panel">
        <div className="ai-mobile-topbar">
          <button className="ai-mobile-icon-button" type="button" aria-label="返回首页" onClick={onBackHome}>
            ‹
          </button>
          <div className="ai-mobile-title">
            <strong>AI 厨房助手</strong>
            <span><i aria-hidden="true" />在线 · 可随时帮你安排做饭</span>
          </div>
          <div className="ai-mobile-actions">
            <button className="ai-mobile-history-trigger" type="button" aria-label="打开历史记录" onClick={() => setIsMobileHistoryOpen(true)}>
              <span className="ai-mobile-menu-mark" aria-hidden="true" />
            </button>
            <button className="ai-mobile-new-session" type="button" aria-label="新会话" onClick={startNewConversation}>
              <span aria-hidden="true">⊕</span>
              新会话
            </button>
          </div>
        </div>
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
                  <img src="/assets/bot_area.png" alt="" />
                </div>
                <div className="ai-welcome-copy">
                  <strong>你好，我是你的 AI 厨房助手 👋</strong>
                  <span>我可以帮你根据现有食材推荐菜谱、安排晚餐、分析临期食材、生成采购清单。</span>
                </div>
              </section>
              <div className="ai-welcome-suggestions" aria-label="快捷问题">
                {WELCOME_SUGGESTIONS.map((suggestion) => (
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
            <textarea
              className="text-input"
              rows={2}
              value={draft}
              placeholder="输入你的问题，或让 AI 帮你安排一餐..."
              onChange={(event) => setDraft(event.target.value)}
            />
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
    </main>
  );
}
