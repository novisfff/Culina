import { describe, expect, it, vi } from 'vitest';
import { submitFoodFormAction } from './useFoodFormActions';
import { defaultIngredientRows, defaultRecipeForm } from '../recipes/RecipeWorkspaceModel';

describe('submitFoodFormAction', () => {
  it('blocks an invalid ready-food stock quantity before calling the food mutation', async () => {
    const showNotice = vi.fn();
    const submitFood = vi.fn();
    await submitFoodFormAction({
      event: { preventDefault: vi.fn() } as never,
      canSubmit: true,
      form: { type: 'readyMade', stockQuantity: 'not-a-number', recipeId: '', name: '面包' } as never,
      isReadyLike: true,
      isSelfMade: false,
      recipeForm: defaultRecipeForm(),
      ingredientRows: defaultIngredientRows(),
      ingredients: [], recipes: [], selectedRecipeId: null,
      submitFood, updateRecipe: vi.fn(), createRecipe: vi.fn(),
      setView: vi.fn(), resetFoodImage: vi.fn(), resetRecipeImage: vi.fn(), showNotice,
    });
    expect(submitFood).not.toHaveBeenCalled();
    expect(showNotice).toHaveBeenCalledWith(expect.objectContaining({ title: '库存数量格式不对' }));
  });
});
