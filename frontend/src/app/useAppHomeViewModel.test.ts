import { describe, expect, it } from 'vitest';
import type { Ingredient, InventoryItem } from '../api/types';
import { useAppHomeViewModel } from './useAppHomeViewModel';

const tomato: Ingredient = {
  id: 'ingredient-tomato',
  family_id: 'family-1',
  name: '番茄',
  category: '蔬菜',
  default_unit: '个',
  unit_conversions: [],
  default_storage: '冷藏',
  default_expiry_mode: 'days',
  default_expiry_days: 3,
  default_low_stock_threshold: null,
  notes: '',
  image: null,
  created_at: '2026-07-01T00:00:00.000Z',
  updated_at: '2026-07-01T00:00:00.000Z',
};

const inventoryItem: InventoryItem = {
  id: 'inventory-tomato',
  family_id: 'family-1',
  ingredient_id: tomato.id,
  ingredient_name: tomato.name,
  quantity: 2,
  remaining_quantity: 2,
  unit: '个',
  status: 'fresh',
  purchase_date: '2026-07-10',
  expiry_date: '2026-07-12',
  storage_location: '冷藏',
  notes: '',
  low_stock_threshold: 1,
  created_at: '2026-07-10T00:00:00.000Z',
  updated_at: '2026-07-10T00:00:00.000Z',
  row_version: 1,
};

describe('useAppHomeViewModel', () => {
  it('injects Asia/Shanghai businessDateKey even when device local calendar differs', () => {
    // 2026-07-11 23:30 America/New_York == 2026-07-12 11:30 Asia/Shanghai
    const now = new Date('2026-07-12T03:30:00.000Z');

    const model = useAppHomeViewModel({
      user: null,
      membershipRole: 'Owner',
      family: null,
      members: [],
      memberEditMemberId: '',
      ingredients: [tomato],
      inventoryItems: [inventoryItem],
      shoppingItems: [],
      recipes: [],
      foods: [],
      foodPlanItems: [],
      foodRecommendations: null,
      mealLogs: [],
      activityLogs: [],
      dashboardRecommendationPage: 0,
      visibleDashboardTodoCount: 4,
      visibleExpiryCount: 3,
      selectedDashboardPlanDate: '2026-07-12',
      foodPlanWeekRange: { start: '2026-07-06', end: '2026-07-12' },
      homePlanDetailItemId: null,
      homePlanAddFoodId: null,
      homePlanAddFoodSearch: '',
      homeRestockShoppingItemId: null,
      homeExpiryReviewItemId: null,
      homeMealDetailId: null,
      homeRestockForm: null,
      homeExpiredDisposalIngredientId: null,
      resolveDashboardAssetUrl: (url) => url,
      now,
    });

    expect(model.businessDateKey).toBe('2026-07-12');
    expect(model.today).toBe('2026-07-12');
    expect(model.inventoryActionGroups).toHaveLength(1);
    expect(model.inventoryActionGroups[0]).toMatchObject({
      kind: 'expiry',
      ingredientId: tomato.id,
      // expiry 2026-07-12 with business date 2026-07-12 => today
      severity: 'expires_today',
    });
    expect(model.homeInventoryActionCount).toBe(1);
    expect(model.availableInventoryCount).toBe(1);
    expect(model.dashboardStats.find((stat) => stat.label === '需处理食材')?.value).toBe('1');
  });
});
