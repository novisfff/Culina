import { describe, expect, it, vi } from 'vitest';
import { submitFoodRecipeEditorAction } from './useFoodRecipeEditorActions';
import { defaultIngredientRows, defaultRecipeForm } from '../recipes/RecipeWorkspaceModel';

describe('submitFoodRecipeEditorAction', () => {
  it('does not save an empty recipe', async () => {
    const showNotice = vi.fn();
    const updateRecipe = vi.fn();
    await submitFoodRecipeEditorAction({ preventDefault: vi.fn() } as never, {
      form: { recipeId: '', name: '' },
      recipeForm: defaultRecipeForm(),
      ingredientRows: defaultIngredientRows(),
      ingredients: [],
      selectedRecipeId: null,
      updateRecipe,
      createRecipe: vi.fn(),
      showNotice,
      setForm: vi.fn(),
      setView: vi.fn(),
      view: 'create',
      isSelfMade: true,
      closeEditor: vi.fn(),
      resetImageState: vi.fn(),
    });
    expect(updateRecipe).not.toHaveBeenCalled();
    expect(showNotice).toHaveBeenCalledWith(expect.objectContaining({ tone: 'warning' }));
  });
});
