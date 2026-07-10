import type {
  AiOperationResultEntity,
  AiInventoryDisplayStatus,
  AiInventoryResultItem,
  AiResultCard,
  AiTodayRecommendationItem,
  MealType,
} from '../../api/types';
import { MEAL_TYPE_LABELS } from '../../lib/ui';

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
  set_status: '状态变更',
  set_done: '状态变更',
  set_favorite: '收藏',
  update_details: '补充详情',
  rate_food: '评分',
  cook: '做菜',
  restock: '补货',
  consume: '消耗',
  dispose: '销毁',
  inventory_operation: '库存处理',
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
  shopping_list: '采购项',
  meal_plan: '菜单计划',
  meal_log: '餐食记录',
  food_profile: '食物',
  ingredient_profile: '食材',
  inventory_operation: '库存处理',
  composite_operation: '复合操作',
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

export function operationResultEntityLabel(entity: AiOperationResultEntity) {
  const label = localizeOperationResultText(entity.label);
  return OPERATION_RESULT_ENTITY_FALLBACK_LABELS[label] ?? (label || '已处理项目');
}

export function operationResultOperationLabel(entity: AiOperationResultEntity) {
  const rawLabel = entity.operationLabel?.trim() || entity.operation?.trim() || '';
  if (!rawLabel) return '';
  const normalized = rawLabel.toLowerCase();
  return OPERATION_RESULT_ACTION_LABELS[rawLabel] ?? OPERATION_RESULT_ACTION_LABELS[normalized] ?? localizeOperationResultText(rawLabel);
}

export function inventoryStatusText(status: AiInventoryDisplayStatus, daysUntilExpiry?: number | null) {
  if (status === 'expired') return daysUntilExpiry == null ? '已过期' : `已过期 ${Math.abs(daysUntilExpiry)} 天`;
  if (status === 'expiring') return daysUntilExpiry == null ? '临期' : daysUntilExpiry === 0 ? '今天到期' : `${daysUntilExpiry} 天后到期`;
  if (status === 'low_stock') return '库存偏低';
  return '库存充足';
}

export function inventoryExpiryText(item: AiInventoryResultItem) {
  if (!item.expiryDate) return '未记录保质期';
  return `保质期至 ${item.expiryDate}`;
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
