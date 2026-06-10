import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { invalidateAfterAiApprovalSettled } from '../../api/cacheInvalidation';
import { api } from '../../api/client';
import type { AiApprovalRequest, AiGeneratedRecipeDraft, AiMessage, AiResultCard, AiRunEvent, Difficulty, UserSummary } from '../../api/types';
import { resolveAssetUrl } from '../../lib/assets';
import { avatarColor, initials } from '../../lib/ui';

const MarkdownMessage = lazy(() => import('./MarkdownMessage'));

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

function isRecipeApproval(approval: AiApprovalRequest) {
  return approval.field_schema.some((field) => field.name === 'recipe' || field.widget === 'recipe_draft_editor');
}

function getApprovalDraft(approval: AiApprovalRequest): Record<string, unknown> {
  const value = approval.submitted_values.draft ?? approval.initial_values.draft ?? {};
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

function cloneDraftRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function getDraftType(approval: AiApprovalRequest, draft: Record<string, unknown>) {
  const explicit = typeof draft.draftType === 'string' ? draft.draftType : '';
  if (explicit) return explicit;
  if (approval.approval_type.startsWith('meal_plan.')) return 'meal_plan';
  if (approval.approval_type.startsWith('shopping_list.')) return 'shopping_list';
  if (approval.approval_type.startsWith('meal_log.')) return 'meal_log';
  if (approval.approval_type.startsWith('food_profile.')) return 'food_profile';
  return '';
}

function asDraftArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item)) : [];
}

function asText(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback = 1) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function joinTextList(value: unknown) {
  return Array.isArray(value) ? value.map(String).join('、') : '';
}

function splitTextList(value: string) {
  return value.split(/[、,，]/).map((item) => item.trim()).filter(Boolean);
}

function lastOf<T>(items: T[]) {
  return items.length > 0 ? items[items.length - 1] : undefined;
}

function formatRunEventTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function isActiveRunStatus(status: AiRunEvent['status']) {
  return status === 'pending' || status === 'running';
}

function runStatusText(status: AiRunEvent['status']) {
  if (status === 'failed') return '执行失败';
  if (status === 'completed') return '已完成';
  return '正在执行';
}

function runEventStatusText(event: AiRunEvent) {
  if (event.type === 'skill' && isActiveRunStatus(event.status)) return '开始执行';
  return runStatusText(event.status);
}

function extractSkillName(event: AiRunEvent | undefined) {
  if (!event) return '任务规划';
  const match = event.user_message.match(/「(.+?)」技能/);
  return match?.[1] ?? event.user_message;
}

const TOOL_REVEAL_INTERVAL_MS = 2000;

type ToolEventEntry = {
  key: string;
  event: AiRunEvent;
};

function runEventKey(event: AiRunEvent, index: number) {
  return event.id || `${event.internal_code}-${event.created_at}-${event.user_message}-${index}`;
}

function isDraftToolEvent(event: AiRunEvent) {
  return event.internal_code.includes('.create_draft') || event.user_message.startsWith('生成「');
}

function ToolEventIcon({ event }: { event: AiRunEvent }) {
  if (isDraftToolEvent(event)) {
    return (
      <svg className="ai-run-tool-icon icon-form" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="5" y="3.75" width="14" height="16.5" rx="3" />
        <path d="M8.25 8.25h7.5" />
        <path d="M8.25 12h7.5" />
        <path d="M8.25 15.75h4.75" />
      </svg>
    );
  }
  return (
    <svg className="ai-run-tool-icon icon-tool" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M15.9 2.9a5.15 5.15 0 0 0-5.1 6.05l-7.25 7.25a3.05 3.05 0 0 0 4.25 4.25l7.25-7.25A5.15 5.15 0 0 0 21.1 7.1l-3.35 3.35-4.2-4.2L16.9 2.9h-1Zm-9.75 16.3a1.35 1.35 0 1 0 0-2.7 1.35 1.35 0 0 0 0 2.7Z"
      />
    </svg>
  );
}

function ProgressEventIcon({ event }: { event: AiRunEvent }) {
  if (event.type === 'tool') {
    return <ToolEventIcon event={event} />;
  }
  return <span className="ai-run-detail-status-dot" aria-hidden="true" />;
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

  if (card.type === 'inventory_summary') {
    const items = Array.isArray(card.data.items) ? card.data.items : [];
    return (
      <article className="ai-result-card">
        <div className="inline-between">
          <h3>{card.title}</h3>
          <span className="subtle">
            可用 {String(card.data.availableCount ?? 0)} · 临期 {String(card.data.expiringCount ?? 0)}
          </span>
        </div>
        <div className="ai-evidence-row">
          {items.slice(0, 6).map((item, index) => {
            const value = item as { label?: string; quantity?: string; unit?: string; status?: string };
            return (
              <span key={`${value.label ?? 'item'}-${index}`} className="ai-evidence-pill">
                {value.label ?? '库存项'}
                {value.quantity ? ` · ${value.quantity}${value.unit ?? ''}` : ''}
              </span>
            );
          })}
        </div>
      </article>
    );
  }

  if (card.type === 'meal_plan_draft' || card.type === 'shopping_list_draft' || card.type === 'meal_log_draft' || card.type === 'food_profile_draft') {
    const items = Array.isArray(card.data.items) ? card.data.items : Array.isArray(card.data.foods) ? card.data.foods : [];
    return (
      <article className="ai-result-card">
        <div className="inline-between">
          <h3>{card.title}</h3>
          <span className="subtle">{String(card.data.summary ?? '')}</span>
        </div>
        <div className="ai-recommendation-list">
          {items.slice(0, 6).map((item, index) => {
            const value = item as { title?: string; name?: string; reason?: string; note?: string; date?: string; mealType?: string };
            return (
              <section key={`${value.title ?? value.name ?? 'draft'}-${index}`} className="ai-recommendation-item">
                <strong>{value.title ?? value.name ?? '草稿项'}</strong>
                <p>{value.reason ?? value.note ?? [value.date, value.mealType].filter(Boolean).join(' · ')}</p>
              </section>
            );
          })}
        </div>
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

function RunProgressTimeline({ events, isLive }: { events: AiRunEvent[]; isLive: boolean }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const sortedEvents = [...events].sort((left, right) => {
    const leftTime = new Date(left.created_at).getTime();
    const rightTime = new Date(right.created_at).getTime();
    return (Number.isNaN(leftTime) ? 0 : leftTime) - (Number.isNaN(rightTime) ? 0 : rightTime);
  });
  const skillEvents = sortedEvents.filter((event) => event.type === 'skill');
  const currentSkill = lastOf(skillEvents);
  const toolEvents = sortedEvents.filter((event) => event.type === 'tool');
  const toolEntries: ToolEventEntry[] = toolEvents.map((event, index) => ({ key: runEventKey(event, index), event }));
  const toolEntrySignature = toolEntries.map((entry) => entry.key).join('\u001f');
  const shouldQueueToolEvents = useRef(isLive);
  if (isLive) {
    shouldQueueToolEvents.current = true;
  }
  const [toolDisplay, setToolDisplay] = useState(() => ({
    visibleKeys: shouldQueueToolEvents.current ? [] : toolEntries.map((entry) => entry.key),
    queuedKeys: [] as string[],
    latestKey: null as string | null,
    revealVersion: 0,
    lastRevealAt: null as number | null,
  }));
  useEffect(() => {
    setToolDisplay((current) => {
      if (!shouldQueueToolEvents.current) {
        const visibleKeys = toolEntries.map((entry) => entry.key);
        const hasSameVisibleKeys = visibleKeys.length === current.visibleKeys.length && visibleKeys.every((key, index) => key === current.visibleKeys[index]);
        if (hasSameVisibleKeys && current.queuedKeys.length === 0) {
          return current;
        }
        return { ...current, visibleKeys, queuedKeys: [], latestKey: null };
      }
      const knownKeys = new Set(toolEntries.map((entry) => entry.key));
      const visibleKeys = current.visibleKeys.filter((key) => knownKeys.has(key));
      const queuedKeys = current.queuedKeys.filter((key) => knownKeys.has(key));
      const existingKeys = new Set([...visibleKeys, ...queuedKeys]);
      for (const entry of toolEntries) {
        if (!existingKeys.has(entry.key)) {
          queuedKeys.push(entry.key);
          existingKeys.add(entry.key);
        }
      }
      const latestKey = current.latestKey && knownKeys.has(current.latestKey) ? current.latestKey : null;
      if (
        visibleKeys.length === current.visibleKeys.length &&
        queuedKeys.length === current.queuedKeys.length &&
        latestKey === current.latestKey
      ) {
        return current;
      }
      return { ...current, visibleKeys, queuedKeys, latestKey };
    });
  }, [toolEntrySignature]);
  useEffect(() => {
    if (toolDisplay.queuedKeys.length === 0) return undefined;
    const elapsedMs = toolDisplay.lastRevealAt === null ? TOOL_REVEAL_INTERVAL_MS : Date.now() - toolDisplay.lastRevealAt;
    const waitMs = Math.max(0, TOOL_REVEAL_INTERVAL_MS - elapsedMs);
    const timer = window.setTimeout(() => {
      setToolDisplay((current) => {
        const [nextKey, ...queuedKeys] = current.queuedKeys;
        if (!nextKey) return current;
        return {
          visibleKeys: current.visibleKeys.includes(nextKey) ? current.visibleKeys : [...current.visibleKeys, nextKey],
          queuedKeys,
          latestKey: nextKey,
          revealVersion: current.revealVersion + 1,
          lastRevealAt: Date.now(),
        };
      });
    }, waitMs);
    return () => window.clearTimeout(timer);
  }, [toolDisplay.queuedKeys.length, toolDisplay.lastRevealAt]);
  if (events.length === 0) return null;
  const visibleToolKeys = new Set(toolDisplay.visibleKeys);
  const visibleToolEvents = toolEntries.filter((entry) => visibleToolKeys.has(entry.key)).reverse();
  const hasActiveEvent = Boolean(currentSkill && isActiveRunStatus(currentSkill.status)) || toolEvents.some((event) => isActiveRunStatus(event.status));
  const currentSkillName = extractSkillName(currentSkill);
  const currentStatus: AiRunEvent['status'] = hasActiveEvent ? 'running' : currentSkill?.status ?? 'completed';

  return (
    <section className={`ai-run-progress${isExpanded ? ' is-expanded' : ''}`} aria-label="AI 执行进度">
      <div className={`ai-run-progress-bar${toolEvents.length > 0 ? ' has-tools' : ''}`}>
        <div className={`ai-run-current-skill status-${currentStatus}${hasActiveEvent ? ' is-active' : ''}`}>
          <span className="ai-run-status-dot" aria-hidden="true" />
          <strong>{runStatusText(currentStatus)}</strong>
          <span title={currentSkillName}>{currentSkillName}</span>
        </div>
        {toolEvents.length > 0 && (
          <div className="ai-run-tool-marquee" aria-label="执行工具">
            <div className="ai-run-tool-track">
              {visibleToolEvents.map(({ event, key }) => {
                const movementClass =
                  key === toolDisplay.latestKey
                    ? ' is-newest'
                    : toolDisplay.latestKey
                      ? ` is-shifted shift-${toolDisplay.revealVersion % 2 === 0 ? 'even' : 'odd'}`
                      : '';
                return (
                  <span
                    key={key}
                    className={`ai-run-tool-chip ${isDraftToolEvent(event) ? 'kind-form' : 'kind-tool'} status-${event.status}${movementClass}`}
                    title={event.user_message}
                  >
                    <ToolEventIcon event={event} />
                    {event.user_message}
                  </span>
                );
              })}
            </div>
          </div>
        )}
        <button className={`ai-run-progress-toggle${isExpanded ? ' is-expanded' : ''}`} type="button" onClick={() => setIsExpanded((current) => !current)}>
          <span>{isExpanded ? '收起进度' : '查看详情'}</span>
          <span className="ai-run-toggle-chevron" aria-hidden="true" />
        </button>
      </div>
      {isExpanded && (
        <div className="ai-run-progress-detail">
          <div className="ai-run-progress-steps">
            {sortedEvents.map((event, index) => (
              <div key={event.id || `${event.internal_code}-${index}`} className={`ai-run-progress-step status-${event.status}`}>
                <ProgressEventIcon event={event} />
                <strong>{runEventStatusText(event)}</strong>
                <p title={event.user_message}>{event.user_message}</p>
                <time dateTime={event.created_at}>{formatRunEventTime(event.created_at)}</time>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

export function ApprovalPanel({ approval, onSettled }: { approval: AiApprovalRequest; onSettled: () => void }) {
  const [recipe, setRecipe] = useState<AiGeneratedRecipeDraft>(() => cloneRecipeDraft(getApprovalRecipe(approval)));
  const [structuredDraft, setStructuredDraft] = useState<Record<string, unknown>>(() => cloneDraftRecord(getApprovalDraft(approval)));
  const [draftJson, setDraftJson] = useState(() => JSON.stringify(getApprovalDraft(approval), null, 2));
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const decisionMutation = useMutation({
    mutationFn: (payload: { approval: AiApprovalRequest; decision: 'approved' | 'rejected'; values: Record<string, unknown> }) =>
      api.decideAiApproval(payload.approval.conversation_id, payload.approval.id, {
        decision: payload.decision,
        draft_version: payload.approval.draft_version,
        values: payload.values,
        comment,
      }),
    onSuccess: (response) => {
      if (isRecipeApproval(response.approval)) {
        setRecipe(cloneRecipeDraft((response.approval.submitted_values.recipe ?? response.draft.payload) as AiGeneratedRecipeDraft));
      } else {
        const nextDraft = cloneDraftRecord((response.approval.submitted_values.draft ?? response.draft.payload) as Record<string, unknown>);
        setStructuredDraft(nextDraft);
        setDraftJson(JSON.stringify(nextDraft, null, 2));
      }
      const operationStatus = typeof response.operation?.status === 'string' ? response.operation.status : '';
      const operationError = typeof response.operation?.error_message === 'string' ? response.operation.error_message : '';
      setError(operationStatus === 'failed' ? operationError || '业务写入失败，草稿已保留。' : null);
      invalidateAfterAiApprovalSettled(queryClient, response.approval.conversation_id);
      onSettled();
    },
    onError: (reason) => setError(reason instanceof Error ? reason.message : '提交失败'),
  });

  useEffect(() => {
    if (approval.status !== 'pending') {
      if (isRecipeApproval(approval)) {
        setRecipe(cloneRecipeDraft(getApprovalRecipe(approval)));
      } else {
        const nextDraft = cloneDraftRecord(getApprovalDraft(approval));
        setStructuredDraft(nextDraft);
        setDraftJson(JSON.stringify(nextDraft, null, 2));
      }
    }
  }, [approval]);

  const currentApproval = decisionMutation.data?.approval ?? approval;
  const readonly = currentApproval.status !== 'pending';
  const recipeApproval = isRecipeApproval(currentApproval);
  const draftType = getDraftType(currentApproval, structuredDraft);
  const usesStructuredDraftEditor = ['meal_plan', 'shopping_list', 'meal_log', 'food_profile'].includes(draftType);
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
  const submitDecision = (decision: 'approved' | 'rejected') => {
    setError(null);
    if (recipeApproval) {
      decisionMutation.mutate({ approval: currentApproval, decision, values: { recipe } });
      return;
    }
    if (usesStructuredDraftEditor) {
      decisionMutation.mutate({ approval: currentApproval, decision, values: { draft: structuredDraft } });
      return;
    }
    try {
      const draft = JSON.parse(draftJson) as Record<string, unknown>;
      decisionMutation.mutate({ approval: currentApproval, decision, values: { draft } });
    } catch {
      setError('草稿 JSON 格式不正确');
    }
  };

  const updateDraft = (patch: Record<string, unknown>) => {
    setStructuredDraft((current) => ({ ...current, ...patch }));
  };
  const updateDraftItem = (key: string, index: number, patch: Record<string, unknown>) => {
    setStructuredDraft((current) => {
      const items = asDraftArray(current[key]);
      return { ...current, [key]: items.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)) };
    });
  };
  const addDraftItem = (key: string, item: Record<string, unknown>) => {
    setStructuredDraft((current) => ({ ...current, [key]: [...asDraftArray(current[key]), item] }));
  };
  const removeDraftItem = (key: string, index: number) => {
    setStructuredDraft((current) => {
      const items = asDraftArray(current[key]);
      if (items.length <= 1) return current;
      return { ...current, [key]: items.filter((_, itemIndex) => itemIndex !== index) };
    });
  };

  const renderStructuredDraftEditor = () => {
    if (draftType === 'meal_plan') {
      const items = asDraftArray(structuredDraft.items);
      return (
        <div className="ai-recipe-editor ai-meal-plan-draft-editor">
          <div className="ai-draft-editor-head">
            <div>
              <strong>计划项</strong>
              <span>{items.length} 条</span>
            </div>
            {!readonly && (
              <button className="ghost-button ai-draft-add-button" type="button" onClick={() => addDraftItem('items', { date: new Date().toISOString().slice(0, 10), mealType: 'dinner', title: '', reason: '', missingIngredients: [] })}>
                添加计划
              </button>
            )}
          </div>
          {items.map((item, index) => (
            <div className="ai-step-row ai-meal-plan-item" key={`${asText(item.date)}-${asText(item.title)}-${index}`}>
              <div className="ai-editor-grid">
                <input className="text-input" type="date" value={asText(item.date)} disabled={readonly} onChange={(event) => updateDraftItem('items', index, { date: event.target.value })} />
                <select className="text-input" value={asText(item.mealType, 'dinner')} disabled={readonly} onChange={(event) => updateDraftItem('items', index, { mealType: event.target.value })}>
                  <option value="breakfast">早餐</option>
                  <option value="lunch">午餐</option>
                  <option value="dinner">晚餐</option>
                  <option value="snack">加餐</option>
                </select>
              </div>
              <input className="text-input" value={asText(item.title)} disabled={readonly} placeholder="食物或菜品名称" onChange={(event) => updateDraftItem('items', index, { title: event.target.value })} />
              <textarea className="text-input" rows={2} value={asText(item.reason)} disabled={readonly} placeholder="安排原因" onChange={(event) => updateDraftItem('items', index, { reason: event.target.value })} />
              <input className="text-input" value={joinTextList(item.missingIngredients)} disabled={readonly} placeholder="缺失食材，用顿号分隔" onChange={(event) => updateDraftItem('items', index, { missingIngredients: splitTextList(event.target.value) })} />
              {!readonly && items.length > 1 && (
                <button className="ghost-button ai-draft-remove-button" type="button" onClick={() => removeDraftItem('items', index)}>
                  删除计划项
                </button>
              )}
            </div>
          ))}
        </div>
      );
    }
    if (draftType === 'shopping_list') {
      const items = asDraftArray(structuredDraft.items);
      return (
        <div className="ai-recipe-editor">
          <div className="inline-between">
            <strong>采购项</strong>
            {!readonly && (
              <button className="ghost-button" type="button" onClick={() => addDraftItem('items', { title: '', quantity: 1, unit: '份', reason: '' })}>
                添加
              </button>
            )}
          </div>
          {items.map((item, index) => (
            <div className="ai-ingredient-row" key={`${asText(item.title)}-${index}`}>
              <input className="text-input" value={asText(item.title)} disabled={readonly} placeholder="采购项" onChange={(event) => updateDraftItem('items', index, { title: event.target.value })} />
              <input className="text-input" type="number" min={0.1} step={0.1} value={asNumber(item.quantity)} disabled={readonly} onChange={(event) => updateDraftItem('items', index, { quantity: Number(event.target.value) || 1 })} />
              <input className="text-input" value={asText(item.unit, '份')} disabled={readonly} placeholder="单位" onChange={(event) => updateDraftItem('items', index, { unit: event.target.value })} />
              <input className="text-input" value={asText(item.reason)} disabled={readonly} placeholder="原因" onChange={(event) => updateDraftItem('items', index, { reason: event.target.value })} />
              {!readonly && items.length > 1 && (
                <button className="ghost-button" type="button" onClick={() => removeDraftItem('items', index)}>
                  删除
                </button>
              )}
            </div>
          ))}
        </div>
      );
    }
    if (draftType === 'meal_log') {
      const foods = asDraftArray(structuredDraft.foods);
      return (
        <div className="ai-recipe-editor">
          <div className="ai-editor-grid">
            <label>
              日期
              <input className="text-input" type="date" value={asText(structuredDraft.date)} disabled={readonly} onChange={(event) => updateDraft({ date: event.target.value })} />
            </label>
            <label>
              餐别
              <select className="text-input" value={asText(structuredDraft.mealType, 'dinner')} disabled={readonly} onChange={(event) => updateDraft({ mealType: event.target.value })}>
                <option value="breakfast">早餐</option>
                <option value="lunch">午餐</option>
                <option value="dinner">晚餐</option>
                <option value="snack">加餐</option>
              </select>
            </label>
          </div>
          <div className="inline-between">
            <strong>食物项</strong>
            {!readonly && (
              <button className="ghost-button" type="button" onClick={() => addDraftItem('foods', { name: '', servings: 1, note: '' })}>
                添加
              </button>
            )}
          </div>
          {foods.map((food, index) => (
            <div className="ai-ingredient-row" key={`${asText(food.name)}-${index}`}>
              <input className="text-input" value={asText(food.name)} disabled={readonly} placeholder="食物" onChange={(event) => updateDraftItem('foods', index, { name: event.target.value })} />
              <input className="text-input" type="number" min={0.1} step={0.1} value={asNumber(food.servings)} disabled={readonly} onChange={(event) => updateDraftItem('foods', index, { servings: Number(event.target.value) || 1 })} />
              <input className="text-input" value={asText(food.note)} disabled={readonly} placeholder="备注" onChange={(event) => updateDraftItem('foods', index, { note: event.target.value })} />
              {!readonly && foods.length > 1 && (
                <button className="ghost-button" type="button" onClick={() => removeDraftItem('foods', index)}>
                  删除
                </button>
              )}
            </div>
          ))}
          <label>
            餐食备注
            <textarea className="text-input" rows={2} value={asText(structuredDraft.notes)} disabled={readonly} onChange={(event) => updateDraft({ notes: event.target.value })} />
          </label>
        </div>
      );
    }
    if (draftType === 'food_profile') {
      return (
        <div className="ai-recipe-editor">
          <label>
            食物名称
            <input className="text-input" value={asText(structuredDraft.name)} disabled={readonly} onChange={(event) => updateDraft({ name: event.target.value })} />
          </label>
          <div className="ai-editor-grid">
            <label>
              类型
              <select className="text-input" value={asText(structuredDraft.type, 'readyMade')} disabled={readonly} onChange={(event) => updateDraft({ type: event.target.value })}>
                <option value="readyMade">现成食物</option>
                <option value="selfMade">自制食物</option>
                <option value="instant">速食</option>
                <option value="packaged">包装食品</option>
                <option value="takeout">外卖</option>
                <option value="diningOut">外食</option>
              </select>
            </label>
            <label>
              分类
              <input className="text-input" value={asText(structuredDraft.category)} disabled={readonly} onChange={(event) => updateDraft({ category: event.target.value })} />
            </label>
          </div>
          <label>
            口味标签
            <input className="text-input" value={joinTextList(structuredDraft.flavor_tags)} disabled={readonly} onChange={(event) => updateDraft({ flavor_tags: splitTextList(event.target.value) })} />
          </label>
          <label>
            适合餐别
            <input className="text-input" value={joinTextList(structuredDraft.suitable_meal_types)} disabled={readonly} placeholder="breakfast、lunch、dinner" onChange={(event) => updateDraft({ suitable_meal_types: splitTextList(event.target.value) })} />
          </label>
          <label>
            来源
            <input className="text-input" value={asText(structuredDraft.source_name)} disabled={readonly} onChange={(event) => updateDraft({ source_name: event.target.value })} />
          </label>
          <label>
            备注
            <textarea className="text-input" rows={3} value={asText(structuredDraft.notes)} disabled={readonly} onChange={(event) => updateDraft({ notes: event.target.value })} />
          </label>
        </div>
      );
    }
    return null;
  };

  return (
    <section className="ai-approval-panel">
      <div className="ai-approval-head">
        <div>
          <h3>{currentApproval.title}</h3>
          <p>{currentApproval.instruction}</p>
        </div>
        <span className={`ai-approval-status status-${currentApproval.status}`}>{readonly ? currentApproval.status : '待确认'}</span>
      </div>
      {recipeApproval ? (
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
      ) : usesStructuredDraftEditor ? (
        renderStructuredDraftEditor()
      ) : (
        <div className="ai-recipe-editor">
          <label>
            草稿内容
            <textarea className="text-input" rows={12} value={draftJson} disabled={readonly} onChange={(event) => setDraftJson(event.target.value)} />
          </label>
          <label>
            备注
            <input className="text-input" value={comment} disabled={readonly} onChange={(event) => setComment(event.target.value)} />
          </label>
        </div>
      )}
      {error && <p className="form-error">{error}</p>}
      {!readonly && (
        <div className="ai-approval-actions">
          <button className="ghost-button" type="button" disabled={decisionMutation.isPending} onClick={() => submitDecision('rejected')}>
            {currentApproval.reject_label}
          </button>
          <button className="solid-button" type="button" disabled={decisionMutation.isPending} onClick={() => submitDecision('approved')}>
            {decisionMutation.isPending ? '提交中...' : currentApproval.approve_label}
          </button>
        </div>
      )}
    </section>
  );
}

export function MessageBubble({
  message,
  user,
  runEvents = [],
  isLatestAssistant = false,
  onApprovalSettled,
  onRetryRun,
  onRegeneratePart,
}: {
  message: AiMessage;
  user: UserSummary | null;
  runEvents?: AiRunEvent[];
  isLatestAssistant?: boolean;
  onApprovalSettled: () => void;
  onRetryRun?: (runId: string) => void;
  onRegeneratePart?: (messageId: string, partId: string) => void;
}) {
  const isUser = message.role === 'user';
  const userName = user?.display_name || user?.username || '我';
  const userAvatarUrl = resolveAiAvatarUrl(user?.avatar_image?.url);
  const messageTime = formatMessageTime(message.created_at);
  const hasRenderableParts = message.parts.some((part) => {
    if (part.type === 'text') return Boolean(part.text?.trim());
    return Boolean(part.card || part.approval || part.draft);
  });
  const isWaitingForAssistant = !isUser && message.status === 'running' && !hasRenderableParts && runEvents.length === 0;
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
          <img src="/assets/chatbot.webp" alt="" />
        )}
      </div>
      <div className="ai-message-content">
        <div className="ai-message-role">{isUser ? userName : 'AI 厨房助手'}</div>
        <div className="ai-message-body">
          {!isUser && <RunProgressTimeline events={runEvents} isLive={message.status === 'running'} />}
          {isWaitingForAssistant && (
            <div className="ai-thinking-cue" aria-live="polite">
              <span>正在整理回复</span>
              <i aria-hidden="true" />
              <i aria-hidden="true" />
              <i aria-hidden="true" />
            </div>
          )}
          {message.parts.map((part) => {
            if (part.type === 'text') {
              return (
                <Suspense key={part.id} fallback={<p>{part.text}</p>}>
                  <MarkdownMessage text={part.text ?? ''} />
                </Suspense>
              );
            }
            if ((part.type === 'result_card' || part.type === 'error_recovery') && part.card) {
              return (
                <div key={part.id} className="ai-message-part">
                  <ResultCard card={part.card} />
                  {part.type === 'result_card' && onRegeneratePart && (
                    <button className="ghost-button ai-part-action" type="button" onClick={() => onRegeneratePart(message.id, part.id)}>
                      局部重生成
                    </button>
                  )}
                </div>
              );
            }
            if (part.type === 'approval_request' && part.approval) {
              return <ApprovalPanel key={part.id} approval={part.approval} onSettled={onApprovalSettled} />;
            }
            return null;
          })}
          {!isUser && isLatestAssistant && message.run_id && (message.status === 'failed' || message.status === 'fallback') && onRetryRun && (
            <button className="ghost-button ai-retry-action" type="button" onClick={() => onRetryRun(message.run_id as string)}>
              重试这次任务
            </button>
          )}
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
