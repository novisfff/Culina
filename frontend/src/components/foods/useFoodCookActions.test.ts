import { describe, expect, it, vi } from 'vitest';
import { submitFoodCookConfirmAction } from './useFoodCookActions';

describe('submitFoodCookConfirmAction', () => {
  it('clears the dialog and navigates with the direct cook target', async () => {
    const setDialog = vi.fn();
    const navigate = vi.fn();
    await submitFoodCookConfirmAction({
      event: { preventDefault: vi.fn() } as never,
      dialog: {
        action: 'cook',
        date: '2026-08-30',
        mealType: 'dinner',
        servings: 2,
        recipeId: 'recipe-1',
        food: { id: 'food-1' } as never,
      },
      recipes: [{ id: 'recipe-1', servings: 4 } as never],
      setDialog,
      navigate,
      onStartRecipe: vi.fn(),
    });
    expect(setDialog).toHaveBeenCalledWith(null);
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({
      workspace: 'eat', view: 'cook', foodId: 'food-1', recipeId: 'recipe-1',
      launchContext: expect.objectContaining({ date: '2026-08-30', mealType: 'dinner', servings: 2 }),
    }));
  });
});
