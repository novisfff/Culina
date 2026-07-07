import { describe, expect, it } from 'vitest';
import type { InventoryOverviewItem } from '../../api/types';
import {
  buildUnifiedInventoryGroups,
  buildUnifiedInventorySummary,
  filterUnifiedInventoryItems,
  getUnifiedInventoryActionLabel,
  getUnifiedInventoryFoodPrimaryActionKind,
} from './inventoryOverviewModel';

const ingredientItem: InventoryOverviewItem = {
  id: 'ingredient:inventory-tomato',
  source_type: 'ingredient',
  source_id: 'ingredient-tomato',
  inventory_item_id: 'inventory-tomato',
  title: '番茄',
  category: '蔬菜',
  image: null,
  quantity: 2,
  unit: '个',
  quantity_label: '2个',
  quantity_tracking_mode: 'track_quantity',
  status: 'fresh',
  tone: 'stable',
  expiry_date: '2026-07-10',
  days_until_expiry: 3,
  storage_location: '冷藏',
  purchase_source: null,
  updated_at: '2026-07-06T12:00:00Z',
  primary_action: 'consume',
  search_text: '番茄 蔬菜 冷藏',
};

const foodItem: InventoryOverviewItem = {
  id: 'food:food-yogurt',
  source_type: 'food',
  source_id: 'food-yogurt',
  inventory_item_id: null,
  title: '蓝莓酸奶',
  category: '饮品',
  image: null,
  quantity: 2,
  unit: '盒',
  quantity_label: '2盒',
  quantity_tracking_mode: 'track_quantity',
  status: null,
  tone: 'warning',
  expiry_date: '2026-07-08',
  days_until_expiry: 1,
  storage_location: '食物库',
  purchase_source: '盒马',
  updated_at: '2026-07-07T12:00:00Z',
  primary_action: 'record_meal',
  search_text: '蓝莓酸奶 饮品 盒马 早餐',
};

describe('inventoryOverviewModel', () => {
  it('filters by source type and search text', () => {
    expect(filterUnifiedInventoryItems([ingredientItem, foodItem], { source: 'food', search: '酸奶' })).toEqual([foodItem]);
    expect(filterUnifiedInventoryItems([ingredientItem, foodItem], { source: 'ingredient', search: '酸奶' })).toEqual([]);
    expect(filterUnifiedInventoryItems([ingredientItem, foodItem], { source: 'all', search: '冷藏' })).toEqual([ingredientItem]);
  });

  it('groups items by storage and counts food stock separately', () => {
    const groups = buildUnifiedInventoryGroups([ingredientItem, foodItem]);
    expect(groups.map((group) => group.key)).toEqual(['食物库', '冷藏']);
    expect(groups[0].foodCount).toBe(1);
    expect(groups[1].ingredientCount).toBe(1);
  });

  it('builds summary metrics and action labels', () => {
    expect(buildUnifiedInventorySummary([ingredientItem, foodItem])).toEqual({
      totalCount: 2,
      ingredientCount: 1,
      foodCount: 1,
      alertCount: 1,
    });
    expect(getUnifiedInventoryActionLabel(foodItem)).toBe('记到今天');
    expect(getUnifiedInventoryActionLabel(ingredientItem)).toBe('消费');
    expect(getUnifiedInventoryFoodPrimaryActionKind(foodItem)).toBe('recordMeal');
    expect(getUnifiedInventoryFoodPrimaryActionKind({ ...foodItem, primary_action: 'edit_food_stock' })).toBe('editStock');
  });
});
