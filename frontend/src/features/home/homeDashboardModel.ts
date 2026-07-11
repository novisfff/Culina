import type {
  FoodPlanItem,
  FoodRecommendations,
  Ingredient,
  IngredientExpiryMode,
  InventoryItem,
  InventoryStatus,
  MealLog,
  MealType,
  Recipe,
  ShoppingListItem,
} from '../../api/types';
import type { DashboardIconName } from '../../app/shellIcons';
import {
  selectHomeEligibleInventoryActionGroups,
  selectHomeInventoryActionGroups,
  type InventoryActionGroup,
} from '../inventory/inventoryActionModel';
import { addDateKeyDays, todayKey } from '../../lib/date';
import { formatDate, getFoodCover } from '../../lib/ui';

export const DASHBOARD_PLAN_MEAL_TYPES: MealType[] = ['breakfast', 'lunch', 'dinner', 'snack'];

export type HomeRestockFormState = {
  ingredientId: string;
  ingredientQuery: string;
  quantity: string;
  unit: string;
  purchaseDate: string;
  storageLocation: string;
  expiryInputMode: IngredientExpiryMode;
  expiryDays: string;
  expiryDate: string;
  status: InventoryStatus;
  notes: string;
};

export type DashboardStat = {
  label: string;
  value: string;
  unit: string;
  detail: string;
  icon: DashboardIconName;
  tone: string;
};

export type DashboardRecommendation = {
  recommendation: FoodRecommendations['items'][number];
  coverUrl?: string;
};

export type DashboardPlanMeal = {
  mealType: MealType;
  items: FoodPlanItem[];
};

export type DashboardPlanDay = {
  date: string;
  weekday: string;
  dayLabel: string;
  mealItems: DashboardPlanMeal[];
  plannedMealCount: number;
  totalCount: number;
  isToday: boolean;
  isSelected: boolean;
};

export type DashboardPlanSummaryItem = {
  label: string;
  value: number;
  icon: DashboardIconName;
  tone: string;
};

export function formatDashboardPlanRange(range: { start: string; end: string }) {
  const format = (dateKey: string) => {
    const [, month, day] = dateKey.split('-');
    return `${Number(month)}月${Number(day)}日`;
  };
  return `${format(range.start)} - ${format(range.end)}`;
}

export function resolveInventoryStatusForStorage(storageLocation: string): InventoryStatus {
  return storageLocation.trim() === '冷冻' ? 'frozen' : 'fresh';
}

export function resolveExpiryDateFromDays(purchaseDate: string, expiryDays: string) {
  const safeDays = Number(expiryDays);
  if (!purchaseDate || !Number.isFinite(safeDays) || safeDays <= 0) {
    return '';
  }
  return addDateKeyDays(purchaseDate, safeDays);
}

export function parsePositiveNumber(value: string) {
  const numeric = Number(value.trim());
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

export function findShoppingIngredient(item: ShoppingListItem, ingredients: Ingredient[]) {
  if (item.ingredient_id) {
    return ingredients.find((ingredient) => ingredient.id === item.ingredient_id) ?? null;
  }
  const title = item.title.trim();
  if (!title) {
    return null;
  }
  return ingredients.find((ingredient) => ingredient.name.trim() === title) ?? null;
}

/** Exact normalized name match for restock free-text binding (no substring). */
export function matchIngredientByExactName(query: string, ingredients: Ingredient[]) {
  const title = query.trim();
  if (!title) {
    return null;
  }
  return ingredients.find((ingredient) => ingredient.name.trim() === title) ?? null;
}

export function buildHomeRestockForm(item: ShoppingListItem, ingredients: Ingredient[]): HomeRestockFormState {
  const ingredient = findShoppingIngredient(item, ingredients);
  const purchaseDate = todayKey();
  const expiryInputMode = ingredient?.default_expiry_mode ?? 'none';
  const expiryDays =
    expiryInputMode === 'days' && ingredient?.default_expiry_days !== null && ingredient?.default_expiry_days !== undefined
      ? String(ingredient.default_expiry_days)
      : '';
  const storageLocation = ingredient?.default_storage || '冷藏';
  return {
    ingredientId: ingredient?.id ?? '',
    ingredientQuery: ingredient?.name ?? item.title,
    quantity: String(item.quantity || 1),
    unit: item.unit || ingredient?.default_unit || '个',
    purchaseDate,
    storageLocation,
    expiryInputMode,
    expiryDays,
    expiryDate: expiryInputMode === 'days' ? resolveExpiryDateFromDays(purchaseDate, expiryDays) : '',
    status: resolveInventoryStatusForStorage(storageLocation),
    notes: item.reason ? `来自采购提醒：${item.reason}` : '来自首页采购提醒',
  };
}

export function buildHomeDashboardViewModel(input: {
  inventoryItems: InventoryItem[];
  inventoryActionGroups: InventoryActionGroup[];
  availableIngredientCount: number;
  shoppingItems: ShoppingListItem[];
  foodPlanItems: FoodPlanItem[];
  foodRecommendations?: FoodRecommendations | null;
  recipes: Recipe[];
  mealLogs: MealLog[];
  today: string;
  dashboardRecommendationPage: number;
  selectedDashboardPlanDate: string;
  foodPlanWeekRange: { start: string; end: string };
}) {
  const homeEligibleInventoryActionGroups = selectHomeEligibleInventoryActionGroups(input.inventoryActionGroups);
  const homeInventoryActionGroups = selectHomeInventoryActionGroups(input.inventoryActionGroups, 3);
  const homeInventoryActionCount = homeEligibleInventoryActionGroups.length;
  const hasLaterInventoryActionGroups = input.inventoryActionGroups.some(
    (group) => group.kind === 'expiry' && group.severity === 'expires_later'
  );
  const hasFullListInventoryActionGroups = input.inventoryActionGroups.length > homeInventoryActionGroups.length;
  const availableInventoryCount = input.availableIngredientCount;
  const activeFoodPlanItems = input.foodPlanItems.filter((item) => item.status !== 'skipped');
  const pendingShoppingPreview = input.shoppingItems.filter((item) => !item.done);
  const pendingShoppingCount = pendingShoppingPreview.length;
  const todaysMeals = input.mealLogs.filter((item) => item.date === input.today);
  const dashboardStats: DashboardStat[] = [
    {
      label: '在库食材',
      value: `${availableInventoryCount}`,
      unit: '种',
      detail: '库存充足',
      icon: 'leaf',
      tone: 'green',
    },
    {
      label: '需处理食材',
      value: `${homeInventoryActionCount}`,
      unit: '种',
      detail: '过期、临期或待补货',
      icon: 'bell',
      tone: 'coral',
    },
    {
      label: '待采购',
      value: `${pendingShoppingCount}`,
      unit: '项',
      detail: pendingShoppingCount > 0 ? '建议尽快补齐' : '清单已完成',
      icon: 'cart',
      tone: 'yellow',
    },
    {
      label: '本周做菜',
      value: `${activeFoodPlanItems.length}`,
      unit: '餐',
      detail: '计划进行中',
      icon: 'pot',
      tone: 'violet',
    },
  ];
  const dashboardRecommendationItems = (input.foodRecommendations?.items ?? []).map((item) => ({
    recommendation: item,
    coverUrl: getFoodCover(item.food, input.recipes),
  }));
  const dashboardRecommendationPageCount = Math.max(1, Math.ceil(dashboardRecommendationItems.length / 3));
  const dashboardRecommendations = dashboardRecommendationItems.slice(
    (input.dashboardRecommendationPage % dashboardRecommendationPageCount) * 3,
    (input.dashboardRecommendationPage % dashboardRecommendationPageCount) * 3 + 3
  );
  const dashboardWeekMealCapacity = 7 * DASHBOARD_PLAN_MEAL_TYPES.length;
  const completedFoodPlanCount = activeFoodPlanItems.filter((item) => item.status === 'cooked').length;
  const pendingFoodPlanSlots = Math.max(0, dashboardWeekMealCapacity - activeFoodPlanItems.length);
  const dashboardPlanSummary: DashboardPlanSummaryItem[] = [
    { label: '已安排', value: activeFoodPlanItems.length, icon: 'receipt', tone: 'orange' },
    { label: '待补充', value: pendingFoodPlanSlots, icon: 'flame', tone: 'amber' },
    { label: '已完成', value: completedFoodPlanCount, icon: 'check', tone: 'green' },
  ];
  const dashboardPlanDays: DashboardPlanDay[] = Array.from({ length: 7 }, (_, index) => {
    const date = addDateKeyDays(input.foodPlanWeekRange.start, index);
    const dayItems = activeFoodPlanItems.filter((entry) => entry.plan_date === date);
    const mealItems = DASHBOARD_PLAN_MEAL_TYPES.map((mealType) => {
      const items = dayItems.filter((item) => item.meal_type === mealType);
      return { mealType, items };
    });
    const plannedMealCount = mealItems.filter((entry) => entry.items.length > 0).length;
    return {
      date,
      weekday: ['一', '二', '三', '四', '五', '六', '日'][index],
      dayLabel: formatDate(date).replace('周', ''),
      mealItems,
      plannedMealCount,
      totalCount: dayItems.length,
      isToday: date === input.today,
      isSelected: date === input.selectedDashboardPlanDate,
    };
  });
  const selectedDashboardPlanDay =
    dashboardPlanDays.find((day) => day.date === input.selectedDashboardPlanDate) ?? dashboardPlanDays[0];
  const selectedDashboardPlanDateLabel = selectedDashboardPlanDay
    ? `${selectedDashboardPlanDay.isToday ? '今天' : `周${selectedDashboardPlanDay.weekday}`} · ${selectedDashboardPlanDay.dayLabel}`
    : '';
  return {
    availableInventoryCount,
    homeEligibleInventoryActionGroups,
    homeInventoryActionGroups,
    homeInventoryActionCount,
    hasLaterInventoryActionGroups,
    hasFullListInventoryActionGroups,
    activeFoodPlanItems,
    pendingShoppingPreview,
    pendingShoppingCount,
    todaysMeals,
    dashboardStats,
    dashboardRecommendationItems,
    dashboardRecommendationPageCount,
    dashboardRecommendations,
    dashboardWeekMealCapacity,
    dashboardPlanSummary,
    dashboardPlanDays,
    selectedDashboardPlanDay,
    selectedDashboardPlanDateLabel,
  };
}
