import { describe, expect, it } from 'vitest';
import { buildFoodWorkspaceViewModel } from './FoodWorkspaceViewModel';
describe('Food workspace view model', () => {
  it('keeps an empty search projection stable', () => {
    const model = buildFoodWorkspaceViewModel({ foods: [], recipes: [], mealLogs: [], search: '' });
    expect(model.items).toEqual([]);
    expect(model.countLabel).toBe('显示 0 / 0 项食物');
  });
});
