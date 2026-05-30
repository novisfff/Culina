import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { AiApprovalRequest, AiConversation, AiGeneratedRecipeDraft, AiMessage, AiResultCard, AiRunEvent, Difficulty } from '../../api/types';
import { EmptyState, PageHeader, SectionHeading } from '../ui-kit';

type AiWorkspaceProps = {
  conversations: AiConversation[];
  isLoading: boolean;
};

const QUICK_TASKS = [
  { key: 'today_recommendation', label: '今日吃什么', prompt: '今日吃什么？尽量参考现有库存和最近餐食。' },
  { key: 'recipe_draft', label: '生成菜谱', prompt: '帮我生成一份番茄鸡蛋面的菜谱，2 人份。' },
  { key: 'fallback_chat', label: '快过期处理', prompt: '冰箱里快过期的东西能做什么？' },
  { key: 'fallback_chat', label: '三天菜单', prompt: '帮我安排未来三天晚餐。' },
];

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
      void queryClient.invalidateQueries({ queryKey: ['ai-messages', approval.conversation_id] });
      void queryClient.invalidateQueries({ queryKey: ['ai-pending-approvals', approval.conversation_id] });
      void queryClient.invalidateQueries({ queryKey: ['ai-conversations'] });
      void queryClient.invalidateQueries({ queryKey: ['recipes'] });
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

function MessageBubble({ message, onApprovalSettled }: { message: AiMessage; onApprovalSettled: () => void }) {
  return (
    <article className={`ai-message ai-message-${message.role}`}>
      <div className="ai-message-role">{message.role === 'user' ? '你' : 'AI 厨房助手'}</div>
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
      </div>
    </article>
  );
}

function RunProgressTimeline({ events }: { events: AiRunEvent[] }) {
  if (events.length === 0) return null;
  return (
    <div className="ai-run-timeline" aria-label="AI 运行进度">
      {events.map((event) => (
        <span key={event.id} className={`ai-run-event ai-run-event-${event.status}`}>
          {event.user_message}
        </span>
      ))}
    </div>
  );
}

export function AiWorkspace({ conversations, isLoading }: AiWorkspaceProps) {
  const queryClient = useQueryClient();
  const [activeConversationId, setActiveConversationId] = useState<string | null>(conversations[0]?.id ?? null);
  const [isStartingNewConversation, setIsStartingNewConversation] = useState(false);
  const [draft, setDraft] = useState('');
  const [localMessages, setLocalMessages] = useState<AiMessage[]>([]);
  const [lastEvents, setLastEvents] = useState<AiRunEvent[]>([]);

  useEffect(() => {
    if (!activeConversationId && !isStartingNewConversation && conversations[0]) {
      setActiveConversationId(conversations[0].id);
    }
  }, [activeConversationId, conversations, isStartingNewConversation]);

  const messagesQuery = useQuery({
    queryKey: ['ai-messages', activeConversationId],
    queryFn: () => api.getAiMessages(activeConversationId as string),
    enabled: Boolean(activeConversationId),
  });
  const pendingApprovalsQuery = useQuery({
    queryKey: ['ai-pending-approvals', activeConversationId],
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
      setLastEvents(response.events);
      void queryClient.invalidateQueries({ queryKey: ['ai-conversations'] });
      void queryClient.invalidateQueries({ queryKey: ['ai-messages', response.conversation_id] });
      void queryClient.invalidateQueries({ queryKey: ['ai-pending-approvals', response.conversation_id] });
    },
  });

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

  async function runQuickTask(task: (typeof QUICK_TASKS)[number]) {
    setDraft('');
    await chatMutation.mutateAsync({
      message: task.prompt,
      conversation_id: activeConversationId ?? undefined,
      quick_task: task.key,
    });
  }

  return (
    <main className="ai-workspace">
      <PageHeader
        variant="compact"
        eyebrow="AI 厨房助手"
        title="把库存、菜谱和餐食记录串起来"
        description="先从结构化建议开始，后续会接入草稿确认和安全写入。"
      />
      <div className="ai-workspace-grid">
        <aside className="ai-conversation-panel">
          <SectionHeading title="历史会话" description="最近的 AI 工作台记录" />
          <button
            className="ghost-button ai-new-chat"
            type="button"
            onClick={() => {
              setActiveConversationId(null);
              setIsStartingNewConversation(true);
              setLocalMessages([]);
              setLastEvents([]);
            }}
          >
            新会话
          </button>
          <div className="ai-conversation-list">
            {isLoading ? (
              <p className="subtle">正在加载会话...</p>
            ) : conversations.length > 0 ? (
              conversations.map((conversation) => (
                <button
                  key={conversation.id}
                  className={`ai-conversation-item ${conversation.id === activeConversationId ? 'active' : ''}`}
                  type="button"
                  onClick={() => {
                    setActiveConversationId(conversation.id);
                    setIsStartingNewConversation(false);
                    setLocalMessages([]);
                    setLastEvents([]);
                  }}
                >
                  <strong>{conversation.title || conversation.prompt || 'AI 会话'}</strong>
                  <span>{conversation.summary || conversation.response || '等待继续对话'}</span>
                </button>
              ))
            ) : (
              <EmptyState title="还没有会话" description="可以先点一个快捷任务。" />
            )}
          </div>
        </aside>

        <section className="ai-chat-panel">
          <div className="ai-shortcuts">
            {QUICK_TASKS.map((task) => (
              <button key={task.label} type="button" className="ghost-button" onClick={() => void runQuickTask(task)}>
                {task.label}
              </button>
            ))}
          </div>
          <RunProgressTimeline events={lastEvents} />
          <div className="ai-thread">
            {messagesQuery.isLoading && activeConversationId ? (
              <p className="subtle">正在加载消息...</p>
            ) : messages.length > 0 ? (
              <>
                {messages.map((message) => (
                  <MessageBubble key={message.id} message={message} onApprovalSettled={() => void messagesQuery.refetch()} />
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
              <EmptyState title="今天想解决什么厨房问题？" description="试试“今日吃什么”或直接描述你的目标。" />
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
          {chatMutation.isError && <p className="form-error">{chatMutation.error.message}</p>}
          <form className="ai-composer" onSubmit={sendMessage}>
            <textarea
              className="text-input"
              rows={2}
              value={draft}
              placeholder="例如：今晚用快过期食材做点什么？"
              onChange={(event) => setDraft(event.target.value)}
            />
            <button className="solid-button" type="submit" disabled={chatMutation.isPending}>
              {chatMutation.isPending ? '发送中...' : '发送'}
            </button>
          </form>
        </section>

        <aside className="ai-context-panel">
          <SectionHeading title="上下文摘要" description="本阶段展示轻量任务依据" />
          <div className="ai-context-summary">
            <span>会话状态：{activeConversationId ? '继续对话' : '新会话'}</span>
            <span>运行状态：{chatMutation.isPending ? '生成中' : '空闲'}</span>
            <span>已启用：今日推荐、兜底聊天</span>
          </div>
        </aside>
      </div>
    </main>
  );
}
