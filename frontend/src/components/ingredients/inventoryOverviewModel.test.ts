import { describe, expect, it } from 'vitest';
import type { InventoryOverviewItem } from '../../api/types';
import {
  buildUnifiedInventoryGroups,
  buildUnifiedInventorySummary,
  filterUnifiedInventoryItems,
  filterUnifiedInventoryItemsByQuickFilter,
  getUnifiedInventoryActionLabel,
  getUnifiedInventoryFoodPrimaryActionKind,
  parseUnifiedFoodStockQuantity,
  resolveUnifiedFoodStockDeductQuantity,
} from './inventoryOverviewModel';

const ingredientItem: InventoryOverviewItem = {
  id: 'ingredient:inventory-tomato',
  source_type: 'ingredient',
  source_id: 'ingredient-tomato',
  row_version: 3,
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
  row_version: 5,
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
  storage_location: '冷冻',
  purchase_source: '盒马',
  updated_at: '2026-07-07T12:00:00Z',
  primary_action: 'record_meal',
  search_text: '蓝莓酸奶 饮品 冷冻 盒马 早餐',
};

const pendingIngredientItem: InventoryOverviewItem = {
  id: 'ingredient:inventory-egg-empty',
  source_type: 'ingredient',
  source_id: 'ingredient-egg',
  row_version: 2,
  inventory_item_id: 'inventory-egg-empty',
  title: '鸡蛋',
  category: '蛋奶',
  image: null,
  quantity: 0,
  unit: '个',
  quantity_label: '未入库',
  quantity_tracking_mode: 'track_quantity',
  status: 'fresh',
  tone: 'empty',
  expiry_date: null,
  days_until_expiry: null,
  storage_location: '冷藏',
  purchase_source: null,
  updated_at: '2026-07-05T12:00:00Z',
  primary_action: 'restock',
  search_text: '鸡蛋 蛋奶 冷藏',
};

const pendingFoodItem: InventoryOverviewItem = {
  id: 'food:food-dumpling-empty',
  source_type: 'food',
  source_id: 'food-dumpling-empty',
  row_version: 4,
  inventory_item_id: null,
  title: '速冻饺子',
  category: '速冻食品',
  image: null,
  quantity: null,
  unit: '袋',
  quantity_label: '未入库',
  quantity_tracking_mode: 'track_quantity',
  status: null,
  tone: 'empty',
  expiry_date: null,
  days_until_expiry: null,
  storage_location: '冷冻',
  purchase_source: '山姆',
  updated_at: '2026-07-04T12:00:00Z',
  primary_action: 'edit_food_stock',
  search_text: '速冻饺子 速冻食品 冷冻 山姆 备餐',
};

const seasoningFoodItem: InventoryOverviewItem = {
  ...foodItem,
  id: 'food:food-soy-sauce',
  source_id: 'food-soy-sauce',
  title: '小瓶酱油',
  category: '调料',
  tone: 'stable',
  days_until_expiry: 60,
  storage_location: '常温',
  search_text: '小瓶酱油 调料 常温 酱料',
};

describe('inventoryOverviewModel', () => {
  it('filters by source type and search text', () => {
    expect(filterUnifiedInventoryItems([ingredientItem, foodItem], { source: 'food', entry: 'all', storage: 'all', search: '酸奶' })).toEqual([foodItem]);
    expect(filterUnifiedInventoryItems([ingredientItem, foodItem], { source: 'ingredient', entry: 'all', storage: 'all', search: '酸奶' })).toEqual([]);
    expect(filterUnifiedInventoryItems([ingredientItem, foodItem], { source: 'all', entry: 'all', storage: 'all', search: '冷藏' })).toEqual([ingredientItem]);
    expect(filterUnifiedInventoryItems([ingredientItem, foodItem], { source: 'food', entry: 'all', storage: 'all', search: '冷冻' })).toEqual([foodItem]);
  });

  it('filters food stock by selected storage location', () => {
    expect(
      filterUnifiedInventoryItems([ingredientItem, foodItem], { source: 'all', entry: 'all', search: '', storage: '冷藏' })
    ).toEqual([ingredientItem]);
    expect(
      filterUnifiedInventoryItems([ingredientItem, foodItem], { source: 'all', entry: 'all', search: '', storage: '冷冻' })
    ).toEqual([foodItem]);
    expect(
      filterUnifiedInventoryItems([ingredientItem, foodItem], { source: 'all', entry: 'all', search: '', storage: 'all' })
    ).toEqual([ingredientItem, foodItem]);
  });

  it('filters stocked and pending inventory entries across ingredients and ready foods', () => {
    const items = [ingredientItem, foodItem, pendingIngredientItem, pendingFoodItem];

    expect(filterUnifiedInventoryItems(items, { source: 'all', entry: 'stocked', storage: 'all', search: '' })).toEqual([
      ingredientItem,
      foodItem,
    ]);
    expect(filterUnifiedInventoryItems(items, { source: 'all', entry: 'pending', storage: 'all', search: '' })).toEqual([
      pendingIngredientItem,
      pendingFoodItem,
    ]);
    expect(filterUnifiedInventoryItems(items, { source: 'food', entry: 'pending', storage: '冷冻', search: '' })).toEqual([
      pendingFoodItem,
    ]);
  });

  it('keeps pending ready food searchable and grouped by its configured storage location', () => {
    expect(
      filterUnifiedInventoryItems([pendingFoodItem], { source: 'all', entry: 'pending', storage: '冷冻', search: '备餐' })
    ).toEqual([pendingFoodItem]);
    expect(buildUnifiedInventoryGroups([pendingFoodItem]).map((group) => group.key)).toEqual(['冷冻']);
  });

  it('filters ready food stock by quick inventory shortcuts', () => {
    const expiredFoodItem: InventoryOverviewItem = {
      ...foodItem,
      id: 'food:food-expired-yogurt',
      source_id: 'food-expired-yogurt',
      tone: 'danger',
      days_until_expiry: -1,
      search_text: '过期酸奶 饮品 冷藏',
    };
    const items = [ingredientItem, foodItem, seasoningFoodItem, expiredFoodItem, pendingFoodItem];

    expect(filterUnifiedInventoryItemsByQuickFilter(items, 'seasoning')).toEqual([seasoningFoodItem]);
    expect(filterUnifiedInventoryItemsByQuickFilter(items, 'alerted')).toEqual([foodItem, expiredFoodItem]);
    expect(filterUnifiedInventoryItemsByQuickFilter(items, 'expiring')).toEqual([foodItem, expiredFoodItem]);
    expect(
      filterUnifiedInventoryItems(items, {
        source: 'all',
        entry: 'all',
        quick: 'seasoning',
        storage: 'all',
        search: '',
      })
    ).toEqual([seasoningFoodItem]);
  });

  it('filters mixed inventory by ingredient and food quick shortcuts', () => {
    const items = [ingredientItem, foodItem, pendingIngredientItem, pendingFoodItem];

    expect(filterUnifiedInventoryItemsByQuickFilter(items, 'ingredient')).toEqual([
      ingredientItem,
      pendingIngredientItem,
    ]);
    expect(filterUnifiedInventoryItemsByQuickFilter(items, 'food')).toEqual([foodItem, pendingFoodItem]);
    expect(
      filterUnifiedInventoryItems(items, {
        source: 'all',
        entry: 'all',
        quick: 'food',
        storage: 'all',
        search: '',
      })
    ).toEqual([foodItem, pendingFoodItem]);
  });

  it('groups items by storage and counts food stock separately', () => {
    const groups = buildUnifiedInventoryGroups([ingredientItem, foodItem]);
    expect(groups.map((group) => group.key)).toEqual(['冷藏', '冷冻']);
    expect(groups[0].ingredientCount).toBe(1);
    expect(groups[1].foodCount).toBe(1);
  });

  it('falls back food stock without a location to room temperature', () => {
    const groups = buildUnifiedInventoryGroups([{ ...foodItem, storage_location: '' }]);
    expect(groups.map((group) => group.key)).toEqual(['常温']);
  });

  it('builds summary metrics and action labels', () => {
    expect(buildUnifiedInventorySummary([ingredientItem, foodItem])).toEqual({
      totalCount: 2,
      ingredientCount: 1,
      foodCount: 1,
      alertCount: 1,
      pendingCount: 0,
      stockedCount: 2,
    });
    expect(getUnifiedInventoryActionLabel(foodItem)).toBe('减扣');
    expect(getUnifiedInventoryActionLabel(pendingFoodItem)).toBe('补库存');
    expect(getUnifiedInventoryActionLabel(ingredientItem)).toBe('消费');
    expect(getUnifiedInventoryFoodPrimaryActionKind(foodItem)).toBe('recordMeal');
    expect(getUnifiedInventoryFoodPrimaryActionKind(pendingFoodItem)).toBe('editStock');
  });

  it('keeps food stock max deduction aligned with one-decimal display', () => {
    expect(resolveUnifiedFoodStockDeductQuantity(140.9, 140.95, '盒')).toEqual({
      quantity: 140.9,
      error: null,
    });
    expect(resolveUnifiedFoodStockDeductQuantity(141, 140.95, '盒')).toEqual({
      quantity: null,
      error: '当前最多只能减扣 140.9盒。',
    });
  });

  it('limits food stock quantities to one decimal place', () => {
    expect(parseUnifiedFoodStockQuantity('13.9', '减扣数量')).toEqual({
      quantity: 13.9,
      error: null,
    });
    expect(parseUnifiedFoodStockQuantity('13.99', '减扣数量')).toEqual({
      quantity: null,
      error: '减扣数量最多保留 1 位小数。',
    });
  });
});
