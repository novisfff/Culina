import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AiApprovalRequest, AiGeneratedRecipeDraft, Difficulty, Food, Ingredient } from '../../api/types';
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
}: {
  approval: AiApprovalRequest;
  foods?: Food[];
  ingredients?: Ingredient[];
  resourceOptionLoader?: AiResourceOptionLoader;
  onDecision: AiApprovalDecisionSubmit;
  isLatest?: boolean;
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
  const readonly = currentApproval.status !== 'pending';
  const recipeApproval = isRecipeApproval(currentApproval);
  const draftType = getDraftType(currentApproval, structuredDraft);
  const usesStructuredDraftEditor = ['meal_plan', 'shopping_list', 'meal_log', 'food_profile'].includes(draftType);
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
    let values: Record<string, unknown>;
    if (recipeApproval) {
      values = { recipe };
    } else if (usesStructuredDraftEditor) {
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

  const renderStructuredDraftEditor = () => {
    if (draftType === 'meal_plan') {
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
      const mealFoods = asDraftArray(structuredDraft.foods);
      return (
        <div className="ai-recipe-editor ai-confirmation-editor ai-meal-log-draft-editor">
          <div className="ai-confirmation-item ai-confirmation-summary-card">
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
          {mealFoods.map((food, index) => (
            <div className="ai-confirmation-item" key={`${asText(food.name)}-${index}`}>
              <SearchableResourceSelect
                kind="food"
                label="食物"
                value={asText(food.foodId) || asText(food.food_id)}
                selectedLabel={asText(food.name)}
                placeholder="从食物库选择"
                disabled={readonly}
                selectedOption={foodOptions.find((option) => option.id === (asText(food.foodId) || asText(food.food_id)) || option.label === asText(food.name)) ?? null}
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
          ))}
          <label className="ai-resource-field ai-confirmation-copy-field">
            <span>餐食备注</span>
            <textarea className="text-input" rows={3} value={asText(structuredDraft.notes)} disabled={readonly} placeholder="记录这一餐的整体情况" onChange={(event) => updateDraft({ notes: event.target.value })} />
          </label>
        </div>
      );
    }
    if (draftType === 'food_profile') {
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
        const items = asDraftArray(structuredDraft.items);
        return `${items.length}个采购项`;
      }
      if (draftType === 'meal_log') {
        const date = asText(structuredDraft.date);
        const mealType = asText(structuredDraft.mealType);
        const mealLabel = MEAL_TYPE_OPTIONS.find(o => o.value === mealType)?.label || mealType;
        const foodsCount = asDraftArray(structuredDraft.foods).length;
        return `${[date, mealLabel].filter(Boolean).join(' ')} · ${foodsCount}个食物项`;
      }
      if (draftType === 'food_profile') {
        const name = asText(structuredDraft.name);
        const type = asText(structuredDraft.type);
        const typeLabel = FOOD_TYPE_OPTIONS.find(o => o.value === type)?.label || foodTypeText(type);
        const category = asText(structuredDraft.category);
        return [name, typeLabel, category].filter(Boolean).join(' · ');
      }
    }
    return '';
  }, [recipeApproval, recipe, usesStructuredDraftEditor, draftType, structuredDraft]);

  return (
    <section className={`ai-approval-panel${isExpanded ? ' is-expanded' : ' is-collapsed'}`}>
      <div
        className="ai-approval-head"
        onClick={() => setIsExpanded(!isExpanded)}
        style={{ cursor: 'pointer', userSelect: 'none' }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <h3 style={{ margin: 0 }}>{currentApproval.title}</h3>
            {!isExpanded && briefSummary && (
              <span className="ai-approval-brief-badge">
                {briefSummary}
              </span>
            )}
          </div>
          <p>{currentApproval.instruction}</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0 }}>
          <span className={`ai-approval-status status-${currentApproval.status}`}>
            {readonly ? approvalStatusText(currentApproval.status) : '待确认'}
          </span>
          <span
            className={`ai-approval-toggle-icon ${isExpanded ? 'is-expanded' : ''}`}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <svg
              viewBox="0 0 24 24"
              width="18"
              height="18"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{
                transition: 'transform 0.2s ease',
                transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                color: '#7a6e65',
              }}
            >
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </span>
        </div>
      </div>
      <div className="ai-approval-body-wrapper">
        <div className="ai-approval-body-content">
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
          {error && <p className="form-error">{error}</p>}
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
