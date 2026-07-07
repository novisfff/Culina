import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AiApprovalRequest, AiGeneratedRecipeDraft, Difficulty, Food, Ingredient } from '../../api/types';
import { FoodRatingInput } from '../foods/FoodWorkspacePrimitives';
import { resolveMediaUrl } from '../../lib/assets';
import { tracksIngredientQuantity } from '../../lib/ingredientTracking';
import { RECIPE_STEP_ICON_OPTIONS } from '../recipes/RecipeWorkspaceOptions';
import { INVENTORY_STORAGE_PRESETS, buildUnitPresetOptions } from '../ingredients/ingredientWorkspaceForms';
import { getIngredientEditorCategoryPresets } from '../ingredients/workspaceModel';
import {
  ApprovalComboboxField,
  ApprovalMultiSelectField,
  ApprovalSelectField,
  IngredientQuantityPicker,
  ResourceSelectIcon,
  AiSearchableResourceSelect,
  normalizeMealPlanIngredientItems,
} from './AiApprovalFields';
import type { AiResourceKind, AiResourceOption, AiResourceOptionLoader } from './AiApprovalFields';
import { AiCompositeOperationPreview, validateCompositeOperationDraftForSubmit } from './AiCompositeOperationPreview';
import { AiInventoryOperationEditor } from './AiInventoryOperationEditor';
import {
  inventoryOperationDraftFromRecord,
  validateInventoryOperationDraftForSubmit,
  type InventoryOperationDraftItemPatch,
} from './aiInventoryOperationDraftModel';
import { asDraftArray, asNumber, asText, draftNumberFromInput, draftNumberInputValue, nullableDraftNumberFromInput } from './aiDraftValueUtils';

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
const MEAL_LOG_MOOD_OPTIONS = [
  { value: '满足', label: '满足' },
  { value: '清淡', label: '清淡' },
  { value: '匆忙', label: '匆忙' },
  { value: '聚餐', label: '聚餐' },
  { value: '孩子喜欢', label: '孩子喜欢' },
];
const INVENTORY_ACTION_OPTIONS = [
  { value: 'restock', label: '补货' },
  { value: 'consume', label: '消耗' },
  { value: 'dispose', label: '销毁' },
];
const INGREDIENT_CATEGORY_OPTIONS = getIngredientEditorCategoryPresets().map((item) => ({
  value: item.label,
  label: item.label,
  description: [item.defaultStorage, item.defaultUnit ? `默认 ${item.defaultUnit}` : ''].filter(Boolean).join(' · '),
}));
const INGREDIENT_STORAGE_OPTIONS = INVENTORY_STORAGE_PRESETS.map((storage) => ({
  value: storage,
  label: storage,
}));
const SHOPPING_QUANTITY_MODE_OPTIONS = [
  { value: 'track_quantity', label: '记录数量' },
  { value: 'not_track_quantity', label: '只提醒需要补充' },
];
const SHOPPING_DONE_OPTIONS = [
  { value: 'false', label: '待买' },
  { value: 'true', label: '已买到' },
];
const FOOD_CATEGORY_PRESETS = ['主食', '饮品', '早餐', '便当', '零食', '甜品', '汤粥', '小吃', '外卖', '速食'];
const FOOD_FLAVOR_PRESETS = ['清淡', '酸甜', '香辣', '咸鲜', '奶香', '酥脆', '软糯', '孩子喜欢'];
const AI_RESOURCE_IMAGE_FALLBACK = '/assets/ai-food-ingredient-placeholder.png';

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

function ingredientExpiryModeLabel(value: unknown) {
  switch (asText(value, 'none')) {
    case 'days':
      return '按天数';
    case 'manual_date':
      return '入库时手动日期';
    case 'none':
      return '不设置';
    default:
      return asText(value) || '不设置';
  }
}

function ingredientExpirySummary(payload: Record<string, unknown>) {
  const mode = asText(payload.default_expiry_mode, 'none');
  if (mode === 'days') {
    const days = asNumber(payload.default_expiry_days, 0);
    return days > 0 ? `${days} 天` : '按天数，待补天数';
  }
  return ingredientExpiryModeLabel(mode);
}

function ingredientLowStockSummary(payload: Record<string, unknown>) {
  const threshold = payload.default_low_stock_threshold;
  if (threshold === null || threshold === undefined || threshold === '') return '不设置';
  const unit = asText(payload.default_unit);
  return `${String(threshold)}${unit ? ` ${unit}` : ''}`;
}

function ingredientUnitConversionSummary(value: unknown, defaultUnit: string) {
  const conversions = asDraftArray(value);
  if (conversions.length === 0) return '未设置副单位';
  return conversions.map((item) => {
    const unit = asText(item.unit);
    const ratio = item.ratio_to_default;
    const ratioText = typeof ratio === 'number' && Number.isFinite(ratio) ? String(ratio) : asText(ratio);
    return `${unit || '副单位'} = ${ratioText || '?'}${defaultUnit ? ` ${defaultUnit}` : ''}`;
  }).join('、');
}

function difficultyLabel(value: unknown) {
  const text = asText(value);
  return DIFFICULTY_OPTIONS.find((option) => option.value === text)?.label ?? text;
}

function recipeDraftSummaryItems(recipe: AiGeneratedRecipeDraft) {
  return [
    { label: '菜谱名', value: recipe.title || '未命名菜谱' },
    { label: '份量', value: `${asNumber(recipe.servings, 0) || '?'} 人份` },
    { label: '预计时间', value: `${asNumber(recipe.prep_minutes, 0) || '?'} 分钟` },
    { label: '难度', value: difficultyLabel(recipe.difficulty) || '未设置' },
    { label: '食材', value: `${recipe.ingredient_items.length} 种` },
    { label: '步骤', value: `${recipe.steps.length} 步` },
  ];
}

function recipeDraftUnitOptions(unit: string) {
  return buildUnitPresetOptions(unit).map((item) => ({ value: item, label: item }));
}

function recipeIngredientUsesPresenceQuantity(
  item: AiGeneratedRecipeDraft['ingredient_items'][number],
  ingredients: Ingredient[],
) {
  if (!item.ingredient_id) return false;
  const ingredient = ingredients.find((entry) => entry.id === item.ingredient_id);
  return Boolean(ingredient && !tracksIngredientQuantity(ingredient));
}

function recipeIngredientItemsFromUnknown(value: unknown): AiGeneratedRecipeDraft['ingredient_items'] {
  return asDraftArray(value).map((item) => ({
    ingredient_id: asText(item.ingredient_id) || asText(item.ingredientId) || null,
    ingredient_name: asText(item.ingredient_name) || asText(item.ingredientName) || asText(item.name),
    quantity: draftNumberInputValue(item.quantity, 1) as number,
    unit: asText(item.unit, '份'),
    note: asText(item.note),
  }));
}

function recipeStepsFromUnknown(value: unknown): AiGeneratedRecipeDraft['steps'] {
  return asDraftArray(value).map((item, index) => ({
    title: asText(item.title, `步骤 ${index + 1}`),
    text: asText(item.text),
    icon: asText(item.icon, 'pan'),
    summary: asText(item.summary),
    estimated_minutes: item.estimated_minutes === null ? null : asNumber(item.estimated_minutes, 5),
    tip: asText(item.tip),
    key_points: Array.isArray(item.key_points) ? item.key_points.map(String).filter(Boolean) : [],
  }));
}

function recipeDraftFromRecord(record: Record<string, unknown>, fallback?: Record<string, unknown>): AiGeneratedRecipeDraft {
  const fallbackRecord = fallback ?? {};
  const difficulty = asText(record.difficulty) || asText(fallbackRecord.difficulty) || 'easy';
  return {
    title: asText(record.title) || asText(fallbackRecord.title),
    servings: draftNumberInputValue(record.servings, asNumber(fallbackRecord.servings, 1)) as number,
    prep_minutes: draftNumberInputValue(record.prep_minutes, asNumber(fallbackRecord.prep_minutes, 0)) as number,
    difficulty: (DIFFICULTY_OPTIONS.some((option) => option.value === difficulty) ? difficulty : 'easy') as Difficulty,
    ingredient_items: recipeIngredientItemsFromUnknown(record.ingredient_items ?? fallbackRecord.ingredient_items),
    steps: recipeStepsFromUnknown(record.steps ?? fallbackRecord.steps),
    tips: asText(record.tips) || asText(fallbackRecord.tips),
    scene_tags: Array.isArray(record.scene_tags) ? record.scene_tags.map(String).filter(Boolean) : Array.isArray(fallbackRecord.scene_tags) ? fallbackRecord.scene_tags.map(String).filter(Boolean) : [],
    media_ids: Array.isArray(record.media_ids) ? record.media_ids.map(String).filter(Boolean) : [],
  };
}

function validateRecipeDraftForSubmit(recipe: AiGeneratedRecipeDraft) {
  if (!recipe.title.trim()) return '菜谱名不能为空';
  if (typeof recipe.servings !== 'number' || !Number.isFinite(recipe.servings) || recipe.servings <= 0) {
    return '份量需要大于 0';
  }
  if (!Array.isArray(recipe.ingredient_items) || recipe.ingredient_items.length === 0) {
    return '菜谱至少需要 1 个食材';
  }
  const invalidIngredient = recipe.ingredient_items.find((item) => !item.ingredient_id || !item.ingredient_name.trim());
  if (invalidIngredient) {
    return '菜谱食材必须从食材库选择；缺失食材请先创建食材档案';
  }
  const invalidQuantity = recipe.ingredient_items.find((item) => typeof item.quantity !== 'number' || !Number.isFinite(item.quantity) || item.quantity <= 0);
  if (invalidQuantity) {
    return '菜谱食材数量需要大于 0';
  }
  if (!Array.isArray(recipe.steps) || recipe.steps.length === 0) {
    return '菜谱至少需要 1 个步骤';
  }
  const invalidStep = recipe.steps.find((step) => !step.title.trim() && !step.text.trim());
  if (invalidStep) {
    return '每个步骤至少需要填写标题或说明';
  }
  return '';
}

function validateRecipeOperationDraftForSubmit(draft: Record<string, unknown>) {
  const action = asText(draft.action);
  const payload = typeof draft.payload === 'object' && draft.payload !== null && !Array.isArray(draft.payload)
    ? draft.payload as Record<string, unknown>
    : {};
  const before = typeof draft.before === 'object' && draft.before !== null && !Array.isArray(draft.before)
    ? draft.before as Record<string, unknown>
    : {};
  if (action === 'delete') return '';
  if (action === 'set_favorite') {
    return typeof payload.favorite === 'boolean' ? '' : '收藏状态必须从固定选项中选择';
  }
  return validateRecipeDraftForSubmit(recipeDraftFromRecord(payload, before));
}

function validateIngredientProfileDraftForSubmit(draft: Record<string, unknown>) {
  const operations = asDraftArray(draft.operations);
  if (operations.length > 0) {
    if (operations.length < 2) return '批量创建食材至少需要 2 项';
    if (operations.length > 5) return '批量创建食材一次不能超过 5 项';
    for (const [index, operation] of operations.entries()) {
      if (asText(operation.action) !== 'create') {
        return `第 ${index + 1} 个食材只能使用新增操作`;
      }
      const payload = typeof operation.payload === 'object' && operation.payload !== null && !Array.isArray(operation.payload)
        ? operation.payload as Record<string, unknown>
        : {};
      const error = validateIngredientProfilePayloadForSubmit(payload);
      if (error) return `第 ${index + 1} 个食材：${error}`;
    }
    return '';
  }
  const payload = typeof draft.payload === 'object' && draft.payload !== null && !Array.isArray(draft.payload)
    ? draft.payload as Record<string, unknown>
    : draft;
  return validateIngredientProfilePayloadForSubmit(payload);
}

function validateIngredientProfilePayloadForSubmit(payload: Record<string, unknown>) {
  if (!asText(payload.name).trim()) {
    return '食材名称不能为空';
  }
  if (!asText(payload.default_unit).trim()) {
    return '默认单位不能为空';
  }
  if (!asText(payload.default_storage).trim()) {
    return '默认保存位置不能为空';
  }
  if (asText(payload.default_expiry_mode, 'none') === 'days') {
    const days = payload.default_expiry_days;
    if (typeof days !== 'number' || !Number.isInteger(days) || days <= 0) {
      return '默认保质期天数需要填写大于 0 的整数';
    }
  }
  const threshold = payload.default_low_stock_threshold;
  if (threshold !== null && threshold !== undefined && threshold !== '') {
    if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold <= 0) {
      return '低库存阈值需要大于 0；如果不需要提醒，请留空';
    }
  }
  const conversions = asDraftArray(payload.unit_conversions);
  const invalidConversion = conversions.find((item) => {
    const unit = asText(item.unit).trim();
    const ratio = item.ratio_to_default;
    return !unit || typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio <= 0;
  });
  if (invalidConversion) {
    return '单位换算需要填写副单位，并且换算数量必须大于 0';
  }
  return '';
}

function formatDraftQuantity(quantity: unknown, unit: unknown) {
  const numeric = asNumber(quantity, 0);
  const display = Number.isInteger(numeric) ? String(numeric) : String(Number(numeric.toFixed(2)));
  return `${display}${asText(unit) ? ` ${asText(unit)}` : ''}`;
}

function recipeCookLinkedPlanSummary(value: Record<string, unknown> | undefined) {
  if (!value) return '未关联计划';
  const date = asText(value.plan_date) || asText(value.date);
  const meal = mealTypeLabel(value.meal_type ?? value.mealType);
  const food = asText(value.food_name) || asText(value.title) || asText(value.name);
  const status = asText(value.status) ? mealPlanStatusLabel(value.status) : '';
  return [date, meal, food, status].filter(Boolean).join(' · ') || '已关联计划';
}

function recipeCookSummaryItems(
  draft: Record<string, unknown>,
  previewItems: Record<string, unknown>[],
  shortages: Record<string, unknown>[],
  linkedPlanItem?: Record<string, unknown>,
) {
  const mealType = asText(draft.mealType, 'dinner');
  return [
    { label: '菜谱', value: asText(draft.title) || '菜谱' },
    { label: '份数', value: `${formatServingCount(draft.servings)} 份` },
    { label: '餐别', value: MEAL_TYPE_OPTIONS.find((option) => option.value === mealType)?.label || mealType },
    { label: '库存扣减', value: previewItems.length > 0 ? `${previewItems.length} 种食材` : '无扣减项' },
    { label: '餐食记录', value: Boolean(draft.createMealLog) ? '同时记录餐食' : '只扣库存不记录' },
    { label: '关联计划', value: recipeCookLinkedPlanSummary(linkedPlanItem) },
    { label: '缺料', value: shortages.length > 0 ? `${shortages.length} 项需补齐` : '库存充足' },
  ];
}

function validateRecipeCookDraftForSubmit(draft: Record<string, unknown>) {
  const servings = draft.servings;
  if (typeof servings !== 'number' || !Number.isFinite(servings) || servings <= 0) {
    return '做菜份数需要大于 0';
  }
  if (!asText(draft.date).trim()) {
    return '做菜日期不能为空';
  }
  const mealType = asText(draft.mealType);
  if (!MEAL_TYPE_OPTIONS.some((option) => option.value === mealType)) {
    return '餐别必须从固定选项中选择';
  }
  const shortages = asDraftArray(draft.shortages);
  if (shortages.length > 0) {
    return '当前做菜草稿包含缺料项，不能直接确认执行；请先补齐库存或调整份数后重新生成草稿';
  }
  const invalidPreviewItem = asDraftArray(draft.previewItems).find((item) => {
    const quantity = item.requested_quantity;
    return typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0 || !asText(item.unit).trim();
  });
  if (invalidPreviewItem) {
    return '库存扣减预览里的数量和单位需要完整有效';
  }
  return '';
}

function mealPlanActionLabel(action: string) {
  switch (action) {
    case 'create':
      return '新增';
    case 'update':
      return '修改';
    case 'set_status':
      return '状态变更';
    case 'delete':
      return '删除';
    default:
      return action || '计划';
  }
}

function mealPlanStatusLabel(value: unknown) {
  switch (asText(value, 'planned')) {
    case 'planned':
      return '计划中';
    case 'cooked':
      return '已完成';
    case 'skipped':
      return '已跳过';
    default:
      return asText(value) || '计划中';
  }
}

function mealPlanItemRecord(value: Record<string, unknown>) {
  return {
    ...value,
    date: asText(value.date),
    mealType: asText(value.mealType, 'dinner'),
    title: asText(value.title) || asText(value.foodName) || asText(value.name),
    foodId: asText(value.foodId) || asText(value.food_id),
    reason: asText(value.reason),
  };
}

function mealPlanMissingIngredientCount(value: Record<string, unknown>) {
  const detailedItems = asDraftArray(value.missingIngredientItems ?? value.missing_ingredient_items);
  if (detailedItems.length > 0) return detailedItems.length;
  const simpleItems = value.missingIngredients ?? value.missing_ingredients;
  return Array.isArray(simpleItems) ? simpleItems.length : 0;
}

function mealPlanSummaryItems(items: Record<string, unknown>[], operations: Record<string, unknown>[]) {
  const planItems = operations.length > 0
    ? operations.map((operation) => {
        const payload = typeof operation.payload === 'object' && operation.payload !== null && !Array.isArray(operation.payload)
          ? operation.payload as Record<string, unknown>
          : {};
        const before = typeof operation.before === 'object' && operation.before !== null && !Array.isArray(operation.before)
          ? operation.before as Record<string, unknown>
          : {};
        return mealPlanItemRecord({ ...before, ...payload });
      })
    : items.map(mealPlanItemRecord);
  const dates = new Set(planItems.map((item) => item.date).filter(Boolean));
  const mealTypes = new Set(planItems.map((item) => mealTypeLabel(item.mealType)).filter(Boolean));
  const missingCount = planItems.reduce((sum, item) => sum + mealPlanMissingIngredientCount(item), 0);
  const actionCounts = operations.reduce<Record<string, number>>((counts, operation) => {
    const label = mealPlanActionLabel(asText(operation.action));
    counts[label] = (counts[label] ?? 0) + 1;
    return counts;
  }, {});
  const changeSummary = operations.length > 0
    ? Object.entries(actionCounts).map(([label, count]) => `${label}${count}`).join('、')
    : '新增计划';
  return [
    { label: '计划项', value: `${operations.length > 0 ? operations.length : items.length} 项` },
    { label: '涉及天数', value: dates.size > 0 ? `${dates.size} 天` : '未填写' },
    { label: '餐别', value: mealTypes.size > 0 ? Array.from(mealTypes).join('、') : '未填写' },
    { label: '缺失食材', value: missingCount > 0 ? `${missingCount} 项` : '无' },
    { label: '变更', value: changeSummary },
  ];
}

function mealPlanResolvedTitle(status: AiApprovalRequest['status'], hasOperations: boolean) {
  if (status === 'approved') return hasOperations ? '餐食计划变更已确认' : '餐食计划已确认';
  if (status === 'rejected') return '未写入的餐食计划草稿';
  if (status === 'expired') return '已过期的餐食计划草稿';
  return hasOperations ? '待确认计划变更' : '待确认餐食计划';
}

function validateMealPlanItemForSubmit(item: Record<string, unknown>) {
  const record = mealPlanItemRecord(item);
  if (!record.date.trim()) return '每个计划项都需要填写日期';
  if (!MEAL_TYPE_OPTIONS.some((option) => option.value === record.mealType)) {
    return '计划项餐别必须从固定选项中选择';
  }
  if (!record.foodId.trim() || !record.title.trim()) {
    return '计划项食物必须从食物库选择；新食物请先创建食物资料';
  }
  const invalidMissing = asDraftArray(item.missingIngredientItems ?? item.missing_ingredient_items).find((ingredient) => {
    const quantity = ingredient.quantity;
    return !asText(ingredient.name).trim() || typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0 || !asText(ingredient.unit).trim();
  });
  if (invalidMissing) return '缺失食材需要填写名称、数量和单位，数量必须大于 0';
  return '';
}

function validateMealPlanDraftForSubmit(draft: Record<string, unknown>) {
  const operations = asDraftArray(draft.operations);
  if (operations.length > 0) {
    for (const operation of operations) {
      const action = asText(operation.action);
      const payload = typeof operation.payload === 'object' && operation.payload !== null && !Array.isArray(operation.payload)
        ? operation.payload as Record<string, unknown>
        : {};
      if (action === 'create' || action === 'update') {
        const itemError = validateMealPlanItemForSubmit(payload);
        if (itemError) return itemError;
      } else if (action === 'set_status') {
        if (!['planned', 'cooked', 'skipped'].includes(asText(payload.status))) {
          return '计划状态必须从固定选项中选择';
        }
      } else if (action !== 'delete') {
        return '未知的餐食计划操作';
      }
    }
    return '';
  }
  const items = asDraftArray(draft.items);
  if (items.length === 0) return '餐食计划至少需要 1 个计划项';
  for (const item of items) {
    const itemError = validateMealPlanItemForSubmit(item);
    if (itemError) return itemError;
  }
  return '';
}

function shoppingListActionLabel(action: string) {
  switch (action) {
    case 'create':
      return '新增';
    case 'update':
      return '修改';
    case 'set_done':
      return '状态变更';
    case 'delete':
      return '删除';
    default:
      return action || '采购项';
  }
}

function shoppingListDoneLabel(value: unknown) {
  return Boolean(value) ? '已买到' : '待买';
}

function shoppingListQuantityMode(value: Record<string, unknown>) {
  const mode = asText(value.quantityMode) || asText(value.quantity_mode);
  return mode === 'not_track_quantity' ? 'not_track_quantity' : 'track_quantity';
}

function shoppingListItemRecord(value: Record<string, unknown>) {
  const quantityMode = shoppingListQuantityMode(value);
  const quantity = draftNumberInputValue(value.quantity, 1);
  const unit = asText(value.unit, '份');
  return {
    ...value,
    title: asText(value.title) || asText(value.ingredientName) || asText(value.ingredient_name) || asText(value.name),
    ingredientId: asText(value.ingredientId) || asText(value.ingredient_id),
    quantityMode,
    quantity,
    unit,
    displayLabel: asText(value.displayLabel) || asText(value.display_label) || '需要补充',
    reason: asText(value.reason),
    done: Boolean(value.done),
  };
}

function shoppingListQuantitySummary(value: Record<string, unknown>) {
  const item = shoppingListItemRecord(value);
  if (item.quantityMode === 'not_track_quantity') return item.displayLabel || '需要补充';
  return `${formatServingCount(item.quantity)} ${item.unit}`.trim();
}

function shoppingListSummaryItems(items: Record<string, unknown>[], operations: Record<string, unknown>[]) {
  const records = operations.length > 0
    ? operations.map((operation) => {
        const payload = typeof operation.payload === 'object' && operation.payload !== null && !Array.isArray(operation.payload)
          ? operation.payload as Record<string, unknown>
          : {};
        const before = typeof operation.before === 'object' && operation.before !== null && !Array.isArray(operation.before)
          ? operation.before as Record<string, unknown>
          : {};
        return shoppingListItemRecord({ ...before, ...payload });
      })
    : items.map(shoppingListItemRecord);
  const actionCounts = operations.reduce<Record<string, number>>((counts, operation) => {
    const label = shoppingListActionLabel(asText(operation.action));
    counts[label] = (counts[label] ?? 0) + 1;
    return counts;
  }, {});
  const changeSummary = operations.length > 0
    ? Object.entries(actionCounts).map(([label, count]) => `${label}${count}`).join('、')
    : '新增采购项';
  return [
    { label: '采购项', value: `${operations.length > 0 ? operations.length : items.length} 项` },
    { label: '已绑定食材', value: `${records.filter((item) => item.ingredientId).length} 项` },
    { label: '只提醒补充', value: `${records.filter((item) => item.quantityMode === 'not_track_quantity').length} 项` },
    { label: '状态变更', value: `${operations.filter((item) => asText(item.action) === 'set_done').length} 项` },
    { label: '变更', value: changeSummary },
  ];
}

function shoppingListResolvedTitle(status: AiApprovalRequest['status'], hasOperations: boolean) {
  if (status === 'approved') return hasOperations ? '购物清单变更已确认' : '购物清单已确认';
  if (status === 'rejected') return '未写入的购物清单草稿';
  if (status === 'expired') return '已过期的购物清单草稿';
  return hasOperations ? '待确认清单变更' : '待确认购物清单';
}

function validateShoppingListItemForSubmit(item: Record<string, unknown>) {
  const record = shoppingListItemRecord(item);
  if (!record.ingredientId.trim() || !record.title.trim()) {
    return '采购项食材必须从食材库选择；缺失食材请先创建食材档案';
  }
  if (!SHOPPING_QUANTITY_MODE_OPTIONS.some((option) => option.value === record.quantityMode)) {
    return '采购数量模式必须从固定选项中选择';
  }
  if (record.quantityMode === 'not_track_quantity') {
    return record.displayLabel.trim() ? '' : '只提醒需要补充时，采购表达不能为空';
  }
  if (typeof record.quantity !== 'number' || !Number.isFinite(record.quantity) || record.quantity <= 0) {
    return '采购数量需要大于 0';
  }
  if (!record.unit.trim()) return '记录数量时，采购单位不能为空';
  return '';
}

function validateShoppingListDraftForSubmit(draft: Record<string, unknown>) {
  const operations = asDraftArray(draft.operations);
  if (operations.length > 0) {
    for (const operation of operations) {
      const action = asText(operation.action);
      const payload = typeof operation.payload === 'object' && operation.payload !== null && !Array.isArray(operation.payload)
        ? operation.payload as Record<string, unknown>
        : {};
      if (action === 'create' || action === 'update') {
        const itemError = validateShoppingListItemForSubmit(payload);
        if (itemError) return itemError;
      } else if (action === 'set_done') {
        if (typeof payload.done !== 'boolean') return '采购状态必须从固定选项中选择';
      } else if (action !== 'delete') {
        return '未知的购物清单操作';
      }
    }
    return '';
  }
  const items = asDraftArray(draft.items);
  if (items.length === 0) return '购物清单至少需要 1 个采购项';
  for (const item of items) {
    const itemError = validateShoppingListItemForSubmit(item);
    if (itemError) return itemError;
  }
  return '';
}

function uniqueTextList(value: unknown) {
  const values = Array.isArray(value)
    ? value.map(String)
    : typeof value === 'string'
      ? splitTextList(value)
      : [];
  return Array.from(new Set(values.map((item) => item.trim()).filter(Boolean)));
}

function foodProfileActionLabel(action: string) {
  switch (action) {
    case 'create':
      return '新增';
    case 'update':
      return '修改';
    case 'set_favorite':
      return '收藏';
    default:
      return action || '创建';
  }
}

function foodFavoriteLabel(value: unknown) {
  return Boolean(value) ? '已收藏' : '未收藏';
}

function foodProfileRecord(value: Record<string, unknown>, fallback: Record<string, unknown> = {}) {
  const type = asText(value.type) || asText(fallback.type) || 'readyMade';
  return {
    ...fallback,
    ...value,
    name: asText(value.name) || asText(fallback.name),
    type,
    category: asText(value.category) || asText(fallback.category),
    suitableMealTypes: uniqueTextList(value.suitable_meal_types ?? value.suitableMealTypes ?? fallback.suitable_meal_types ?? fallback.suitableMealTypes),
    flavorTags: uniqueTextList(value.flavor_tags ?? value.flavorTags ?? fallback.flavor_tags ?? fallback.flavorTags),
    sourceName: asText(value.source_name) || asText(value.sourceName) || asText(fallback.source_name) || asText(fallback.sourceName),
    notes: asText(value.notes) || asText(fallback.notes),
    favorite: Boolean(value.favorite ?? fallback.favorite),
  };
}

function foodProfileSummaryItems(record: ReturnType<typeof foodProfileRecord>) {
  return [
    { label: '食物名', value: record.name || '未命名食物' },
    { label: '类型', value: FOOD_TYPE_OPTIONS.find((option) => option.value === record.type)?.label || foodTypeText(record.type) || '未设置' },
    { label: '分类', value: record.category || '未填写' },
    { label: '适合餐别', value: record.suitableMealTypes.map(mealTypeLabel).filter(Boolean).join('、') || '未设置' },
    { label: '口味标签', value: record.flavorTags.join('、') || '未设置' },
    { label: '来源', value: record.sourceName || '未填写' },
  ];
}

function foodProfileResolvedTitle(status: AiApprovalRequest['status'], action: string) {
  const actionLabel = foodProfileActionLabel(action);
  if (status === 'approved') return `${actionLabel}食物资料已确认`;
  if (status === 'rejected') return '未写入的食物资料草稿';
  if (status === 'expired') return '已过期的食物资料草稿';
  return `${actionLabel}食物资料`;
}

function validateFoodProfilePayloadForSubmit(payload: Record<string, unknown>) {
  const record = foodProfileRecord(payload);
  if (!record.name.trim()) return '食物名称不能为空';
  if (!FOOD_TYPE_OPTIONS.some((option) => option.value === record.type)) {
    return '食物类型必须从固定选项中选择';
  }
  const invalidMealType = record.suitableMealTypes.find((mealType) => !MEAL_TYPE_OPTIONS.some((option) => option.value === mealType));
  if (invalidMealType) return '适合餐别必须从固定选项中选择';
  return '';
}

function normalizeFoodProfilePayload(payload: Record<string, unknown>) {
  const record = foodProfileRecord(payload);
  return {
    ...payload,
    name: record.name,
    type: record.type,
    category: record.category,
    suitable_meal_types: record.suitableMealTypes,
    flavor_tags: record.flavorTags,
    source_name: record.sourceName,
    notes: record.notes,
  };
}

function validateFoodProfileDraftForSubmit(draft: Record<string, unknown>) {
  const action = asText(draft.action);
  if (action === 'set_favorite') {
    const payload = typeof draft.payload === 'object' && draft.payload !== null && !Array.isArray(draft.payload)
      ? draft.payload as Record<string, unknown>
      : {};
    return typeof payload.favorite === 'boolean' ? '' : '收藏状态必须从固定选项中选择';
  }
  const payload = action
    ? (typeof draft.payload === 'object' && draft.payload !== null && !Array.isArray(draft.payload) ? draft.payload as Record<string, unknown> : {})
    : draft;
  return validateFoodProfilePayloadForSubmit(payload);
}

function mealLogFoodsFromDraft(value: unknown) {
  return asDraftArray(value).map((item) => ({
    ...item,
    foodId: asText(item.foodId) || asText(item.food_id),
    name: asText(item.name) || asText(item.foodName),
    servings: asNumber(item.servings, 1),
    note: asText(item.note),
  }));
}

function mealLogSummaryItems(record: Record<string, unknown>) {
  const foods = mealLogFoodsFromDraft(record.foods);
  const totalServings = foods.reduce((sum, food) => sum + asNumber(food.servings, 0), 0);
  return [
    { label: '日期', value: asText(record.date) || '未填写' },
    { label: '餐别', value: mealTypeLabel(record.mealType) || '未填写' },
    { label: '食物', value: `${foods.length} 项` },
    { label: '总份数', value: `${formatServingCount(totalServings)} 份` },
    { label: '参与人', value: countLabel(record.participantUserIds, '人') },
    { label: '照片', value: countLabel(record.mediaIds, '张') },
    { label: '关联计划', value: asText(record.planItemId) ? '已关联' : '未关联' },
    { label: '心情', value: asText(record.mood) || '未填写' },
  ];
}

function mealLogStatusTitle(status: AiApprovalRequest['status'], action: string) {
  const actionLabel = action === 'update_details' ? '补充' : action === 'rate_food' ? '评分' : '创建';
  if (status === 'approved') return `${actionLabel}餐食记录已确认`;
  if (status === 'rejected') return '未写入的餐食记录草稿';
  if (status === 'expired') return '已过期的餐食记录草稿';
  return `${actionLabel}餐食记录`;
}

function validateMealLogDraftForSubmit(draft: Record<string, unknown>) {
  const action = asText(draft.action);
  if (action === 'rate_food') {
    const ratings = asDraftArray((draft.payload as Record<string, unknown> | undefined)?.foodEntryRatings);
    if (ratings.length === 0) return '餐食评分至少需要 1 个食物项';
    const invalidRating = ratings.find((item) => {
      const rating = item.rating;
      return typeof rating !== 'number' || !Number.isFinite(rating) || rating < 1 || rating > 5;
    });
    return invalidRating ? '评分需要在 1 到 5 分之间' : '';
  }
  if (action === 'update_details') return '';
  const record = action === 'create'
    ? (typeof draft.payload === 'object' && draft.payload !== null && !Array.isArray(draft.payload) ? draft.payload as Record<string, unknown> : {})
    : draft;
  if (!asText(record.date).trim()) return '餐食日期不能为空';
  if (!MEAL_TYPE_OPTIONS.some((option) => option.value === asText(record.mealType))) {
    return '餐别必须从固定选项中选择';
  }
  const foods = mealLogFoodsFromDraft(record.foods);
  if (foods.length === 0) return '餐食记录至少需要 1 个食物项';
  const invalidFood = foods.find((food) => !asText(food.foodId).trim() || !asText(food.name).trim());
  if (invalidFood) return '餐食记录里的食物必须从食物库选择；新食物请先创建食物资料';
  const invalidServing = foods.find((food) => typeof food.servings !== 'number' || !Number.isFinite(food.servings) || food.servings <= 0);
  if (invalidServing) return '每个食物项份数需要大于 0';
  return '';
}

function ApprovalTagInput({
  label,
  values,
  disabled,
  placeholder,
  onChange,
}: {
  label: string;
  values: string[];
  disabled: boolean;
  placeholder: string;
  onChange: (values: string[]) => void;
}) {
  return (
    <label className="ai-resource-field ai-tag-input-field">
      <span>{label}</span>
      <input
        className="text-input"
        value={values.join('、')}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => onChange(splitTextList(event.target.value))}
      />
      {values.length > 0 && (
        <div className="ai-tag-preview" aria-label={`${label}预览`}>
          {values.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
      )}
    </label>
  );
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
    case 'cancelled':
    case 'canceled':
      return '已取消';
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

  const [isExpanded, setIsExpanded] = useState(isLatest && approval.status === 'pending');
  const foldTimeoutRef = useRef<any>(null);

  useEffect(() => {
    setIsExpanded(isLatest && approval.status === 'pending');
  }, [isLatest, approval.status]);

  useEffect(() => {
    return () => {
      if (foldTimeoutRef.current) {
        clearTimeout(foldTimeoutRef.current);
      }
    };
  }, []);

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
  const inventoryOperationDraft = useMemo(
    () => inventoryOperationDraftFromRecord(structuredDraft),
    [structuredDraft],
  );
  const staticFoodOptions = useMemo<AiResourceOption[]>(() => foods.map((food) => ({
    id: food.id,
    label: food.name,
    description: [food.category, foodTypeText(food.type)].filter(Boolean).join(' · '),
    imageUrl: resolveMediaUrl(food.images?.[0], 'thumb') ?? AI_RESOURCE_IMAGE_FALLBACK,
  })), [foods]);
  const staticIngredientOptions = useMemo<AiResourceOption[]>(() => ingredients.map((ingredient) => ({
    id: ingredient.id,
    label: ingredient.name,
    description: [ingredient.category, ingredient.default_unit].filter(Boolean).join(' · '),
    imageUrl: resolveMediaUrl(ingredient.image, 'thumb') ?? AI_RESOURCE_IMAGE_FALLBACK,
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
	  const foodCategoryOptions = useMemo(() => (
	    Array.from(new Set([
	      ...foods.map((food) => food.category).filter(Boolean),
	      ...FOOD_CATEGORY_PRESETS,
	    ])).map((category) => ({ value: category, label: category }))
	  ), [foods]);
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
      const recipeError = validateRecipeDraftForSubmit(recipe);
      if (recipeError) {
        setError(recipeError);
        return;
      }
      values = { recipe };
    } else if (usesStructuredDraftEditor) {
      if (draftType === 'recipe') {
        const recipeOperationError = validateRecipeOperationDraftForSubmit(structuredDraft);
        if (recipeOperationError) {
          setError(recipeOperationError);
          return;
        }
      }
      if (draftType === 'inventory_operation') {
        const inventoryError = validateInventoryOperationDraftForSubmit(inventoryOperationDraft);
        if (inventoryError) {
          setError(inventoryError);
          return;
        }
      }
      if (draftType === 'composite_operation') {
        const compositeError = validateCompositeOperationDraftForSubmit(structuredDraft);
        if (compositeError) {
          setError(compositeError);
          return;
        }
      }
      if (draftType === 'ingredient_profile') {
        const ingredientError = validateIngredientProfileDraftForSubmit(structuredDraft);
        if (ingredientError) {
          setError(ingredientError);
          return;
        }
      }
      if (draftType === 'recipe_cook') {
        const recipeCookError = validateRecipeCookDraftForSubmit(structuredDraft);
        if (recipeCookError) {
          setError(recipeCookError);
          return;
        }
      }
      if (draftType === 'meal_log') {
        const mealLogError = validateMealLogDraftForSubmit(structuredDraft);
        if (mealLogError) {
          setError(mealLogError);
          return;
        }
      }
      if (draftType === 'meal_plan') {
        const mealPlanError = validateMealPlanDraftForSubmit(structuredDraft);
        if (mealPlanError) {
          setError(mealPlanError);
          return;
        }
      }
      if (draftType === 'shopping_list') {
        const shoppingListError = validateShoppingListDraftForSubmit(structuredDraft);
	        if (shoppingListError) {
	          setError(shoppingListError);
	          return;
	        }
	      }
	      if (draftType === 'food_profile') {
	        const foodProfileError = validateFoodProfileDraftForSubmit(structuredDraft);
	        if (foodProfileError) {
	          setError(foodProfileError);
	          return;
	        }
	        if (asText(structuredDraft.action) && typeof structuredDraft.payload === 'object' && structuredDraft.payload !== null && !Array.isArray(structuredDraft.payload)) {
	          values = { draft: { ...structuredDraft, payload: normalizeFoodProfilePayload(structuredDraft.payload as Record<string, unknown>) } };
	        } else {
	          values = { draft: normalizeFoodProfilePayload(structuredDraft) };
	        }
	      } else {
	        values = { draft: structuredDraft };
	      }
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
      foldTimeoutRef.current = setTimeout(() => {
        setIsExpanded(false);
      }, 300);
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
  const updateInventoryOperationItem = (index: number, patch: InventoryOperationDraftItemPatch) => {
    updateDraftItem('operations', index, patch as Record<string, unknown>);
  };
  const renderStructuredDraftEditor = () => {
    if (draftType === 'composite_operation') {
      return (
        <AiCompositeOperationPreview
          draft={structuredDraft}
          status={currentApproval.status}
          readonly={readonly}
        />
      );
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
      const operationRecipe = recipeDraftFromRecord(payload, before);
      const deleteImpact = typeof before.deleteImpact === 'object' && before.deleteImpact !== null && !Array.isArray(before.deleteImpact)
        ? before.deleteImpact as Record<string, unknown>
        : {};
      const updatePayload = (patch: Record<string, unknown>) => updateDraft({ payload: { ...payload, ...patch } });
      const updateOperationIngredient = (index: number, patch: Partial<AiGeneratedRecipeDraft['ingredient_items'][number]>) => {
        updatePayload({
          ingredient_items: operationRecipe.ingredient_items.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)),
        });
      };
      const updateOperationStep = (index: number, patch: Partial<AiGeneratedRecipeDraft['steps'][number]>) => {
        updatePayload({
          steps: operationRecipe.steps.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)),
        });
      };
      const mediaCount = Array.isArray(before.media_ids)
        ? before.media_ids.length
        : Array.isArray(before.mediaIds)
          ? before.mediaIds.length
          : 0;
      if (currentApproval.status !== 'pending') {
        return (
          <div className="ai-recipe-editor ai-confirmation-editor ai-recipe-draft-editor">
            <section className="ai-confirmation-item ai-recipe-summary-card" aria-label="菜谱摘要">
              <div className="ai-recipe-summary-head">
                <div>
                  <strong>
                    {currentApproval.status === 'approved'
                      ? `${actionLabel}菜谱已确认`
                      : currentApproval.status === 'rejected'
                        ? '未写入的菜谱草稿'
                        : '已过期的菜谱草稿'}
                  </strong>
                  <span>{operationRecipe.title || '菜谱'}</span>
                </div>
                <em>{actionLabel}</em>
              </div>
              <dl className="ai-recipe-summary-grid">
                {recipeDraftSummaryItems(operationRecipe).map((item) => (
                  <div key={item.label}>
                    <dt>{item.label}</dt>
                    <dd>{item.value}</dd>
                  </div>
                ))}
              </dl>
              {operationRecipe.tips && <p className="ai-recipe-summary-note">{operationRecipe.tips}</p>}
            </section>
          </div>
        );
      }
      return (
        <div className="ai-recipe-editor ai-confirmation-editor ai-recipe-draft-editor">
          <div className="ai-draft-editor-head">
            <div>
              <strong>{actionLabel}菜谱</strong>
              <span>{operationRecipe.title || '菜谱'}</span>
            </div>
          </div>
          <section className="ai-confirmation-item ai-recipe-summary-card" aria-label="菜谱摘要">
            <div className="ai-recipe-summary-head">
              <div>
                <strong>{operationRecipe.title || '待确认菜谱'}</strong>
                <span>
                  {action === 'delete'
                    ? '确认后会删除菜谱，并按现有规则处理同步食物和媒体绑定。'
                    : action === 'set_favorite'
                      ? '确认后只更新收藏状态，不修改菜谱内容。'
                      : '确认后会写入菜谱资料，并同步关联的家常菜食物资料。'}
                </span>
              </div>
              <em>{actionLabel}</em>
            </div>
            <dl className="ai-recipe-summary-grid">
              {recipeDraftSummaryItems(operationRecipe).map((item) => (
                <div key={item.label}>
                  <dt>{item.label}</dt>
                  <dd>{item.value}</dd>
                </div>
              ))}
            </dl>
          </section>
          {action !== 'create' && (
            <p className="ai-approval-compare-copy">
              当前：{[asText(before.title), `${asNumber(before.servings)}人份`, difficultyLabel(before.difficulty)].filter(Boolean).join(' · ')}
            </p>
          )}
          {action === 'delete' ? (
            <div className="ai-confirmation-item">
              <div className="ai-confirmation-summary-card ai-recipe-danger-impact">
                <strong>删除影响</strong>
                <p>被删菜谱：{operationRecipe.title || asText(before.title) || '当前菜谱'}</p>
                <p>同步食物：{asNumber(deleteImpact.linkedFoodCount, 0)} 个</p>
                <p>关联计划：{asNumber(deleteImpact.planItemCount, 0)} 条</p>
                <p>历史烹饪：{asNumber(deleteImpact.cookLogCount, 0)} 条</p>
                <p>媒体绑定：{asNumber(deleteImpact.mediaCount, mediaCount)} 个</p>
              </div>
              <label className="ai-resource-field ai-confirmation-copy-field">
                <span>删除原因</span>
                <textarea className="text-input" rows={2} value={asText(payload.reason)} disabled={readonly} placeholder="可选，说明删除原因" onChange={(event) => updatePayload({ reason: event.target.value })} />
              </label>
            </div>
          ) : action === 'set_favorite' ? (
            <div className="ai-confirmation-item">
              <div className="ai-recipe-favorite-card">
                <div>
                  <span>当前：{Boolean(before.favorite) ? '已收藏' : '未收藏'}</span>
                  <strong>{operationRecipe.title || asText(before.title) || '当前菜谱'}</strong>
                  <p>调整后：{Boolean(payload.favorite) ? '已收藏' : '未收藏'}</p>
                </div>
                <em>收藏</em>
              </div>
              <ApprovalSelectField
                label="收藏状态"
                value={String(Boolean(payload.favorite))}
                disabled={readonly}
                options={[
                  { value: 'true', label: '加入收藏' },
                  { value: 'false', label: '移出收藏' },
                ]}
                icon="type"
                onChange={(favorite) => updatePayload({ favorite: favorite === 'true' })}
              />
            </div>
          ) : (
            <div className="ai-confirmation-item">
              <div className="ai-recipe-draft-section">
                <div className="ai-recipe-draft-section-head">
                  <strong>基础信息</strong>
                  <span>用于菜谱库展示、搜索和后续餐食计划。</span>
                </div>
                <label className="ai-resource-field">
                  <span>菜谱名</span>
                  <input className="text-input" value={operationRecipe.title} disabled={readonly} onChange={(event) => updatePayload({ title: event.target.value })} />
                </label>
                <div className="ai-confirmation-grid ai-confirmation-grid-three">
                  <label className="ai-resource-field">
                    <span>份量</span>
                    <input className="text-input" type="number" min={1} value={draftNumberInputValue(operationRecipe.servings, 1)} disabled={readonly} onChange={(event) => updatePayload({ servings: draftNumberFromInput(event.target.value) })} />
                  </label>
                  <label className="ai-resource-field">
                    <span>时间（分钟）</span>
                    <input className="text-input" type="number" min={0} value={draftNumberInputValue(operationRecipe.prep_minutes, 0)} disabled={readonly} onChange={(event) => updatePayload({ prep_minutes: draftNumberFromInput(event.target.value) })} />
                  </label>
                  <ApprovalSelectField
                    label="难度"
                    value={operationRecipe.difficulty}
                    disabled={readonly}
                    options={DIFFICULTY_OPTIONS}
                    icon="difficulty"
                    onChange={(difficulty) => updatePayload({ difficulty })}
                  />
                </div>
                <ApprovalTagInput
                  label="场景标签"
                  values={operationRecipe.scene_tags ?? []}
                  disabled={readonly}
                  placeholder="家常菜、快手菜"
                  onChange={(sceneTags) => updatePayload({ scene_tags: sceneTags })}
                />
                <label className="ai-resource-field ai-confirmation-copy-field">
                  <span>小贴士</span>
                  <textarea className="text-input" rows={2} value={operationRecipe.tips} disabled={readonly} placeholder="补充火候、替换食材等提示" onChange={(event) => updatePayload({ tips: event.target.value })} />
                </label>
              </div>
              <div className="ai-recipe-draft-section">
                <div className="ai-recipe-draft-section-head ai-recipe-draft-section-head-row">
                  <div>
                    <strong>食材匹配</strong>
                    <span>{operationRecipe.ingredient_items.length} 种食材，必须绑定到家庭食材库。</span>
                  </div>
                  {!readonly && (
                    <button className="ghost-button ai-draft-add-button" type="button" onClick={() => updatePayload({ ingredient_items: [...operationRecipe.ingredient_items, { ingredient_id: null, ingredient_name: '', quantity: 1, unit: '份', note: '' }] })}>
                      添加食材
                    </button>
                  )}
                </div>
                {operationRecipe.ingredient_items.map((item, index) => {
                  const usesPresenceQuantity = recipeIngredientUsesPresenceQuantity(item, ingredients);
                  return (
                    <div className={`ai-recipe-ingredient-card${item.ingredient_id ? '' : ' is-unbound'}`} key={`${item.ingredient_name}-${index}`}>
                      <AiSearchableResourceSelect
                        kind="ingredient"
                        label={`食材 ${index + 1}`}
                        value={item.ingredient_id ?? ''}
                        selectedLabel={item.ingredient_name}
                        placeholder="从食材库选择"
                        disabled={readonly}
                        selectedOption={ingredientOptions.find((option) => option.id === item.ingredient_id || option.label === item.ingredient_name) ?? null}
                        loadOptions={loadApprovalResourceOptions}
                        onSelect={(option) => updateOperationIngredient(index, {
                          ingredient_id: option.id,
                          ingredient_name: option.label,
                          unit: option.unit || item.unit || '',
                        })}
                      />
                      {!item.ingredient_id && (
                        <p className="ai-recipe-binding-warning">
                          未绑定到食材库。请先选择已有食材；如果家里还没有这个食材，应先生成食材档案草稿。
                        </p>
                      )}
                      {usesPresenceQuantity ? (
                        <div className="recipe-editor-ingredient-presence-note">用量写在步骤或备注里</div>
                      ) : (
                        <div className="ai-confirmation-grid ai-confirmation-grid-compact">
                          <label className="ai-resource-field">
                            <span>数量</span>
                            <input className="text-input" type="number" min={0.1} step={0.1} value={draftNumberInputValue(item.quantity)} disabled={readonly} onChange={(event) => updateOperationIngredient(index, { quantity: draftNumberFromInput(event.target.value) as number })} />
                          </label>
                          <ApprovalComboboxField
                            label="单位"
                            value={item.unit ?? ''}
                            disabled={readonly}
                            options={recipeDraftUnitOptions(item.unit ?? '')}
                            placeholder="选择单位"
                            icon="step"
                            onChange={(unit) => updateOperationIngredient(index, { unit })}
                          />
                        </div>
                      )}
                      <label className="ai-resource-field">
                        <span>处理备注</span>
                        <input className="text-input" value={item.note} disabled={readonly} placeholder="例如切块、提前浸泡" onChange={(event) => updateOperationIngredient(index, { note: event.target.value })} />
                      </label>
                      {!readonly && operationRecipe.ingredient_items.length > 1 && (
                        <button className="ghost-button ai-draft-remove-button" type="button" onClick={() => updatePayload({ ingredient_items: operationRecipe.ingredient_items.filter((_, itemIndex) => itemIndex !== index) })}>
                          删除食材
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="ai-recipe-draft-section">
                <div className="ai-recipe-draft-section-head ai-recipe-draft-section-head-row">
                  <div>
                    <strong>烹饪步骤</strong>
                    <span>{operationRecipe.steps.length} 步，标题或说明至少填写一项。</span>
                  </div>
                  {!readonly && (
                    <button className="ghost-button ai-draft-add-button" type="button" onClick={() => updatePayload({ steps: [...operationRecipe.steps, { title: `步骤 ${operationRecipe.steps.length + 1}`, text: '', icon: 'pan', summary: '', estimated_minutes: 5, tip: '', key_points: [] }] })}>
                      添加步骤
                    </button>
                  )}
                </div>
                {operationRecipe.steps.map((step, index) => (
                  <div className="ai-recipe-step-card" key={`${step.title}-${index}`}>
                    <label className="ai-resource-field">
                      <span>步骤 {index + 1}</span>
                      <input className="text-input ai-confirmation-title-input" value={step.title} disabled={readonly} placeholder={`步骤 ${index + 1}`} onChange={(event) => updateOperationStep(index, { title: event.target.value })} />
                    </label>
                    <div className="ai-confirmation-grid ai-confirmation-grid-three">
                      <label className="ai-resource-field">
                        <span>摘要</span>
                        <input className="text-input" value={step.summary ?? ''} disabled={readonly} placeholder="简短概括" onChange={(event) => updateOperationStep(index, { summary: event.target.value })} />
                      </label>
                      <label className="ai-resource-field">
                        <span>预计用时（分钟）</span>
                        <input className="text-input" type="number" min={1} value={draftNumberInputValue(step.estimated_minutes)} disabled={readonly} placeholder="分钟" onChange={(event) => updateOperationStep(index, { estimated_minutes: nullableDraftNumberFromInput(event.target.value) })} />
                      </label>
                      <ApprovalSelectField
                        label="步骤图标"
                        value={step.icon ?? 'pan'}
                        disabled={readonly}
                        options={RECIPE_STEP_ICON_OPTIONS}
                        icon="step"
                        onChange={(icon) => updateOperationStep(index, { icon })}
                      />
                    </div>
                    <label className="ai-resource-field ai-confirmation-copy-field">
                      <span>步骤说明</span>
                      <textarea className="text-input" rows={3} value={step.text} disabled={readonly} placeholder="详细说明操作方法" onChange={(event) => updateOperationStep(index, { text: event.target.value })} />
                    </label>
                    <ApprovalTagInput
                      label="关键点"
                      values={step.key_points ?? []}
                      disabled={readonly}
                      placeholder="火候、状态、注意点"
                      onChange={(keyPoints) => updateOperationStep(index, { key_points: keyPoints })}
                    />
                    {!readonly && operationRecipe.steps.length > 1 && (
                      <button className="ghost-button ai-draft-remove-button" type="button" onClick={() => updatePayload({ steps: operationRecipe.steps.filter((_, itemIndex) => itemIndex !== index) })}>
                        删除步骤
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      );
    }
    if (draftType === 'inventory_operation') {
      return (
        <AiInventoryOperationEditor
          draft={inventoryOperationDraft}
          readonly={readonly}
          onUpdateItem={updateInventoryOperationItem}
          onRemoveItem={(index) => removeDraftItem('operations', index)}
        />
      );
    }
    if (draftType === 'meal_plan') {
      const operations = asDraftArray(structuredDraft.operations);
      const items = asDraftArray(structuredDraft.items);
      const summaryItems = mealPlanSummaryItems(items, operations);
      const hasOperations = operations.length > 0;
      const renderMealPlanSummary = () => (
        <section className="ai-confirmation-item ai-meal-plan-summary-card" aria-label="餐食计划摘要">
          <div className="ai-recipe-summary-head">
            <div>
              <strong>{mealPlanResolvedTitle(currentApproval.status, hasOperations)}</strong>
              <span>
                {hasOperations
                  ? '确认后会按下方操作创建、修改、删除或更新计划状态。'
                  : '确认后会写入正式餐食计划，不会创建新食物资料。'}
              </span>
            </div>
            <em>{hasOperations ? '变更' : '创建'}</em>
          </div>
          <dl className="ai-recipe-summary-grid">
            {summaryItems.map((item) => (
              <div key={item.label}>
                <dt>{item.label}</dt>
                <dd>{item.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      );
      const renderPlanPreviewCard = (item: Record<string, unknown>, index: number, badge: string) => {
        const record = mealPlanItemRecord(item);
        return (
          <div className="ai-meal-plan-preview-card" key={`${badge}-${record.date}-${record.title}-${index}`}>
            <div className="ai-meal-plan-card-head">
              <div>
                <span>{[record.date, mealTypeLabel(record.mealType)].filter(Boolean).join(' · ') || '待安排'}</span>
                <strong>{record.title || '未选择食物'}</strong>
                <p>{record.foodId ? '已绑定食物库' : '需要从食物库选择'}</p>
              </div>
              <em>{badge}</em>
            </div>
            {record.reason && <p className="ai-meal-plan-preview-note">{record.reason}</p>}
          </div>
        );
      };
      const renderMissingIngredients = (item: Record<string, unknown>, onChange: (nextItems: Array<{ ingredientId: string; name: string; quantity: number | ''; unit: string }>) => void) => (
        <div className="ai-meal-plan-missing-section">
          <p className="ai-recipe-summary-note">这里仅作为计划缺料提醒，不会登记库存或加入购物清单。</p>
          <IngredientQuantityPicker
            label="缺失食材"
            items={normalizeMealPlanIngredientItems(
              item.missingIngredientItems ?? item.missing_ingredient_items ?? item.missingIngredients ?? item.missing_ingredients,
              ingredientOptions,
            )}
            disabled={readonly}
            selectedOptions={ingredientOptions}
            loadOptions={loadApprovalResourceOptions}
            onChange={onChange}
          />
        </div>
      );
      const renderEditablePlanItem = (
        item: Record<string, unknown>,
        index: number,
        patchItem: (patch: Record<string, unknown>) => void,
        options: { badge: string; before?: Record<string, unknown>; removable?: boolean; onRemove?: () => void },
      ) => {
        const record = mealPlanItemRecord(item);
        const selectedFood = foodOptions.find((option) => option.id === record.foodId) ?? null;
        return (
          <div className="ai-meal-plan-item-card" key={`${options.badge}-${record.date}-${record.title}-${index}`}>
            <div className="ai-meal-plan-card-head">
              <div>
                <span>{[record.date, mealTypeLabel(record.mealType)].filter(Boolean).join(' · ') || '待安排'}</span>
                <strong>{record.title || selectedFood?.label || '未选择食物'}</strong>
                <p>{selectedFood?.description || (record.foodId ? '已绑定食物库' : '需要从食物库选择')}</p>
              </div>
              <em>{options.badge}</em>
            </div>
            {options.before ? (
              <div className="ai-meal-plan-before-after">
                <p>当前：{[asText(options.before.date), mealTypeLabel(options.before.mealType), asText(options.before.title)].filter(Boolean).join(' · ') || '未记录'}</p>
                <p>调整后：{[record.date, mealTypeLabel(record.mealType), record.title].filter(Boolean).join(' · ') || '待填写'}</p>
              </div>
            ) : null}
            <div className="ai-meal-plan-item-top">
              <label className="ai-resource-field ai-resource-field-date">
                <span>日期</span>
                <div className="ai-resource-select">
                  <ResourceSelectIcon kind="calendar" />
                  <input type="date" value={record.date} disabled={readonly} onChange={(event) => patchItem({ date: event.target.value })} />
                </div>
              </label>
              <ApprovalSelectField
                label="餐别"
                value={record.mealType}
                disabled={readonly}
                options={MEAL_TYPE_OPTIONS}
                icon="meal"
                onChange={(mealType) => patchItem({ mealType })}
              />
            </div>
            <AiSearchableResourceSelect
              kind="food"
              label="食物"
              value={record.foodId}
              selectedLabel={record.title}
              placeholder="搜索食物库"
              disabled={readonly}
              selectedOption={selectedFood}
              loadOptions={loadApprovalResourceOptions}
              onSelect={(option) => patchItem({ foodId: option.id, food_id: option.id, title: option.label })}
            />
            {renderMissingIngredients(item, (nextItems) => patchItem({
              missingIngredientItems: nextItems,
              missingIngredients: nextItems.map((ingredient) => ingredient.name),
            }))}
            <label className="ai-resource-field ai-meal-plan-reason-field">
              <span>安排原因</span>
              <textarea className="text-input" rows={2} value={record.reason} disabled={readonly} placeholder="安排原因" onChange={(event) => patchItem({ reason: event.target.value })} />
            </label>
            {options.removable && !readonly && (
              <button className="ghost-button ai-draft-remove-button" type="button" onClick={options.onRemove}>
                删除计划项
              </button>
            )}
          </div>
        );
      };
      if (currentApproval.status !== 'pending') {
        return (
          <div className="ai-recipe-editor ai-confirmation-editor ai-meal-plan-draft-editor">
            {renderMealPlanSummary()}
            <section className="ai-confirmation-item">
              <div className="ai-recipe-draft-section">
                <div className="ai-recipe-draft-section-head">
                  <strong>计划项预览</strong>
                  <span>已处理状态只保留核对摘要，不展示禁用长表单。</span>
                </div>
                {(hasOperations ? operations : items).map((entry, index) => {
                  if (!hasOperations) return renderPlanPreviewCard(entry, index, '计划');
                  const action = asText(entry.action);
                  const payload = typeof entry.payload === 'object' && entry.payload !== null && !Array.isArray(entry.payload)
                    ? entry.payload as Record<string, unknown>
                    : {};
                  const before = typeof entry.before === 'object' && entry.before !== null && !Array.isArray(entry.before)
                    ? entry.before as Record<string, unknown>
                    : {};
                  return renderPlanPreviewCard({ ...before, ...payload }, index, mealPlanActionLabel(action));
                })}
              </div>
            </section>
          </div>
        );
      }
      return (
        <div className="ai-recipe-editor ai-confirmation-editor ai-meal-plan-draft-editor">
          <div className="ai-draft-editor-head">
            <div>
              <strong>{hasOperations ? '计划变更' : '创建餐食计划'}</strong>
              <span>{hasOperations ? `${operations.length} 条操作` : `${items.length} 条计划`}</span>
            </div>
          </div>
          {renderMealPlanSummary()}
          {hasOperations ? (
            <section className="ai-confirmation-item">
              <div className="ai-recipe-draft-section">
                <div className="ai-recipe-draft-section-head">
                  <strong>计划项</strong>
                  <span>按操作逐项核对会写入的计划变更。</span>
                </div>
                {operations.map((operation, index) => {
                  const action = asText(operation.action);
                  const payload = typeof operation.payload === 'object' && operation.payload !== null && !Array.isArray(operation.payload)
                    ? operation.payload as Record<string, unknown>
                    : {};
                  const before = typeof operation.before === 'object' && operation.before !== null && !Array.isArray(operation.before)
                    ? operation.before as Record<string, unknown>
                    : {};
                  if (action === 'set_status') {
                    return (
                      <div className="ai-meal-plan-item-card" key={`${action}-${asText(operation.targetId)}-${index}`}>
                        <div className="ai-meal-plan-card-head">
                          <div>
                            <span>{[asText(before.date), mealTypeLabel(before.mealType)].filter(Boolean).join(' · ') || '计划项'}</span>
                            <strong>{asText(before.title) || asText(operation.targetId) || '计划项'}</strong>
                            <p>状态：{mealPlanStatusLabel(before.status)} → {mealPlanStatusLabel(payload.status)}</p>
                          </div>
                          <em>{mealPlanActionLabel(action)}</em>
                        </div>
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
                      </div>
                    );
                  }
                  if (action === 'delete') {
                    return (
                      <div className="ai-meal-plan-item-card is-danger" key={`${action}-${asText(operation.targetId)}-${index}`}>
                        <div className="ai-meal-plan-card-head">
                          <div>
                            <span>{[asText(before.date), mealTypeLabel(before.mealType)].filter(Boolean).join(' · ') || '计划项'}</span>
                            <strong>{asText(before.title) || asText(operation.targetId) || '计划项'}</strong>
                            <p>确认后只删除这条计划，不删除食物资料。</p>
                          </div>
                          <em>{mealPlanActionLabel(action)}</em>
                        </div>
                        <div className="ai-recipe-danger-impact">
                          <strong>删除影响</strong>
                          <p>删除计划项：{[asText(before.date), mealTypeLabel(before.mealType), asText(before.title)].filter(Boolean).join(' · ') || asText(operation.targetId)}</p>
                          <p>不会删除食物资料；如有关联餐食记录，请在确认前核对。</p>
                        </div>
                        <label className="ai-resource-field ai-meal-plan-reason-field">
                          <span>删除原因</span>
                          <textarea className="text-input" rows={2} value={asText(payload.reason)} disabled={readonly} placeholder="可选，说明删除原因" onChange={(event) => updateOperationPayloadItem(index, { reason: event.target.value })} />
                        </label>
                      </div>
                    );
                  }
                  return renderEditablePlanItem(payload, index, (patch) => updateOperationPayloadItem(index, patch), {
                    badge: mealPlanActionLabel(action),
                    before: action === 'update' ? before : undefined,
                  });
                })}
              </div>
            </section>
          ) : (
            <>
              <section className="ai-confirmation-item">
                <div className="ai-recipe-draft-section">
                  <div className="ai-recipe-draft-section-head ai-recipe-draft-section-head-row">
                    <div>
                      <strong>计划项</strong>
                      <span>每个计划项都需要绑定食物库中的食物。</span>
                    </div>
                    {!readonly && (
                      <button className="ghost-button ai-draft-add-button" type="button" onClick={() => addDraftItem('items', { date: new Date().toISOString().slice(0, 10), mealType: 'dinner', title: '', foodId: '', reason: '', missingIngredients: [] })}>
                        添加计划
                      </button>
                    )}
                  </div>
                  {items.map((item, index) => renderEditablePlanItem(item, index, (patch) => updateDraftItem('items', index, patch), {
                    badge: '新增',
                    removable: items.length > 1,
                    onRemove: () => removeDraftItem('items', index),
                  }))}
                </div>
              </section>
            </>
          )}
        </div>
      );
    }
    if (draftType === 'shopping_list') {
      const operations = asDraftArray(structuredDraft.operations);
      const items = asDraftArray(structuredDraft.items);
      const hasOperations = operations.length > 0;
      const summaryItems = shoppingListSummaryItems(items, operations);
      const findIngredientOption = (record: Record<string, unknown>) => {
        const item = shoppingListItemRecord(record);
        return ingredientOptions.find((option) => option.id === item.ingredientId || option.label === item.title) ?? null;
      };
      const renderShoppingListSummary = () => (
        <section className="ai-confirmation-item ai-shopping-list-summary-card" aria-label="购物清单摘要">
          <div className="ai-recipe-summary-head">
            <div>
              <strong>{shoppingListResolvedTitle(currentApproval.status, hasOperations)}</strong>
              <span>
                {hasOperations
                  ? '确认后会按下方操作创建、修改、删除或更新采购状态。'
                  : '确认后会写入购物清单，缺失食材需要先创建食材档案。'}
              </span>
            </div>
            <em>{hasOperations ? '变更' : '创建'}</em>
          </div>
          <dl className="ai-recipe-summary-grid">
            {summaryItems.map((item) => (
              <div key={item.label}>
                <dt>{item.label}</dt>
                <dd>{item.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      );
      const renderShoppingPreviewCard = (item: Record<string, unknown>, index: number, badge: string) => {
        const record = shoppingListItemRecord(item);
        return (
          <div className="ai-shopping-list-preview-card" key={`${badge}-${record.title}-${index}`}>
            <div className="ai-shopping-list-card-head">
              <div>
                <span>{shoppingListQuantitySummary(record)}</span>
                <strong>{record.title || '未选择食材'}</strong>
                <p>{record.ingredientId ? '已绑定食材库' : '需要从食材库选择'}</p>
              </div>
              <em>{badge}</em>
            </div>
            {record.reason && <p className="ai-shopping-list-preview-note">{record.reason}</p>}
          </div>
        );
      };
      const renderEditableShoppingItem = (
        item: Record<string, unknown>,
        index: number,
        patchItem: (patch: Record<string, unknown>) => void,
        options: { badge: string; before?: Record<string, unknown>; removable?: boolean; onRemove?: () => void },
      ) => {
        const record = shoppingListItemRecord(item);
        const selectedIngredient = findIngredientOption(record);
        const usesPresenceQuantity = record.quantityMode === 'not_track_quantity';
        const unitOptions = buildUnitPresetOptions(selectedIngredient?.unit || record.unit).map((unit) => ({ value: unit, label: unit }));
        return (
          <div className="ai-shopping-list-item-card" key={`${options.badge}-${record.title}-${index}`}>
            <div className="ai-shopping-list-card-head">
              <div>
                <span>{shoppingListQuantitySummary(record)}</span>
                <strong>{record.title || selectedIngredient?.label || '未选择食材'}</strong>
                <p>{selectedIngredient?.description || (record.ingredientId ? '已绑定食材库' : '需要从食材库选择')}</p>
              </div>
              <em>{options.badge}</em>
            </div>
            {options.before ? (
              <div className="ai-shopping-list-before-after">
                <p>当前：{[asText(options.before.title), shoppingListQuantitySummary(options.before)].filter(Boolean).join(' · ') || '未记录'}</p>
                <p>调整后：{[record.title, shoppingListQuantitySummary(record)].filter(Boolean).join(' · ') || '待填写'}</p>
              </div>
            ) : null}
            <div className="ai-shopping-list-section">
              <div className="ai-recipe-draft-section-head">
                <strong>采购项</strong>
                <span>必须绑定食材库中的食材。</span>
              </div>
              <AiSearchableResourceSelect
                kind="ingredient"
                label="采购食材"
                value={record.ingredientId}
                selectedLabel={record.title}
                placeholder="从食材库选择"
                disabled={readonly}
                selectedOption={selectedIngredient}
                loadOptions={loadApprovalResourceOptions}
                onSelect={(option) => patchItem({
                  ingredientId: option.id,
                  ingredient_id: option.id,
                  title: option.label,
                  unit: option.unit || record.unit,
                })}
              />
            </div>
            <div className="ai-shopping-list-section">
              <div className="ai-recipe-draft-section-head">
                <strong>数量与单位</strong>
                <span>选择是否记录明确数量；单位可从预设中选择或自定义。</span>
              </div>
              <ApprovalSelectField
                label="数量模式"
                value={record.quantityMode}
                disabled={readonly}
                options={SHOPPING_QUANTITY_MODE_OPTIONS}
                icon="type"
                onChange={(quantityMode) => patchItem({ quantityMode, quantity_mode: quantityMode })}
              />
              {usesPresenceQuantity ? (
                <label className="ai-resource-field">
                  <span>采购表达</span>
                  <input className="text-input" value={record.displayLabel} disabled={readonly} onChange={(event) => patchItem({ displayLabel: event.target.value, display_label: event.target.value })} />
                </label>
              ) : (
                <div className="ai-confirmation-grid ai-confirmation-grid-compact">
                  <label className="ai-resource-field">
                    <span>数量</span>
                    <input className="text-input" type="number" min={0.1} step={0.1} value={draftNumberInputValue(record.quantity, 1)} disabled={readonly} onChange={(event) => patchItem({ quantity: draftNumberFromInput(event.target.value) })} />
                  </label>
                  <ApprovalComboboxField
                    label="单位"
                    value={record.unit}
                    disabled={readonly}
                    options={unitOptions}
                    placeholder="选择或输入单位"
                    icon="type"
                    onChange={(unit) => patchItem({ unit })}
                  />
                </div>
              )}
            </div>
            <label className="ai-resource-field ai-confirmation-copy-field">
              <span>采购原因</span>
              <textarea className="text-input" rows={2} value={record.reason} disabled={readonly} placeholder="为什么需要采购" onChange={(event) => patchItem({ reason: event.target.value })} />
            </label>
            {options.removable && !readonly && (
              <button className="ghost-button ai-draft-remove-button" type="button" onClick={options.onRemove}>
                删除采购项
              </button>
            )}
          </div>
        );
      };
      if (currentApproval.status !== 'pending') {
        return (
          <div className="ai-recipe-editor ai-confirmation-editor ai-shopping-list-draft-editor">
            {renderShoppingListSummary()}
            <section className="ai-confirmation-item">
              <div className="ai-recipe-draft-section">
                <div className="ai-recipe-draft-section-head">
                  <strong>采购项预览</strong>
                  <span>已处理状态只保留核对摘要，不展示禁用长表单。</span>
                </div>
                {(hasOperations ? operations : items).map((entry, index) => {
                  if (!hasOperations) return renderShoppingPreviewCard(entry, index, '采购项');
                  const action = asText(entry.action);
                  const payload = typeof entry.payload === 'object' && entry.payload !== null && !Array.isArray(entry.payload)
                    ? entry.payload as Record<string, unknown>
                    : {};
                  const before = typeof entry.before === 'object' && entry.before !== null && !Array.isArray(entry.before)
                    ? entry.before as Record<string, unknown>
                    : {};
                  return renderShoppingPreviewCard({ ...before, ...payload }, index, shoppingListActionLabel(action));
                })}
              </div>
            </section>
          </div>
        );
      }
      return (
        <div className="ai-recipe-editor ai-confirmation-editor ai-shopping-list-draft-editor">
          <div className="ai-draft-editor-head">
            <div>
              <strong>{hasOperations ? '清单变更' : '创建购物清单'}</strong>
              <span>{hasOperations ? `${operations.length} 条操作` : `${items.length} 条采购项`}</span>
            </div>
          </div>
          {renderShoppingListSummary()}
          {hasOperations ? (
            <section className="ai-confirmation-item">
              <div className="ai-recipe-draft-section">
                <div className="ai-recipe-draft-section-head">
                  <strong>清单操作</strong>
                  <span>按操作逐项核对会写入的购物清单变更。</span>
                </div>
                {operations.map((operation, index) => {
                  const action = asText(operation.action);
                  const payload = typeof operation.payload === 'object' && operation.payload !== null && !Array.isArray(operation.payload)
                    ? operation.payload as Record<string, unknown>
                    : {};
                  const before = typeof operation.before === 'object' && operation.before !== null && !Array.isArray(operation.before)
                    ? operation.before as Record<string, unknown>
                    : {};
                  const beforeRecord = shoppingListItemRecord(before);
                  if (action === 'set_done') {
                    return (
                      <div className="ai-shopping-list-item-card" key={`${action}-${asText(operation.targetId)}-${index}`}>
                        <div className="ai-shopping-list-card-head">
                          <div>
                            <span>{shoppingListQuantitySummary(beforeRecord)}</span>
                            <strong>{beforeRecord.title || asText(operation.targetId) || '采购项'}</strong>
                            <p>状态：{shoppingListDoneLabel(before.done)} → {shoppingListDoneLabel(payload.done)}</p>
                          </div>
                          <em>{shoppingListActionLabel(action)}</em>
                        </div>
                        <ApprovalSelectField
                          label="采购状态"
                          value={String(Boolean(payload.done))}
                          disabled={readonly}
                          options={SHOPPING_DONE_OPTIONS}
                          icon="type"
                          onChange={(done) => updateOperationPayloadItem(index, { done: done === 'true' })}
                        />
                        <label className="ai-resource-field ai-confirmation-copy-field">
                          <span>状态说明</span>
                          <textarea className="text-input" rows={2} value={asText(payload.reason)} disabled={readonly} placeholder="可选，说明状态变更" onChange={(event) => updateOperationPayloadItem(index, { reason: event.target.value })} />
                        </label>
                      </div>
                    );
                  }
                  if (action === 'delete') {
                    return (
                      <div className="ai-shopping-list-item-card is-danger" key={`${action}-${asText(operation.targetId)}-${index}`}>
                        <div className="ai-shopping-list-card-head">
                          <div>
                            <span>{shoppingListQuantitySummary(beforeRecord)}</span>
                            <strong>{beforeRecord.title || asText(operation.targetId) || '采购项'}</strong>
                            <p>确认后只删除这条采购项，不影响食材档案和库存。</p>
                          </div>
                          <em>{shoppingListActionLabel(action)}</em>
                        </div>
                        <div className="ai-recipe-danger-impact">
                          <strong>删除影响</strong>
                          <p>删除采购项：{[beforeRecord.title, shoppingListQuantitySummary(beforeRecord), shoppingListDoneLabel(before.done)].filter(Boolean).join(' · ')}</p>
                          <p>不会删除食材档案，也不会调整库存数量。</p>
                        </div>
                      </div>
                    );
                  }
                  return renderEditableShoppingItem(payload, index, (patch) => updateOperationPayloadItem(index, patch), {
                    badge: shoppingListActionLabel(action),
                    before: action === 'update' ? before : undefined,
                  });
                })}
              </div>
            </section>
          ) : (
            <section className="ai-confirmation-item">
              <div className="ai-recipe-draft-section">
                <div className="ai-recipe-draft-section-head ai-recipe-draft-section-head-row">
                  <div>
                    <strong>采购项</strong>
                    <span>每个采购项都需要绑定食材库中的食材。</span>
                  </div>
                  {!readonly && (
                    <button className="ghost-button ai-draft-add-button" type="button" onClick={() => addDraftItem('items', { title: '', ingredient_id: '', quantityMode: 'track_quantity', quantity_mode: 'track_quantity', quantity: 1, unit: '份', reason: '' })}>
                      添加采购项
                    </button>
                  )}
                </div>
                {items.map((item, index) => renderEditableShoppingItem(item, index, (patch) => updateDraftItem('items', index, patch), {
                  badge: '新增',
                  removable: items.length > 1,
                  onRemove: () => removeDraftItem('items', index),
                }))}
              </div>
            </section>
          )}
        </div>
      );
    }
    if (draftType === 'meal_log') {
      const action = asText(structuredDraft.action);
      const before = typeof structuredDraft.before === 'object' && structuredDraft.before !== null && !Array.isArray(structuredDraft.before)
        ? structuredDraft.before as Record<string, unknown>
        : {};
      const payload = typeof structuredDraft.payload === 'object' && structuredDraft.payload !== null && !Array.isArray(structuredDraft.payload)
        ? structuredDraft.payload as Record<string, unknown>
        : {};
      const isCreate = !action || action === 'create';
      const createRecord = action === 'create' ? payload : structuredDraft;
      const editableFoods = mealLogFoodsFromDraft(createRecord.foods);
      const updateMealLogRecord = (patch: Record<string, unknown>) => {
        if (action === 'create') {
          updateDraft({ payload: { ...payload, ...patch } });
        } else {
          updateDraft(patch);
        }
      };
      const updateMealLogFood = (index: number, patch: Record<string, unknown>) => {
        updateMealLogRecord({
          foods: editableFoods.map((food, foodIndex) => (foodIndex === index ? { ...food, ...patch } : food)),
        });
      };
      const addMealLogFood = () => {
        updateMealLogRecord({ foods: [...editableFoods, { foodId: '', name: '', servings: 1, note: '' }] });
      };
      const removeMealLogFood = (index: number) => {
        if (editableFoods.length <= 1) return;
        updateMealLogRecord({ foods: editableFoods.filter((_, foodIndex) => foodIndex !== index) });
      };
      const renderReferenceChips = (label: string, value: unknown, emptyLabel: string) => {
        const values = Array.isArray(value) ? value.map(String).filter(Boolean) : [];
        return (
          <div className="ai-meal-log-reference-group">
            <span>{label}</span>
            <div className="ai-meal-log-reference-chips">
              {values.length > 0 ? values.map((item) => <em key={item}>{item}</em>) : <em className="is-empty">{emptyLabel}</em>}
            </div>
          </div>
        );
      };
      const renderMealLogSummary = (record: Record<string, unknown>, title: string, badge: string) => (
        <section className="ai-confirmation-item ai-confirmation-summary-card ai-meal-log-summary-card" aria-label="餐食记录摘要">
          <div className="ai-recipe-summary-head">
            <div>
              <strong>{title}</strong>
              <span>{[asText(record.date), mealTypeLabel(record.mealType)].filter(Boolean).join(' · ') || '餐食记录'}</span>
            </div>
            <em>{badge}</em>
          </div>
          <div className="ai-meal-log-summary-grid">
            {mealLogSummaryItems(record).map((item) => (
              <div key={item.label}>
                <span>{item.label}</span>
                <strong>{item.value}</strong>
              </div>
            ))}
          </div>
          {asText(record.notes) && <p className="ai-meal-log-summary-note">{asText(record.notes)}</p>}
        </section>
      );
      const renderMealLogCreateEditor = () => (
        <>
          {renderMealLogSummary(
            createRecord,
            currentApproval.status === 'pending' ? '待确认餐食记录' : mealLogStatusTitle(currentApproval.status, 'create'),
            '创建',
          )}
          {currentApproval.status === 'pending' && (
            <>
              <section className="ai-confirmation-item">
                <div className="ai-recipe-draft-section">
                  <div className="ai-recipe-draft-section-head">
                    <strong>餐食信息</strong>
                    <span>确认日期、餐别和是否关联计划。</span>
                  </div>
                  <div className="ai-confirmation-grid">
                    <label className="ai-resource-field ai-resource-field-date">
                      <span>日期</span>
                      <div className="ai-resource-select">
                        <ResourceSelectIcon kind="calendar" />
                        <input type="date" value={asText(createRecord.date)} disabled={readonly} onChange={(event) => updateMealLogRecord({ date: event.target.value })} />
                      </div>
                    </label>
                    <ApprovalSelectField
                      label="餐别"
                      value={asText(createRecord.mealType, 'dinner')}
                      disabled={readonly}
                      options={MEAL_TYPE_OPTIONS}
                      icon="meal"
                      onChange={(mealType) => updateMealLogRecord({ mealType })}
                    />
                  </div>
                  <p className="ai-approval-compare-copy">
                    关联计划：{asText(createRecord.planItemId) ? '已关联计划项' : '未关联计划'}
                  </p>
                </div>
              </section>
              <section className="ai-confirmation-item">
                <div className="ai-recipe-draft-section">
                  <div className="ai-recipe-draft-section-head ai-recipe-draft-section-head-row">
                    <div>
                      <strong>食物项</strong>
                      <span>每个食物都必须从食物库选择，新食物先创建食物资料。</span>
                    </div>
                    {!readonly && (
                      <button className="ghost-button ai-draft-add-button" type="button" onClick={addMealLogFood}>
                        添加食物
                      </button>
                    )}
                  </div>
                  {editableFoods.map((food, index) => {
                    const selectedFood = foodOptions.find((option) => option.id === asText(food.foodId) || option.label === asText(food.name)) ?? null;
                    return (
                      <div className="ai-meal-log-food-item" key={`${asText(food.name)}-${index}`}>
                        <div className="ai-meal-log-food-head">
                          <div>
                            <span>食物 {index + 1}</span>
                            <strong>{asText(food.name) || selectedFood?.label || '未选择食物'}</strong>
                            <p>{selectedFood?.description || (asText(food.foodId) ? '已绑定食物库' : '需要从食物库选择')}</p>
                          </div>
                          <em>{formatServingCount(food.servings)} 份</em>
                        </div>
                        <AiSearchableResourceSelect
                          kind="food"
                          label="食物"
                          value={asText(food.foodId)}
                          selectedLabel={asText(food.name)}
                          placeholder="从食物库选择"
                          disabled={readonly}
                          selectedOption={selectedFood}
                          loadOptions={loadApprovalResourceOptions}
                          onSelect={(option) => updateMealLogFood(index, { foodId: option.id, food_id: option.id, name: option.label })}
                        />
                        <label className="ai-resource-field">
                          <span>份数</span>
                          <input className="text-input" type="number" min={0.1} step={0.1} value={draftNumberInputValue(food.servings, 1)} disabled={readonly} onChange={(event) => updateMealLogFood(index, { servings: draftNumberFromInput(event.target.value) })} />
                        </label>
                        <label className="ai-resource-field ai-confirmation-copy-field">
                          <span>食物备注</span>
                          <textarea className="text-input" rows={2} value={asText(food.note)} disabled={readonly} placeholder="这份食物的补充说明" onChange={(event) => updateMealLogFood(index, { note: event.target.value })} />
                        </label>
                        {!readonly && editableFoods.length > 1 && (
                          <button className="ghost-button ai-draft-remove-button" type="button" onClick={() => removeMealLogFood(index)}>
                            删除食物
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
              <section className="ai-confirmation-item">
                <div className="ai-recipe-draft-section">
                  <div className="ai-recipe-draft-section-head">
                    <strong>参与人和照片</strong>
                    <span>当前审批内先只读核对成员和照片引用。</span>
                  </div>
                  <div className="ai-meal-log-reference-grid">
                    {renderReferenceChips('参与人', createRecord.participantUserIds, '未指定')}
                    {renderReferenceChips('照片', createRecord.mediaIds, '无照片')}
                  </div>
                </div>
              </section>
              <section className="ai-confirmation-item">
                <div className="ai-recipe-draft-section">
                  <div className="ai-recipe-draft-section-head">
                    <strong>备注与心情</strong>
                    <span>补充这一餐的主观记录。</span>
                  </div>
                  <ApprovalComboboxField
                    label="心情"
                    value={asText(createRecord.mood)}
                    disabled={readonly}
                    options={MEAL_LOG_MOOD_OPTIONS}
                    placeholder="选择或输入心情"
                    icon="type"
                    onChange={(mood) => updateMealLogRecord({ mood })}
                  />
                  <label className="ai-resource-field ai-confirmation-copy-field">
                    <span>餐食备注</span>
                    <textarea className="text-input" rows={3} value={asText(createRecord.notes)} disabled={readonly} placeholder="记录这一餐的整体情况" onChange={(event) => updateMealLogRecord({ notes: event.target.value })} />
                  </label>
                </div>
              </section>
            </>
          )}
        </>
      );
      if (isCreate) {
        return (
          <div className="ai-recipe-editor ai-confirmation-editor ai-meal-log-draft-editor">
            {renderMealLogCreateEditor()}
          </div>
        );
      }
      const updateRecord = { ...before, ...payload };
      const updatePayload = (patch: Record<string, unknown>) => updateDraft({ payload: { ...payload, ...patch } });
      const foodRatings = asDraftArray(payload.foodEntryRatings);
      if (currentApproval.status !== 'pending') {
        return (
          <div className="ai-recipe-editor ai-confirmation-editor ai-meal-log-draft-editor">
            {renderMealLogSummary(updateRecord, mealLogStatusTitle(currentApproval.status, action), action === 'rate_food' ? '评分' : '补充')}
          </div>
        );
      }
      return (
        <div className="ai-recipe-editor ai-confirmation-editor ai-meal-log-draft-editor">
          {renderMealLogSummary(updateRecord, action === 'update_details' ? '补充餐食记录' : '更新餐食评分', action === 'rate_food' ? '评分' : '补充')}
          {action === 'update_details' ? (
            <>
              <section className="ai-confirmation-item">
                <div className="ai-recipe-draft-section">
                  <div className="ai-recipe-draft-section-head">
                    <strong>参与人和照片</strong>
                    <span>当前审批内先只读核对成员和照片引用。</span>
                  </div>
                  <div className="ai-meal-log-reference-grid">
                    {renderReferenceChips('参与人', payload.participantUserIds, '不变更')}
                    {renderReferenceChips('照片', payload.mediaIds, '不变更')}
                  </div>
                </div>
              </section>
              <section className="ai-confirmation-item">
                <div className="ai-recipe-draft-section">
                  <div className="ai-recipe-draft-section-head">
                    <strong>备注与心情</strong>
                    <span>只补充餐食记录细节，不修改食物项。</span>
                  </div>
                  <ApprovalComboboxField
                    label="心情"
                    value={asText(payload.mood)}
                    disabled={readonly}
                    options={MEAL_LOG_MOOD_OPTIONS}
                    placeholder="选择或输入心情"
                    icon="type"
                    onChange={(mood) => updatePayload({ mood })}
                  />
                  <label className="ai-resource-field ai-confirmation-copy-field">
                    <span>备注</span>
                    <textarea className="text-input" rows={3} value={asText(payload.notes)} disabled={readonly} placeholder="补充这一餐的说明" onChange={(event) => updatePayload({ notes: event.target.value })} />
                  </label>
                </div>
              </section>
            </>
          ) : action === 'rate_food' ? (
            <section className="ai-confirmation-item">
              <div className="ai-recipe-draft-section">
                <div className="ai-recipe-draft-section-head">
                  <strong>食物评分</strong>
                  <span>逐项确认本次评分变化。</span>
                </div>
                {foodRatings.map((item, index) => {
                  const food = asDraftArray(before.foods).find((entry) => asText(entry.id) === asText(item.id));
                  return (
                    <div className="ai-meal-log-rating-card" key={`${asText(item.id)}-${index}`}>
                      <p className="ai-approval-compare-copy">
                        {asText(food?.foodName) || asText(item.id)} · 当前评分 {ratingDisplayText(food?.rating)} · 新评分 {ratingDisplayText(item.rating)}
                      </p>
                      <div className="ai-resource-field ai-rating-field">
                        <span>新评分</span>
                        <FoodRatingInput
                          value={ratingInputValue(item.rating)}
                          disabled={readonly}
                          onChange={(value) => updatePayload({ foodEntryRatings: foodRatings.map((ratingItem, ratingIndex) => ratingIndex === index ? { ...ratingItem, rating: Number(value) || null } : ratingItem) })}
                        />
                      </div>
                      <label className="ai-resource-field ai-confirmation-copy-field">
                        <span>评分备注</span>
                        <textarea
                          className="text-input"
                          rows={2}
                          value={asText(item.note)}
                          disabled={readonly}
                          placeholder="可选，记录这次评分原因"
                          onChange={(event) => updatePayload({ foodEntryRatings: foodRatings.map((ratingItem, ratingIndex) => ratingIndex === index ? { ...ratingItem, note: event.target.value } : ratingItem) })}
                        />
                      </label>
                    </div>
                  );
                })}
              </div>
            </section>
          ) : null}
        </div>
      );
    }
    if (draftType === 'recipe_cook') {
      const previewItems = asDraftArray(structuredDraft.previewItems);
      const shortages = asDraftArray(structuredDraft.shortages);
      const linkedPlanItem = typeof structuredDraft.before === 'object' && structuredDraft.before !== null && !Array.isArray(structuredDraft.before)
        ? (structuredDraft.before as Record<string, unknown>).linkedPlanItem as Record<string, unknown> | undefined
        : undefined;
      const summaryItems = recipeCookSummaryItems(structuredDraft, previewItems, shortages, linkedPlanItem);
      if (currentApproval.status !== 'pending') {
        return (
          <div className="ai-recipe-editor ai-confirmation-editor ai-recipe-cook-draft-editor">
            <section className="ai-confirmation-item ai-recipe-summary-card ai-recipe-cook-summary-card" aria-label="做菜执行摘要">
              <div className="ai-recipe-summary-head">
                <div>
                  <strong>
                    {currentApproval.status === 'approved'
                      ? '做菜执行已确认'
                      : currentApproval.status === 'rejected'
                        ? '未执行的做菜草稿'
                        : '已过期的做菜草稿'}
                  </strong>
                  <span>{asText(structuredDraft.title) || '菜谱'}</span>
                </div>
                <em>{shortages.length > 0 ? '有缺料' : '可执行'}</em>
              </div>
              <dl className="ai-recipe-summary-grid">
                {summaryItems.map((item) => (
                  <div key={item.label}>
                    <dt>{item.label}</dt>
                    <dd>{item.value}</dd>
                  </div>
                ))}
              </dl>
              {asText(structuredDraft.resultNote) && <p className="ai-recipe-summary-note">{asText(structuredDraft.resultNote)}</p>}
            </section>
          </div>
        );
      }
      return (
        <div className="ai-recipe-editor ai-confirmation-editor ai-recipe-cook-draft-editor">
          <div className="ai-draft-editor-head">
            <div>
              <strong>做菜执行</strong>
              <span>{asText(structuredDraft.title) || '菜谱'}</span>
            </div>
          </div>
          <section className="ai-confirmation-item ai-recipe-summary-card ai-recipe-cook-summary-card" aria-label="做菜执行摘要">
            <div className="ai-recipe-summary-head">
              <div>
                <strong>{asText(structuredDraft.title) || '待确认做菜'}</strong>
                <span>
                  确认后会按预览扣减库存{Boolean(structuredDraft.createMealLog) ? '，并同时写入餐食记录' : '；不会自动写入餐食记录'}。
                </span>
              </div>
              <em>{shortages.length > 0 ? '有缺料' : '可执行'}</em>
            </div>
            <dl className="ai-recipe-summary-grid">
              {summaryItems.map((item) => (
                <div key={item.label}>
                  <dt>{item.label}</dt>
                  <dd>{item.value}</dd>
                </div>
              ))}
            </dl>
          </section>
          <section className="ai-confirmation-item">
            <div className="ai-recipe-draft-section">
              <div className="ai-recipe-draft-section-head">
                <strong>执行设置</strong>
                <span>确认本次做菜份数、日期、餐别和关联计划。</span>
              </div>
              <div className="ai-confirmation-grid">
                <label className="ai-resource-field">
                  <span>份数</span>
                  <input className="text-input" type="number" min={0.1} step={0.1} value={draftNumberInputValue(structuredDraft.servings, 1)} disabled={readonly} onChange={(event) => updateDraft({ servings: draftNumberFromInput(event.target.value) })} />
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
                  label="餐食记录"
                  value={String(Boolean(structuredDraft.createMealLog))}
                  disabled={readonly}
                  options={[
                    { value: 'true', label: '同时记录餐食' },
                    { value: 'false', label: '只扣库存不记录' },
                  ]}
                  icon="type"
                  onChange={(createMealLog) => updateDraft({ createMealLog: createMealLog === 'true' })}
                />
              </div>
              <p className="ai-approval-compare-copy">
                关联计划：{recipeCookLinkedPlanSummary(linkedPlanItem)}
              </p>
            </div>
          </section>
          <section className="ai-confirmation-item">
            <div className="ai-recipe-draft-section">
              <div className="ai-recipe-draft-section-head ai-recipe-draft-section-head-row">
                <div>
                  <strong>库存扣减预览</strong>
                  <span>按食材核对请求数量和实际扣减批次。</span>
                </div>
                <span>{previewItems.length} 项</span>
              </div>
              {previewItems.length > 0 ? previewItems.map((item, index) => {
                const batches = asDraftArray(item.batches);
                return (
                  <div className="ai-recipe-cook-preview-card" key={`${asText(item.ingredient_name)}-${index}`}>
                    <div className="ai-recipe-cook-preview-head">
                      <strong>{asText(item.ingredient_name) || `食材 ${index + 1}`}</strong>
                      <span>需要 {formatDraftQuantity(item.requested_quantity, item.unit)}</span>
                    </div>
                    <div className="ai-recipe-cook-batch-list">
                      {batches.length > 0 ? batches.map((batch, batchIndex) => (
                        <p className="ai-approval-compare-copy" key={`${asText(batch.inventory_item_id)}-${batchIndex}`}>
                          批次 {batchIndex + 1}：扣 {formatDraftQuantity(batch.quantity, batch.unit)}
                          {asText(batch.storage_location) ? ` · ${asText(batch.storage_location)}` : ''}
                          {asText(batch.purchase_date) ? ` · 购于 ${asText(batch.purchase_date)}` : ''}
                          {asText(batch.expiry_date) ? ` · 到期 ${asText(batch.expiry_date)}` : ''}
                        </p>
                      )) : (
                        <p className="ai-recipe-summary-note">没有具体批次明细，确认前建议重新预览库存。</p>
                      )}
                    </div>
                  </div>
                );
              }) : (
                <p className="ai-recipe-summary-note">没有库存扣减项，确认前建议检查菜谱食材或重新生成草稿。</p>
              )}
            </div>
          </section>
          <section className="ai-confirmation-item">
            <div className="ai-recipe-draft-section">
              <div className="ai-recipe-draft-section-head ai-recipe-draft-section-head-row">
                <div>
                  <strong>缺料与阻断</strong>
                  <span>有缺料时不能直接执行做菜扣库存。</span>
                </div>
                <span>{shortages.length > 0 ? `${shortages.length} 项` : '库存充足'}</span>
              </div>
              {shortages.length > 0 ? (
                <div className="ai-recipe-danger-impact">
                  <strong>当前草稿不能确认执行</strong>
                  <p className="ai-approval-compare-copy">
                    请先补齐库存或调整份数后重新生成做菜草稿；确认按钮会被前端阻断。
                  </p>
                </div>
              ) : (
                <p className="ai-recipe-summary-note">预览没有发现缺料，可以按上方批次扣减库存。</p>
              )}
              {shortages.map((item, index) => (
                <div className="ai-recipe-cook-shortage-card" key={`${asText(item.ingredient_name)}-${index}`}>
                  <strong>{asText(item.ingredient_name) || `缺料 ${index + 1}`}</strong>
                  <span>
                    缺 {formatDraftQuantity(item.missing_quantity, item.unit)} · 现有 {formatDraftQuantity(item.available_quantity, item.unit)} · 需要 {formatDraftQuantity(item.required_quantity, item.unit)}
                  </span>
                </div>
              ))}
            </div>
          </section>
          <section className="ai-confirmation-item">
            <div className="ai-recipe-draft-section">
              <div className="ai-recipe-draft-section-head">
                <strong>餐食记录补充</strong>
                <span>仅在选择“同时记录餐食”时会写入餐食记录；否则只作为本次做菜日志备注。</span>
              </div>
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
          </section>
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
      const record = foodProfileRecord(payload, before);
      const actionLabel = foodProfileActionLabel(action || 'create');
      const updateFoodPayload = (patch: Record<string, unknown>) => {
        if (action) {
          updateDraft({ payload: { ...payload, ...patch } });
        } else {
          updateDraft(patch);
        }
      };
      const renderFoodProfileSummary = () => (
        <section className="ai-confirmation-item ai-food-profile-summary-card" aria-label="食物资料摘要">
          <div className="ai-recipe-summary-head">
            <div>
              <strong>{foodProfileResolvedTitle(currentApproval.status, action || 'create')}</strong>
              <span>
                {action === 'set_favorite'
                  ? '确认后只更新收藏状态，不修改食物资料内容。'
                  : '确认后会写入食物资料，用于餐食记录、计划和推荐。'}
              </span>
            </div>
            <em>{actionLabel}</em>
          </div>
          <dl className="ai-recipe-summary-grid">
            {foodProfileSummaryItems(record).map((item) => (
              <div key={item.label}>
                <dt>{item.label}</dt>
                <dd>{item.value}</dd>
              </div>
            ))}
          </dl>
          {record.notes && <p className="ai-recipe-summary-note">{record.notes}</p>}
        </section>
      );
      const renderFoodProfileForm = () => (
        <>
          <section className="ai-confirmation-item">
            <div className="ai-food-profile-section">
              <div className="ai-food-profile-section-head">
                <strong>核心信息</strong>
                <span>确认名称、类型和家庭分类，分类可选择已有值或自定义。</span>
              </div>
              <label className="ai-resource-field">
                <span>食物名称</span>
                <input className="text-input" value={record.name} disabled={readonly} onChange={(event) => updateFoodPayload({ name: event.target.value })} />
              </label>
              <div className="ai-confirmation-grid">
                <ApprovalSelectField
                  label="类型"
                  value={record.type}
                  disabled={readonly}
                  options={FOOD_TYPE_OPTIONS}
                  icon="type"
                  onChange={(type) => updateFoodPayload({ type })}
                />
                <ApprovalComboboxField
                  label="分类"
                  value={record.category}
                  disabled={readonly}
                  options={foodCategoryOptions}
                  placeholder="选择或输入分类"
                  icon="type"
                  onChange={(category) => updateFoodPayload({ category })}
                />
              </div>
            </div>
          </section>
          <section className="ai-confirmation-item">
            <div className="ai-food-profile-section">
              <div className="ai-food-profile-section-head">
                <strong>适用场景</strong>
                <span>餐别是固定多选；口味标签会去重并过滤空值。</span>
              </div>
              <ApprovalMultiSelectField
                label="适合餐别"
                values={record.suitableMealTypes}
                disabled={readonly}
                options={MEAL_TYPE_OPTIONS}
                onChange={(suitableMealTypes) => updateFoodPayload({ suitable_meal_types: suitableMealTypes })}
              />
              <ApprovalTagInput
                label="口味标签"
                values={record.flavorTags}
                disabled={readonly}
                placeholder="清淡、酸甜、香辣"
                onChange={(flavorTags) => updateFoodPayload({ flavor_tags: flavorTags })}
              />
              <div className="ai-food-profile-tag-presets" aria-label="口味标签预设">
                {FOOD_FLAVOR_PRESETS.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    className={record.flavorTags.includes(tag) ? 'is-selected' : ''}
                    disabled={readonly}
                    onClick={() => updateFoodPayload({
                      flavor_tags: record.flavorTags.includes(tag)
                        ? record.flavorTags.filter((item) => item !== tag)
                        : [...record.flavorTags, tag],
                    })}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            </div>
          </section>
          <section className="ai-confirmation-item">
            <div className="ai-food-profile-section">
              <div className="ai-food-profile-section-head">
                <strong>来源与备注</strong>
                <span>来源属于开放信息，作为补充字段保留。</span>
              </div>
              <label className="ai-resource-field">
                <span>来源</span>
                <input className="text-input" value={record.sourceName} disabled={readonly} placeholder="店铺、品牌或来源" onChange={(event) => updateFoodPayload({ source_name: event.target.value })} />
              </label>
              <label className="ai-resource-field ai-confirmation-copy-field">
                <span>备注</span>
                <textarea className="text-input" rows={3} value={record.notes} disabled={readonly} placeholder="补充食用场景或偏好" onChange={(event) => updateFoodPayload({ notes: event.target.value })} />
              </label>
            </div>
          </section>
        </>
      );
      if (currentApproval.status !== 'pending') {
        return (
          <div className="ai-recipe-editor ai-confirmation-editor ai-food-profile-draft-editor">
            {renderFoodProfileSummary()}
          </div>
        );
      }
      if (action) {
        return (
          <div className="ai-recipe-editor ai-confirmation-editor ai-food-profile-draft-editor">
            <div className="ai-draft-editor-head">
              <div>
                <strong>{actionLabel}食物资料</strong>
                <span>{record.name || '食物资料'}</span>
              </div>
            </div>
            {renderFoodProfileSummary()}
            {action === 'set_favorite' ? (
              <section className="ai-confirmation-item">
                <div className="ai-food-profile-favorite-card">
                  <div>
                    <span>当前：{foodFavoriteLabel(before.favorite)}</span>
                    <strong>{record.name || asText(structuredDraft.targetId) || '食物资料'}</strong>
                    <p>调整后：{foodFavoriteLabel(payload.favorite)}</p>
                  </div>
                  <em>{actionLabel}</em>
                </div>
                <ApprovalSelectField
                  label="收藏状态"
                  value={String(Boolean(payload.favorite))}
                  disabled={readonly}
                  options={[
                    { value: 'true', label: '加入收藏' },
                    { value: 'false', label: '移出收藏' },
                  ]}
                  icon="type"
                  onChange={(favorite) => updateFoodPayload({ favorite: favorite === 'true' })}
                />
              </section>
            ) : (
              <>
                {action === 'update' && (
                  <p className="ai-approval-compare-copy">
                    当前：{[asText(before.name), foodTypeText(before.type), asText(before.category)].filter(Boolean).join(' · ')}
                  </p>
                )}
                {renderFoodProfileForm()}
              </>
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
          {renderFoodProfileSummary()}
          {renderFoodProfileForm()}
        </div>
      );
    }
    if (draftType === 'ingredient_profile') {
      const action = asText(structuredDraft.action, 'create');
      const operations = asDraftArray(structuredDraft.operations);
      if (operations.length > 0) {
        const updateBatchPayload = (index: number, patch: Record<string, unknown>) => {
          setStructuredDraft((current) => ({
            ...current,
            operations: asDraftArray(current.operations).map((item, itemIndex) => {
              if (itemIndex !== index) return item;
              const itemPayload = typeof item.payload === 'object' && item.payload !== null && !Array.isArray(item.payload)
                ? item.payload as Record<string, unknown>
                : {};
              return { ...item, payload: { ...itemPayload, ...patch } };
            }),
          }));
        };
        const updateBatchUnitConversion = (operationIndex: number, conversionIndex: number, patch: Record<string, unknown>) => {
          setStructuredDraft((current) => ({
            ...current,
            operations: asDraftArray(current.operations).map((item, itemIndex) => {
              if (itemIndex !== operationIndex) return item;
              const itemPayload = typeof item.payload === 'object' && item.payload !== null && !Array.isArray(item.payload)
                ? item.payload as Record<string, unknown>
                : {};
              const conversions = asDraftArray(itemPayload.unit_conversions);
              return {
                ...item,
                payload: {
                  ...itemPayload,
                  unit_conversions: conversions.map((conversion, index) => (index === conversionIndex ? { ...conversion, ...patch } : conversion)),
                },
              };
            }),
          }));
        };
        const addBatchUnitConversion = (operationIndex: number) => {
          setStructuredDraft((current) => ({
            ...current,
            operations: asDraftArray(current.operations).map((item, itemIndex) => {
              if (itemIndex !== operationIndex) return item;
              const itemPayload = typeof item.payload === 'object' && item.payload !== null && !Array.isArray(item.payload)
                ? item.payload as Record<string, unknown>
                : {};
              return {
                ...item,
                payload: {
                  ...itemPayload,
                  unit_conversions: [...asDraftArray(itemPayload.unit_conversions), { unit: '', ratio_to_default: 1 }],
                },
              };
            }),
          }));
        };
        const removeBatchUnitConversion = (operationIndex: number, conversionIndex: number) => {
          setStructuredDraft((current) => ({
            ...current,
            operations: asDraftArray(current.operations).map((item, itemIndex) => {
              if (itemIndex !== operationIndex) return item;
              const itemPayload = typeof item.payload === 'object' && item.payload !== null && !Array.isArray(item.payload)
                ? item.payload as Record<string, unknown>
                : {};
              return {
                ...item,
                payload: {
                  ...itemPayload,
                  unit_conversions: asDraftArray(itemPayload.unit_conversions).filter((_, index) => index !== conversionIndex),
                },
              };
            }),
          }));
        };
        if (currentApproval.status !== 'pending') {
          const resolvedTitle = currentApproval.status === 'approved'
            ? `已创建 ${operations.length} 个食材档案`
            : currentApproval.status === 'rejected'
              ? '未写入的批量食材草稿'
              : '已过期的批量食材草稿';
          return (
            <div className="ai-recipe-editor ai-confirmation-editor ai-ingredient-profile-draft-editor">
              <section className="ai-confirmation-item ai-ingredient-profile-summary-card" aria-label="批量食材档案摘要">
                <div className="ai-ingredient-profile-summary-head">
                  <div>
                    <strong>{resolvedTitle}</strong>
                    <span>{operations.map((item) => {
                      const itemPayload = typeof item.payload === 'object' && item.payload !== null && !Array.isArray(item.payload)
                        ? item.payload as Record<string, unknown>
                        : {};
                      return asText(itemPayload.name);
                    }).filter(Boolean).join('、') || '食材档案'}</span>
                  </div>
                  <em>批量新增</em>
                </div>
              </section>
            </div>
          );
        }
        return (
          <div className="ai-recipe-editor ai-confirmation-editor ai-ingredient-profile-draft-editor">
            <div className="ai-draft-editor-head">
              <div>
                <strong>批量创建食材档案</strong>
                <span>一次确认创建 {operations.length} 个食材，不会登记库存数量。</span>
              </div>
            </div>
            {operations.map((operation, operationIndex) => {
              const itemPayload = typeof operation.payload === 'object' && operation.payload !== null && !Array.isArray(operation.payload)
                ? operation.payload as Record<string, unknown>
                : {};
              const itemDefaultUnit = asText(itemPayload.default_unit);
              const itemExpiryMode = asText(itemPayload.default_expiry_mode, 'none');
              const itemUnitConversions = asDraftArray(itemPayload.unit_conversions);
              const itemUnitOptions = buildUnitPresetOptions(itemDefaultUnit).map((unit) => ({ value: unit, label: unit }));
              return (
                <div className="ai-confirmation-item" key={asText(operation.operationId) || operationIndex}>
                  <section className="ai-ingredient-profile-section">
                    <div className="ai-ingredient-profile-section-head">
                      <strong>食材 {operationIndex + 1}</strong>
                      <span>{asText(itemPayload.name) || '待填写名称'}</span>
                    </div>
                    <div className="ai-confirmation-grid">
                      <label className="ai-resource-field">
                        <span>食材名称</span>
                        <input className="text-input" value={asText(itemPayload.name)} disabled={readonly} onChange={(event) => updateBatchPayload(operationIndex, { name: event.target.value })} />
                      </label>
                      <ApprovalComboboxField
                        label="分类"
                        value={asText(itemPayload.category)}
                        disabled={readonly}
                        options={INGREDIENT_CATEGORY_OPTIONS}
                        placeholder="选择分类或自定义"
                        icon="type"
                        onChange={(category) => updateBatchPayload(operationIndex, { category })}
                      />
                      <ApprovalComboboxField
                        label="默认单位"
                        value={itemDefaultUnit}
                        disabled={readonly}
                        options={itemUnitOptions}
                        placeholder="选择单位或自定义"
                        icon="step"
                        onChange={(defaultUnit) => updateBatchPayload(operationIndex, { default_unit: defaultUnit })}
                      />
                    </div>
                  </section>
                  <section className="ai-ingredient-profile-section">
                    <div className="ai-confirmation-grid ai-confirmation-grid-three">
                      <ApprovalComboboxField
                        label="默认保存"
                        value={asText(itemPayload.default_storage)}
                        disabled={readonly}
                        options={INGREDIENT_STORAGE_OPTIONS}
                        placeholder="选择保存位置"
                        icon="type"
                        onChange={(defaultStorage) => updateBatchPayload(operationIndex, { default_storage: defaultStorage })}
                      />
                      <ApprovalSelectField
                        label="保质期模式"
                        value={itemExpiryMode}
                        disabled={readonly}
                        options={[
                          { value: 'days', label: '按天数' },
                          { value: 'manual_date', label: '手动日期' },
                          { value: 'none', label: '不设置' },
                        ]}
                        icon="calendar"
                        onChange={(defaultExpiryMode) => updateBatchPayload(operationIndex, {
                          default_expiry_mode: defaultExpiryMode,
                          default_expiry_days: defaultExpiryMode === 'days' ? itemPayload.default_expiry_days ?? 1 : null,
                        })}
                      />
                      {itemExpiryMode === 'days' ? (
                        <label className="ai-resource-field">
                          <span>默认保质期天数</span>
                          <input
                            className="text-input"
                            type="number"
                            min={1}
                            step={1}
                            value={itemPayload.default_expiry_days == null ? '' : String(itemPayload.default_expiry_days)}
                            disabled={readonly}
                            placeholder="例如 7"
                            onChange={(event) => updateBatchPayload(operationIndex, { default_expiry_days: event.target.value ? Number(event.target.value) : null })}
                          />
                        </label>
                      ) : (
                        <div className="ai-resource-field ai-ingredient-profile-field-note">
                          <span>默认保质期天数</span>
                          <strong>{itemExpiryMode === 'manual_date' ? '入库时手动选择日期' : '不设置默认保质期'}</strong>
                        </div>
                      )}
                    </div>
                    <label className="ai-resource-field ai-ingredient-profile-low-stock">
                      <span>低库存阈值</span>
                      <div className="ai-inline-unit-input">
                        <input
                          className="text-input"
                          type="number"
                          min={0.1}
                          step="0.1"
                          value={itemPayload.default_low_stock_threshold == null ? '' : String(itemPayload.default_low_stock_threshold)}
                          disabled={readonly}
                          placeholder="留空则不提醒"
                          onChange={(event) => updateBatchPayload(operationIndex, { default_low_stock_threshold: event.target.value ? Number(event.target.value) : null })}
                        />
                        {itemDefaultUnit && <span>{itemDefaultUnit}</span>}
                      </div>
                    </label>
                  </section>
                  <section className="ai-ingredient-profile-section">
                    <div className="ai-ingredient-profile-section-head">
                      <strong>副单位与备注</strong>
                      <span>含义不确定时可以先留空。</span>
                    </div>
                    <div className="ai-ingredient-profile-conversion-list">
                      {itemUnitConversions.length > 0 ? itemUnitConversions.map((item, index) => (
                        <div className="ai-ingredient-profile-conversion-row" key={index}>
                          <ApprovalComboboxField
                            label="副单位"
                            value={asText(item.unit)}
                            disabled={readonly}
                            options={buildUnitPresetOptions(asText(item.unit)).map((unit) => ({ value: unit, label: unit }))}
                            placeholder="选择副单位"
                            icon="step"
                            onChange={(unit) => updateBatchUnitConversion(operationIndex, index, { unit })}
                          />
                          <label className="ai-resource-field">
                            <span>等于多少默认单位</span>
                            <div className="ai-inline-unit-input">
                              <input
                                className="text-input"
                                type="number"
                                min={0.1}
                                step="0.1"
                                value={item.ratio_to_default == null ? '' : String(item.ratio_to_default)}
                                disabled={readonly}
                                placeholder="例如 500"
                                onChange={(event) => updateBatchUnitConversion(operationIndex, index, { ratio_to_default: event.target.value ? Number(event.target.value) : null })}
                              />
                              {itemDefaultUnit && <span>{itemDefaultUnit}</span>}
                            </div>
                          </label>
                          {!readonly && (
                            <button className="ghost-button ai-ingredient-profile-remove-conversion" type="button" onClick={() => removeBatchUnitConversion(operationIndex, index)}>
                              删除
                            </button>
                          )}
                        </div>
                      )) : (
                        <p className="ai-ingredient-profile-empty-conversion">暂不设置副单位。</p>
                      )}
                      {!readonly && (
                        <button className="ghost-button ai-ingredient-profile-add-conversion" type="button" onClick={() => addBatchUnitConversion(operationIndex)}>
                          添加副单位
                        </button>
                      )}
                    </div>
                    <label className="ai-resource-field ai-confirmation-copy-field">
                      <span>备注</span>
                      <textarea className="text-input" rows={2} value={asText(itemPayload.notes)} disabled={readonly} placeholder="补充采购、保存或使用习惯" onChange={(event) => updateBatchPayload(operationIndex, { notes: event.target.value })} />
                    </label>
                  </section>
                </div>
              );
            })}
          </div>
        );
      }
      const payload = typeof structuredDraft.payload === 'object' && structuredDraft.payload !== null && !Array.isArray(structuredDraft.payload)
        ? structuredDraft.payload as Record<string, unknown>
        : structuredDraft;
      const before = typeof structuredDraft.before === 'object' && structuredDraft.before !== null && !Array.isArray(structuredDraft.before)
        ? structuredDraft.before as Record<string, unknown>
        : {};
      const actionLabel = action === 'update' ? '修改' : '新增';
      const defaultUnit = asText(payload.default_unit);
      const expiryMode = asText(payload.default_expiry_mode, 'none');
      const unitConversions = asDraftArray(payload.unit_conversions);
      const defaultUnitOptions = buildUnitPresetOptions(defaultUnit).map((unit) => ({ value: unit, label: unit }));
      const summaryItems = [
        { label: '食材名称', value: asText(payload.name) || asText(before.name) || '未命名食材' },
        { label: '分类', value: asText(payload.category) || asText(before.category) || '未填写' },
        { label: '默认单位', value: defaultUnit || asText(before.default_unit) || '未填写' },
        { label: '默认保存', value: asText(payload.default_storage) || asText(before.default_storage) || '未填写' },
        { label: '保质期', value: ingredientExpirySummary(payload) },
        { label: '低库存提醒', value: ingredientLowStockSummary(payload) },
        { label: '单位换算', value: ingredientUnitConversionSummary(payload.unit_conversions, defaultUnit) },
      ];
      const updatePayload = (patch: Record<string, unknown>) => {
        setStructuredDraft((current) => {
          const currentPayload = typeof current.payload === 'object' && current.payload !== null && !Array.isArray(current.payload)
            ? current.payload as Record<string, unknown>
            : current;
          return { ...current, payload: { ...currentPayload, ...patch } };
        });
      };
      const updateUnitConversion = (index: number, patch: Record<string, unknown>) => {
        setStructuredDraft((current) => {
          const currentPayload = typeof current.payload === 'object' && current.payload !== null && !Array.isArray(current.payload)
            ? current.payload as Record<string, unknown>
            : current;
          const currentConversions = asDraftArray(currentPayload.unit_conversions);
          return {
            ...current,
            payload: {
              ...currentPayload,
              unit_conversions: currentConversions.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)),
            },
          };
        });
      };
      const removeUnitConversion = (index: number) => {
        setStructuredDraft((current) => {
          const currentPayload = typeof current.payload === 'object' && current.payload !== null && !Array.isArray(current.payload)
            ? current.payload as Record<string, unknown>
            : current;
          const currentConversions = asDraftArray(currentPayload.unit_conversions);
          return {
            ...current,
            payload: {
              ...currentPayload,
              unit_conversions: currentConversions.filter((_, itemIndex) => itemIndex !== index),
            },
          };
        });
      };
      const addUnitConversion = () => {
        setStructuredDraft((current) => {
          const currentPayload = typeof current.payload === 'object' && current.payload !== null && !Array.isArray(current.payload)
            ? current.payload as Record<string, unknown>
            : current;
          const currentConversions = asDraftArray(currentPayload.unit_conversions);
          return {
            ...current,
            payload: {
              ...currentPayload,
              unit_conversions: [...currentConversions, { unit: '', ratio_to_default: 1 }],
            },
          };
        });
      };
      if (currentApproval.status !== 'pending') {
        const resolvedTitle = currentApproval.status === 'approved'
          ? `${action === 'update' ? '已更新' : '已创建'}食材档案`
          : currentApproval.status === 'rejected'
            ? '未写入的食材草稿'
            : '已过期的食材草稿';
        return (
          <div className="ai-recipe-editor ai-confirmation-editor ai-ingredient-profile-draft-editor">
            <section className="ai-confirmation-item ai-ingredient-profile-summary-card" aria-label="食材档案摘要">
              <div className="ai-ingredient-profile-summary-head">
                <div>
                  <strong>{resolvedTitle}</strong>
                  <span>{asText(payload.name) || asText(before.name) || '食材档案'}</span>
                </div>
                <em>{actionLabel}</em>
              </div>
              <dl className="ai-ingredient-profile-summary-grid">
                {summaryItems.map((item) => (
                  <div key={item.label}>
                    <dt>{item.label}</dt>
                    <dd>{item.value}</dd>
                  </div>
                ))}
              </dl>
              {asText(payload.notes) && (
                <p className="ai-ingredient-profile-summary-note">
                  {asText(payload.notes)}
                </p>
              )}
            </section>
          </div>
        );
      }
      return (
        <div className="ai-recipe-editor ai-confirmation-editor ai-ingredient-profile-draft-editor">
          <div className="ai-draft-editor-head">
            <div>
              <strong>{actionLabel}食材档案</strong>
              <span>{asText(payload.name) || asText(before.name) || '食材档案'}</span>
            </div>
          </div>
          {action === 'update' && (
            <div className="ai-ingredient-profile-before-after">
              <p>
                当前：{[asText(before.name), asText(before.category), asText(before.default_unit), asText(before.default_storage)].filter(Boolean).join(' · ') || '未记录'}
              </p>
              <p>
                调整后：{[asText(payload.name), asText(payload.category), asText(payload.default_unit), asText(payload.default_storage)].filter(Boolean).join(' · ') || '待填写'}
              </p>
              <span>只更新食材档案默认值，不直接修改已有库存批次。</span>
            </div>
          )}
          <div className="ai-confirmation-item">
            <p className="ai-ingredient-profile-intent">
              {action === 'update'
                ? '只更新食材档案默认值，不直接修改已有库存批次。'
                : '确认后会创建新的家庭食材档案，不会登记库存数量。'}
            </p>
            <section className="ai-ingredient-profile-section">
              <div className="ai-ingredient-profile-section-head">
                <strong>核心信息</strong>
                <span>用于食材库检索和后续菜谱、库存匹配。</span>
              </div>
              <div className="ai-confirmation-grid">
                <label className="ai-resource-field">
                  <span>食材名称</span>
                  <input className="text-input" value={asText(payload.name)} disabled={readonly} onChange={(event) => updatePayload({ name: event.target.value })} />
                </label>
                <ApprovalComboboxField
                  label="分类"
                  value={asText(payload.category)}
                  disabled={readonly}
                  options={INGREDIENT_CATEGORY_OPTIONS}
                  placeholder="选择分类或自定义"
                  icon="type"
                  onChange={(category) => updatePayload({ category })}
                />
                <ApprovalComboboxField
                  label="默认单位"
                  value={defaultUnit}
                  disabled={readonly}
                  options={defaultUnitOptions}
                  placeholder="选择单位或自定义"
                  icon="step"
                  onChange={(defaultUnit) => updatePayload({ default_unit: defaultUnit })}
                />
              </div>
            </section>
            <section className="ai-ingredient-profile-section">
              <div className="ai-ingredient-profile-section-head">
                <strong>保存与提醒</strong>
                <span>作为新增库存时的默认建议，入库时仍可单独调整。</span>
              </div>
              <div className="ai-confirmation-grid ai-confirmation-grid-three">
                <ApprovalComboboxField
                  label="默认保存"
                  value={asText(payload.default_storage)}
                  disabled={readonly}
                  options={INGREDIENT_STORAGE_OPTIONS}
                  placeholder="选择保存位置"
                  icon="type"
                  onChange={(defaultStorage) => updatePayload({ default_storage: defaultStorage })}
                />
                <ApprovalSelectField
                  label="保质期模式"
                  value={expiryMode}
                  disabled={readonly}
                  options={[
                    { value: 'days', label: '按天数' },
                    { value: 'manual_date', label: '手动日期' },
                    { value: 'none', label: '不设置' },
                  ]}
                  icon="calendar"
                  onChange={(defaultExpiryMode) => updatePayload({
                    default_expiry_mode: defaultExpiryMode,
                    default_expiry_days: defaultExpiryMode === 'days' ? payload.default_expiry_days ?? 1 : null,
                  })}
                />
                {expiryMode === 'days' ? (
                  <label className="ai-resource-field">
                    <span>默认保质期天数</span>
                    <input
                      className="text-input"
                      type="number"
                      min={1}
                      step={1}
                      value={payload.default_expiry_days == null ? '' : String(payload.default_expiry_days)}
                      disabled={readonly}
                      placeholder="例如 7"
                      onChange={(event) => updatePayload({ default_expiry_days: event.target.value ? Number(event.target.value) : null })}
                    />
                  </label>
                ) : (
                  <div className="ai-resource-field ai-ingredient-profile-field-note">
                    <span>默认保质期天数</span>
                    <strong>{expiryMode === 'manual_date' ? '入库时手动选择日期' : '不设置默认保质期'}</strong>
                  </div>
                )}
              </div>
              <label className="ai-resource-field ai-ingredient-profile-low-stock">
                <span>低库存阈值</span>
                <div className="ai-inline-unit-input">
                  <input
                    className="text-input"
                    type="number"
                    min={0.1}
                    step="0.1"
                    value={payload.default_low_stock_threshold == null ? '' : String(payload.default_low_stock_threshold)}
                    disabled={readonly}
                    placeholder="留空则不提醒"
                    onChange={(event) => updatePayload({ default_low_stock_threshold: event.target.value ? Number(event.target.value) : null })}
                  />
                  {defaultUnit && <span>{defaultUnit}</span>}
                </div>
                <small>当可用库存低于这个数量时提醒；不需要提醒可以留空。</small>
              </label>
            </section>
            <section className="ai-ingredient-profile-section">
              <div className="ai-ingredient-profile-section-head">
                <strong>高级设置</strong>
                <span>副单位用于以后入库换算，含义不确定时建议先留空。</span>
              </div>
              <div className="ai-ingredient-profile-conversion-list">
                {unitConversions.length > 0 ? unitConversions.map((item, index) => (
                  <div className="ai-ingredient-profile-conversion-row" key={index}>
                    <ApprovalComboboxField
                      label="副单位"
                      value={asText(item.unit)}
                      disabled={readonly}
                      options={buildUnitPresetOptions(asText(item.unit)).map((unit) => ({ value: unit, label: unit }))}
                      placeholder="选择副单位"
                      icon="step"
                      onChange={(unit) => updateUnitConversion(index, { unit })}
                    />
                    <label className="ai-resource-field">
                      <span>等于多少默认单位</span>
                      <div className="ai-inline-unit-input">
                        <input
                          className="text-input"
                          type="number"
                          min={0.1}
                          step="0.1"
                          value={item.ratio_to_default == null ? '' : String(item.ratio_to_default)}
                          disabled={readonly}
                          placeholder="例如 500"
                          onChange={(event) => updateUnitConversion(index, { ratio_to_default: event.target.value ? Number(event.target.value) : null })}
                        />
                        {defaultUnit && <span>{defaultUnit}</span>}
                      </div>
                    </label>
                    {!readonly && (
                      <button className="ghost-button ai-ingredient-profile-remove-conversion" type="button" onClick={() => removeUnitConversion(index)}>
                        删除
                      </button>
                    )}
                  </div>
                )) : (
                  <p className="ai-ingredient-profile-empty-conversion">暂不设置副单位。</p>
                )}
                {!readonly && (
                  <button className="ghost-button ai-ingredient-profile-add-conversion" type="button" onClick={addUnitConversion}>
                    添加副单位
                  </button>
                )}
              </div>
              <label className="ai-resource-field ai-confirmation-copy-field">
                <span>备注</span>
                <textarea className="text-input" rows={3} value={asText(payload.notes)} disabled={readonly} placeholder="补充采购、保存或使用习惯" onChange={(event) => updatePayload({ notes: event.target.value })} />
              </label>
            </section>
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
        return [actionLabel, name, category, unit].filter(Boolean);
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
        const operations = inventoryOperationDraft.operations;
        const labels = operations.map((item) => INVENTORY_ACTION_OPTIONS.find((option) => option.value === item.action)?.label ?? '处理');
        return `${operations.length}项库存处理 · ${Array.from(new Set(labels)).join('、')}`;
      }
    }
    return '';
  }, [recipeApproval, recipe, usesStructuredDraftEditor, draftType, structuredDraft, inventoryOperationDraft]);
  const briefSummaryParts = Array.isArray(briefSummary) ? briefSummary : briefSummary ? [briefSummary] : [];

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
            {!isExpanded && briefSummaryParts.map((summaryPart) => (
              <span className="ai-approval-brief-badge" key={summaryPart}>
                {summaryPart}
              </span>
            ))}
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
                  <strong>{currentApproval.status === 'pending' ? '菜谱草稿' : '菜谱摘要'}</strong>
                  <span>{recipe.title || '未命名菜谱'}</span>
                </div>
              </div>
              <section className="ai-confirmation-item ai-recipe-summary-card" aria-label="菜谱摘要">
                <div className="ai-recipe-summary-head">
                  <div>
                    <strong>
                      {currentApproval.status === 'approved'
                        ? '已创建菜谱'
                        : currentApproval.status === 'rejected'
                          ? '未写入的菜谱草稿'
                          : currentApproval.status === 'expired'
                            ? '已过期的菜谱草稿'
                            : recipe.title || '待确认菜谱'}
                    </strong>
                    <span>
                      {currentApproval.status === 'pending'
                        ? '确认后会创建菜谱，并同步关联的家常菜食物资料。'
                        : '以下为本次审批保留的菜谱摘要。'}
                    </span>
                  </div>
                  <em>{difficultyLabel(recipe.difficulty) || '未设置难度'}</em>
                </div>
                <dl className="ai-recipe-summary-grid">
                  {recipeDraftSummaryItems(recipe).map((item) => (
                    <div key={item.label}>
                      <dt>{item.label}</dt>
                      <dd>{item.value}</dd>
                    </div>
                  ))}
                </dl>
                {recipe.tips && (
                  <p className="ai-recipe-summary-note">{recipe.tips}</p>
                )}
              </section>
              {currentApproval.status !== 'pending' ? null : (
                <>
                  <section className="ai-confirmation-item">
                    <p className="ai-recipe-draft-intent">
                      请先核对菜谱基础信息、食材绑定和步骤。未绑定到食材库的食材不能直接写入菜谱。
                    </p>
                    <div className="ai-recipe-draft-section">
                      <div className="ai-recipe-draft-section-head">
                        <strong>基础信息</strong>
                        <span>用于菜谱库展示、搜索和后续餐食计划。</span>
                      </div>
                      <label className="ai-resource-field">
                        <span>菜谱名</span>
                        <input className="text-input" value={recipe.title} disabled={readonly} onChange={(event) => setRecipe({ ...recipe, title: event.target.value })} />
                      </label>
                      <div className="ai-confirmation-grid ai-confirmation-grid-three">
                        <label className="ai-resource-field">
                          <span>份量</span>
                          <input className="text-input" type="number" min={1} value={draftNumberInputValue(recipe.servings, 1)} disabled={readonly} onChange={(event) => setRecipe({ ...recipe, servings: draftNumberFromInput(event.target.value) as number })} />
                        </label>
                        <label className="ai-resource-field">
                          <span>时间（分钟）</span>
                          <input className="text-input" type="number" min={0} value={draftNumberInputValue(recipe.prep_minutes, 0)} disabled={readonly} onChange={(event) => setRecipe({ ...recipe, prep_minutes: draftNumberFromInput(event.target.value) as number })} />
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
                  </section>
                  <section className="ai-confirmation-item">
                    <div className="ai-recipe-draft-section">
                      <div className="ai-recipe-draft-section-head ai-recipe-draft-section-head-row">
                        <div>
                          <strong>食材匹配</strong>
                          <span>{recipe.ingredient_items.length} 种食材，必须绑定到家庭食材库。</span>
                        </div>
                        {!readonly && (
                          <button className="ghost-button ai-draft-add-button" type="button" onClick={() => setRecipe({ ...recipe, ingredient_items: [...recipe.ingredient_items, { ingredient_id: null, ingredient_name: '', quantity: 1, unit: '份', note: '' }] })}>
                            添加食材
                          </button>
                        )}
                      </div>
                      {recipe.ingredient_items.map((item, index) => {
                        const usesPresenceQuantity = recipeIngredientUsesPresenceQuantity(item, ingredients);
                        return (
                          <div className={`ai-recipe-ingredient-card${item.ingredient_id ? '' : ' is-unbound'}`} key={`${item.ingredient_name}-${index}`}>
                            <AiSearchableResourceSelect
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
                                unit: option.unit || item.unit || '',
                              })}
                            />
                            {!item.ingredient_id && (
                              <p className="ai-recipe-binding-warning">
                                未绑定到食材库。请先选择已有食材；如果家里还没有这个食材，应先生成食材档案草稿。
                              </p>
                            )}
                            {usesPresenceQuantity ? (
                              <div className="recipe-editor-ingredient-presence-note">用量写在步骤或备注里</div>
                            ) : (
                              <div className="ai-confirmation-grid ai-confirmation-grid-compact">
                                <label className="ai-resource-field">
                                  <span>数量</span>
                                  <input className="text-input" type="number" min={0.1} step={0.1} value={draftNumberInputValue(item.quantity)} disabled={readonly} onChange={(event) => updateIngredient(index, { quantity: draftNumberFromInput(event.target.value) as number })} />
                                </label>
                                <ApprovalComboboxField
                                  label="单位"
                                  value={item.unit ?? ''}
                                  disabled={readonly}
                                  options={recipeDraftUnitOptions(item.unit ?? '')}
                                  placeholder="选择单位"
                                  icon="step"
                                  onChange={(unit) => updateIngredient(index, { unit })}
                                />
                              </div>
                            )}
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
                        );
                      })}
                    </div>
                  </section>
                  <section className="ai-confirmation-item">
                    <div className="ai-recipe-draft-section">
                      <div className="ai-recipe-draft-section-head ai-recipe-draft-section-head-row">
                        <div>
                          <strong>烹饪步骤</strong>
                          <span>{recipe.steps.length} 步，标题或说明至少填写一项。</span>
                        </div>
                        {!readonly && (
                          <button className="ghost-button ai-draft-add-button" type="button" onClick={() => setRecipe({ ...recipe, steps: [...recipe.steps, { title: `步骤 ${recipe.steps.length + 1}`, text: '', icon: 'pan', summary: '', estimated_minutes: 5, tip: '', key_points: [] }] })}>
                            添加步骤
                          </button>
                        )}
                      </div>
                      {recipe.steps.map((step, index) => (
                        <div className="ai-recipe-step-card" key={`${step.title}-${index}`}>
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
                              <input className="text-input" type="number" min={1} value={draftNumberInputValue(step.estimated_minutes)} disabled={readonly} placeholder="分钟" onChange={(event) => updateStep(index, { estimated_minutes: nullableDraftNumberFromInput(event.target.value) })} />
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
                          <ApprovalTagInput
                            label="关键点"
                            values={step.key_points ?? []}
                            disabled={readonly}
                            placeholder="火候、状态、注意点"
                            onChange={(keyPoints) => updateStep(index, { key_points: keyPoints })}
                          />
                          {!readonly && recipe.steps.length > 1 && (
                            <button className="ghost-button ai-draft-remove-button" type="button" onClick={() => setRecipe({ ...recipe, steps: recipe.steps.filter((_, itemIndex) => itemIndex !== index) })}>
                              删除步骤
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </section>
                  <section className="ai-confirmation-item">
                    <div className="ai-recipe-draft-section">
                      <div className="ai-recipe-draft-section-head">
                        <strong>补充信息</strong>
                        <span>用于后续筛选和家庭做菜备注。</span>
                      </div>
                      <ApprovalTagInput
                        label="场景标签"
                        values={recipe.scene_tags ?? []}
                        disabled={readonly}
                        placeholder="家常菜、快手菜"
                        onChange={(sceneTags) => setRecipe({ ...recipe, scene_tags: sceneTags })}
                      />
                      <label className="ai-resource-field ai-confirmation-copy-field">
                        <span>小贴士</span>
                        <textarea className="text-input" rows={2} value={recipe.tips} disabled={readonly} placeholder="补充火候、替换食材等提示" onChange={(event) => setRecipe({ ...recipe, tips: event.target.value })} />
                      </label>
                    </div>
                  </section>
                </>
              )}
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
