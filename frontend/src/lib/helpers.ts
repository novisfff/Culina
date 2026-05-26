import type {
  ActivityAction,
  ActivityLog,
  AiMode,
  AppState,
  Food,
  FoodType,
  ImageInputValue,
  Ingredient,
  InventoryItem,
  InventoryStatus,
  MealLog,
  MealType,
  PhotoAsset,
  Recipe
} from './types';

export const STORAGE_KEY = 'culina-app-state-v1';

export const FOOD_TYPE_LABELS: Record<FoodType, string> = {
  selfMade: '家常菜',
  takeout: '外卖',
  diningOut: '外食',
  readyMade: '成品',
  instant: '速食',
  packaged: '成品'
};

export const MEAL_TYPE_LABELS: Record<MealType, string> = {
  breakfast: '早餐',
  lunch: '午餐',
  dinner: '晚餐',
  snack: '加餐'
};

export const INVENTORY_STATUS_LABELS: Record<InventoryStatus, string> = {
  fresh: '新鲜',
  opened: '已开封',
  frozen: '冷冻',
  expiring: '临期'
};

export const AI_MODE_LABELS: Record<AiMode, string> = {
  foodQa: '单菜问答',
  inventoryQa: '库存问答',
  recommendation: '今日吃什么',
  recipeDraft: '菜谱草稿'
};

export function createId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function todayKey(): string {
  const today = new Date();
  const year = today.getFullYear();
  const month = `${today.getMonth() + 1}`.padStart(2, '0');
  const day = `${today.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function formatDate(date: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    weekday: 'short'
  }).format(new Date(date));
}

export function formatDateTime(date: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(date));
}

export function formatRelativeDays(date: string): string {
  const today = new Date(todayKey()).getTime();
  const target = new Date(date).getTime();
  const diff = Math.round((target - today) / (1000 * 60 * 60 * 24));
  if (diff === 0) {
    return '今天';
  }
  if (diff === 1) {
    return '明天';
  }
  if (diff > 1) {
    return `${diff} 天后`;
  }
  return `${Math.abs(diff)} 天前`;
}

export function buildMeta(userId: string, prefix: string) {
  const timestamp = nowIso();
  return {
    id: createId(prefix),
    createdAt: timestamp,
    updatedAt: timestamp,
    createdBy: userId,
    updatedBy: userId
  };
}

export function makeActivity(
  familyId: string,
  actorId: string,
  action: ActivityAction,
  entityType: string,
  entityId: string,
  summary: string
): ActivityLog {
  return {
    id: createId('activity'),
    familyId,
    actorId,
    action,
    entityType,
    entityId,
    summary,
    createdAt: nowIso()
  };
}

export function initials(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

export function avatarColor(seed: string): string {
  const palette = ['#f28f60', '#e56b6f', '#7a9e7e', '#4c82a4', '#d2a24c', '#8b77d1'];
  const index =
    [...seed].reduce((sum, char) => sum + char.charCodeAt(0), 0) % palette.length;
  return palette[index];
}

export function countRecentMealUsage(state: AppState, foodId: string): number {
  return state.mealLogs.filter((log) => log.foodEntries.some((item) => item.foodId === foodId)).length;
}

export function buildInventoryAlerts(
  inventoryItems: InventoryItem[],
  ingredients: Ingredient[]
): Array<{ id: string; title: string; detail: string; tone: 'warning' | 'danger' }> {
  const alerts = inventoryItems.flatMap((item) => {
    const ingredient = ingredients.find((entry) => entry.id === item.ingredientId);
    if (!ingredient) {
      return [];
    }
    const lowStock = item.quantity <= item.lowStockThreshold;
    const daysToExpiry = item.expiryDate
      ? Math.round(
          (new Date(item.expiryDate).getTime() - new Date(todayKey()).getTime()) /
            (1000 * 60 * 60 * 24)
        )
      : null;

    const list = [];
    if (lowStock) {
      list.push({
        id: `${item.id}-low`,
        title: `${ingredient.name} 库存偏低`,
        detail: `当前仅剩 ${item.quantity}${item.unit}，建议补货`,
        tone: 'warning' as const
      });
    }
    if (daysToExpiry !== null && daysToExpiry <= 2) {
      list.push({
        id: `${item.id}-expiry`,
        title: `${ingredient.name} ${daysToExpiry < 0 ? '已过期' : '即将到期'}`,
        detail: item.expiryDate
          ? `到期时间 ${formatDate(item.expiryDate)}，优先安排使用`
          : '建议尽快使用',
        tone: 'danger' as const
      });
    }
    return list;
  });

  return alerts.slice(0, 4);
}

export function getFoodCover(food: Food): PhotoAsset | undefined {
  return food.images[0];
}

export function getRecipeCover(recipe: Recipe): PhotoAsset | undefined {
  return recipe.images[0];
}

export function getImagePreview(value: ImageInputValue): PhotoAsset | undefined {
  return value.generatedAsset ?? value.referenceAsset;
}

export function splitTags(value: string): string[] {
  return value
    .split(/[,\n，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function deriveFamilyStats(state: AppState) {
  return {
    foods: state.foods.length,
    recipes: state.recipes.length,
    ingredients: state.ingredients.length,
    mealsToday: state.mealLogs.filter((log) => log.date === todayKey()).length
  };
}

export function lookupFood(state: AppState, foodId: string): Food | undefined {
  return state.foods.find((food) => food.id === foodId);
}

export function lookupRecipeByFood(state: AppState, foodId: string): Recipe | undefined {
  const food = lookupFood(state, foodId);
  return food?.recipeId ? state.recipes.find((recipe) => recipe.id === food.recipeId) : undefined;
}

export function sortByUpdatedAtDesc<T extends { updatedAt?: string; createdAt?: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const left = a.updatedAt ?? a.createdAt ?? '';
    const right = b.updatedAt ?? b.createdAt ?? '';
    return right.localeCompare(left);
  });
}

export function sortLogs(logs: MealLog[]): MealLog[] {
  return [...logs].sort((a, b) => {
    const dateCompare = b.date.localeCompare(a.date);
    if (dateCompare !== 0) {
      return dateCompare;
    }
    return b.createdAt.localeCompare(a.createdAt);
  });
}
