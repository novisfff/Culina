import { describe, expect, it, vi } from 'vitest';
import type { Food, FoodPlanItem, Ingredient, InventoryItem, MealLog, ShoppingListItem } from '../../api/types';
import {
  buildHomeDashboardViewModel,
  buildHomeRestockForm,
  findShoppingIngredient,
  formatDashboardPlanRange,
  getDashboardExpiryBadge,
  getExpiryDaysLeft,
  parsePositiveNumber,
  resolveExpiryDateFromDays,
  resolveInventoryStatusForStorage,
} from './homeDashboardModel';

const ingredient: Ingredient = {
  id: 'ingredient-1',
  family_id: 'family-1',
  name: '鸡蛋',
  category: '蛋奶',
  default_unit: '个',
  unit_conversions: [],
  default_storage: '冷藏',
  default_expiry_mode: 'days',
  default_expiry_days: 14,
  default_low_stock_threshold: 4,
  notes: '',
  image: null,
  created_at: '2026-06-01T00:00:00.000Z',
  updated_at: '2026-06-01T00:00:00.000Z',
};

const shoppingItem: ShoppingListItem = {
  id: 'shopping-1',
  family_id: 'family-1',
  title: '鸡蛋',
  quantity: 6,
  unit: '个',
  reason: '库存不足',
  done: false,
  created_at: '2026-06-01T00:00:00.000Z',
  updated_at: '2026-06-01T00:00:00.000Z',
};

describe('homeDashboardModel', () => {
  it('formats expiry distance and badges', () => {
    expect(getExpiryDaysLeft('2026-06-04', '2026-06-01')).toBe(3);
    expect(getExpiryDaysLeft('2026-05-30', '2026-06-01')).toBe(-2);
    expect(getDashboardExpiryBadge(-2)).toEqual({
      label: '已过期2天',
      className: 'dashboard-expiry-badge dashboard-expiry-badge-expired',
    });
    expect(getDashboardExpiryBadge(0).label).toBe('今日过期');
    expect(getDashboardExpiryBadge(3).className).toContain('soon');
    expect(getDashboardExpiryBadge(8).className).toContain('later');
  });

  it('builds restock defaults from matched ingredient', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T08:00:00.000Z'));

    const form = buildHomeRestockForm(shoppingItem, [ingredient]);

    expect(form).toMatchObject({
      ingredientId: 'ingredient-1',
      ingredientQuery: '鸡蛋',
      quantity: '6',
      unit: '个',
      purchaseDate: '2026-06-01',
      storageLocation: '冷藏',
      expiryInputMode: 'days',
      expiryDays: '14',
      expiryDate: '2026-06-15',
      status: 'fresh',
      notes: '来自采购提醒：库存不足',
    });

    vi.useRealTimers();
  });

  it('handles standalone dashboard helpers', () => {
    expect(formatDashboardPlanRange({ start: '2026-06-01', end: '2026-06-07' })).toBe('6月1日 - 6月7日');
    expect(resolveInventoryStatusForStorage(' 冷冻 ')).toBe('frozen');
    expect(resolveInventoryStatusForStorage('冷藏')).toBe('fresh');
    expect(resolveExpiryDateFromDays('2026-06-01', '3')).toBe('2026-06-04');
    expect(resolveExpiryDateFromDays('2026-06-01', '0')).toBe('');
    expect(parsePositiveNumber(' 1.5 ')).toBe(1.5);
    expect(parsePositiveNumber('0')).toBeNull();
    expect(findShoppingIngredient({ ...shoppingItem, title: '有机鸡蛋' }, [ingredient])?.id).toBe('ingredient-1');
  });

  it('builds dashboard view model from inventory, shopping, meals, and plan data', () => {
    const inventoryItems: InventoryItem[] = [
      {
        id: 'inventory-expired',
        family_id: 'family-1',
        ingredient_id: 'ingredient-1',
        ingredient_name: '鸡蛋',
        quantity: 3,
        remaining_quantity: 3,
        unit: '个',
        status: 'fresh',
        purchase_date: '2026-05-20',
        expiry_date: '2026-05-31',
        storage_location: '冷藏',
        notes: '',
        low_stock_threshold: 1,
        created_at: '2026-05-20T00:00:00.000Z',
        updated_at: '2026-05-20T00:00:00.000Z',
      },
      {
        id: 'inventory-soon',
        family_id: 'family-1',
        ingredient_id: 'ingredient-2',
        ingredient_name: '牛奶',
        quantity: 1,
        remaining_quantity: 1,
        unit: '盒',
        status: 'opened',
        purchase_date: '2026-05-30',
        expiry_date: '2026-06-03',
        storage_location: '冷藏',
        notes: '',
        low_stock_threshold: 1,
        created_at: '2026-05-30T00:00:00.000Z',
        updated_at: '2026-05-30T00:00:00.000Z',
      },
      {
        id: 'inventory-safe',
        family_id: 'family-1',
        ingredient_id: 'ingredient-3',
        ingredient_name: '米',
        quantity: 2,
        remaining_quantity: 2,
        unit: '袋',
        status: 'fresh',
        purchase_date: '2026-05-30',
        expiry_date: '2026-07-30',
        storage_location: '常温',
        notes: '',
        low_stock_threshold: 1,
        created_at: '2026-05-30T00:00:00.000Z',
        updated_at: '2026-05-30T00:00:00.000Z',
      },
    ];
    const food: Food = {
      id: 'food-1',
      family_id: 'family-1',
      name: '番茄炒蛋',
      type: 'selfMade',
      category: '家常菜',
      flavor_tags: [],
      scene_tags: [],
      suitable_meal_types: ['dinner'],
      source_name: '',
      purchase_source: '',
      scene: '',
      images: [],
      notes: '',
      routine_note: '',
      stock_unit: '份',
      favorite: false,
      recipe_id: null,
      created_at: '2026-06-01T00:00:00.000Z',
      updated_at: '2026-06-01T00:00:00.000Z',
    };
    const planItem: FoodPlanItem = {
      id: 'plan-1',
      family_id: 'family-1',
      user_id: 'user-1',
      food_id: 'food-1',
      food_name: '番茄炒蛋',
      food_type: 'selfMade',
      recipe_id: null,
      recipe_title: '',
      plan_date: '2026-06-01',
      meal_type: 'dinner',
      note: '',
      status: 'planned',
      created_at: '2026-06-01T00:00:00.000Z',
      updated_at: '2026-06-01T00:00:00.000Z',
    };
    const meal: MealLog = {
      id: 'meal-1',
      family_id: 'family-1',
      date: '2026-06-01',
      meal_type: 'lunch',
      food_entries: [{ id: 'entry-1', food_id: 'food-1', food_name: '番茄炒蛋', servings: 1, note: '' }],
      participant_user_ids: ['user-1'],
      notes: '',
      mood: '不错',
      photos: [],
      deduction_suggestions: [],
      created_at: '2026-06-01T12:00:00.000Z',
      updated_at: '2026-06-01T12:00:00.000Z',
    };

    const model = buildHomeDashboardViewModel({
      inventoryItems,
      inventoryAlertCount: 2,
      shoppingItems: [shoppingItem, { ...shoppingItem, id: 'shopping-done', done: true }],
      foodPlanItems: [planItem, { ...planItem, id: 'plan-skipped', status: 'skipped' }],
      foodRecommendations: {
        target_meal_type: 'dinner',
        target_date: '2026-06-01',
        items: [{ food, score: 0.9, reasons: ['适合晚餐'], primary_action: 'quick_add_meal' }],
      },
      recipes: [],
      mealLogs: [meal, { ...meal, id: 'meal-old', date: '2026-05-31' }],
      today: '2026-06-01',
      dashboardRecommendationPage: 0,
      visibleDashboardTodoCount: 2,
      visibleExpiryCount: 1,
      selectedDashboardPlanDate: '2026-06-01',
      foodPlanWeekRange: { start: '2026-06-01', end: '2026-06-07' },
    });

    expect(model.expiringInventoryItems.map((item) => item.id)).toEqual(['inventory-expired', 'inventory-soon']);
    expect(model.visibleExpiringInventoryItems).toHaveLength(1);
    expect(model.pendingShoppingCount).toBe(1);
    expect(model.dashboardRecommendationPageCount).toBe(1);
    expect(model.dashboardRecommendations[0]?.recommendation.food.id).toBe('food-1');
    expect(model.dashboardTodoItems.map((item) => item.type)).toEqual(['expiry', 'expiry', 'shopping', 'meal']);
    expect(model.visibleDashboardTodoItems).toHaveLength(2);
    expect(model.hasMoreDashboardTodoItems).toBe(true);
    expect(model.dashboardCompletedCount).toBe(1);
    expect(model.activeFoodPlanItems).toHaveLength(1);
    expect(model.dashboardPlanDays[0]).toMatchObject({
      date: '2026-06-01',
      plannedMealCount: 1,
      totalCount: 1,
      isToday: true,
      isSelected: true,
    });
    expect(model.selectedDashboardPlanDateLabel).toContain('今天');
  });
});
