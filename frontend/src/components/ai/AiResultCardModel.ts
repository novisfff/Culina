import type {
  AiOperationResultEntity,
  AiInventoryDisplayStatus,
  AiInventoryResultItem,
  AiResultCard,
  AiTodayRecommendationItem,
  MealType,
} from '../../api/types';
import type { AppNavigationTarget } from '../../app/appNavigationModel';
import { MEAL_TYPE_LABELS } from '../../lib/ui';

export type AiNavigableEntityType =
  | 'food'
  | 'recipe'
  | 'meal_plan'
  | 'meal_log'
  | 'food_plan'
  | 'food_profile';

export type AiNavigableEntity = {
  type: AiNavigableEntityType | string;
  id: string;
};

/**
 * Map AI result entities onto semantic AppNavigationTarget values.
 * No tab setters — callers must navigate(target).
 */
export function targetForAiEntity(entity: AiNavigableEntity): AppNavigationTarget | null {
  switch (entity.type) {
    case 'food':
    case 'food_profile':
      return { workspace: 'eat', view: 'food', foodId: entity.id };
    case 'recipe':
      return { workspace: 'eat', view: 'recipe', recipeId: entity.id };
    case 'meal_plan':
    case 'food_plan':
      return { workspace: 'eat', view: 'plan', foodPlanItemId: entity.id };
    case 'meal_log':
      return { workspace: 'eat', view: 'history', mealLogId: entity.id };
    default:
      return null;
  }
}

export const AI_RESULT_PLACEHOLDER = '/assets/ai-food-ingredient-placeholder.png';

export function inventoryItems(card: AiResultCard): AiInventoryResultItem[] {
  return Array.isArray(card.data.items)
    ? card.data.items.filter((item): item is AiInventoryResultItem => 'id' in item && 'sourceType' in item)
    : [];
}

export function recommendationItems(card: AiResultCard): AiTodayRecommendationItem[] {
  return Array.isArray(card.data.recommendations) ? card.data.recommendations : [];
}

export function operationResultEntities(card: AiResultCard): AiOperationResultEntity[] {
  return Array.isArray(card.data.entities) ? card.data.entities : [];
}

const OPERATION_RESULT_ACTION_LABELS: Record<string, string> = {
  create: '新增',
  update: '更新',
  delete: '删除',
  set_status: '更新状态',
  set_done: '更新状态',
  set_favorite: '收藏',
  update_details: '补充详情',
  rate_food: '评分',
  cook: '做菜',
  restock: '补货',
  consume: '扣减库存',
  dispose: '丢弃',
  inventory_operation: '库存变更',
};

const MEAL_TYPE_TOKEN_MAP: Record<string, MealType> = {
  breakfast: 'breakfast',
  lunch: 'lunch',
  dinner: 'dinner',
  snack: 'snack',
};

const OPERATION_RESULT_ENTITY_FALLBACK_LABELS: Record<string, string> = {
  recipe: '菜谱',
  recipe_cook: '做菜记录',
  shopping_list: '待买内容',
  meal_plan: '餐食计划',
  meal_log: '餐食记录',
  food_profile: '食物',
  ingredient_profile: '食材',
  inventory_operation: '库存变更',
  composite_operation: '一组变更',
};

function mealTypeDisplayText(value: string) {
  const normalized = value.trim().replace(/^MealType\./i, '').toLowerCase();
  const mealType = MEAL_TYPE_TOKEN_MAP[normalized];
  return mealType ? MEAL_TYPE_LABELS[mealType] : '';
}

export function localizeOperationResultText(value?: string | null) {
  if (!value) return '';
  return value.replace(
    /(^|[^A-Za-z0-9_])(?:MealType\.)?(BREAKFAST|LUNCH|DINNER|SNACK|breakfast|lunch|dinner|snack)(?=$|[^A-Za-z0-9_])/g,
    (match, prefix: string, mealType: string) => {
      const label = mealTypeDisplayText(mealType);
      return label ? `${prefix}${label}` : match;
    },
  );
}

/**
 * Normalize legacy inventory wording at the rendering boundary. API values and
 * operation enums stay unchanged; only copy shown in a result card is adapted
 * to the product language used elsewhere in the inventory workspace.
 */
export function localizeInventoryOperationText(value?: string | null) {
  if (!value) return '';
  // Apply legacy replacements in one pass.  A chained `入库` replacement can
  // match the `入库` substring inside the canonical copy `加入库存`, producing
  // broken text such as `加加入库存存` when a result is localized twice.
  const replacements: Record<string, string> = {
    '入库并完成采购项': '加入库存并完成待买内容',
    '直接入库': '直接加入库存',
    '已入库': '已加入库存',
    '录入库存': '加入库存',
    '库存记录': '库存',
    '采购项': '待买内容',
    '库存处理': '库存变更',
    '入库': '加入库存',
  };
  return value.replace(/入库并完成采购项|直接入库|已入库|录入库存|库存记录|采购项|库存处理|(?<!加)入库/g, (match) => replacements[match] ?? match);
}

export function operationResultEntityLabel(entity: AiOperationResultEntity) {
  const label = localizeInventoryOperationText(localizeOperationResultText(entity.label));
  return OPERATION_RESULT_ENTITY_FALLBACK_LABELS[label] ?? (label || '已处理内容');
}

export function operationResultOperationLabel(entity: AiOperationResultEntity) {
  const rawLabel = entity.operationLabel?.trim() || entity.operation?.trim() || '';
  if (!rawLabel) return '';
  const normalized = rawLabel.toLowerCase();
  return localizeInventoryOperationText(
    OPERATION_RESULT_ACTION_LABELS[rawLabel] ?? OPERATION_RESULT_ACTION_LABELS[normalized] ?? localizeOperationResultText(rawLabel),
  );
}

export function inventoryStatusText(status: AiInventoryDisplayStatus, daysUntilExpiry?: number | null) {
  if (status === 'expired') return daysUntilExpiry == null ? '已过期' : `已过期 ${Math.abs(daysUntilExpiry)} 天`;
  if (status === 'expiring') return daysUntilExpiry == null ? '临期' : daysUntilExpiry === 0 ? '今天到期' : `${daysUntilExpiry} 天后到期`;
  if (status === 'low_stock') return '库存偏低';
  return '库存充足';
}

export function inventoryExpiryText(item: AiInventoryResultItem) {
  if (!item.expiryDate) return '未填写到期日';
  return `到期日 ${item.expiryDate}`;
}

export function recommendationMeta(item: AiTodayRecommendationItem) {
  const values = item.entityType === 'recipe'
    ? [
        item.prepMinutes ? `${item.prepMinutes} 分钟` : '',
        item.servings ? `${item.servings} 人份` : '',
        item.difficulty || '',
      ]
    : [item.category || '', item.foodType || ''];
  return values.filter(Boolean).join(' · ');
}

export function evidenceText(item: AiTodayRecommendationItem) {
  return item.evidence
    .map((evidence) => [evidence.label, evidence.detail].filter(Boolean).join(' · '))
    .filter(Boolean)
    .slice(0, 3);
}
