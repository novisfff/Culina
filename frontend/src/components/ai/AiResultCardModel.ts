import type {
  AiCacheScope,
  AiOperationResultEntity,
  AiOperationResultProjection,
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

const RESULT_STATUSES = new Set<AiOperationResultProjection['result_status']>(['completed', 'no_change', 'failed', 'reverted']);
const EXECUTION_MODES = new Set<AiOperationResultProjection['execution_mode']>(['manual_approval', 'policy_auto', 'policy_no_change']);
const OPERATION_STATUSES = new Set<NonNullable<AiOperationResultProjection['operation_status']>>(['pending', 'completed', 'failed', 'reverted']);
const REVERT_AVAILABILITIES = new Set<AiOperationResultProjection['revert_availability']>(['available', 'expired', 'unsupported', 'blocked', 'reverted']);
const CACHE_SCOPES = new Set<AiCacheScope>(['food', 'meal_log', 'meal_plan', 'shopping_list', 'inventory', 'ai_conversation']);

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isOperationResultEntity(value: unknown): value is AiOperationResultEntity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entity = value as Record<string, unknown>;
  return typeof entity.id === 'string'
    && typeof entity.label === 'string'
    && (entity.operation === undefined || isNullableString(entity.operation))
    && (entity.operationLabel === undefined || isNullableString(entity.operationLabel))
    && (entity.updatedAt === undefined || isNullableString(entity.updatedAt));
}

function parsedFiniteTime(value: string | null) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function operationResultProjection(card: AiResultCard): AiOperationResultProjection | null {
  if (card.type !== 'operation_result') return null;
  const data = card.data;
  if (
    typeof data.draft_id !== 'string'
    || !isNullableString(data.operation_id)
    || !RESULT_STATUSES.has(data.result_status as AiOperationResultProjection['result_status'])
    || !EXECUTION_MODES.has(data.execution_mode as AiOperationResultProjection['execution_mode'])
    || !(data.operation_status === null || OPERATION_STATUSES.has(data.operation_status as NonNullable<AiOperationResultProjection['operation_status']>))
    || typeof data.execution_explanation !== 'string'
    || !REVERT_AVAILABILITIES.has(data.revert_availability as AiOperationResultProjection['revert_availability'])
    || !isNullableString(data.revertible_until)
    || !isNullableString(data.revert_blocked_code)
    || typeof data.server_now !== 'string'
    || !Array.isArray(data.entities)
    || !data.entities.every(isOperationResultEntity)
    || !Array.isArray(data.cache_scopes)
    || !data.cache_scopes.every((scope) => CACHE_SCOPES.has(scope as AiCacheScope))
  ) return null;
  const projection = data as unknown as AiOperationResultProjection;
  if (projection.revert_availability === 'available') {
    const serverNowMs = parsedFiniteTime(projection.server_now);
    const deadlineMs = parsedFiniteTime(projection.revertible_until);
    if (serverNowMs === null || deadlineMs === null || deadlineMs < serverNowMs) return null;
  }
  return projection;
}

export type AiOperationResultViewModel = {
  eyebrow: string;
  canRevert: boolean;
  statusText: string;
  deadlineText: string | null;
  locallyExpired: boolean;
  tone: 'success' | 'danger' | 'warning' | 'neutral';
};

const OPERATION_RESULT_EYEBROWS = {
  manual_approval: '已按你的确认执行',
  policy_auto: '已自动执行',
  policy_no_change: '已是目标状态',
} as const;

function absoluteRevertDeadline(value: string | null) {
  if (!value || Number.isNaN(Date.parse(value))) return null;
  return `可撤销至 ${new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value))}`;
}

function revertStatusText(projection: AiOperationResultProjection, locallyExpired: boolean) {
  if (locallyExpired || projection.revert_availability === 'expired') return '撤销时间已过，可前往页面修改';
  if (projection.revert_availability === 'unsupported') return '此操作需要前往页面修正';
  if (projection.revert_availability === 'reverted') return '操作已撤销';
  if (projection.revert_availability === 'blocked') {
    if (projection.revert_blocked_code === 'revert_target_changed') return '相关内容后来被修改，无法安全撤销';
    if (projection.revert_blocked_code === 'revert_dependency_exists') return '该内容已被后续操作使用';
    return '当前无法安全撤销';
  }
  return '可在 1 小时内撤销';
}

export function operationResultViewModel(
  projection: AiOperationResultProjection,
  effectiveNowMs: number,
): AiOperationResultViewModel {
  if (projection.result_status === 'no_change') {
    return {
      eyebrow: '已是目标状态',
      canRevert: false,
      statusText: projection.execution_explanation,
      deadlineText: null,
      locallyExpired: false,
      tone: 'success',
    };
  }
  if (projection.result_status === 'failed') {
    return {
      eyebrow: '未完成操作',
      canRevert: false,
      statusText: '本次操作未完成',
      deadlineText: null,
      locallyExpired: false,
      tone: 'danger',
    };
  }
  if (projection.result_status === 'reverted') {
    return {
      eyebrow: '已撤销',
      canRevert: false,
      statusText: '操作已撤销',
      deadlineText: null,
      locallyExpired: false,
      tone: 'neutral',
    };
  }
  const serverNowMs = parsedFiniteTime(projection.server_now);
  const deadlineMs = parsedFiniteTime(projection.revertible_until);
  if (
    projection.revert_availability === 'available'
    && (
      serverNowMs === null
      || deadlineMs === null
      || deadlineMs < serverNowMs
      || !Number.isFinite(effectiveNowMs)
    )
  ) {
    return {
      eyebrow: OPERATION_RESULT_EYEBROWS[projection.execution_mode],
      canRevert: false,
      statusText: '撤销状态暂不可用，请刷新后重试',
      deadlineText: null,
      locallyExpired: false,
      tone: 'danger',
    };
  }
  const locallyExpired = deadlineMs !== null && effectiveNowMs > deadlineMs;
  const tone: AiOperationResultViewModel['tone'] = locallyExpired || projection.revert_availability === 'expired'
    ? 'danger'
    : projection.revert_availability === 'blocked'
      ? 'danger'
      : projection.revert_availability === 'unsupported' || projection.revert_availability === 'reverted'
        ? 'neutral'
        : 'success';
  return {
    eyebrow: OPERATION_RESULT_EYEBROWS[projection.execution_mode],
    canRevert: Boolean(projection.operation_id)
      && projection.revert_availability === 'available'
      && !locallyExpired,
    statusText: revertStatusText(projection, locallyExpired),
    deadlineText: !locallyExpired && projection.revert_availability === 'available'
      ? absoluteRevertDeadline(projection.revertible_until)
      : null,
    locallyExpired,
    tone,
  };
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
