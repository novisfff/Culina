import type { FormEvent } from 'react';
import type { Food, FoodPayload, Ingredient, Recipe } from '../../api/types';
import { getMediaIds, getPendingImageJobId } from '../../lib/aiImages';
import { parseOptionalFoodStockQuantity } from '../../lib/foodStockQuantity';
import { buildRecipePayload, type RecipeDraftIngredient, type RecipeFormState } from '../recipes/RecipeWorkspaceModel';
import { buildFoodPayloadFromForm, type FoodFormState } from './FoodWorkspaceModel';
import { resolveErrorMessage } from '../recipes/RecipeWorkspaceModel';

type Args = {
  event: FormEvent<HTMLFormElement>;
  canSubmit: boolean;
  form: Pick<FoodFormState, 'type' | 'stockQuantity' | 'recipeId' | 'name'> & FoodFormState;
  isReadyLike: boolean;
  isSelfMade: boolean;
  recipeForm: RecipeFormState;
  ingredientRows: RecipeDraftIngredient[];
  ingredients: Ingredient[];
  recipes: Recipe[];
  selectedRecipeId: string | null;
  submitFood: (event: FormEvent<HTMLFormElement>, canSubmit: boolean, payloadOverride?: FoodPayload) => Promise<void>;
  updateRecipe: (recipeId: string, payload: ReturnType<typeof buildRecipePayload>) => Promise<unknown>;
  createRecipe: (payload: ReturnType<typeof buildRecipePayload>) => Promise<Recipe>;
  setView: (view: 'list' | 'create' | 'edit') => void;
  resetFoodImage: () => void;
  resetRecipeImage: () => void;
  showNotice: (notice: { tone: 'success' | 'warning' | 'danger'; title: string; message: string }) => void;
};

export async function submitFoodFormAction(args: Args) {
  args.event.preventDefault();
  if (!args.canSubmit) return;
  if (args.isReadyLike) {
    const stockQuantity = parseOptionalFoodStockQuantity(args.form.stockQuantity, '剩余数量');
    if (stockQuantity.error) {
      args.showNotice({ tone: 'warning', title: '库存数量格式不对', message: stockQuantity.error });
      return;
    }
  }
  if (!args.isSelfMade) {
    await args.submitFood(args.event, true);
    args.resetFoodImage();
    return;
  }
  const recipePayload = buildRecipePayload(args.recipeForm, args.ingredientRows, args.ingredients, getPendingImageJobId(args.recipeForm.images));
  if (!recipePayload.title || recipePayload.ingredient_items.length === 0) {
    args.showNotice({ tone: 'warning', title: '暂时无法保存菜谱', message: '家常菜谱至少要有名称和一种食材。' });
    return;
  }
  try {
    const recipeId = args.form.recipeId || args.selectedRecipeId;
    if (recipeId) {
      await args.updateRecipe(recipeId, recipePayload);
      const payload = buildFoodPayloadFromForm({ ...args.form, recipeId, name: recipePayload.title }, args.recipes, getMediaIds(args.form.images), getPendingImageJobId(args.form.images));
      await args.submitFood(args.event, true, payload);
      args.showNotice({ tone: 'success', title: '家常菜谱已更新', message: `${recipePayload.title} 的菜谱和食物信息已保存。` });
    } else {
      await args.createRecipe(recipePayload);
      args.setView('list');
      args.showNotice({ tone: 'success', title: '家常菜谱已保存', message: `${recipePayload.title} 已出现在食物库。` });
    }
    args.resetFoodImage();
    args.resetRecipeImage();
  } catch (reason) {
    args.showNotice({ tone: 'danger', title: '保存菜谱失败', message: resolveErrorMessage(reason, '保存菜谱失败') });
  }
}
