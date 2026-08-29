import type { Recipe } from '../../api/types/food';
import { getFoodFormCompletionItems, type FoodFormState } from './FoodWorkspaceModel';

export function buildFoodEditorCompletionState(args: {
  form: FoodFormState;
  editingFood: Parameters<typeof getFoodFormCompletionItems>[1];
  recipes: Recipe[];
}) {
  const items = getFoodFormCompletionItems(args.form, args.editingFood, args.recipes);
  return {
    items,
    completedCount: items.filter((item) => item.done).length,
    percent: Math.round((items.filter((item) => item.done).length / items.length) * 100),
  };
}

export function buildRecipeEditorCompletionState(args: {
  title: string;
  servings: number | string;
  ingredientRows: Array<{ ingredient_id?: string | null; ingredient_name: string }>;
  steps: Array<{ text: string }>;
  hasCover: boolean;
}) {
  const ingredientCount = args.ingredientRows.filter((item) => item.ingredient_id || item.ingredient_name.trim()).length;
  const stepCount = args.steps.filter((step) => step.text.trim()).length;
  const items = [
    { label: '已填写基础信息', done: Boolean(args.title.trim() && Number(args.servings) > 0) },
    { label: '已添加食材', done: ingredientCount > 0 },
    { label: '已添加步骤', done: stepCount > 0 },
    { label: '已设置封面', done: args.hasCover },
  ];
  return {
    ingredientCount,
    stepCount,
    items,
    percent: Math.round((items.filter((item) => item.done).length / items.length) * 100),
  };
}
