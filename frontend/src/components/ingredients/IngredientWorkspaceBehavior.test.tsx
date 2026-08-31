import { describe, expect, it } from 'vitest';
import { buildIngredientWorkspaceViewModel } from './IngredientWorkspaceViewModel';

describe('Ingredient workspace view model', () => {
  it('returns an empty safe projection when selected id is absent', () => {
    const model = buildIngredientWorkspaceViewModel({ ingredients: [], inventoryItems: [], inventoryStates: [], shoppingItems: [], recipes: [], foods: [], referenceDate: '2026-08-28' });
    expect(model.selected).toBeNull();
    expect(model.storageGroups).toEqual([]);
  });
});
