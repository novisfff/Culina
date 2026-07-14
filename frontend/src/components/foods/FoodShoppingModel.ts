import type { Food, ShoppingListItem } from '../../api/types';
import type { UpdateShoppingItemPayload } from '../../api/ingredientsApi';
import { parseFoodStockQuantity } from '../../lib/foodStockQuantity';

export type FoodShoppingDraft = {
  foodId: string;
  title: string;
  quantity: string;
  unit: string;
  reason: string;
};

export type FoodShoppingDialogState = {
  existingItem: ShoppingListItem | null;
  draft: FoodShoppingDraft;
};

export type FoodShoppingPayload = {
  title: string;
  quantity: number;
  unit: string;
  ingredient_id: null;
  food_id: string;
  quantity_mode: 'track_quantity';
  display_label: null;
  reason: string;
};

export type FoodShoppingWrite =
  | {
      kind: 'create';
      payload: FoodShoppingPayload;
    }
  | {
      kind: 'update';
      itemId: string;
      payload: UpdateShoppingItemPayload;
    };

export function findPendingFoodShoppingItem(items: ShoppingListItem[], foodId: string) {
  return items
    .filter((item) => !item.done && item.food_id === foodId)
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at))[0] ?? null;
}

export function buildFoodShoppingDialogState(
  food: Food,
  items: ShoppingListItem[],
): FoodShoppingDialogState {
  const existingItem = findPendingFoodShoppingItem(items, food.id);
  return {
    existingItem,
    draft: {
      foodId: food.id,
      title: food.name,
      quantity: String(existingItem?.quantity ?? 1),
      unit: existingItem?.unit || food.stock_unit || '份',
      reason: existingItem?.reason || '补充成品库存',
    },
  };
}

export function buildFoodShoppingWrite(
  draft: FoodShoppingDraft,
  existingItem: ShoppingListItem | null,
): FoodShoppingWrite {
  const parsedQuantity = parseFoodStockQuantity(draft.quantity, '待买数量');
  if (parsedQuantity.error || parsedQuantity.quantity === null) {
    throw new Error(parsedQuantity.error || '请确认待买数量，至少要大于 0。');
  }
  const payload: FoodShoppingPayload = {
    title: draft.title,
    quantity: parsedQuantity.quantity,
    unit: draft.unit.trim() || '份',
    ingredient_id: null,
    food_id: draft.foodId,
    quantity_mode: 'track_quantity' as const,
    display_label: null,
    reason: draft.reason.trim() || '补充成品库存',
  };
  if (!existingItem) {
    return { kind: 'create', payload };
  }
  return {
    kind: 'update',
    itemId: existingItem.id,
    payload: {
      expected_row_version: existingItem.row_version,
      ...payload,
    },
  };
}
