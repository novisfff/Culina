import type { Dispatch, FormEvent, SetStateAction } from 'react';
import type { Ingredient, Recipe } from '../../api/types';
import { getPendingImageJobId } from '../../lib/aiImages';
import { buildRecipePayload, type RecipeDraftIngredient, type RecipeFormState } from '../recipes/RecipeWorkspaceModel';
import { resolveErrorMessage } from '../recipes/RecipeWorkspaceModel';
import type { FoodFormState } from './FoodWorkspaceModel';

type Args = {
  form: Pick<FoodFormState, 'recipeId' | 'name'>;
  recipeForm: RecipeFormState;
  ingredientRows: RecipeDraftIngredient[];
  ingredients: Ingredient[];
  selectedRecipeId: string | null;
  updateRecipe: (recipeId: string, payload: ReturnType<typeof buildRecipePayload>) => Promise<unknown>;
  createRecipe: (payload: ReturnType<typeof buildRecipePayload>) => Promise<Recipe>;
  showNotice: (notice: { tone: 'success' | 'warning' | 'danger'; title: string; message: string }) => void;
  setForm: Dispatch<SetStateAction<FoodFormState>>;
  setView: (view: 'list' | 'create' | 'edit') => void;
  view: 'create' | 'edit';
  isSelfMade: boolean;
  closeEditor: () => void;
  resetImageState: () => void;
};

export async function submitFoodRecipeEditorAction(event: FormEvent<HTMLFormElement>, args: Args) {
  event.preventDefault();
  const payload = buildRecipePayload(args.recipeForm, args.ingredientRows, args.ingredients, getPendingImageJobId(args.recipeForm.images));
  if (!payload.title || payload.ingredient_items.length === 0) {
    args.showNotice({ tone: 'warning', title: '暂时无法保存菜谱', message: '家常菜谱至少要有名称和一种食材。' });
    return;
  }
  try {
    const recipeId = args.selectedRecipeId || args.form.recipeId;
    if (recipeId) {
      await args.updateRecipe(recipeId, payload);
      args.setForm((current) => ({ ...current, recipeId, name: current.name || payload.title }));
    } else {
      const created = await args.createRecipe(payload);
      args.setForm((current) => ({ ...current, recipeId: created.id, name: current.name || created.title }));
      if (args.view === 'create' && args.isSelfMade) args.setView('list');
    }
    args.closeEditor();
    args.resetImageState();
    args.showNotice({ tone: 'success', title: '菜谱已保存', message: `${payload.title} 的用料和步骤已保存。` });
  } catch (reason) {
    args.showNotice({ tone: 'danger', title: '保存菜谱失败', message: resolveErrorMessage(reason, '保存菜谱失败') });
  }
}
