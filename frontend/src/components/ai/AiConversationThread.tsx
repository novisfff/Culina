import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { invalidateAfterAiApprovalSettled } from '../../api/cacheInvalidation';
import { api } from '../../api/client';
import type { AiApprovalRequest, AiGeneratedRecipeDraft, AiMessage, AiResultCard, Difficulty, UserSummary } from '../../api/types';
import { resolveAssetUrl } from '../../lib/assets';
import { avatarColor, initials } from '../../lib/ui';

function resolveAiAvatarUrl(url: string | null | undefined) {
  return resolveAssetUrl(url) ?? null;
}

function formatMessageTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
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
              <input className="text-input" value={(step.key_points ?? []).join('、')} disabled={readonly} placeholder="关键点，用顿号分隔" onChange={(event) => updateStep(index, { key_points: event.target.value.split(/[、,，]/).map((item) => item.trim()).filter(Boolean) })} />
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
          <input className="text-input" value={(recipe.scene_tags ?? []).join('、')} disabled={readonly} onChange={(event) => setRecipe({ ...recipe, scene_tags: event.target.value.split(/[、,，]/).map((item) => item.trim()).filter(Boolean) })} />
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

export function MessageBubble({ message, user, onApprovalSettled }: { message: AiMessage; user: UserSummary | null; onApprovalSettled: () => void }) {
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
