import { describe, expect, it, vi } from 'vitest';
import { buildHomeHandlers, homeTargets } from './useAppHomeHandlers';

describe('useAppHomeHandlers semantic targets', () => {
  it('maps a Home direct Cook recommendation to a complete launch context', () => {
    const navigate = vi.fn();
    const handlers = buildHomeHandlers({ navigate });
    handlers.startRecommendedRecipe({
      foodId: 'food-1',
      recipeId: 'recipe-1',
      date: '2026-07-14',
      mealType: 'lunch',
      servings: 3.5,
    });
    expect(navigate).toHaveBeenCalledWith({
      workspace: 'eat',
      view: 'cook',
      foodId: 'food-1',
      recipeId: 'recipe-1',
      launchContext: {
        date: '2026-07-14',
        mealType: 'lunch',
        servings: 3.5,
        source: { kind: 'direct' },
      },
    });
  });

  it('maps a Home plan Cook action with plan item base updated_at', () => {
    const navigate = vi.fn();
    const handlers = buildHomeHandlers({ navigate });
    handlers.startPlanRecipe({
      foodId: 'food-2',
      recipeId: 'recipe-2',
      foodPlanItemId: 'plan-9',
      planDate: '2026-07-15',
      mealType: 'dinner',
      servings: 2,
      planItemBaseUpdatedAt: '2026-07-12T10:00:00.000Z',
    });
    expect(navigate).toHaveBeenCalledWith({
      workspace: 'eat',
      view: 'cook',
      foodId: 'food-2',
      recipeId: 'recipe-2',
      launchContext: {
        date: '2026-07-15',
        mealType: 'dinner',
        servings: 2,
        source: {
          kind: 'plan',
          foodPlanItemId: 'plan-9',
          planItemBaseUpdatedAt: '2026-07-12T10:00:00.000Z',
        },
      },
    });
  });

  it('maps food/plan/history/meal-create helpers to AppNavigationTarget', () => {
    const navigate = vi.fn();
    const handlers = buildHomeHandlers({ navigate });

    handlers.openFood('food-1');
    handlers.openPlan('plan-1');
    handlers.openHistory('meal-1');
    handlers.openHistory();
    handlers.openMealCreate({ kind: 'direct' }, 'food-9');

    expect(navigate.mock.calls).toEqual([
      [homeTargets.food('food-1')],
      [homeTargets.plan('plan-1')],
      [homeTargets.history('meal-1')],
      [homeTargets.history()],
      [homeTargets.mealCreate({ kind: 'direct' }, 'food-9')],
    ]);
  });

  it('never exposes setActiveTab or legacy TabKey cooking routes', () => {
    const navigate = vi.fn();
    const handlers = buildHomeHandlers({ navigate });
    expect(handlers).not.toHaveProperty('setActiveTab');
    handlers.startRecommendedRecipe({
      foodId: 'food-1',
      recipeId: 'recipe-1',
      date: '2026-07-14',
      mealType: 'lunch',
      servings: 1,
    });
    const target = navigate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(target).not.toHaveProperty('tab');
    expect(JSON.stringify(target)).not.toMatch(/"foods"|"recipes"|"logs"/);
  });
});
