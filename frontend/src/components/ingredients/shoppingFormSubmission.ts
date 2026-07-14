import type { Food, Ingredient, ShoppingListItem } from '../../api/types';
import { parseFoodStockQuantity } from '../../lib/foodStockQuantity';
import { tracksIngredientQuantity } from '../../lib/ingredientTracking';
import { parsePositiveNumber, type ShoppingDialogFormState } from './ingredientWorkspaceForms';

export type ShoppingItemWritePayload = {
  title: string;
  quantity: number | null;
  unit: string | null;
  ingredient_id: string | null;
  food_id: string | null;
  quantity_mode: ShoppingListItem['quantity_mode'];
  display_label: string | null;
  reason: string;
};

export type ShoppingFormSubmissionResult =
  | { ok: true; payload: ShoppingItemWritePayload }
  | { ok: false; title: string; message: string };

export function resolveShoppingFormSubmission(args: {
  form: ShoppingDialogFormState;
  ingredients: Ingredient[];
  foods: Food[];
}): ShoppingFormSubmissionResult {
  const title = args.form.title.trim();
  if (!title) {
    return { ok: false, title: '缺少采购名称', message: '请填写或选择这次要采购的内容。' };
  }

  const selectedIngredient =
    args.form.targetType === 'ingredient' && args.form.ingredientId
      ? args.ingredients.find((item) => item.id === args.form.ingredientId) ?? null
      : null;
  const selectedFood =
    args.form.targetType === 'food' && args.form.foodId
      ? args.foods.find((item) => item.id === args.form.foodId) ?? null
      : null;

  if (args.form.targetType === 'ingredient' && !selectedIngredient) {
    return {
      ok: false,
      title: '先选择采购对象',
      message: '请从食材档案中选择采购对象，或改用其他采购。',
    };
  }
  if (args.form.targetType === 'food' && !selectedFood) {
    return {
      ok: false,
      title: '先选择采购对象',
      message: '请从成品速食档案中选择采购对象，或改用其他采购。',
    };
  }

  const isFreeText = args.form.targetType === 'free_text';
  const tracksQuantity = isFreeText || selectedFood
    ? true
    : tracksIngredientQuantity(selectedIngredient);
  const parsedFoodQuantity = selectedFood
    ? parseFoodStockQuantity(args.form.quantity, '待买数量')
    : null;
  const quantity = tracksQuantity
    ? parsedFoodQuantity
      ? parsedFoodQuantity.quantity
      : parsePositiveNumber(args.form.quantity)
    : 1;

  if (tracksQuantity && quantity === null) {
    return {
      ok: false,
      title: '待买数量无效',
      message: parsedFoodQuantity?.error ?? '请确认待买数量，至少要大于 0。',
    };
  }

  return {
    ok: true,
    payload: {
      title: selectedFood?.name ?? selectedIngredient?.name ?? title,
      quantity: tracksQuantity ? quantity ?? 1 : null,
      unit: tracksQuantity
        ? args.form.unit.trim() || selectedFood?.stock_unit || selectedIngredient?.default_unit || '份'
        : null,
      ingredient_id: selectedIngredient?.id ?? null,
      food_id: selectedFood?.id ?? null,
      quantity_mode: tracksQuantity ? 'track_quantity' : 'not_track_quantity',
      display_label: tracksQuantity ? null : '需要补充',
      reason:
        args.form.reason.trim() ||
        (selectedFood ? '补充成品库存' : !tracksQuantity ? '需要补充' : ''),
    },
  };
}
