import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AiApprovalRequest, AiGeneratedRecipeDraft, Food, Ingredient } from '../../api/types';
import { resolveMediaUrl } from '../../lib/assets';
import { parseFoodStockQuantity } from '../../lib/foodStockQuantity';
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
import { AiInventoryIntakeApproval, validateInventoryIntakeDraftForSubmit } from './AiInventoryIntakeApproval';
import {
  AiIngredientTrackingTransitionApproval,
  AiMealCompositionCorrectionApproval,
  validateIngredientTrackingTransitionForSubmit,
  validateMealCompositionCorrectionForSubmit,
} from './AiSpecializedApprovalEditors';
import { AiDraftImpactNote } from './draft-ui/AiDraftImpactNote';
import { AiDraftRenderer } from './draft-ui/AiDraftRenderer';
import { normalizeAiDraftTagValues } from './draft-ui/AiDraftTagInput';
import { RECIPE_DIFFICULTY_OPTIONS as DIFFICULTY_OPTIONS, recipeDraftFromRecord } from './draft-ui/views/aiRecipeDraftViewModel';

export type { AiResourceOptionLoader } from './AiApprovalFields';

const MEAL_TYPE_OPTIONS = [
  { value: 'breakfast', label: '早餐' },
  { value: 'lunch', label: '午餐' },
  { value: 'dinner', label: '晚餐' },
  { value: 'snack', label: '加餐' },
];
const FOOD_TYPE_OPTIONS = [
  { value: 'selfMade', label: '家常菜' },
  { value: 'takeout', label: '外卖' },
  { value: 'diningOut', label: '外食' },
  { value: 'readyMade', label: '成品' },
  { value: 'instant', label: '速食' },
  { value: 'packaged', label: '包装食品' },
];
const READY_LIKE_FOOD_TYPES = new Set(['readyMade', 'instant', 'packaged']);
const INVENTORY_ACTION_OPTIONS = [
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
  if (approval.approval_type.startsWith('inventory_intake.')) return 'inventory_intake';
  if (approval.approval_type.startsWith('meal_log.')) return 'meal_log';
  if (approval.approval_type.startsWith('food_profile.')) return 'food_profile';
  if (approval.approval_type.startsWith('ingredient.')) return 'ingredient_profile';
  if (approval.approval_type.startsWith('inventory.')) return 'inventory_operation';
  return '';
}

function joinTextList(value: unknown) {
  return Array.isArray(value) ? value.map(String).join('、') : '';
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
  if (!['create', 'update', 'delete'].includes(action)) return '菜谱操作类型不正确';
  if (action === 'delete') return '';
  return validateRecipeDraftForSubmit(recipeDraftFromRecord(payload, before));
}

function validateIngredientProfileDraftForSubmit(draft: Record<string, unknown>) {
  if (asText(draft.action) === 'transition_tracking_mode') {
    return validateIngredientTrackingTransitionForSubmit(draft);
  }
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

type RecipeCookSchemaVersion = 'recipe_cook_operation.v1' | 'recipe_cook_operation.v2' | 'unknown';

function resolveRecipeCookSchemaVersion(
  approval: AiApprovalRequest,
  draft: Record<string, unknown>,
): RecipeCookSchemaVersion {
  const candidates = [
    asText(draft.schemaVersion),
    asText(approval.draft_schema_version),
  ];
  for (const candidate of candidates) {
    if (candidate === 'recipe_cook_operation.v1' || candidate === 'recipe_cook_operation.v2') {
      return candidate;
    }
  }
  // Legacy cook drafts without an explicit version keep v1 semantics.
  if (asText(draft.draftType) === 'recipe_cook' || approval.approval_type.startsWith('recipe.cook')) {
    return 'recipe_cook_operation.v1';
  }
  return 'unknown';
}

function validateRecipeCookDraftForSubmit(
  draft: Record<string, unknown>,
  schemaVersion: RecipeCookSchemaVersion,
) {
  if (schemaVersion !== 'recipe_cook_operation.v2') {
    return '这份旧草稿需要刷新后重新确认';
  }
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

function buildRecipeCookSubmitDraft(draft: Record<string, unknown>) {
  const nextDraft = cloneDraftRecord(draft);
  delete nextDraft.createMealLog;
  delete nextDraft.create_meal_log;
  nextDraft.schemaVersion = 'recipe_cook_operation.v2';
  return nextDraft;
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

function foodProfileRecord(value: Record<string, unknown>, fallback: Record<string, unknown> = {}) {
  const type = asText(value.type) || asText(fallback.type) || 'readyMade';
  return {
    ...fallback,
    ...value,
    name: asText(value.name) || asText(fallback.name),
    type,
    category: asText(value.category) || asText(fallback.category),
    suitableMealTypes: normalizeAiDraftTagValues(value.suitable_meal_types ?? value.suitableMealTypes ?? fallback.suitable_meal_types ?? fallback.suitableMealTypes),
    flavorTags: normalizeAiDraftTagValues(value.flavor_tags ?? value.flavorTags ?? fallback.flavor_tags ?? fallback.flavorTags),
    sourceName: asText(value.source_name) || asText(value.sourceName) || asText(fallback.source_name) || asText(fallback.sourceName),
    notes: asText(value.notes) || asText(fallback.notes),
    stockQuantity: value.stock_quantity ?? value.stockQuantity ?? fallback.stock_quantity ?? fallback.stockQuantity ?? null,
    stockUnit: asText(value.stock_unit) || asText(value.stockUnit) || asText(fallback.stock_unit) || asText(fallback.stockUnit),
    storageLocation: asText(value.storage_location) || asText(value.storageLocation) || asText(fallback.storage_location) || asText(fallback.storageLocation),
    favorite: Boolean(value.favorite ?? fallback.favorite),
  };
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
    foodType: asText(item.foodType),
    deductStock: item.deductStock === true,
    stockQuantity: asText(item.stockQuantity),
    stockUnit: asText(item.stockUnit),
    stockCurrentQuantity: asText(item.stockCurrentQuantity),
    stockAfterQuantity: asText(item.stockAfterQuantity),
  }));
}

function validateMealLogDraftForSubmit(draft: Record<string, unknown>) {
  const action = asText(draft.action);
  if (action === 'update_composition') return validateMealCompositionCorrectionForSubmit(draft);
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
  for (const food of foods) {
    if (!food.deductStock) continue;
    if (!READY_LIKE_FOOD_TYPES.has(food.foodType)) return '只有成品、速食或包装食品支持随餐食记录扣减库存';
    if (!food.stockUnit) return `${food.name}尚未设置库存单位`;
    const parsed = parseFoodStockQuantity(food.stockQuantity, `${food.name}扣减数量`);
    if (parsed.error) return parsed.error;
    const currentQuantity = Number(food.stockCurrentQuantity);
    if (parsed.quantity !== null && Number.isFinite(currentQuantity) && parsed.quantity > currentQuantity) {
      return `${food.name}当前最多只能扣减 ${food.stockCurrentQuantity}${food.stockUnit}`;
    }
  }
  return '';
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
  const recipeCookSchemaVersion = draftType === 'recipe_cook'
    ? resolveRecipeCookSchemaVersion(currentApproval, structuredDraft)
    : 'unknown';
  const recipeCookRequiresRegeneration =
    draftType === 'recipe_cook'
    && recipeCookSchemaVersion !== 'recipe_cook_operation.v2';
  const usesStructuredDraftEditor = ['recipe', 'recipe_cook', 'meal_plan', 'shopping_list', 'inventory_intake', 'meal_log', 'food_profile', 'ingredient_profile', 'inventory_operation', 'composite_operation'].includes(draftType);
  const inventoryOperationDraft = useMemo(
    () => inventoryOperationDraftFromRecord(structuredDraft),
    [structuredDraft],
  );
  const staticFoodOptions = useMemo<AiResourceOption[]>(() => foods.map((food) => ({
    id: food.id,
    label: food.name,
    description: [food.category, foodTypeText(food.type)].filter(Boolean).join(' · '),
    imageUrl: resolveMediaUrl(food.images?.[0], 'thumb') ?? AI_RESOURCE_IMAGE_FALLBACK,
    unit: food.stock_unit,
    foodType: food.type,
    stockQuantity: food.stock_quantity,
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
        const recipeCookError = validateRecipeCookDraftForSubmit(structuredDraft, recipeCookSchemaVersion);
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
	      if (draftType === 'inventory_intake') {
	        const inventoryIntakeError = validateInventoryIntakeDraftForSubmit(structuredDraft);
	        if (inventoryIntakeError) {
	          setError(inventoryIntakeError);
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
	      } else if (draftType === 'recipe_cook') {
	        values = { draft: buildRecipeCookSubmitDraft(structuredDraft) };
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
    if (draftType === 'ingredient_profile' && asText(structuredDraft.action) === 'transition_tracking_mode') {
      return <AiIngredientTrackingTransitionApproval draft={structuredDraft} readonly={readonly} onChange={setStructuredDraft} />;
    }
    if (draftType === 'meal_log' && asText(structuredDraft.action) === 'update_composition') {
      return <AiMealCompositionCorrectionApproval draft={structuredDraft} readonly={readonly} onChange={setStructuredDraft} />;
    }
    if (draftType === 'inventory_intake') {
      return (
        <AiInventoryIntakeApproval
          draft={structuredDraft}
          readonly={readonly}
          onChange={setStructuredDraft}
        />
      );
    }
    if (draftType === 'composite_operation') {
      return (
        <AiCompositeOperationPreview
          draft={structuredDraft}
          status={currentApproval.status}
          readonly={readonly}
        />
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
      if (draftType === 'inventory_intake') {
        const items = asDraftArray(structuredDraft.items);
        const ignored = asDraftArray(structuredDraft.ignoredItems);
        const executable = items.filter((item) => asText(item.action) !== 'skip');
        return `${executable.length}项确认入库${ignored.length ? ` · ${ignored.length}项已忽略` : ''}`;
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
        const actionLabel = action === 'update' ? '修改' : action === 'delete' ? '删除' : '创建';
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
            <AiDraftImpactNote tone="danger" title="上次写入失败">
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
            </AiDraftImpactNote>
          )}
          {recipeApproval ? (
            <AiDraftRenderer
              approval={currentApproval}
              draftType={draftType}
              recipeApproval={recipeApproval}
              recipe={recipe}
              structuredDraft={structuredDraft}
              readonly={readonly}
              foodOptions={foodOptions}
              foodCategoryOptions={foodCategoryOptions}
              ingredientOptions={ingredientOptions}
              ingredients={ingredients}
              recipeCookSchemaVersion={recipeCookSchemaVersion}
              recipeCookRequiresRegeneration={recipeCookRequiresRegeneration}
              onRecipeChange={setRecipe}
              onStructuredDraftChange={setStructuredDraft}
              onLoadResourceOptions={loadApprovalResourceOptions}
              renderLegacyFallback={() => null}
            />
          ) : usesStructuredDraftEditor ? (
            <AiDraftRenderer
              approval={currentApproval}
              draftType={draftType}
              recipeApproval={recipeApproval}
              recipe={recipe}
              structuredDraft={structuredDraft}
              readonly={readonly}
              foodOptions={foodOptions}
              foodCategoryOptions={foodCategoryOptions}
              ingredientOptions={ingredientOptions}
              ingredients={ingredients}
              recipeCookSchemaVersion={recipeCookSchemaVersion}
              recipeCookRequiresRegeneration={recipeCookRequiresRegeneration}
              onRecipeChange={setRecipe}
              onStructuredDraftChange={setStructuredDraft}
              onLoadResourceOptions={loadApprovalResourceOptions}
              renderLegacyFallback={renderStructuredDraftEditor}
            />
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
              <button
                className="solid-button"
                type="button"
                disabled={isSubmitting || recipeCookRequiresRegeneration}
                onClick={() => submitDecision('approved')}
              >
                {isSubmitting ? '提交中...' : currentApproval.approve_label}
              </button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
