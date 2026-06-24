import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AiApprovalRequest, AiGeneratedRecipeDraft, Difficulty, Food, Ingredient } from '../../api/types';
import { FoodRatingInput } from '../foods/FoodWorkspacePrimitives';
import { resolveAssetUrl } from '../../lib/assets';
import { RECIPE_STEP_ICON_OPTIONS } from '../recipes/RecipeWorkspaceOptions';
import {
  ApprovalMultiSelectField,
  ApprovalSelectField,
  IngredientQuantityPicker,
  ResourceSelectIcon,
  SearchableResourceSelect,
  normalizeMealPlanIngredientItems,
} from './AiApprovalFields';
import type { AiResourceKind, AiResourceOption, AiResourceOptionLoader } from './AiApprovalFields';
import { AiCompositeOperationPreview } from './AiCompositeOperationPreview';
import { AiInventoryOperationEditor } from './AiInventoryOperationEditor';

export type { AiResourceOptionLoader } from './AiApprovalFields';

const MEAL_TYPE_OPTIONS = [
  { value: 'breakfast', label: '早餐' },
  { value: 'lunch', label: '午餐' },
  { value: 'dinner', label: '晚餐' },
  { value: 'snack', label: '加餐' },
];
const DIFFICULTY_OPTIONS = [
  { value: 'easy', label: '简单' },
  { value: 'medium', label: '适中' },
  { value: 'hard', label: '较难' },
];
const FOOD_TYPE_OPTIONS = [
  { value: 'selfMade', label: '家常菜' },
  { value: 'takeout', label: '外卖' },
  { value: 'diningOut', label: '外食' },
  { value: 'readyMade', label: '成品' },
  { value: 'instant', label: '速食' },
  { value: 'packaged', label: '包装食品' },
];
const INVENTORY_ACTION_OPTIONS = [
  { value: 'restock', label: '补货' },
  { value: 'consume', label: '消耗' },
  { value: 'dispose', label: '销毁' },
];

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
  if (approval.approval_type.startsWith('composite_operation.')) return 'composite_operation';
  if (approval.approval_type.startsWith('meal_plan.')) return 'meal_plan';
  if (approval.approval_type.startsWith('shopping_list.')) return 'shopping_list';
  if (approval.approval_type.startsWith('meal_log.')) return 'meal_log';
  if (approval.approval_type.startsWith('food_profile.')) return 'food_profile';
  if (approval.approval_type.startsWith('ingredient.')) return 'ingredient_profile';
  if (approval.approval_type.startsWith('inventory.')) return 'inventory_operation';
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

function normalizeSearchText(value: string) {
  return value.trim().toLowerCase();
}

function foodTypeText(value: unknown) {
  switch (value) {
    case 'readyMade':
      return '现成食物';
    case 'selfMade':
      return '自制食物';
    case 'instant':
      return '速食';
    case 'packaged':
      return '包装食品';
    case 'takeout':
      return '外卖';
    case 'diningOut':
      return '外食';
    default:
      return typeof value === 'string' ? value : '';
  }
}

function mealTypeLabel(value: unknown) {
  const text = asText(value);
  const normalized = text.replace(/^MealType\./i, '').toLowerCase();
  return MEAL_TYPE_OPTIONS.find((option) => option.value === normalized)?.label ?? text;
}

function formatServingCount(value: unknown) {
  const numeric = asNumber(value, 0);
  return Number.isInteger(numeric) ? String(numeric) : String(Number(numeric.toFixed(1)));
}

function ratingInputValue(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return asText(value);
}

function ratingDisplayText(value: unknown) {
  const rating = typeof value === 'number' && Number.isFinite(value) ? value : Number(asText(value));
  if (!Number.isFinite(rating) || rating <= 0) return '未评分';
  return `${rating.toFixed(1).replace(/\.0$/, '')} 分`;
}

function countLabel(value: unknown, unit: string) {
  const count = Array.isArray(value) ? value.length : 0;
  return count > 0 ? `${count} ${unit}` : '无';
}

export function approvalStatusText(value: unknown) {
  switch (value) {
    case 'pending':
      return '待确认';
    case 'approved':
      return '已确认';
    case 'rejected':
      return '已拒绝';
    case 'expired':
      return '已过期';
    default:
      return typeof value === 'string' ? value : '待确认';
  }
}

interface AiApprovalFailureItem {
  operationId: string;
  action: string;
  targetId: string;
  summary: string;
  currentValue: {
    id: string;
    label: string;
    summary: string;
    payload?: Record<string, unknown> | null;
  } | null;
  recoveryHint: string;
}

interface AiApprovalFailureSummary {
  errorMessage: string;
  failedOperationIds: string[];
  failedOperationSummaries: AiApprovalFailureItem[];
  hasConflictHint: boolean;
}

function getApprovalFailureSummary(approval: AiApprovalRequest): AiApprovalFailureSummary | null {
  const value = approval.failure_summary;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const errorMessage = asText(value.errorMessage);
  const failedOperationIds = Array.isArray(value.failedOperationIds)
    ? value.failedOperationIds.map((item) => asText(item)).filter(Boolean)
    : [];
  const failedOperationSummaries = Array.isArray(value.failedOperationSummaries)
    ? value.failedOperationSummaries
        .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item))
        .map((item) => ({
          operationId: asText(item.operationId),
          action: asText(item.action),
          targetId: asText(item.targetId),
          summary: asText(item.summary),
          currentValue:
            typeof item.currentValue === 'object' && item.currentValue !== null && !Array.isArray(item.currentValue)
              ? {
                  id: asText((item.currentValue as Record<string, unknown>).id),
                  label: asText((item.currentValue as Record<string, unknown>).label),
                  summary: asText((item.currentValue as Record<string, unknown>).summary),
                  payload:
                    typeof (item.currentValue as Record<string, unknown>).payload === 'object'
                    && (item.currentValue as Record<string, unknown>).payload !== null
                    && !Array.isArray((item.currentValue as Record<string, unknown>).payload)
                      ? (item.currentValue as Record<string, unknown>).payload as Record<string, unknown>
                      : null,
                }
              : null,
          recoveryHint: asText(item.recoveryHint),
        }))
    : [];
  if (!errorMessage && failedOperationIds.length === 0 && failedOperationSummaries.length === 0) return null;
  return {
    errorMessage,
    failedOperationIds,
    failedOperationSummaries,
    hasConflictHint: /版本|冲突|基线/.test(errorMessage),
  };
}

export type AiApprovalDecisionSubmit = (
  approval: AiApprovalRequest,
  decision: 'approved' | 'rejected',
  values: Record<string, unknown>,
  comment?: string,
) => Promise<void> | void;

export function ApprovalPanel({
  approval,
  foods = [],
  ingredients = [],
  resourceOptionLoader,
  onDecision,
  isLatest = true,
  canSubmit = true,
  submitDisabledReason,
}: {
  approval: AiApprovalRequest;
  foods?: Food[];
  ingredients?: Ingredient[];
  resourceOptionLoader?: AiResourceOptionLoader;
  onDecision: AiApprovalDecisionSubmit;
  isLatest?: boolean;
  canSubmit?: boolean;
  submitDisabledReason?: string;
}) {
  const [recipe, setRecipe] = useState<AiGeneratedRecipeDraft>(() => cloneRecipeDraft(getApprovalRecipe(approval)));
  const [structuredDraft, setStructuredDraft] = useState<Record<string, unknown>>(() => cloneDraftRecord(getApprovalDraft(approval)));
  const [draftJson, setDraftJson] = useState(() => JSON.stringify(getApprovalDraft(approval), null, 2));
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [loadedResourceOptions, setLoadedResourceOptions] = useState<Record<AiResourceKind, AiResourceOption[]>>({
    food: [],
    ingredient: [],
  });

  const [isExpanded, setIsExpanded] = useState(isLatest);

  useEffect(() => {
    setIsExpanded(isLatest);
  }, [isLatest]);

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

  const currentApproval = approval;
  const pendingButLocked = currentApproval.status === 'pending' && !canSubmit;
  const readonly = currentApproval.status !== 'pending' || pendingButLocked;
  const recipeApproval = isRecipeApproval(currentApproval);
  const failureSummary = getApprovalFailureSummary(currentApproval);
  const draftType = getDraftType(currentApproval, structuredDraft);
  const usesStructuredDraftEditor = ['recipe', 'recipe_cook', 'meal_plan', 'shopping_list', 'meal_log', 'food_profile', 'ingredient_profile', 'inventory_operation', 'composite_operation'].includes(draftType);
  const staticFoodOptions = useMemo<AiResourceOption[]>(() => foods.map((food) => ({
    id: food.id,
    label: food.name,
    description: [food.category, foodTypeText(food.type)].filter(Boolean).join(' · '),
    imageUrl: resolveAssetUrl(food.images?.[0]?.url),
  })), [foods]);
  const staticIngredientOptions = useMemo<AiResourceOption[]>(() => ingredients.map((ingredient) => ({
    id: ingredient.id,
    label: ingredient.name,
    description: [ingredient.category, ingredient.default_unit].filter(Boolean).join(' · '),
    imageUrl: resolveAssetUrl(ingredient.image?.url),
    unit: ingredient.default_unit,
  })), [ingredients]);
  const foodOptions = useMemo(
    () => Array.from(new Map([...staticFoodOptions, ...loadedResourceOptions.food].map((option) => [option.id, option])).values()),
    [staticFoodOptions, loadedResourceOptions.food],
  );
  const ingredientOptions = useMemo(
    () => Array.from(new Map([...staticIngredientOptions, ...loadedResourceOptions.ingredient].map((option) => [option.id, option])).values()),
    [staticIngredientOptions, loadedResourceOptions.ingredient],
  );
  const loadApprovalResourceOptions = useCallback<AiResourceOptionLoader>(async (kind, params) => {
    const staticOptions = kind === 'food' ? staticFoodOptions : staticIngredientOptions;
    const normalizedQuery = normalizeSearchText(params.query);
    const nextOptions = resourceOptionLoader
      ? await resourceOptionLoader(kind, params)
      : staticOptions
          .filter((option) => !normalizedQuery || normalizeSearchText(`${option.label} ${option.description ?? ''}`).includes(normalizedQuery))
          .slice(params.offset, params.offset + params.limit);
    setLoadedResourceOptions((current) => {
      const merged = new Map(current[kind].map((option) => [option.id, option]));
      nextOptions.forEach((option) => merged.set(option.id, option));
      return { ...current, [kind]: Array.from(merged.values()) };
    });
    return nextOptions;
  }, [resourceOptionLoader, staticFoodOptions, staticIngredientOptions]);
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
  const submitDecision = async (decision: 'approved' | 'rejected') => {
    if (isSubmitting) return;
    setError(null);
    if (pendingButLocked) {
      if (submitDisabledReason) {
        setError(submitDisabledReason);
      }
      return;
    }
    const isRejecting = decision === 'rejected';
    let values: Record<string, unknown>;
    if (isRejecting) {
      values = {};
    } else if (recipeApproval) {
      values = { recipe };
    } else if (usesStructuredDraftEditor) {
      if (draftType === 'inventory_operation') {
        const invalidDispose = asDraftArray(structuredDraft.operations).find(
          (item) => asText(item.action) === 'dispose' && !asText(item.reason).trim(),
        );
        if (invalidDispose) {
          setError('销毁库存必须填写原因');
          return;
        }
      }
      values = { draft: structuredDraft };
    } else {
      try {
        const draft = JSON.parse(draftJson) as Record<string, unknown>;
        values = { draft };
      } catch {
        setError('草稿 JSON 格式不正确');
        return;
      }
    }
    try {
      setIsSubmitting(true);
      await onDecision(currentApproval, decision, values, comment);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '提交失败');
    } finally {
      setIsSubmitting(false);
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
  const updateOperationPayloadItem = (index: number, patch: Record<string, unknown>) => {
    setStructuredDraft((current) => {
      const items = asDraftArray(current.operations);
      return {
        ...current,
        operations: items.map((item, itemIndex) => (
          itemIndex === index
            ? { ...item, payload: { ...(typeof item.payload === 'object' && item.payload !== null && !Array.isArray(item.payload) ? item.payload as Record<string, unknown> : {}), ...patch } }
            : item
        )),
      };
    });
  };
  const renderStructuredDraftEditor = () => {
    if (draftType === 'composite_operation') {
      return <AiCompositeOperationPreview draft={structuredDraft} />;
    }
    if (draftType === 'recipe') {
      const action = asText(structuredDraft.action);
      const payload = typeof structuredDraft.payload === 'object' && structuredDraft.payload !== null && !Array.isArray(structuredDraft.payload)
        ? structuredDraft.payload as Record<string, unknown>
        : {};
      const before = typeof structuredDraft.before === 'object' && structuredDraft.before !== null && !Array.isArray(structuredDraft.before)
        ? structuredDraft.before as Record<string, unknown>
        : {};
      const actionLabel = action === 'update' ? '修改' : action === 'delete' ? '删除' : action === 'set_favorite' ? '收藏' : '创建';
      return (
        <div className="ai-recipe-editor ai-confirmation-editor ai-recipe-draft-editor">
          <div className="ai-draft-editor-head">
            <div>
              <strong>{actionLabel}菜谱</strong>
              <span>{asText(before.title) || asText(payload.title) || '菜谱'}</span>
            </div>
          </div>
          {action !== 'create' && (
            <p className="ai-approval-compare-copy">
              当前：{[asText(before.title), `${asNumber(before.servings)}人份`, asText(before.difficulty)].filter(Boolean).join(' · ')}
            </p>
          )}
          {action === 'delete' ? (
            <div className="ai-confirmation-item">
              <label className="ai-resource-field ai-confirmation-copy-field">
                <span>删除原因</span>
                <textarea className="text-input" rows={2} value={asText(payload.reason)} disabled={readonly} placeholder="可选，说明删除原因" onChange={(event) => updateDraft({ payload: { ...payload, reason: event.target.value } })} />
              </label>
              <div className="ai-confirmation-summary-card">
                <strong>删除影响</strong>
                <p>同步食物：{asNumber((before.deleteImpact as Record<string, unknown> | undefined)?.linkedFoodCount)} 个</p>
                <p>关联计划：{asNumber((before.deleteImpact as Record<string, unknown> | undefined)?.planItemCount)} 条</p>
                <p>历史烹饪：{asNumber((before.deleteImpact as Record<string, unknown> | undefined)?.cookLogCount)} 条</p>
              </div>
            </div>
          ) : action === 'set_favorite' ? (
            <div className="ai-confirmation-item">
              <ApprovalSelectField
                label="收藏状态"
                value={String(Boolean(payload.favorite))}
                disabled={readonly}
                options={[
                  { value: 'true', label: '加入收藏' },
                  { value: 'false', label: '移出收藏' },
                ]}
                icon="type"
                onChange={(favorite) => updateDraft({ payload: { ...payload, favorite: favorite === 'true' } })}
              />
            </div>
          ) : (
            <div className="ai-confirmation-item">
              <label className="ai-resource-field">
                <span>菜谱名</span>
                <input className="text-input" value={asText(payload.title)} disabled={readonly} onChange={(event) => updateDraft({ payload: { ...payload, title: event.target.value } })} />
              </label>
              <div className="ai-confirmation-grid ai-confirmation-grid-three">
                <label className="ai-resource-field">
                  <span>份量</span>
                  <input className="text-input" type="number" min={1} value={asNumber(payload.servings)} disabled={readonly} onChange={(event) => updateDraft({ payload: { ...payload, servings: Number(event.target.value) || 1 } })} />
                </label>
                <label className="ai-resource-field">
                  <span>时间（分钟）</span>
                  <input className="text-input" type="number" min={0} value={asNumber(payload.prep_minutes)} disabled={readonly} onChange={(event) => updateDraft({ payload: { ...payload, prep_minutes: Number(event.target.value) || 0 } })} />
                </label>
                <ApprovalSelectField
                  label="难度"
                  value={asText(payload.difficulty, 'easy')}
                  disabled={readonly}
                  options={DIFFICULTY_OPTIONS}
                  icon="difficulty"
                  onChange={(difficulty) => updateDraft({ payload: { ...payload, difficulty } })}
                />
              </div>
              <label className="ai-resource-field ai-confirmation-copy-field">
                <span>小贴士</span>
                <textarea className="text-input" rows={2} value={asText(payload.tips)} disabled={readonly} placeholder="补充火候、替换食材等提示" onChange={(event) => updateDraft({ payload: { ...payload, tips: event.target.value } })} />
              </label>
            </div>
          )}
        </div>
      );
    }
    if (draftType === 'inventory_operation') {
      return (
        <AiInventoryOperationEditor
          draft={structuredDraft}
          readonly={readonly}
          onUpdateItem={(index, patch) => updateDraftItem('operations', index, patch)}
          onRemoveItem={(index) => removeDraftItem('operations', index)}
        />
      );
    }
    if (draftType === 'meal_plan') {
      const operations = asDraftArray(structuredDraft.operations);
      if (operations.length > 0) {
        return (
          <div className="ai-recipe-editor ai-confirmation-editor ai-meal-plan-draft-editor">
            <div className="ai-draft-editor-head">
              <div>
                <strong>计划变更</strong>
                <span>{operations.length} 条</span>
              </div>
            </div>
            {operations.map((operation, index) => {
              const action = asText(operation.action);
              const payload = typeof operation.payload === 'object' && operation.payload !== null && !Array.isArray(operation.payload)
                ? operation.payload as Record<string, unknown>
                : {};
              const before = typeof operation.before === 'object' && operation.before !== null && !Array.isArray(operation.before)
                ? operation.before as Record<string, unknown>
                : {};
              const actionLabel = action === 'create' ? '新增' : action === 'update' ? '修改' : action === 'set_status' ? '状态变更' : '删除';
              return (
                <div className="ai-confirmation-item ai-meal-plan-item" key={`${action}-${asText(operation.targetId)}-${index}`}>
                  <div className="ai-draft-editor-head">
                    <div>
                      <strong>{actionLabel}计划项</strong>
                      <span>{action === 'create' ? '新计划' : asText(before.title) || asText(before.foodId) || asText(operation.targetId)}</span>
                    </div>
                  </div>
                  {action !== 'create' && (
                    <p className="ai-approval-compare-copy">
                      当前：{[asText(before.date), mealTypeLabel(before.mealType), asText(before.title)].filter(Boolean).join(' · ')}
                    </p>
                  )}
                  {action === 'set_status' ? (
                    <>
                      <p className="ai-approval-compare-copy">
                        当前状态：{asText(before.status) || 'planned'}
                      </p>
                      <ApprovalSelectField
                        label="计划状态"
                        value={asText(payload.status, 'planned')}
                        disabled={readonly}
                        options={[
                          { value: 'planned', label: '计划中' },
                          { value: 'cooked', label: '已完成' },
                          { value: 'skipped', label: '已跳过' },
                        ]}
                        icon="meal"
                        onChange={(status) => updateOperationPayloadItem(index, { status })}
                      />
                      <label className="ai-resource-field ai-meal-plan-reason-field">
                        <span>状态说明</span>
                        <textarea className="text-input" rows={2} value={asText(payload.reason)} disabled={readonly} placeholder="可选，说明完成或跳过原因" onChange={(event) => updateOperationPayloadItem(index, { reason: event.target.value })} />
                      </label>
                    </>
                  ) : action !== 'delete' ? (
                    <>
                      <div className="ai-meal-plan-item-top">
                        <label className="ai-resource-field ai-resource-field-date">
                          <span>日期</span>
                          <div className="ai-resource-select">
                            <ResourceSelectIcon kind="calendar" />
                            <input type="date" value={asText(payload.date)} disabled={readonly} onChange={(event) => updateOperationPayloadItem(index, { date: event.target.value })} />
                          </div>
                        </label>
                        <label className="ai-resource-field ai-resource-field-meal">
                          <span>餐别</span>
                          <div className="ai-resource-select">
                            <ResourceSelectIcon kind="meal" />
                            <select value={asText(payload.mealType, 'dinner')} disabled={readonly} onChange={(event) => updateOperationPayloadItem(index, { mealType: event.target.value })}>
                              <option value="breakfast">早餐</option>
                              <option value="lunch">午餐</option>
                              <option value="dinner">晚餐</option>
                              <option value="snack">加餐</option>
                            </select>
                            <span className="ai-resource-select-chevron" aria-hidden="true" />
                          </div>
                        </label>
                      </div>
                      <SearchableResourceSelect
                        kind="food"
                        label="食物"
                        value={asText(payload.foodId) || asText(payload.food_id)}
                        selectedLabel={asText(payload.title)}
                        placeholder="搜索食物库"
                        disabled={readonly}
                        selectedOption={foodOptions.find((option) => option.id === (asText(payload.foodId) || asText(payload.food_id))) ?? null}
                        loadOptions={loadApprovalResourceOptions}
                        onSelect={(option) => updateOperationPayloadItem(index, { foodId: option.id, food_id: option.id, title: option.label })}
                      />
                      <label className="ai-resource-field ai-meal-plan-reason-field">
                        <span>安排原因</span>
                        <textarea className="text-input" rows={2} value={asText(payload.reason)} disabled={readonly} placeholder="安排原因" onChange={(event) => updateOperationPayloadItem(index, { reason: event.target.value })} />
                      </label>
                    </>
                  ) : (
                    <label className="ai-resource-field ai-meal-plan-reason-field">
                      <span>删除原因</span>
                      <textarea className="text-input" rows={2} value={asText(payload.reason)} disabled={readonly} placeholder="可选，说明删除原因" onChange={(event) => updateOperationPayloadItem(index, { reason: event.target.value })} />
                    </label>
                  )}
                </div>
              );
            })}
          </div>
        );
      }
      const items = asDraftArray(structuredDraft.items);
      return (
        <div className="ai-recipe-editor ai-confirmation-editor ai-meal-plan-draft-editor">
          <div className="ai-draft-editor-head">
            <div>
              <strong>计划项</strong>
              <span>{items.length} 条</span>
            </div>
            {!readonly && (
              <button className="ghost-button ai-draft-add-button" type="button" onClick={() => addDraftItem('items', { date: new Date().toISOString().slice(0, 10), mealType: 'dinner', title: '', foodId: '', reason: '', missingIngredients: [] })}>
                添加计划
              </button>
            )}
          </div>
          {items.map((item, index) => (
            <div className="ai-confirmation-item ai-meal-plan-item" key={`${asText(item.date)}-${asText(item.title)}-${index}`}>
              <div className="ai-meal-plan-item-top">
                <label className="ai-resource-field ai-resource-field-date">
                  <span>日期</span>
                  <div className="ai-resource-select">
                    <ResourceSelectIcon kind="calendar" />
                    <input type="date" value={asText(item.date)} disabled={readonly} onChange={(event) => updateDraftItem('items', index, { date: event.target.value })} />
                  </div>
                </label>
                <label className="ai-resource-field ai-resource-field-meal">
                  <span>餐别</span>
                  <div className="ai-resource-select">
                    <ResourceSelectIcon kind="meal" />
                    <select value={asText(item.mealType, 'dinner')} disabled={readonly} onChange={(event) => updateDraftItem('items', index, { mealType: event.target.value })}>
                      <option value="breakfast">早餐</option>
                      <option value="lunch">午餐</option>
                      <option value="dinner">晚餐</option>
                      <option value="snack">加餐</option>
                    </select>
                    <span className="ai-resource-select-chevron" aria-hidden="true" />
                  </div>
                </label>
              </div>
              <SearchableResourceSelect
                kind="food"
                label="食物"
                value={asText(item.foodId) || asText(item.food_id)}
                selectedLabel={asText(item.title)}
                placeholder="搜索食物库"
                disabled={readonly}
                selectedOption={foodOptions.find((option) => option.id === (asText(item.foodId) || asText(item.food_id))) ?? null}
                loadOptions={loadApprovalResourceOptions}
                onSelect={(option) => updateDraftItem('items', index, { foodId: option.id, food_id: option.id, title: option.label })}
              />
              <label className="ai-resource-field ai-meal-plan-reason-field">
                <span>安排原因</span>
                <textarea className="text-input" rows={2} value={asText(item.reason)} disabled={readonly} placeholder="安排原因" onChange={(event) => updateDraftItem('items', index, { reason: event.target.value })} />
              </label>
              <IngredientQuantityPicker
                label="缺失食材"
                items={normalizeMealPlanIngredientItems(
                  item.missingIngredientItems ?? item.missing_ingredient_items ?? item.missingIngredients ?? item.missing_ingredients,
                  ingredientOptions,
                )}
                disabled={readonly}
                selectedOptions={ingredientOptions}
                loadOptions={loadApprovalResourceOptions}
                onChange={(nextItems) => updateDraftItem('items', index, {
                  missingIngredientItems: nextItems,
                  missingIngredients: nextItems.map((ingredient) => ingredient.name),
                })}
              />
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
      const operations = asDraftArray(structuredDraft.operations);
      if (operations.length > 0) {
        return (
          <div className="ai-recipe-editor ai-confirmation-editor ai-shopping-list-draft-editor">
            <div className="ai-draft-editor-head">
              <div>
                <strong>清单变更</strong>
                <span>{operations.length} 条</span>
              </div>
            </div>
            {operations.map((operation, index) => {
              const action = asText(operation.action);
              const payload = typeof operation.payload === 'object' && operation.payload !== null && !Array.isArray(operation.payload)
                ? operation.payload as Record<string, unknown>
                : {};
              const before = typeof operation.before === 'object' && operation.before !== null && !Array.isArray(operation.before)
                ? operation.before as Record<string, unknown>
                : {};
              const actionLabel = action === 'create' ? '新增' : action === 'update' ? '修改' : action === 'set_done' ? '状态变更' : '删除';
              return (
                <div className="ai-confirmation-item" key={`${action}-${asText(operation.targetId)}-${index}`}>
                  <div className="ai-draft-editor-head">
                    <div>
                      <strong>{actionLabel}采购项</strong>
                      <span>{action === 'create' ? '新采购项' : asText(before.title) || asText(operation.targetId)}</span>
                    </div>
                  </div>
                  {action !== 'create' && (
                    <p className="ai-approval-compare-copy">
                      当前：{[asText(before.title), `${asNumber(before.quantity)}${asText(before.unit)}`].filter(Boolean).join(' · ')}
                    </p>
                  )}
                  {action === 'set_done' ? (
                    <ApprovalSelectField
                      label="采购状态"
                      value={String(Boolean(payload.done))}
                      disabled={readonly}
                      options={[
                        { value: 'true', label: '已买到' },
                        { value: 'false', label: '恢复待买' },
                      ]}
                      icon="type"
                      onChange={(done) => updateOperationPayloadItem(index, { done: done === 'true' })}
                    />
                  ) : action !== 'delete' ? (
                    <>
                      <SearchableResourceSelect
                        kind="ingredient"
                        label="采购食材"
                        value={asText(payload.ingredientId) || asText(payload.ingredient_id)}
                        selectedLabel={asText(payload.title)}
                        placeholder="从食材库选择"
                        disabled={readonly}
                        selectedOption={ingredientOptions.find((option) => option.id === (asText(payload.ingredientId) || asText(payload.ingredient_id)) || option.label === asText(payload.title)) ?? null}
                        loadOptions={loadApprovalResourceOptions}
                        onSelect={(option) => updateOperationPayloadItem(index, { title: option.label, unit: option.unit || asText(payload.unit, '份') })}
                      />
                      <div className="ai-confirmation-grid ai-confirmation-grid-compact">
                        <label className="ai-resource-field">
                          <span>数量</span>
                          <input className="text-input" type="number" min={0.1} step={0.1} value={asNumber(payload.quantity)} disabled={readonly} onChange={(event) => updateOperationPayloadItem(index, { quantity: Number(event.target.value) || 1 })} />
                        </label>
                        <label className="ai-resource-field">
                          <span>单位</span>
                          <input className="text-input" value={asText(payload.unit, '份')} disabled={readonly} placeholder="单位" onChange={(event) => updateOperationPayloadItem(index, { unit: event.target.value })} />
                        </label>
                      </div>
                    </>
                  ) : null}
                  {action !== 'delete' && (
                    <label className="ai-resource-field ai-confirmation-copy-field">
                      <span>{action === 'set_done' ? '状态说明' : '采购原因'}</span>
                      <textarea className="text-input" rows={2} value={asText(payload.reason)} disabled={readonly} placeholder={action === 'set_done' ? '可选，说明状态变更' : '为什么需要采购'} onChange={(event) => updateOperationPayloadItem(index, { reason: event.target.value })} />
                    </label>
                  )}
                </div>
              );
            })}
          </div>
        );
      }
      const items = asDraftArray(structuredDraft.items);
      return (
        <div className="ai-recipe-editor ai-confirmation-editor ai-shopping-list-draft-editor">
          <div className="ai-draft-editor-head">
            <div>
              <strong>采购项</strong>
              <span>{items.length} 条</span>
            </div>
            {!readonly && (
              <button className="ghost-button ai-draft-add-button" type="button" onClick={() => addDraftItem('items', { title: '', quantity: 1, unit: '份', reason: '' })}>
                添加采购项
              </button>
            )}
          </div>
          {items.map((item, index) => (
            <div className="ai-confirmation-item" key={`${asText(item.title)}-${index}`}>
              <SearchableResourceSelect
                kind="ingredient"
                label="采购食材"
                value={asText(item.ingredientId) || asText(item.ingredient_id)}
                selectedLabel={asText(item.title)}
                placeholder="从食材库选择"
                disabled={readonly}
                selectedOption={ingredientOptions.find((option) => option.id === (asText(item.ingredientId) || asText(item.ingredient_id)) || option.label === asText(item.title)) ?? null}
                loadOptions={loadApprovalResourceOptions}
                onSelect={(option) => updateDraftItem('items', index, {
                  title: option.label,
                  unit: option.unit || asText(item.unit, '份'),
                })}
              />
              <div className="ai-confirmation-grid ai-confirmation-grid-compact">
                <label className="ai-resource-field">
                  <span>数量</span>
                  <input className="text-input" type="number" min={0.1} step={0.1} value={asNumber(item.quantity)} disabled={readonly} onChange={(event) => updateDraftItem('items', index, { quantity: Number(event.target.value) || 1 })} />
                </label>
                <label className="ai-resource-field">
                  <span>单位</span>
                  <input className="text-input" value={asText(item.unit, '份')} disabled={readonly} placeholder="单位" onChange={(event) => updateDraftItem('items', index, { unit: event.target.value })} />
                </label>
              </div>
              <label className="ai-resource-field ai-confirmation-copy-field">
                <span>采购原因</span>
                <textarea className="text-input" rows={2} value={asText(item.reason)} disabled={readonly} placeholder="为什么需要采购" onChange={(event) => updateDraftItem('items', index, { reason: event.target.value })} />
              </label>
              {!readonly && items.length > 1 && (
                <button className="ghost-button ai-draft-remove-button" type="button" onClick={() => removeDraftItem('items', index)}>
                  删除采购项
                </button>
              )}
            </div>
          ))}
        </div>
      );
    }
    if (draftType === 'meal_log') {
      const action = asText(structuredDraft.action);
      const before = typeof structuredDraft.before === 'object' && structuredDraft.before !== null && !Array.isArray(structuredDraft.before)
        ? structuredDraft.before as Record<string, unknown>
        : {};
      if (action) {
        const payload = typeof structuredDraft.payload === 'object' && structuredDraft.payload !== null && !Array.isArray(structuredDraft.payload)
          ? structuredDraft.payload as Record<string, unknown>
          : {};
        const foodRatings = asDraftArray(payload.foodEntryRatings);
        if (action === 'create') {
          const operationFoods = asDraftArray(payload.foods);
          const totalServings = operationFoods.reduce((sum, food) => sum + asNumber(food.servings, 0), 0);
          return (
            <div className="ai-recipe-editor ai-confirmation-editor ai-meal-log-draft-editor">
              <div className="ai-draft-editor-head">
                <div>
                  <strong>创建餐食记录</strong>
                  <span>{[asText(payload.date), mealTypeLabel(payload.mealType)].filter(Boolean).join(' · ') || '餐食记录'}</span>
                </div>
              </div>
              <div className="ai-confirmation-item ai-confirmation-summary-card ai-meal-log-summary-card">
                <div className="ai-meal-log-summary-grid">
                  <div><span>日期</span><strong>{asText(payload.date) || '未填写'}</strong></div>
                  <div><span>餐别</span><strong>{mealTypeLabel(payload.mealType) || '未填写'}</strong></div>
                  <div><span>食物</span><strong>{operationFoods.length} 项</strong></div>
                  <div><span>总份数</span><strong>{formatServingCount(totalServings)} 份</strong></div>
                  <div><span>参与人</span><strong>{countLabel(payload.participantUserIds, '人')}</strong></div>
                  <div><span>照片</span><strong>{countLabel(payload.mediaIds, '张')}</strong></div>
                  <div><span>关联计划</span><strong>{asText(payload.planItemId) ? '已关联' : '未关联'}</strong></div>
                  <div><span>心情</span><strong>{asText(payload.mood) || '未填写'}</strong></div>
                </div>
                {asText(payload.notes) && <p className="ai-meal-log-summary-note">{asText(payload.notes)}</p>}
              </div>
              {operationFoods.map((food, index) => {
                const selectedFood = foodOptions.find((option) => option.id === (asText(food.foodId) || asText(food.food_id)) || option.label === asText(food.name)) ?? null;
                return (
                  <div className="ai-confirmation-item ai-meal-log-food-item" key={`${asText(food.name)}-${index}`}>
                    <div className="ai-meal-log-food-head">
                      <div>
                        <span>食物 {index + 1}</span>
                        <strong>{asText(food.name) || selectedFood?.label || '未选择食物'}</strong>
                        <p>{selectedFood?.description || (asText(food.foodId) ? `食物 ID：${asText(food.foodId)}` : '需要从食物库选择')}</p>
                      </div>
                      <em>{formatServingCount(food.servings)} 份</em>
                    </div>
                    {asText(food.note) && <p className="ai-meal-log-food-note">{asText(food.note)}</p>}
                  </div>
                );
              })}
            </div>
          );
        }
        return (
          <div className="ai-recipe-editor ai-confirmation-editor ai-meal-log-draft-editor">
            <div className="ai-draft-editor-head">
              <div>
                <strong>{action === 'update_details' ? '补充餐食记录' : action === 'rate_food' ? '更新评分' : '创建餐食记录'}</strong>
                <span>{[asText(before.date), mealTypeLabel(before.mealType)].filter(Boolean).join(' · ') || '餐食记录'}</span>
              </div>
            </div>
            {action === 'update_details' ? (
              <>
                <label className="ai-resource-field">
                  <span>参与人 ID</span>
                  <input className="text-input" value={Array.isArray(payload.participantUserIds) ? payload.participantUserIds.map(String).join(', ') : ''} disabled={readonly} placeholder="逗号分隔的用户 ID" onChange={(event) => updateDraft({ payload: { ...payload, participantUserIds: splitTextList(event.target.value) } })} />
                </label>
                <label className="ai-resource-field ai-confirmation-copy-field">
                  <span>备注</span>
                  <textarea className="text-input" rows={3} value={asText(payload.notes)} disabled={readonly} placeholder="补充这一餐的说明" onChange={(event) => updateDraft({ payload: { ...payload, notes: event.target.value } })} />
                </label>
                <label className="ai-resource-field">
                  <span>心情</span>
                  <input className="text-input" value={asText(payload.mood)} disabled={readonly} placeholder="例如满足、轻松" onChange={(event) => updateDraft({ payload: { ...payload, mood: event.target.value } })} />
                </label>
                <label className="ai-resource-field">
                  <span>媒体 ID</span>
                  <input className="text-input" value={Array.isArray(payload.mediaIds) ? payload.mediaIds.map(String).join(', ') : ''} disabled={readonly} placeholder="逗号分隔的媒体 ID" onChange={(event) => updateDraft({ payload: { ...payload, mediaIds: splitTextList(event.target.value) } })} />
                </label>
              </>
            ) : action === 'rate_food' ? (
              <>
                {foodRatings.map((item, index) => {
                  const food = asDraftArray(before.foods).find((entry) => asText(entry.id) === asText(item.id));
                  return (
                    <div className="ai-confirmation-item" key={`${asText(item.id)}-${index}`}>
                      <p className="ai-approval-compare-copy">
                        {asText(food?.foodName) || asText(item.id)} · 当前评分 {ratingDisplayText(food?.rating)}
                      </p>
                      <div className="ai-resource-field ai-rating-field">
                        <span>新评分</span>
                        <FoodRatingInput
                          value={ratingInputValue(item.rating)}
                          disabled={readonly}
                          onChange={(value) => updateDraft({ payload: { ...payload, foodEntryRatings: foodRatings.map((ratingItem, ratingIndex) => ratingIndex === index ? { ...ratingItem, rating: Number(value) || null } : ratingItem) } })}
                        />
                      </div>
                    </div>
                  );
                })}
              </>
            ) : null}
          </div>
        );
      }
      const mealFoods = asDraftArray(structuredDraft.foods);
      const totalServings = mealFoods.reduce((sum, food) => sum + asNumber(food.servings, 0), 0);
      return (
        <div className="ai-recipe-editor ai-confirmation-editor ai-meal-log-draft-editor">
          <div className="ai-confirmation-item ai-confirmation-summary-card ai-meal-log-summary-card">
            <div className="ai-meal-log-summary-grid">
              <div><span>日期</span><strong>{asText(structuredDraft.date) || '未填写'}</strong></div>
              <div><span>餐别</span><strong>{mealTypeLabel(structuredDraft.mealType) || '未填写'}</strong></div>
              <div><span>食物</span><strong>{mealFoods.length} 项</strong></div>
              <div><span>总份数</span><strong>{formatServingCount(totalServings)} 份</strong></div>
              <div><span>参与人</span><strong>{countLabel(structuredDraft.participantUserIds, '人')}</strong></div>
              <div><span>照片</span><strong>{countLabel(structuredDraft.mediaIds, '张')}</strong></div>
              <div><span>关联计划</span><strong>{asText(structuredDraft.planItemId) ? '已关联' : '未关联'}</strong></div>
              <div><span>心情</span><strong>{asText(structuredDraft.mood) || '未填写'}</strong></div>
            </div>
            {asText(structuredDraft.notes) && <p className="ai-meal-log-summary-note">{asText(structuredDraft.notes)}</p>}
            <div className="ai-confirmation-grid">
              <label className="ai-resource-field ai-resource-field-date">
                <span>日期</span>
                <div className="ai-resource-select">
                  <ResourceSelectIcon kind="calendar" />
                  <input type="date" value={asText(structuredDraft.date)} disabled={readonly} onChange={(event) => updateDraft({ date: event.target.value })} />
                </div>
              </label>
              <ApprovalSelectField
                label="餐别"
                value={asText(structuredDraft.mealType, 'dinner')}
                disabled={readonly}
                options={MEAL_TYPE_OPTIONS}
                icon="meal"
                onChange={(mealType) => updateDraft({ mealType })}
              />
            </div>
          </div>
          <div className="ai-draft-editor-head">
            <div>
              <strong>食物项</strong>
              <span>{mealFoods.length} 项</span>
            </div>
            {!readonly && (
              <button className="ghost-button ai-draft-add-button" type="button" onClick={() => addDraftItem('foods', { foodId: '', name: '', servings: 1, note: '' })}>
                添加食物
              </button>
            )}
          </div>
          {mealFoods.map((food, index) => {
            const selectedFood = foodOptions.find((option) => option.id === (asText(food.foodId) || asText(food.food_id)) || option.label === asText(food.name)) ?? null;
            return (
              <div className="ai-confirmation-item ai-meal-log-food-item" key={`${asText(food.name)}-${index}`}>
                <div className="ai-meal-log-food-head">
                  <div>
                    <span>食物 {index + 1}</span>
                    <strong>{asText(food.name) || selectedFood?.label || '未选择食物'}</strong>
                    <p>{selectedFood?.description || (asText(food.foodId) ? `食物 ID：${asText(food.foodId)}` : '需要从食物库选择')}</p>
                  </div>
                  <em>{formatServingCount(food.servings)} 份</em>
                </div>
                <SearchableResourceSelect
                  kind="food"
                  label="食物"
                  value={asText(food.foodId) || asText(food.food_id)}
                  selectedLabel={asText(food.name)}
                  placeholder="从食物库选择"
                  disabled={readonly}
                  selectedOption={selectedFood}
                  loadOptions={loadApprovalResourceOptions}
                  onSelect={(option) => updateDraftItem('foods', index, { foodId: option.id, food_id: option.id, name: option.label })}
                />
                <label className="ai-resource-field">
                  <span>份数</span>
                  <input className="text-input" type="number" min={0.1} step={0.1} value={asNumber(food.servings)} disabled={readonly} onChange={(event) => updateDraftItem('foods', index, { servings: Number(event.target.value) || 1 })} />
                </label>
                <label className="ai-resource-field ai-confirmation-copy-field">
                  <span>食物备注</span>
                  <textarea className="text-input" rows={2} value={asText(food.note)} disabled={readonly} placeholder="这份食物的补充说明" onChange={(event) => updateDraftItem('foods', index, { note: event.target.value })} />
                </label>
                {!readonly && mealFoods.length > 1 && (
                  <button className="ghost-button ai-draft-remove-button" type="button" onClick={() => removeDraftItem('foods', index)}>
                    删除食物
                  </button>
                )}
              </div>
            );
          })}
          <label className="ai-resource-field ai-confirmation-copy-field">
            <span>餐食备注</span>
            <textarea className="text-input" rows={3} value={asText(structuredDraft.notes)} disabled={readonly} placeholder="记录这一餐的整体情况" onChange={(event) => updateDraft({ notes: event.target.value })} />
          </label>
        </div>
      );
    }
    if (draftType === 'recipe_cook') {
      const previewItems = asDraftArray(structuredDraft.previewItems);
      const shortages = asDraftArray(structuredDraft.shortages);
      const linkedPlanItem = typeof structuredDraft.before === 'object' && structuredDraft.before !== null && !Array.isArray(structuredDraft.before)
        ? (structuredDraft.before as Record<string, unknown>).linkedPlanItem as Record<string, unknown> | undefined
        : undefined;
      return (
        <div className="ai-recipe-editor ai-confirmation-editor ai-recipe-cook-draft-editor">
          <div className="ai-draft-editor-head">
            <div>
              <strong>做菜执行</strong>
              <span>{asText(structuredDraft.title) || '菜谱'}</span>
            </div>
          </div>
          <div className="ai-confirmation-item ai-confirmation-summary-card">
            <div className="ai-confirmation-grid">
              <label className="ai-resource-field">
                <span>份数</span>
                <input className="text-input" type="number" min={0.1} step={0.1} value={asNumber(structuredDraft.servings, 1)} disabled={readonly} onChange={(event) => updateDraft({ servings: Number(event.target.value) || 1 })} />
              </label>
              <label className="ai-resource-field ai-resource-field-date">
                <span>日期</span>
                <div className="ai-resource-select">
                  <ResourceSelectIcon kind="calendar" />
                  <input type="date" value={asText(structuredDraft.date)} disabled={readonly} onChange={(event) => updateDraft({ date: event.target.value })} />
                </div>
              </label>
              <ApprovalSelectField
                label="餐别"
                value={asText(structuredDraft.mealType, 'dinner')}
                disabled={readonly}
                options={MEAL_TYPE_OPTIONS}
                icon="meal"
                onChange={(mealType) => updateDraft({ mealType })}
              />
              <ApprovalSelectField
                label="生成餐食记录"
                value={String(Boolean(structuredDraft.createMealLog))}
                disabled={readonly}
                options={[
                  { value: 'true', label: '生成' },
                  { value: 'false', label: '不生成' },
                ]}
                icon="type"
                onChange={(createMealLog) => updateDraft({ createMealLog: createMealLog === 'true' })}
              />
            </div>
            {linkedPlanItem ? (
              <p className="ai-approval-compare-copy">
                关联计划：{[asText(linkedPlanItem.plan_date), mealTypeLabel(linkedPlanItem.meal_type), asText(linkedPlanItem.food_name), asText(linkedPlanItem.status)].filter(Boolean).join(' · ')}
              </p>
            ) : null}
          </div>
          <div className="ai-draft-editor-head">
            <div>
              <strong>库存扣减预览</strong>
              <span>{previewItems.length} 项</span>
            </div>
          </div>
          {previewItems.map((item, index) => (
            <div className="ai-confirmation-item" key={`${asText(item.ingredient_name)}-${index}`}>
              <p className="ai-approval-compare-copy">
                {asText(item.ingredient_name)} · {asNumber(item.requested_quantity)} {asText(item.unit)}
              </p>
              <div className="ai-confirmation-copy-field">
                {asDraftArray(item.batches).map((batch, batchIndex) => (
                  <p className="ai-approval-compare-copy" key={`${asText(batch.inventory_item_id)}-${batchIndex}`}>
                    批次 {batchIndex + 1}：{asNumber(batch.quantity)} {asText(batch.unit)} · {asText(batch.storage_location)} · 购于 {asText(batch.purchase_date)}
                  </p>
                ))}
              </div>
            </div>
          ))}
          {shortages.length > 0 ? (
            <>
              <div className="ai-draft-editor-head">
                <div>
                  <strong>缺料</strong>
                  <span>{shortages.length} 项</span>
                </div>
              </div>
              {shortages.map((item, index) => (
                <div className="ai-confirmation-item" key={`${asText(item.ingredient_name)}-${index}`}>
                  <p className="ai-approval-compare-copy">
                    {asText(item.ingredient_name)}：缺 {asNumber(item.missing_quantity)} {asText(item.unit)}，现有 {asNumber(item.available_quantity)} / 需要 {asNumber(item.required_quantity)}
                  </p>
                </div>
              ))}
            </>
          ) : null}
          <label className="ai-resource-field ai-confirmation-copy-field">
            <span>餐食备注</span>
            <textarea className="text-input" rows={2} value={asText(structuredDraft.notes)} disabled={readonly} placeholder="生成餐食记录时附带说明" onChange={(event) => updateDraft({ notes: event.target.value })} />
          </label>
          <label className="ai-resource-field ai-confirmation-copy-field">
            <span>结果备注</span>
            <textarea className="text-input" rows={2} value={asText(structuredDraft.resultNote)} disabled={readonly} placeholder="记录成品效果、口味等" onChange={(event) => updateDraft({ resultNote: event.target.value })} />
          </label>
          <label className="ai-resource-field ai-confirmation-copy-field">
            <span>调整说明</span>
            <textarea className="text-input" rows={2} value={asText(structuredDraft.adjustments)} disabled={readonly} placeholder="记录替换食材或临时调整" onChange={(event) => updateDraft({ adjustments: event.target.value })} />
          </label>
        </div>
      );
    }
    if (draftType === 'food_profile') {
      const action = asText(structuredDraft.action);
      const payload = typeof structuredDraft.payload === 'object' && structuredDraft.payload !== null && !Array.isArray(structuredDraft.payload)
        ? structuredDraft.payload as Record<string, unknown>
        : structuredDraft;
      const before = typeof structuredDraft.before === 'object' && structuredDraft.before !== null && !Array.isArray(structuredDraft.before)
        ? structuredDraft.before as Record<string, unknown>
        : {};
      if (action) {
        const actionLabel = action === 'create' ? '新增' : action === 'update' ? '修改' : '收藏';
        return (
          <div className="ai-recipe-editor ai-confirmation-editor ai-food-profile-draft-editor">
            <div className="ai-draft-editor-head">
              <div>
                <strong>{actionLabel}食物资料</strong>
                <span>{asText(payload.name) || asText(before.name) || '食物资料'}</span>
              </div>
            </div>
            {action !== 'create' && (
              <p className="ai-approval-compare-copy">
                当前：{[asText(before.name), asText(before.type), asText(before.category)].filter(Boolean).join(' · ')}
              </p>
            )}
            {action === 'set_favorite' ? (
              <div className="ai-confirmation-item">
                <ApprovalSelectField
                  label="收藏状态"
                  value={String(Boolean(payload.favorite))}
                  disabled={readonly}
                  options={[
                    { value: 'true', label: '加入收藏' },
                    { value: 'false', label: '移出收藏' },
                  ]}
                  icon="type"
                  onChange={(favorite) => updateDraft({ payload: { ...payload, favorite: favorite === 'true' } })}
                />
              </div>
            ) : (
              <div className="ai-confirmation-item">
                <label className="ai-resource-field">
                  <span>食物名称</span>
                  <input className="text-input" value={asText(payload.name)} disabled={readonly} onChange={(event) => updateDraft({ payload: { ...payload, name: event.target.value } })} />
                </label>
                <div className="ai-confirmation-grid">
                  <ApprovalSelectField
                    label="类型"
                    value={asText(payload.type, 'readyMade')}
                    disabled={readonly}
                    options={FOOD_TYPE_OPTIONS}
                    icon="type"
                    onChange={(type) => updateDraft({ payload: { ...payload, type } })}
                  />
                  <label className="ai-resource-field">
                    <span>分类</span>
                    <input className="text-input" value={asText(payload.category)} disabled={readonly} placeholder="例如主食、饮品" onChange={(event) => updateDraft({ payload: { ...payload, category: event.target.value } })} />
                  </label>
                </div>
                <ApprovalMultiSelectField
                  label="适合餐别"
                  values={Array.isArray(payload.suitable_meal_types) ? payload.suitable_meal_types.map(String) : []}
                  disabled={readonly}
                  options={MEAL_TYPE_OPTIONS}
                  onChange={(suitableMealTypes) => updateDraft({ payload: { ...payload, suitable_meal_types: suitableMealTypes } })}
                />
                <label className="ai-resource-field">
                  <span>口味标签</span>
                  <input className="text-input" value={joinTextList(payload.flavor_tags)} disabled={readonly} placeholder="清淡、酸甜、香辣" onChange={(event) => updateDraft({ payload: { ...payload, flavor_tags: splitTextList(event.target.value) } })} />
                </label>
                <label className="ai-resource-field">
                  <span>来源</span>
                  <input className="text-input" value={asText(payload.source_name)} disabled={readonly} placeholder="店铺、品牌或来源" onChange={(event) => updateDraft({ payload: { ...payload, source_name: event.target.value } })} />
                </label>
                <label className="ai-resource-field ai-confirmation-copy-field">
                  <span>备注</span>
                  <textarea className="text-input" rows={3} value={asText(payload.notes)} disabled={readonly} placeholder="补充食用场景或偏好" onChange={(event) => updateDraft({ payload: { ...payload, notes: event.target.value } })} />
                </label>
              </div>
            )}
          </div>
        );
      }
      return (
        <div className="ai-recipe-editor ai-confirmation-editor ai-food-profile-draft-editor">
          <div className="ai-draft-editor-head">
            <div>
              <strong>食物资料</strong>
              <span>确认名称、类型与适合餐别</span>
            </div>
          </div>
          <div className="ai-confirmation-item">
            <label className="ai-resource-field">
              <span>食物名称</span>
              <input className="text-input" value={asText(structuredDraft.name)} disabled={readonly} onChange={(event) => updateDraft({ name: event.target.value })} />
            </label>
            <div className="ai-confirmation-grid">
              <ApprovalSelectField
                label="类型"
                value={asText(structuredDraft.type, 'readyMade')}
                disabled={readonly}
                options={FOOD_TYPE_OPTIONS}
                icon="type"
                onChange={(type) => updateDraft({ type })}
              />
              <label className="ai-resource-field">
                <span>分类</span>
                <input className="text-input" value={asText(structuredDraft.category)} disabled={readonly} placeholder="例如主食、饮品" onChange={(event) => updateDraft({ category: event.target.value })} />
              </label>
            </div>
            <ApprovalMultiSelectField
              label="适合餐别"
              values={Array.isArray(structuredDraft.suitable_meal_types) ? structuredDraft.suitable_meal_types.map(String) : []}
              disabled={readonly}
              options={MEAL_TYPE_OPTIONS}
              onChange={(suitableMealTypes) => updateDraft({ suitable_meal_types: suitableMealTypes })}
            />
            <label className="ai-resource-field">
              <span>口味标签</span>
              <input className="text-input" value={joinTextList(structuredDraft.flavor_tags)} disabled={readonly} placeholder="清淡、酸甜、香辣" onChange={(event) => updateDraft({ flavor_tags: splitTextList(event.target.value) })} />
            </label>
            <label className="ai-resource-field">
              <span>来源</span>
              <input className="text-input" value={asText(structuredDraft.source_name)} disabled={readonly} placeholder="店铺、品牌或来源" onChange={(event) => updateDraft({ source_name: event.target.value })} />
            </label>
            <label className="ai-resource-field ai-confirmation-copy-field">
              <span>备注</span>
              <textarea className="text-input" rows={3} value={asText(structuredDraft.notes)} disabled={readonly} placeholder="补充食用场景或偏好" onChange={(event) => updateDraft({ notes: event.target.value })} />
            </label>
          </div>
        </div>
      );
    }
    if (draftType === 'ingredient_profile') {
      const action = asText(structuredDraft.action, 'create');
      const payload = typeof structuredDraft.payload === 'object' && structuredDraft.payload !== null && !Array.isArray(structuredDraft.payload)
        ? structuredDraft.payload as Record<string, unknown>
        : structuredDraft;
      const before = typeof structuredDraft.before === 'object' && structuredDraft.before !== null && !Array.isArray(structuredDraft.before)
        ? structuredDraft.before as Record<string, unknown>
        : {};
      const actionLabel = action === 'update' ? '修改' : '新增';
      return (
        <div className="ai-recipe-editor ai-confirmation-editor ai-ingredient-profile-draft-editor">
          <div className="ai-draft-editor-head">
            <div>
              <strong>{actionLabel}食材档案</strong>
              <span>{asText(payload.name) || asText(before.name) || '食材档案'}</span>
            </div>
          </div>
          {action === 'update' && (
            <p className="ai-approval-compare-copy">
              当前：{[asText(before.name), asText(before.category), asText(before.default_unit), asText(before.default_storage)].filter(Boolean).join(' · ')}
            </p>
          )}
          <div className="ai-confirmation-item">
            <div className="ai-confirmation-grid">
              <label className="ai-resource-field">
                <span>食材名称</span>
                <input className="text-input" value={asText(payload.name)} disabled={readonly} onChange={(event) => updateDraft({ payload: { ...payload, name: event.target.value } })} />
              </label>
              <label className="ai-resource-field">
                <span>分类</span>
                <input className="text-input" value={asText(payload.category)} disabled={readonly} placeholder="例如蔬菜、肉类" onChange={(event) => updateDraft({ payload: { ...payload, category: event.target.value } })} />
              </label>
            </div>
            <div className="ai-confirmation-grid ai-confirmation-grid-three">
              <label className="ai-resource-field">
                <span>默认单位</span>
                <input className="text-input" value={asText(payload.default_unit)} disabled={readonly} placeholder="例如个、盒、g" onChange={(event) => updateDraft({ payload: { ...payload, default_unit: event.target.value } })} />
              </label>
              <label className="ai-resource-field">
                <span>默认保存</span>
                <input className="text-input" value={asText(payload.default_storage)} disabled={readonly} placeholder="例如冷藏、冷冻" onChange={(event) => updateDraft({ payload: { ...payload, default_storage: event.target.value } })} />
              </label>
              <ApprovalSelectField
                label="保质期模式"
                value={asText(payload.default_expiry_mode, 'none')}
                disabled={readonly}
                options={[
                  { value: 'days', label: '按天数' },
                  { value: 'manual_date', label: '手动日期' },
                  { value: 'none', label: '不设置' },
                ]}
                icon="calendar"
                onChange={(defaultExpiryMode) => updateDraft({ payload: { ...payload, default_expiry_mode: defaultExpiryMode } })}
              />
            </div>
            <div className="ai-confirmation-grid ai-confirmation-grid-three">
              <label className="ai-resource-field">
                <span>默认保质期天数</span>
                <input
                  className="text-input"
                  type="number"
                  min={1}
                  value={payload.default_expiry_days == null ? '' : String(payload.default_expiry_days)}
                  disabled={readonly || asText(payload.default_expiry_mode, 'none') !== 'days'}
                  placeholder="例如 7"
                  onChange={(event) => updateDraft({ payload: { ...payload, default_expiry_days: event.target.value ? Number(event.target.value) : null } })}
                />
              </label>
              <label className="ai-resource-field">
                <span>低库存阈值</span>
                <input
                  className="text-input"
                  type="number"
                  min={0}
                  step="0.1"
                  value={payload.default_low_stock_threshold == null ? '' : String(payload.default_low_stock_threshold)}
                  disabled={readonly}
                  placeholder="例如 2"
                  onChange={(event) => updateDraft({ payload: { ...payload, default_low_stock_threshold: event.target.value ? Number(event.target.value) : null } })}
                />
              </label>
              <label className="ai-resource-field">
                <span>单位换算</span>
                <input
                  className="text-input"
                  value={Array.isArray(payload.unit_conversions) ? payload.unit_conversions.map((item) => {
                    if (typeof item !== 'object' || item === null || Array.isArray(item)) return '';
                    return `${asText((item as Record<string, unknown>).unit)}=${asNumber((item as Record<string, unknown>).ratio_to_default, 1)}`;
                  }).filter(Boolean).join('、') : ''}
                  disabled={readonly}
                  placeholder="例如 杯=1、斤=500"
                  onChange={(event) => updateDraft({
                    payload: {
                      ...payload,
                      unit_conversions: splitTextList(event.target.value).map((entry) => {
                        const [unit, ratio] = entry.split('=').map((item) => item.trim());
                        return { unit, ratio_to_default: Number(ratio) || 1 };
                      }),
                    },
                  })}
                />
              </label>
            </div>
            <label className="ai-resource-field ai-confirmation-copy-field">
              <span>备注</span>
              <textarea className="text-input" rows={3} value={asText(payload.notes)} disabled={readonly} placeholder="补充采购、保存或使用习惯" onChange={(event) => updateDraft({ payload: { ...payload, notes: event.target.value } })} />
            </label>
          </div>
        </div>
      );
    }
    return null;
  };

  const briefSummary = useMemo(() => {
    if (recipeApproval) {
      const servings = recipe.servings ? `${recipe.servings}人份` : '';
      const time = recipe.prep_minutes ? `${recipe.prep_minutes}分钟` : '';
      const difficulty = recipe.difficulty ? DIFFICULTY_OPTIONS.find(o => o.value === recipe.difficulty)?.label || recipe.difficulty : '';
      const ingrCount = recipe.ingredient_items?.length ? `${recipe.ingredient_items.length}个食材` : '';
      return [servings, time, difficulty, ingrCount].filter(Boolean).join(' · ');
    }
    if (usesStructuredDraftEditor) {
      if (draftType === 'meal_plan') {
        const operations = asDraftArray(structuredDraft.operations);
        if (operations.length > 0) {
          const labels = operations.map((item) => {
            const action = asText(item.action);
            return action === 'create' ? '新增' : action === 'update' ? '修改' : action === 'set_status' ? '状态变更' : '删除';
          });
          return `${operations.length}个计划操作 · ${Array.from(new Set(labels)).join('、')}`;
        }
        const items = asDraftArray(structuredDraft.items);
        if (items.length === 0) return '无计划项';
        const dates = Array.from(new Set(items.map(item => asText(item.date)).filter(Boolean)));
        const mealTypes = Array.from(new Set(items.map(item => {
          const type = asText(item.mealType);
          return MEAL_TYPE_OPTIONS.find(o => o.value === type)?.label || type;
        }).filter(Boolean)));
        const dateStr = dates.length > 1 ? `${dates.length}天` : dates[0] || '';
        const mealStr = mealTypes.join('、');
        return `${items.length}个计划项${dateStr || mealStr ? ` (${[dateStr, mealStr].filter(Boolean).join(' · ')})` : ''}`;
      }
      if (draftType === 'shopping_list') {
        const operations = asDraftArray(structuredDraft.operations);
        if (operations.length > 0) {
          const labels = operations.map((item) => {
            const action = asText(item.action);
            return action === 'create' ? '新增' : action === 'update' ? '修改' : action === 'set_done' ? '状态变更' : '删除';
          });
          return `${operations.length}个清单操作 · ${Array.from(new Set(labels)).join('、')}`;
        }
        const items = asDraftArray(structuredDraft.items);
        return `${items.length}个采购项`;
      }
      if (draftType === 'meal_log') {
        const action = asText(structuredDraft.action);
        if (action) {
          const before = typeof structuredDraft.before === 'object' && structuredDraft.before !== null && !Array.isArray(structuredDraft.before)
            ? structuredDraft.before as Record<string, unknown>
            : {};
          const actionLabel = action === 'update_details' ? '补充' : action === 'rate_food' ? '评分' : '创建';
          return [actionLabel, asText(before.date), mealTypeLabel(before.mealType)].filter(Boolean).join(' · ');
        }
        const date = asText(structuredDraft.date);
        const mealType = asText(structuredDraft.mealType);
        const mealLabel = MEAL_TYPE_OPTIONS.find(o => o.value === mealType)?.label || mealType;
        const foodsCount = asDraftArray(structuredDraft.foods).length;
        return `${[date, mealLabel].filter(Boolean).join(' ')} · ${foodsCount}个食物项`;
      }
      if (draftType === 'recipe_cook') {
        const mealType = asText(structuredDraft.mealType);
        const mealLabel = MEAL_TYPE_OPTIONS.find(o => o.value === mealType)?.label || mealType;
        const shortages = asDraftArray(structuredDraft.shortages).length;
        return [
          asText(structuredDraft.title),
          `${asNumber(structuredDraft.servings, 1)}份`,
          mealLabel,
          shortages ? `缺料${shortages}项` : '库存可做',
        ].filter(Boolean).join(' · ');
      }
      if (draftType === 'food_profile') {
        const record = typeof structuredDraft.payload === 'object' && structuredDraft.payload !== null && !Array.isArray(structuredDraft.payload)
          ? structuredDraft.payload as Record<string, unknown>
          : structuredDraft;
        const action = asText(structuredDraft.action);
        if (action) {
          const name = asText(record.name) || asText((structuredDraft.before as Record<string, unknown> | undefined)?.name);
          const actionLabel = action === 'create' ? '新增' : action === 'update' ? '修改' : '收藏';
          return [actionLabel, name].filter(Boolean).join(' · ');
        }
        const name = asText(structuredDraft.name);
        const type = asText(structuredDraft.type);
        const typeLabel = FOOD_TYPE_OPTIONS.find(o => o.value === type)?.label || foodTypeText(type);
        const category = asText(structuredDraft.category);
        return [name, typeLabel, category].filter(Boolean).join(' · ');
      }
      if (draftType === 'ingredient_profile') {
        const record = typeof structuredDraft.payload === 'object' && structuredDraft.payload !== null && !Array.isArray(structuredDraft.payload)
          ? structuredDraft.payload as Record<string, unknown>
          : structuredDraft;
        const action = asText(structuredDraft.action, 'create');
        const name = asText(record.name) || asText((structuredDraft.before as Record<string, unknown> | undefined)?.name);
        const category = asText(record.category) || asText((structuredDraft.before as Record<string, unknown> | undefined)?.category);
        const unit = asText(record.default_unit) || asText((structuredDraft.before as Record<string, unknown> | undefined)?.default_unit);
        const actionLabel = action === 'update' ? '修改' : '新增';
        return [actionLabel, name, category, unit].filter(Boolean).join(' · ');
      }
      if (draftType === 'recipe') {
        const action = asText(structuredDraft.action);
        const payload = typeof structuredDraft.payload === 'object' && structuredDraft.payload !== null && !Array.isArray(structuredDraft.payload)
          ? structuredDraft.payload as Record<string, unknown>
          : {};
        const before = typeof structuredDraft.before === 'object' && structuredDraft.before !== null && !Array.isArray(structuredDraft.before)
          ? structuredDraft.before as Record<string, unknown>
          : {};
        const title = asText(payload.title) || asText(before.title);
        const actionLabel = action === 'update' ? '修改' : action === 'delete' ? '删除' : action === 'set_favorite' ? '收藏' : '创建';
        return [actionLabel, title].filter(Boolean).join(' · ');
      }
      if (draftType === 'inventory_operation') {
        const operations = asDraftArray(structuredDraft.operations);
        const labels = operations.map((item) => INVENTORY_ACTION_OPTIONS.find((option) => option.value === asText(item.action))?.label ?? '处理');
        return `${operations.length}项库存处理 · ${Array.from(new Set(labels)).join('、')}`;
      }
    }
    return '';
  }, [recipeApproval, recipe, usesStructuredDraftEditor, draftType, structuredDraft]);

  return (
    <section className={`ai-approval-panel${isExpanded ? ' is-expanded' : ' is-collapsed'}`}>
      <div
        className="ai-approval-head"
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        onClick={() => setIsExpanded(!isExpanded)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setIsExpanded((current) => !current);
          }
        }}
      >
        <div className="ai-approval-head-copy">
          <div className="ai-approval-title-row">
            <h3>{currentApproval.title}</h3>
            {!isExpanded && briefSummary && (
              <span className="ai-approval-brief-badge">
                {briefSummary}
              </span>
            )}
          </div>
          <p>{currentApproval.instruction}</p>
        </div>
        <div className="ai-approval-head-actions">
          <span className={`ai-approval-status status-${currentApproval.status}`}>
            {readonly ? approvalStatusText(currentApproval.status) : '待确认'}
          </span>
          <span className={`ai-approval-toggle-icon ${isExpanded ? 'is-expanded' : ''}`}>
            <svg
              viewBox="0 0 24 24"
              width="18"
              height="18"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </span>
        </div>
      </div>
      <div className="ai-approval-body-wrapper">
        <div className="ai-approval-body-content">
          {failureSummary && (
            <section className="ai-approval-failure-summary" aria-label="上次失败详情">
              <div className="ai-approval-failure-head">
                <strong>
                  {failureSummary.failedOperationSummaries.length > 0
                    ? `上次写入失败，以下 ${failureSummary.failedOperationSummaries.length} 项需要重新确认`
                    : '上次写入失败，请先核对后再重试'}
                </strong>
                {failureSummary.failedOperationIds.length > 0 && (
                  <span className="ai-approval-failure-badge">{failureSummary.failedOperationIds.length} 项失败</span>
                )}
              </div>
              {failureSummary.errorMessage && (
                <p className="ai-approval-failure-copy">{failureSummary.errorMessage}</p>
              )}
              {failureSummary.hasConflictHint && (
                <p className="ai-approval-failure-copy">
                  检测到版本或基线冲突，建议先核对当前业务值，再决定直接重试还是修改草稿。
                </p>
              )}
              {failureSummary.failedOperationSummaries.length > 0 && (
                <ul className="ai-approval-failure-list">
                  {failureSummary.failedOperationSummaries.map((item, index) => (
                    <li
                      className="ai-approval-failure-item"
                      key={item.operationId || `${item.summary}-${item.targetId}-${index}`}
                    >
                      <div className="ai-approval-failure-item-main">
                        <strong>{item.summary || '未识别操作'}</strong>
                        {(item.targetId || item.action) && (
                          <span>
                            {[item.action && `动作 ${item.action}`, item.targetId && `目标 ${item.targetId}`].filter(Boolean).join(' · ')}
                          </span>
                        )}
                      </div>
                      {item.operationId && (
                        <span className="ai-approval-failure-opid">操作 ID · {item.operationId}</span>
                      )}
                      {item.currentValue && (
                        <div className="ai-approval-failure-current">
                          <strong>当前业务值</strong>
                          <span>{item.currentValue.label || '当前对象'}</span>
                          {item.currentValue.summary && <p>{item.currentValue.summary}</p>}
                        </div>
                      )}
                      {item.recoveryHint && (
                        <p className="ai-approval-failure-recovery">{item.recoveryHint}</p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
          {recipeApproval ? (
            <div className="ai-recipe-editor ai-confirmation-editor ai-recipe-draft-editor">
              <div className="ai-draft-editor-head">
                <div>
                  <strong>菜谱基础信息</strong>
                  <span>确认名称、份量、时间和难度</span>
                </div>
              </div>
              <div className="ai-confirmation-item ai-confirmation-summary-card">
                <label className="ai-resource-field">
                  <span>菜谱名</span>
                  <input className="text-input" value={recipe.title} disabled={readonly} onChange={(event) => setRecipe({ ...recipe, title: event.target.value })} />
                </label>
                <div className="ai-confirmation-grid ai-confirmation-grid-three">
                  <label className="ai-resource-field">
                    <span>份量</span>
                    <input className="text-input" type="number" min={1} value={recipe.servings} disabled={readonly} onChange={(event) => setRecipe({ ...recipe, servings: Number(event.target.value) || 1 })} />
                  </label>
                  <label className="ai-resource-field">
                    <span>时间（分钟）</span>
                    <input className="text-input" type="number" min={0} value={recipe.prep_minutes} disabled={readonly} onChange={(event) => setRecipe({ ...recipe, prep_minutes: Number(event.target.value) || 0 })} />
                  </label>
                  <ApprovalSelectField
                    label="难度"
                    value={recipe.difficulty}
                    disabled={readonly}
                    options={DIFFICULTY_OPTIONS}
                    icon="difficulty"
                    onChange={(difficulty) => setRecipe({ ...recipe, difficulty: difficulty as Difficulty })}
                  />
                </div>
              </div>
              <div className="ai-draft-editor-head">
                <div>
                  <strong>食材</strong>
                  <span>{recipe.ingredient_items.length} 种</span>
                </div>
                {!readonly && (
                  <button className="ghost-button ai-draft-add-button" type="button" onClick={() => setRecipe({ ...recipe, ingredient_items: [...recipe.ingredient_items, { ingredient_id: null, ingredient_name: '', quantity: 1, unit: '份', note: '' }] })}>
                    添加食材
                  </button>
                )}
              </div>
              {recipe.ingredient_items.map((item, index) => (
                <div className="ai-confirmation-item" key={`${item.ingredient_name}-${index}`}>
                  <SearchableResourceSelect
                    kind="ingredient"
                    label={`食材 ${index + 1}`}
                    value={item.ingredient_id ?? ''}
                    selectedLabel={item.ingredient_name}
                    placeholder="从食材库选择"
                    disabled={readonly}
                    selectedOption={ingredientOptions.find((option) => option.id === item.ingredient_id || option.label === item.ingredient_name) ?? null}
                    loadOptions={loadApprovalResourceOptions}
                    onSelect={(option) => updateIngredient(index, {
                      ingredient_id: option.id,
                      ingredient_name: option.label,
                      unit: option.unit || item.unit,
                    })}
                  />
                  <div className="ai-confirmation-grid ai-confirmation-grid-compact">
                    <label className="ai-resource-field">
                      <span>数量</span>
                      <input className="text-input" type="number" min={0.1} step={0.1} value={item.quantity} disabled={readonly} onChange={(event) => updateIngredient(index, { quantity: Number(event.target.value) || 1 })} />
                    </label>
                    <label className="ai-resource-field">
                      <span>单位</span>
                      <input className="text-input" value={item.unit} disabled={readonly} placeholder="单位" onChange={(event) => updateIngredient(index, { unit: event.target.value })} />
                    </label>
                  </div>
                  <label className="ai-resource-field">
                    <span>处理备注</span>
                    <input className="text-input" value={item.note} disabled={readonly} placeholder="例如切块、提前浸泡" onChange={(event) => updateIngredient(index, { note: event.target.value })} />
                  </label>
                  {!readonly && recipe.ingredient_items.length > 1 && (
                    <button className="ghost-button ai-draft-remove-button" type="button" onClick={() => setRecipe({ ...recipe, ingredient_items: recipe.ingredient_items.filter((_, itemIndex) => itemIndex !== index) })}>
                      删除食材
                    </button>
                  )}
                </div>
              ))}
              <div className="ai-draft-editor-head">
                <div>
                  <strong>步骤</strong>
                  <span>{recipe.steps.length} 步</span>
                </div>
                {!readonly && (
                  <button className="ghost-button ai-draft-add-button" type="button" onClick={() => setRecipe({ ...recipe, steps: [...recipe.steps, { title: `步骤 ${recipe.steps.length + 1}`, text: '', icon: 'pan', summary: '', estimated_minutes: 5, tip: '', key_points: [] }] })}>
                    添加步骤
                  </button>
                )}
              </div>
              {recipe.steps.map((step, index) => (
                <div className="ai-confirmation-item" key={`${step.title}-${index}`}>
                  <label className="ai-resource-field">
                    <span>步骤 {index + 1}</span>
                    <input className="text-input ai-confirmation-title-input" value={step.title} disabled={readonly} placeholder={`步骤 ${index + 1}`} onChange={(event) => updateStep(index, { title: event.target.value })} />
                  </label>
                  <div className="ai-confirmation-grid ai-confirmation-grid-three">
                    <label className="ai-resource-field">
                      <span>摘要</span>
                      <input className="text-input" value={step.summary ?? ''} disabled={readonly} placeholder="简短概括" onChange={(event) => updateStep(index, { summary: event.target.value })} />
                    </label>
                    <label className="ai-resource-field">
                      <span>预计用时（分钟）</span>
                      <input className="text-input" type="number" min={1} value={step.estimated_minutes ?? ''} disabled={readonly} placeholder="分钟" onChange={(event) => updateStep(index, { estimated_minutes: Number(event.target.value) || null })} />
                    </label>
                    <ApprovalSelectField
                      label="步骤图标"
                      value={step.icon ?? 'pan'}
                      disabled={readonly}
                      options={RECIPE_STEP_ICON_OPTIONS}
                      icon="step"
                      onChange={(icon) => updateStep(index, { icon })}
                    />
                  </div>
                  <label className="ai-resource-field ai-confirmation-copy-field">
                    <span>步骤说明</span>
                    <textarea className="text-input" rows={3} value={step.text} disabled={readonly} placeholder="详细说明操作方法" onChange={(event) => updateStep(index, { text: event.target.value })} />
                  </label>
                  <label className="ai-resource-field">
                    <span>关键点</span>
                    <input className="text-input" value={(step.key_points ?? []).join('、')} disabled={readonly} placeholder="用顿号分隔" onChange={(event) => updateStep(index, { key_points: event.target.value.split(/[、,，]/).map((item) => item.trim()).filter(Boolean) })} />
                  </label>
                  {!readonly && recipe.steps.length > 1 && (
                    <button className="ghost-button ai-draft-remove-button" type="button" onClick={() => setRecipe({ ...recipe, steps: recipe.steps.filter((_, itemIndex) => itemIndex !== index) })}>
                      删除步骤
                    </button>
                  )}
                </div>
              ))}
              <div className="ai-confirmation-item">
                <label className="ai-resource-field">
                  <span>场景标签</span>
                  <input className="text-input" value={(recipe.scene_tags ?? []).join('、')} disabled={readonly} placeholder="家常菜、快手菜" onChange={(event) => setRecipe({ ...recipe, scene_tags: event.target.value.split(/[、,，]/).map((item) => item.trim()).filter(Boolean) })} />
                </label>
                <label className="ai-resource-field ai-confirmation-copy-field">
                  <span>小贴士</span>
                  <textarea className="text-input" rows={2} value={recipe.tips} disabled={readonly} placeholder="补充火候、替换食材等提示" onChange={(event) => setRecipe({ ...recipe, tips: event.target.value })} />
                </label>
              </div>
            </div>
          ) : usesStructuredDraftEditor ? (
            renderStructuredDraftEditor()
          ) : (
            <div className="ai-recipe-editor">
              <label>
                草稿内容
                <textarea className="text-input" rows={12} value={draftJson} disabled={readonly} onChange={(event) => setDraftJson(event.target.value)} />
              </label>
            </div>
          )}
          <label className="ai-approval-comment-field">
            <span>确认备注</span>
            <input className="text-input" value={comment} disabled={readonly} placeholder="可选，补充本次确认说明" onChange={(event) => setComment(event.target.value)} />
          </label>
          {pendingButLocked && submitDisabledReason && (
            <p className="ai-approval-submit-hint">
              {submitDisabledReason}
            </p>
          )}
          {error && <p className="form-error" role="alert">{error}</p>}
          {!readonly && (
            <div className="ai-approval-actions">
              <button className="ghost-button" type="button" disabled={isSubmitting} onClick={() => submitDecision('rejected')}>
                {currentApproval.reject_label}
              </button>
              <button className="solid-button" type="button" disabled={isSubmitting} onClick={() => submitDecision('approved')}>
                {isSubmitting ? '提交中...' : currentApproval.approve_label}
              </button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
