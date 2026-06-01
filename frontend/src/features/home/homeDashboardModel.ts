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
import { addDateKeyDays, todayKey } from '../../lib/date';
import { formatDate, formatRelativeDays, getFoodCover, INVENTORY_STATUS_LABELS, MEAL_TYPE_LABELS } from '../../lib/ui';

export const DASHBOARD_PLAN_MEAL_TYPES: MealType[] = ['breakfast', 'lunch', 'dinner', 'snack'];
export const DASHBOARD_TODO_PAGE_SIZE = 4;

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

export type DashboardExpiryTodoInventoryItem = InventoryItem & { daysLeft: number };

export type DashboardTodoItem =
  | {
      type: 'expiry';
      id: string;
      title: string;
      description: string;
      status: string;
      done: false;
      dateLabel: string;
      icon: DashboardIconName;
      item: DashboardExpiryTodoInventoryItem;
    }
  | {
      type: 'shopping';
      id: string;
      title: string;
      description: string;
      status: string;
      done: false;
      dateLabel: string;
      icon: DashboardIconName;
      item: ShoppingListItem;
    }
  | {
      type: 'meal';
      id: string;
      title: string;
      description: string;
      status: string;
      done: true;
      dateLabel: string;
      icon: DashboardIconName;
      item: MealLog;
    };

export function getExpiryDaysLeft(expiryDate: string, referenceDate: string) {
  const [expiryYear, expiryMonth, expiryDay] = expiryDate.slice(0, 10).split('-').map(Number);
  const [referenceYear, referenceMonth, referenceDay] = referenceDate.slice(0, 10).split('-').map(Number);
  const expiryTime = new Date(expiryYear, (expiryMonth || 1) - 1, expiryDay || 1).getTime();
  const referenceTime = new Date(referenceYear, (referenceMonth || 1) - 1, referenceDay || 1).getTime();
  return Math.round((expiryTime - referenceTime) / (1000 * 60 * 60 * 24));
}

export function getDashboardExpiryBadge(daysLeft: number) {
  if (daysLeft < 0) {
    return { label: `已过期${Math.abs(daysLeft)}天`, className: 'dashboard-expiry-badge dashboard-expiry-badge-expired' };
  }
  if (daysLeft === 0) {
    return { label: '今日过期', className: 'dashboard-expiry-badge dashboard-expiry-badge-today' };
  }
  if (daysLeft <= 3) {
    return { label: `还有${daysLeft}天过期`, className: 'dashboard-expiry-badge dashboard-expiry-badge-soon' };
  }
  return { label: `还有${daysLeft}天过期`, className: 'dashboard-expiry-badge dashboard-expiry-badge-later' };
}

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
  const title = item.title.trim();
  return (
    ingredients.find((ingredient) => ingredient.name === title) ??
    ingredients.find((ingredient) => title.includes(ingredient.name) || ingredient.name.includes(title)) ??
    null
  );
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
  inventoryAlertCount: number;
  shoppingItems: ShoppingListItem[];
  foodPlanItems: FoodPlanItem[];
  foodRecommendations?: FoodRecommendations | null;
  recipes: Recipe[];
  mealLogs: MealLog[];
  today: string;
  dashboardRecommendationPage: number;
  visibleDashboardTodoCount: number;
  visibleExpiryCount: number;
  selectedDashboardPlanDate: string;
  foodPlanWeekRange: { start: string; end: string };
}) {
  const availableInventoryCount = input.inventoryItems.filter((item) => (item.remaining_quantity ?? item.quantity) > 0).length;
  const expiringInventoryItems = input.inventoryItems
    .filter((item) => (item.remaining_quantity ?? item.quantity) > 0 && item.expiry_date)
    .map((item) => ({
      ...item,
      daysLeft: item.expiry_date ? getExpiryDaysLeft(item.expiry_date, input.today) : 99,
    }))
    .filter((item) => item.daysLeft <= 7)
    .sort((left, right) => left.daysLeft - right.daysLeft);
  const visibleExpiringInventoryItems = expiringInventoryItems.slice(0, input.visibleExpiryCount);
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
      label: '临期提醒',
      value: `${input.inventoryAlertCount}`,
      unit: '项',
      detail: '已过期/7 天内到期',
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
  const dashboardTodoItems: DashboardTodoItem[] = [
    ...expiringInventoryItems.map((item) => ({
      type: 'expiry' as const,
      id: `expiry-${item.id}`,
      title: `处理临期${item.ingredient_name}`,
      status: item.daysLeft <= 1 ? '紧急' : '待办',
      done: false as const,
      dateLabel: item.daysLeft <= 0 ? '今天' : formatRelativeDays(item.expiry_date ?? input.today),
      description: `${item.storage_location || INVENTORY_STATUS_LABELS[item.status]} · ${
        item.expiry_date ? formatDate(item.expiry_date) : '未记录到期日'
      }到期`,
      icon: 'bell' as const,
      item,
    })),
    ...pendingShoppingPreview.map((item) => ({
      type: 'shopping' as const,
      id: `shopping-${item.id}`,
      title: `补齐${item.title}`,
      status: '待办',
      done: false as const,
      dateLabel: '今天',
      description: `${item.quantity}${item.unit || ''}${item.reason ? ` · ${item.reason}` : ' · 采购后可快速入库'}`,
      icon: 'cart' as const,
      item,
    })),
    ...todaysMeals.map((meal) => ({
      type: 'meal' as const,
      id: `meal-${meal.id}`,
      title: `记录${MEAL_TYPE_LABELS[meal.meal_type]}`,
      status: '已完成',
      done: true as const,
      dateLabel: '今天',
      description:
        meal.food_entries.length > 0
          ? meal.food_entries.map((entry) => entry.food_name).join('、')
          : meal.notes || '查看这餐的记录详情',
      icon: 'check' as const,
      item: meal,
    })),
  ];
  const visibleDashboardTodoItems = dashboardTodoItems.slice(0, input.visibleDashboardTodoCount);
  const hasMoreDashboardTodoItems = visibleDashboardTodoItems.length < dashboardTodoItems.length;
  const dashboardCompletedCount = dashboardTodoItems.filter((item) => item.done).length;
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
    expiringInventoryItems,
    visibleExpiringInventoryItems,
    activeFoodPlanItems,
    pendingShoppingPreview,
    pendingShoppingCount,
    todaysMeals,
    dashboardStats,
    dashboardRecommendationItems,
    dashboardRecommendationPageCount,
    dashboardRecommendations,
    dashboardTodoItems,
    visibleDashboardTodoItems,
    hasMoreDashboardTodoItems,
    dashboardCompletedCount,
    dashboardWeekMealCapacity,
    dashboardPlanSummary,
    dashboardPlanDays,
    selectedDashboardPlanDay,
    selectedDashboardPlanDateLabel,
  };
}
