import { describe, expect, it, vi } from 'vitest';
import type {
  ActivityHighlight,
  Food,
  FoodPlanItem,
  Ingredient,
  InventoryItem,
  MealLog,
  ShoppingListItem,
} from '../../api/types';
import {
  buildInventoryActionGroups,
  countUniqueAvailableIngredients,
  type InventoryActionGroup,
} from '../inventory/inventoryActionModel';
import {
  advanceRecommendationCursor,
  buildHomeDashboardViewModel,
  buildHomeHighlightsViewModel,
  buildHomeRequiredActions,
  buildHomeRestockForm,
  findShoppingIngredient,
  homeHighlightIcon,
  getDashboardPlanProgress,
  matchIngredientByExactName,
  formatDashboardPlanRange,
  parsePositiveNumber,
  resolveExpiryDateFromDays,
  resolveHomeHighlightActor,
  resolveInventoryStatusForStorage,
  selectCircularWindow,
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
  row_version: 1,
  created_at: '2026-06-01T00:00:00.000Z',
  updated_at: '2026-06-01T00:00:00.000Z',
  target_type: 'ingredient',
  ingredient_id: 'ingredient-1',
};

describe('homeDashboardModel', () => {
  it('describes planned, partial, and completed meal-plan progress without conflating them', () => {
    const base: FoodPlanItem = {
      id: 'plan-1',
      family_id: 'family-1',
      user_id: 'user-1',
      food_id: 'food-1',
      food_name: '番茄炒蛋',
      food_type: 'selfMade',
      recipe_id: null,
      recipe_title: '',
      plan_date: '2026-07-16',
      meal_type: 'dinner',
      note: '',
      status: 'planned',
      created_at: '2026-07-15T00:00:00Z',
      updated_at: '2026-07-15T00:00:00Z',
    };

    expect(getDashboardPlanProgress([])).toEqual({ totalCount: 0, recordedCount: 0, pendingCount: 0, label: '待安排', state: 'empty' });
    expect(getDashboardPlanProgress([base, { ...base, id: 'plan-2' }])).toEqual({ totalCount: 2, recordedCount: 0, pendingCount: 2, label: '2 项安排', state: 'planned' });
    expect(getDashboardPlanProgress([base, { ...base, id: 'plan-2', status: 'cooked' }])).toEqual({ totalCount: 2, recordedCount: 1, pendingCount: 1, label: '已记录 1 / 2', state: 'partial' });
    expect(getDashboardPlanProgress([{ ...base, status: 'cooked' }, { ...base, id: 'plan-2', status: 'cooked' }])).toEqual({ totalCount: 2, recordedCount: 2, pendingCount: 0, label: '2 项已记录', state: 'complete' });
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
  });

  it('resolves shopping ingredients by id first and rejects substring collisions', () => {
    const milk = { ...ingredient, id: 'ingredient-milk', name: '牛奶' };
    const cereal = { ...ingredient, id: 'ingredient-cereal', name: '牛奶麦片' };
    const oil = { ...ingredient, id: 'ingredient-oil', name: '油' };
    const soy = { ...ingredient, id: 'ingredient-soy', name: '酱油' };

    expect(
      findShoppingIngredient(
        { ...shoppingItem, id: 's1', title: '被改过的标题', ingredient_id: milk.id, target_type: 'ingredient' },
        [milk, cereal]
      )?.id
    ).toBe(milk.id);
    expect(
      findShoppingIngredient(
        { ...shoppingItem, id: 's2', title: '牛奶麦片', ingredient_id: null, target_type: 'ingredient' },
        [milk, cereal]
      )?.id
    ).toBe(cereal.id);
    expect(
      findShoppingIngredient(
        { ...shoppingItem, id: 's3', title: '牛奶', ingredient_id: null, target_type: 'ingredient' },
        [milk, cereal]
      )?.id
    ).toBe(milk.id);
    expect(
      findShoppingIngredient(
        { ...shoppingItem, id: 's4', title: '有机鸡蛋', ingredient_id: null, target_type: 'ingredient' },
        [ingredient]
      )
    ).toBeNull();
    expect(
      findShoppingIngredient(
        { ...shoppingItem, id: 's5', title: '酱油', ingredient_id: null, target_type: 'ingredient' },
        [oil, soy]
      )?.id
    ).toBe(soy.id);
    expect(
      findShoppingIngredient(
        { ...shoppingItem, id: 's6', title: '油', ingredient_id: null, target_type: 'ingredient' },
        [oil, soy]
      )?.id
    ).toBe(oil.id);
  });

  it('matches restock free-text with exact normalized name only (no substring)', () => {
    const milk = { ...ingredient, id: 'ingredient-milk', name: '牛奶' };
    const cereal = { ...ingredient, id: 'ingredient-cereal', name: '牛奶麦片' };
    const oil = { ...ingredient, id: 'ingredient-oil', name: '油' };
    const soy = { ...ingredient, id: 'ingredient-soy', name: '酱油' };

    expect(matchIngredientByExactName('牛奶', [milk, cereal])?.id).toBe(milk.id);
    expect(matchIngredientByExactName(' 牛奶 ', [milk, cereal])?.id).toBe(milk.id);
    expect(matchIngredientByExactName('牛奶麦片', [milk, cereal])?.id).toBe(cereal.id);
    expect(matchIngredientByExactName('牛', [milk, cereal])).toBeNull();
    expect(matchIngredientByExactName('有机牛奶', [milk, cereal])).toBeNull();
    expect(matchIngredientByExactName('油', [oil, soy])?.id).toBe(oil.id);
    expect(matchIngredientByExactName('酱油', [oil, soy])?.id).toBe(soy.id);
    expect(matchIngredientByExactName('', [milk])).toBeNull();
  });

  it('builds dashboard view model from prepared inventory action groups', () => {
    const ingredients: Ingredient[] = [
      { ...ingredient, id: 'ingredient-1', name: '鸡蛋', default_low_stock_threshold: null },
      { ...ingredient, id: 'ingredient-2', name: '牛奶', default_low_stock_threshold: null },
      { ...ingredient, id: 'ingredient-3', name: '米', default_low_stock_threshold: null },
    ];
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
        row_version: 1,
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
        row_version: 1,
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
        row_version: 1,
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
      storage_location: '',
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
      row_version: 1,
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
    row_version: 1,
    created_at: '2026-06-01T12:00:00.000Z',
      updated_at: '2026-06-01T12:00:00.000Z',
    };

    const today = '2026-06-01';
    const inventoryActionGroups = buildInventoryActionGroups({
      inventoryItems,
      ingredients,
      shoppingItems: [shoppingItem],
      referenceDate: today,
    });
    const availableIngredientCount = countUniqueAvailableIngredients({ inventoryItems, referenceDate: today });

    const model = buildHomeDashboardViewModel({
      inventoryItems,
      inventoryActionGroups,
      availableIngredientCount,
      shoppingItems: [shoppingItem, { ...shoppingItem, id: 'shopping-done', done: true }],
      foodPlanItems: [planItem, { ...planItem, id: 'plan-skipped', status: 'skipped' }],
      foodRecommendations: {
        target_meal_type: 'dinner',
        target_date: '2026-06-01',
        items: [{ food, score: 0.9, reasons: ['适合晚餐'], primary_action: 'quick_add_meal' }],
      },
      recipes: [],
      mealLogs: [meal, { ...meal, id: 'meal-old', date: '2026-05-31' }],
      today,
      selectedDashboardPlanDate: '2026-06-01',
      foodPlanWeekRange: { start: '2026-06-01', end: '2026-06-07' },
    });

    expect(model.homeInventoryActionGroups.map((group) => group.kind)).toEqual(['expiry', 'expiry']);
    expect(model.homeInventoryActionGroups.map((group) => group.ingredientName)).toEqual(['鸡蛋', '牛奶']);
    expect(model.homeInventoryActionCount).toBe(2);
    expect('dashboardTodoItems' in model).toBe(false);
    expect(model.dashboardStats.find((stat) => stat.label === '需处理食材')).toMatchObject({
      value: '2',
      unit: '种',
      detail: '过期、临期或待补货',
    });
    expect(model.dashboardStats.find((stat) => stat.label === '在库食材')).toMatchObject({
      value: '2',
      unit: '种',
    });
    expect(model.pendingShoppingCount).toBe(1);
    expect(model.mobileRecommendations[0]?.recommendation.food.id).toBe('food-1');
    expect(model.desktopRecommendations[0]?.recommendation.food.id).toBe('food-1');
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

  it('renders three home groups while counting six eligible and only hinting later groups', () => {
    const ingredients: Ingredient[] = Array.from({ length: 7 }, (_, index) => ({
      ...ingredient,
      id: `ingredient-${index}`,
      name: `食材${index}`,
      default_low_stock_threshold: index === 5 ? 10 : null,
    }));
    const inventoryItems: InventoryItem[] = [
      {
        id: 'g0',
        family_id: 'family-1',
        ingredient_id: 'ingredient-0',
        ingredient_name: '食材0',
        quantity: 1,
        remaining_quantity: 1,
        unit: '个',
        status: 'fresh',
        purchase_date: '2026-07-01',
        expiry_date: '2026-07-09',
        storage_location: '冷藏',
        notes: '',
        low_stock_threshold: 1,
        created_at: '2026-07-01T00:00:00.000Z',
        updated_at: '2026-07-01T00:00:00.000Z',
        row_version: 1,
      },
      {
        id: 'g1',
        family_id: 'family-1',
        ingredient_id: 'ingredient-1',
        ingredient_name: '食材1',
        quantity: 1,
        remaining_quantity: 1,
        unit: '个',
        status: 'fresh',
        purchase_date: '2026-07-01',
        expiry_date: '2026-07-11',
        storage_location: '冷藏',
        notes: '',
        low_stock_threshold: 1,
        created_at: '2026-07-01T00:00:00.000Z',
        updated_at: '2026-07-01T00:00:00.000Z',
        row_version: 1,
      },
      {
        id: 'g2',
        family_id: 'family-1',
        ingredient_id: 'ingredient-2',
        ingredient_name: '食材2',
        quantity: 1,
        remaining_quantity: 1,
        unit: '个',
        status: 'fresh',
        purchase_date: '2026-07-01',
        expiry_date: '2026-07-12',
        storage_location: '冷藏',
        notes: '',
        low_stock_threshold: 1,
        created_at: '2026-07-01T00:00:00.000Z',
        updated_at: '2026-07-01T00:00:00.000Z',
        row_version: 1,
      },
      {
        id: 'g3',
        family_id: 'family-1',
        ingredient_id: 'ingredient-3',
        ingredient_name: '食材3',
        quantity: 1,
        remaining_quantity: 1,
        unit: '个',
        status: 'fresh',
        purchase_date: '2026-07-01',
        expiry_date: '2026-07-13',
        storage_location: '冷藏',
        notes: '',
        low_stock_threshold: 1,
        created_at: '2026-07-01T00:00:00.000Z',
        updated_at: '2026-07-01T00:00:00.000Z',
        row_version: 1,
      },
      {
        id: 'g4',
        family_id: 'family-1',
        ingredient_id: 'ingredient-4',
        ingredient_name: '食材4',
        quantity: 1,
        remaining_quantity: 1,
        unit: '个',
        status: 'fresh',
        purchase_date: '2026-07-01',
        expiry_date: '2026-07-14',
        storage_location: '冷藏',
        notes: '',
        low_stock_threshold: 1,
        created_at: '2026-07-01T00:00:00.000Z',
        updated_at: '2026-07-01T00:00:00.000Z',
        row_version: 1,
      },
      {
        id: 'g5',
        family_id: 'family-1',
        ingredient_id: 'ingredient-5',
        ingredient_name: '食材5',
        quantity: 1,
        remaining_quantity: 1,
        unit: '个',
        status: 'fresh',
        purchase_date: '2026-07-01',
        expiry_date: null,
        storage_location: '冷藏',
        notes: '',
        low_stock_threshold: 1,
        created_at: '2026-07-01T00:00:00.000Z',
        updated_at: '2026-07-01T00:00:00.000Z',
        row_version: 1,
      },
      {
        id: 'later-only',
        family_id: 'family-1',
        ingredient_id: 'ingredient-6',
        ingredient_name: '食材6',
        quantity: 1,
        remaining_quantity: 1,
        unit: '个',
        status: 'fresh',
        purchase_date: '2026-07-01',
        expiry_date: '2026-07-16',
        storage_location: '冷藏',
        notes: '',
        low_stock_threshold: 1,
        created_at: '2026-07-01T00:00:00.000Z',
        updated_at: '2026-07-01T00:00:00.000Z',
        row_version: 1,
      },
    ];

    const today = '2026-07-11';
    const inventoryActionGroups = buildInventoryActionGroups({
      inventoryItems,
      ingredients,
      shoppingItems: [],
      referenceDate: today,
    });
    const model = buildHomeDashboardViewModel({
      inventoryItems,
      inventoryActionGroups,
      availableIngredientCount: countUniqueAvailableIngredients({ inventoryItems, referenceDate: today }),
      shoppingItems: [],
      foodPlanItems: [],
      foodRecommendations: null,
      recipes: [],
      mealLogs: [],
      today,
      selectedDashboardPlanDate: today,
      foodPlanWeekRange: { start: '2026-07-06', end: '2026-07-12' },
    });

    expect(model.homeInventoryActionGroups).toHaveLength(3);
    expect(model.homeInventoryActionCount).toBe(6);
    expect(model.dashboardStats.find((stat) => stat.label === '需处理食材')?.value).toBe('6');
    expect(model.hasLaterInventoryActionGroups).toBe(true);
    expect(model.hasFullListInventoryActionGroups).toBe(true);
    expect(model.homeEligibleInventoryActionGroups.some((group) => group.ingredientId === 'ingredient-6')).toBe(false);
  });

  describe.each([
    { size: 0, pageSize: 3, cursor: 0, expected: [] as number[] },
    { size: 1, pageSize: 3, cursor: 0, expected: [0] },
    { size: 2, pageSize: 3, cursor: 0, expected: [0, 1] },
    { size: 4, pageSize: 3, cursor: 3, expected: [3, 0, 1] },
    { size: 5, pageSize: 3, cursor: 3, expected: [3, 4, 0] },
    { size: 6, pageSize: 3, cursor: 3, expected: [3, 4, 5] },
  ])('circular recommendations: $size items', ({ size, pageSize, cursor, expected }) => {
    it('returns only real items and never repeats inside a full window', () => {
      const items = Array.from({ length: size }, (_, id) => ({ id }));
      const result = selectCircularWindow(items, cursor, pageSize);
      expect(result.map((item) => item.id)).toEqual(expected);
      expect(new Set(result.map((item) => item.id)).size).toBe(result.length);
    });
  });

  it('advances recommendation cursor with wrap and empty-source guard', () => {
    expect(advanceRecommendationCursor(0, 6, 3)).toBe(3);
    expect(advanceRecommendationCursor(3, 6, 3)).toBe(0);
    expect(advanceRecommendationCursor(0, 0, 3)).toBe(0);
    expect(advanceRecommendationCursor(5, 6, 1)).toBe(0);
  });

  it('merges urgent expiry, one shopping action, then low stock before one truncation', () => {
    const result = buildHomeRequiredActions({
      inventoryGroups: [expiredTomato, expiringMilk, lowStockEggs, lowStockRice],
      pendingShoppingCount: 5,
    });
    expect(result.actions).toEqual([
      { kind: 'inventory', group: expiredTomato },
      { kind: 'inventory', group: expiringMilk },
      { kind: 'shopping', pendingCount: 5 },
    ]);
    expect(result.hasMoreHomeActions).toBe(true);
  });

  it('does not create a shopping action when pending count is zero', () => {
    const result = buildHomeRequiredActions({
      inventoryGroups: [expiredTomato, lowStockEggs],
      pendingShoppingCount: 0,
    });
    expect(result.actions.map((item) => item.kind)).toEqual(['inventory', 'inventory']);
  });

  it('distinguishes success zero, no-cache failure and stale refresh failure', () => {
    expect(
      buildHomeHighlightsViewModel({
        data: { items: [], week_highlight_count: 0 },
        isLoading: false,
        isError: false,
        isFetching: false,
      }),
    ).toMatchObject({ phase: 'empty', weekCountLabel: '本周协作 0 次' });

    expect(
      buildHomeHighlightsViewModel({
        data: undefined,
        isLoading: false,
        isError: true,
        isFetching: false,
      }),
    ).toMatchObject({ phase: 'error', weekCountLabel: '本周协作 --' });

    expect(
      buildHomeHighlightsViewModel({
        data: { items: [shoppingHighlight], week_highlight_count: 7 },
        isLoading: false,
        isError: true,
        isFetching: false,
      }),
    ).toMatchObject({
      phase: 'ready',
      hasRefreshError: true,
      weekCountLabel: '本周协作 7 次',
    });
  });

  it('normalizes highlight actors, icons and keeps seven compact plan days', () => {
    expect(resolveHomeHighlightActor('')).toBe('家庭成员');
    expect(resolveHomeHighlightActor(null)).toBe('家庭成员');
    expect(resolveHomeHighlightActor('  小明  ')).toBe('小明');
    expect(homeHighlightIcon('shopping')).toBe('cart');
    expect(homeHighlightIcon('inventory')).toBe('leaf');
    expect(homeHighlightIcon('meal_plan')).toBe('calendar');
    expect(homeHighlightIcon('meal')).toBe('pot');
    expect(homeHighlightIcon('family')).toBe('family');
    expect(homeHighlightIcon('unknown')).toBe('family');

    const model = buildHomeDashboardViewModel({
      inventoryItems: [],
      inventoryActionGroups: [],
      availableIngredientCount: 0,
      shoppingItems: [],
      foodPlanItems: [],
      foodRecommendations: null,
      recipes: [],
      mealLogs: [],
      today: '2026-06-01',
      selectedDashboardPlanDate: '2026-06-01',
      foodPlanWeekRange: { start: '2026-06-01', end: '2026-06-07' },
    });
    expect(model.dashboardPlanDays).toHaveLength(7);
  });
});

const expiredTomato: InventoryActionGroup = {
  kind: 'expiry',
  id: 'expiry:ingredient-tomato',
  ingredientId: 'ingredient-tomato',
  ingredientName: '番茄',
  severity: 'expired',
  batches: [],
  expiredBatchCount: 1,
  todayBatchCount: 0,
  soonBatchCount: 0,
  laterBatchCount: 0,
  totalBatchCount: 1,
  quantityLabels: ['2 个'],
  storageLocations: ['冷藏'],
  earliestExpiryDate: '2026-06-28',
  earliestDaysLeft: -2,
  title: '番茄需要处理',
  detail: '1 批已过期',
  primaryAction: 'manage_expiry',
  targetKind: 'inventory_item',
};

const expiringMilk: InventoryActionGroup = {
  kind: 'expiry',
  id: 'expiry:ingredient-milk',
  ingredientId: 'ingredient-milk',
  ingredientName: '牛奶',
  severity: 'expires_soon',
  batches: [],
  expiredBatchCount: 0,
  todayBatchCount: 0,
  soonBatchCount: 1,
  laterBatchCount: 0,
  totalBatchCount: 1,
  quantityLabels: ['1 盒'],
  storageLocations: ['冷藏'],
  earliestExpiryDate: '2026-07-02',
  earliestDaysLeft: 2,
  title: '牛奶需要处理',
  detail: '1 批即将过期',
  primaryAction: 'manage_expiry',
  targetKind: 'inventory_item',
};

const lowStockEggs: InventoryActionGroup = {
  kind: 'low_stock',
  id: 'low_stock:ingredient-egg',
  ingredientId: 'ingredient-egg',
  ingredientName: '鸡蛋',
  availableQuantity: 1,
  unit: '个',
  threshold: 4,
  title: '鸡蛋库存不足',
  detail: '现有 1 个，补货线 4 个',
  primaryAction: 'add_shopping',
};

const lowStockRice: InventoryActionGroup = {
  kind: 'low_stock',
  id: 'low_stock:ingredient-rice',
  ingredientId: 'ingredient-rice',
  ingredientName: '大米',
  availableQuantity: 0.5,
  unit: '袋',
  threshold: 1,
  title: '大米库存不足',
  detail: '现有 0.5 袋，补货线 1 袋',
  primaryAction: 'add_shopping',
};

const shoppingHighlight: ActivityHighlight = {
  id: 'highlight-1',
  kind: 'shopping',
  summary: '完成了采购清单',
  actor_id: 'user-1',
  actor_name: '小明',
  created_at: '2026-07-12T08:00:00.000Z',
};
