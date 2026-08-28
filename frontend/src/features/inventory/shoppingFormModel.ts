import type { Food, Ingredient } from '../../api/types';
import { resolvePreferredIngredientUnit } from '../../lib/ingredientUnits';

export type ShoppingTargetType = 'ingredient' | 'food' | 'free_text';

export type ShoppingDialogFormState = {
  targetType: ShoppingTargetType;
  ingredientId: string;
  foodId: string;
  title: string;
  quantity: string;
  unit: string;
  reason: string;
};

export function buildShoppingForm(ingredient?: Ingredient, reason = '', food?: Food): ShoppingDialogFormState {
  return {
    targetType: food ? 'food' : ingredient ? 'ingredient' : 'free_text',
    ingredientId: ingredient?.id ?? '',
    foodId: food?.id ?? '',
    title: food?.name ?? ingredient?.name ?? '',
    quantity: '1',
    unit: food
      ? food.stock_unit || '份'
      : ingredient
        ? resolvePreferredIngredientUnit(ingredient, ingredient.default_unit) || '个'
        : '份',
    reason: reason || (food ? '补充成品库存' : ''),
  };
}

export function parsePositiveNumber(value: string): number | null {
  const numeric = Number(value.trim());
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}
