import { describe, expect, it, vi } from 'vitest';
import { useAppCookNavigation } from './useAppCookNavigation';

describe('useAppCookNavigation', () => {
  it('routes ambiguous recipe relations to the recipe target instead of picking a food', () => {
    const navigate = vi.fn();
    const controller = useAppCookNavigation({ foods: [], recipes: [], foodPlanItems: [], foodPlanDetail: null, navigate });
    controller.startRecipeCook('recipe-1');
    expect(navigate).toHaveBeenCalledWith({ workspace: 'eat', view: 'recipe', recipeId: 'recipe-1' });
  });
});
