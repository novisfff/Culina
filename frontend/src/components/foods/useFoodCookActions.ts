import type { FormEvent } from 'react';
import type { Recipe } from '../../api/types';
import type { FoodQuickMealDialogState } from './FoodQuickMealDialog';
import { buildDirectCookTarget } from './FoodWorkspaceModel';

type Args = {
  event: FormEvent<HTMLFormElement>;
  dialog: FoodQuickMealDialogState | null;
  recipes: Recipe[];
  setDialog: (dialog: FoodQuickMealDialogState | null) => void;
  navigate?: (target: ReturnType<typeof buildDirectCookTarget>) => void;
  onStartRecipe: (recipeId: string) => void;
};

export async function submitFoodCookConfirmAction(args: Args) {
  args.event.preventDefault();
  const current = args.dialog;
  if (!current || current.action !== 'cook' || !current.recipeId) return;

  // Direct Cook: never create a plan item just to start cooking.
  const servings = current.servings != null && current.servings > 0
    ? current.servings
    : args.recipes.find((recipe) => recipe.id === current.recipeId)?.servings || 1;
  const target = buildDirectCookTarget({
    foodId: current.food.id,
    recipeId: current.recipeId,
    date: current.date,
    mealType: current.mealType,
    servings,
  });
  args.setDialog(null);
  if (args.navigate) args.navigate(target);
  else args.onStartRecipe(current.recipeId);
}
