import { describe, expect, it } from 'vitest';
import type { Food, ShoppingListItem } from '../../api/types';
import {
  buildFoodShoppingDialogState,
  buildFoodShoppingWrite,
  findPendingFoodShoppingItem,
} from './FoodShoppingModel';

const food = {
  id: 'food-milk',
  name: '盒装牛奶',
  stock_quantity: 0,
  stock_unit: '盒',
} as Food;

function shoppingItem(overrides: Partial<ShoppingListItem> = {}): ShoppingListItem {
  return {
    id: 'shopping-milk',
    family_id: 'family-1',
    ingredient_id: null,
    food_id: food.id,
    target_type: 'food',
    title: food.name,
    quantity: 2,
    unit: '盒',
    quantity_mode: 'track_quantity',
    display_label: null,
    reason: '周末补货',
    done: false,
    created_at: '2026-07-13T10:00:00Z',
    updated_at: '2026-07-13T10:00:00Z',
    row_version: 4,
    ...overrides,
  };
}

describe('FoodShoppingModel', () => {
  it('reuses only the newest unfinished shopping item bound to the food', () => {
    const older = shoppingItem({ id: 'older', updated_at: '2026-07-12T10:00:00Z' });
    const newest = shoppingItem({ id: 'newest', updated_at: '2026-07-14T10:00:00Z' });
    const completed = shoppingItem({ id: 'completed', done: true, updated_at: '2026-07-15T10:00:00Z' });
    const otherFood = shoppingItem({ id: 'other', food_id: 'food-other' });

    expect(findPendingFoodShoppingItem([older, completed, otherFood, newest], food.id)).toEqual(newest);
  });

  it('builds a new locked food draft when no unfinished item exists', () => {
    expect(buildFoodShoppingDialogState(food, [shoppingItem({ done: true })])).toEqual({
      existingItem: null,
      draft: {
        foodId: food.id,
        title: food.name,
        quantity: '1',
        unit: '盒',
        reason: '补充成品库存',
      },
    });
  });

  it('preserves the existing final quantity, unit, reason and row version for updates', () => {
    const existing = shoppingItem();
    const state = buildFoodShoppingDialogState(food, [existing]);

    expect(state.draft).toMatchObject({ quantity: '2', unit: '盒', reason: '周末补货' });
    expect(buildFoodShoppingWrite(state.draft, state.existingItem)).toEqual({
      kind: 'update',
      itemId: existing.id,
      payload: {
        expected_row_version: 4,
        title: food.name,
        quantity: 2,
        unit: '盒',
        ingredient_id: null,
        food_id: food.id,
        quantity_mode: 'track_quantity',
        display_label: null,
        reason: '周末补货',
      },
    });
  });
});
