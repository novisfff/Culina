import { describe, expect, it } from 'vitest';
import {
  deriveAppQueryScope,
  initialNavigationState,
  migrateLegacyNavigation,
  parsePersistedNavigation,
  persistedNavigationFromState,
  reduceNavigation,
  type AppNavigationState,
  type AppQueryScope,
} from './appNavigationModel';

function eatState(
  overrides: Partial<AppNavigationState['eat']> & { primaryTab?: AppNavigationState['primaryTab'] } = {},
): AppNavigationState {
  const { primaryTab = 'eat', ...eat } = overrides;
  return {
    primaryTab,
    eat: {
      baseView: 'discover',
      task: null,
      discoverSection: 'all',
      ...eat,
    },
  };
}

function enabledFlags(scope: AppQueryScope): Array<keyof AppQueryScope> {
  return (Object.keys(scope) as Array<keyof AppQueryScope>).filter((key) => scope[key]);
}

describe('appNavigationModel', () => {
  it.each([
    ['foods', 'discover', 'all'],
    ['recipes', 'discover', 'selfMade'],
    ['logs', 'history', 'all'],
  ] as const)('migrates %s without restoring a task', (legacy, baseView, discoverSection) => {
    expect(migrateLegacyNavigation(legacy)).toMatchObject({
      primaryTab: 'eat',
      eat: { baseView, discoverSection, task: null },
    });
  });

  it.each([
    ['home', 'home'],
    ['ingredients', 'ingredients'],
    ['ai', 'ai'],
    ['family', 'family'],
  ] as const)('migrates legacy %s to the matching primary tab', (legacy, primaryTab) => {
    expect(migrateLegacyNavigation(legacy)).toMatchObject({
      primaryTab,
      eat: { task: null },
    });
  });

  it('falls back to home for unknown legacy tabs', () => {
    expect(migrateLegacyNavigation('mystery-tab')).toMatchObject({
      primaryTab: 'home',
      eat: { baseView: 'discover', task: null, discoverSection: 'all' },
    });
  });

  it('falls back to home for corrupt v2 input', () => {
    expect(parsePersistedNavigation('{bad json')).toMatchObject({ primaryTab: 'home' });
  });

  it('falls back to home for unknown v2 fields and future versions', () => {
    expect(
      parsePersistedNavigation(
        JSON.stringify({
          version: 2,
          primaryTab: 'recipes',
          eatBaseView: 'discover',
        }),
      ),
    ).toMatchObject({ primaryTab: 'home' });

    expect(
      parsePersistedNavigation(
        JSON.stringify({
          version: 3,
          primaryTab: 'eat',
          eatBaseView: 'plan',
        }),
      ),
    ).toMatchObject({ primaryTab: 'home' });
  });

  it('restores valid v2 snapshots without task state', () => {
    const restored = parsePersistedNavigation(
      JSON.stringify({
        version: 2,
        primaryTab: 'eat',
        eatBaseView: 'plan',
        discoverSection: 'selfMade',
        foodId: 'should-not-restore',
        task: { kind: 'cook', foodId: 'food-1' },
      }),
    );

    expect(restored).toEqual({
      primaryTab: 'eat',
      eat: { baseView: 'plan', task: null, discoverSection: 'selfMade' },
    });
  });

  it('persists only scalar navigation state without task ids', () => {
    const state = reduceNavigation(migrateLegacyNavigation('foods'), {
      type: 'navigate',
      target: {
        workspace: 'eat',
        view: 'cook',
        foodId: 'food-1',
        recipeId: 'recipe-1',
        launchContext: {
          date: '2026-07-13',
          mealType: 'lunch',
          servings: 3,
          source: { kind: 'direct' },
        },
      },
    });

    expect(persistedNavigationFromState(state)).toEqual({
      version: 2,
      primaryTab: 'eat',
      eatBaseView: 'discover',
      discoverSection: 'all',
    });
    expect(JSON.stringify(persistedNavigationFromState(state))).not.toContain('food-1');
    expect(JSON.stringify(persistedNavigationFromState(state))).not.toContain('recipe-1');
  });

  it('opens and closes a direct Cook task with its explicit launch context', () => {
    const opened = reduceNavigation(migrateLegacyNavigation('foods'), {
      type: 'navigate',
      target: {
        workspace: 'eat',
        view: 'cook',
        foodId: 'food-1',
        recipeId: 'recipe-1',
        launchContext: {
          date: '2026-07-13',
          mealType: 'lunch',
          servings: 3,
          source: { kind: 'direct' },
        },
      },
    });
    expect(opened.eat.task).toMatchObject({
      kind: 'cook',
      foodId: 'food-1',
      recipeId: 'recipe-1',
      returnTo: 'discover',
      launchContext: {
        date: '2026-07-13',
        mealType: 'lunch',
        servings: 3,
        source: { kind: 'direct' },
      },
    });
    expect(reduceNavigation(opened, { type: 'close-task' }).eat.task).toBeNull();
  });

  it('opens plan-sourced Cook and meal-create with plan return targets', () => {
    const planCook = reduceNavigation(eatState({ baseView: 'plan' }), {
      type: 'navigate',
      target: {
        workspace: 'eat',
        view: 'cook',
        foodId: 'food-2',
        recipeId: 'recipe-2',
        launchContext: {
          date: '2026-07-14',
          mealType: 'dinner',
          servings: 2,
          source: {
            kind: 'plan',
            foodPlanItemId: 'plan-9',
            planItemBaseUpdatedAt: '2026-07-13T01:00:00.000Z',
          },
        },
      },
    });
    expect(planCook.eat).toMatchObject({
      baseView: 'plan',
      task: {
        kind: 'cook',
        returnTo: 'plan',
        launchContext: {
          source: {
            kind: 'plan',
            foodPlanItemId: 'plan-9',
            planItemBaseUpdatedAt: '2026-07-13T01:00:00.000Z',
          },
        },
      },
    });

    const mealCreate = reduceNavigation(eatState({ baseView: 'discover' }), {
      type: 'navigate',
      target: {
        workspace: 'eat',
        view: 'meal-create',
        source: {
          kind: 'plan',
          foodPlanItemId: 'plan-3',
          planItemBaseUpdatedAt: '2026-07-13T02:00:00.000Z',
        },
        foodId: 'food-3',
        date: '2026-07-15',
        mealType: 'breakfast',
      },
    });
    expect(mealCreate.eat.task).toMatchObject({
      kind: 'meal-create',
      returnTo: 'plan',
      foodId: 'food-3',
      date: '2026-07-15',
      mealType: 'breakfast',
      source: {
        kind: 'plan',
        foodPlanItemId: 'plan-3',
        planItemBaseUpdatedAt: '2026-07-13T02:00:00.000Z',
      },
    });
    expect(mealCreate.eat.baseView).toBe('plan');
  });

  it('emits recipe-target for recipe navigation on both desktop and mobile paths', () => {
    const opened = reduceNavigation(eatState({ baseView: 'history' }), {
      type: 'navigate',
      target: { workspace: 'eat', view: 'recipe', recipeId: 'recipe-7', mode: 'edit' },
    });
    expect(opened.eat.task).toEqual({
      kind: 'recipe-target',
      recipeId: 'recipe-7',
      mode: 'edit',
      returnTo: 'history',
    });
  });

  it('opens meal-detail with returnTo history even when previous base was discover', () => {
    const opened = reduceNavigation(eatState({ baseView: 'discover' }), {
      type: 'navigate',
      target: { workspace: 'eat', view: 'history', mealLogId: 'meal-42' },
    });
    expect(opened.eat).toMatchObject({
      baseView: 'history',
      task: {
        kind: 'meal-detail',
        mealLogId: 'meal-42',
        returnTo: 'history',
      },
    });
  });

  it('closes the current task when switching primary tabs or eat base views', () => {
    const withTask = reduceNavigation(migrateLegacyNavigation('foods'), {
      type: 'navigate',
      target: { workspace: 'eat', view: 'food', foodId: 'food-1' },
    });
    expect(withTask.eat.task).toMatchObject({ kind: 'food-detail', returnTo: 'discover' });

    expect(
      reduceNavigation(withTask, {
        type: 'navigate',
        target: { workspace: 'family' },
      }).eat.task,
    ).toBeNull();

    expect(
      reduceNavigation(withTask, {
        type: 'select-eat-view',
        view: 'plan',
      }),
    ).toMatchObject({
      primaryTab: 'eat',
      eat: { baseView: 'plan', task: null },
    });
  });

  it('restores the task returnTo base view when closing', () => {
    const opened = reduceNavigation(eatState({ baseView: 'history' }), {
      type: 'navigate',
      target: { workspace: 'eat', view: 'food', foodId: 'food-9' },
    });
    const closed = reduceNavigation(opened, { type: 'close-task' });
    expect(closed).toMatchObject({
      primaryTab: 'eat',
      eat: { baseView: 'history', task: null },
    });
  });

  it('derives plan-detail queries without enabling discovery recommendations', () => {
    const state = reduceNavigation(migrateLegacyNavigation('foods'), {
      type: 'navigate',
      target: { workspace: 'eat', view: 'plan', foodPlanItemId: 'plan-1' },
    });
    expect(deriveAppQueryScope(state)).toMatchObject({
      needsFoodPlan: true,
      needsFoodPlanDetail: true,
      needsFoods: true,
      needsRecipes: true,
      needsMealLogs: true,
      needsFoodRecommendations: false,
    });
  });

  it.each([
    {
      name: 'eat/discover',
      state: eatState({ baseView: 'discover' }),
      expected: [
        'needsIngredients',
        'needsInventory',
        'needsRecipes',
        'needsFoodPlan',
        'needsFoodScenes',
        'needsFoods',
        'needsFoodRecommendations',
        'needsMealLogs',
      ],
    },
    {
      name: 'eat/plan',
      state: eatState({ baseView: 'plan' }),
      expected: ['needsRecipes', 'needsFoodPlan', 'needsFoods', 'needsMealLogs'],
    },
    {
      name: 'plan-detail',
      state: eatState({
        baseView: 'plan',
        task: { kind: 'plan-detail', foodPlanItemId: 'plan-1', returnTo: 'plan' },
      }),
      expected: ['needsRecipes', 'needsFoodPlan', 'needsFoodPlanDetail', 'needsFoods', 'needsMealLogs'],
    },
    {
      name: 'eat/history',
      state: eatState({ baseView: 'history' }),
      expected: ['needsMembers', 'needsFoodPlan', 'needsFoods', 'needsMealLogs'],
    },
    {
      name: 'food-detail',
      state: eatState({
        task: { kind: 'food-detail', foodId: 'food-1', returnTo: 'discover' },
      }),
      expected: [
        'needsIngredients',
        'needsInventory',
        'needsRecipes',
        'needsFoods',
        'needsMealLogs',
      ],
    },
    {
      name: 'recipe-target',
      state: eatState({
        task: { kind: 'recipe-target', recipeId: 'recipe-1', mode: 'view', returnTo: 'discover' },
      }),
      expected: [
        'needsIngredients',
        'needsInventory',
        'needsRecipes',
        'needsFoods',
        'needsMealLogs',
      ],
    },
    {
      name: 'recipe',
      state: eatState({
        task: {
          kind: 'recipe',
          foodId: 'food-1',
          recipeId: 'recipe-1',
          mode: 'edit',
          returnTo: 'discover',
        },
      }),
      expected: [
        'needsIngredients',
        'needsInventory',
        'needsRecipes',
        'needsFoods',
        'needsMealLogs',
      ],
    },
    {
      name: 'direct cook',
      state: eatState({
        task: {
          kind: 'cook',
          foodId: 'food-1',
          recipeId: 'recipe-1',
          returnTo: 'discover',
          launchContext: {
            date: '2026-07-13',
            mealType: 'lunch',
            servings: 2,
            source: { kind: 'direct' },
          },
        },
      }),
      expected: ['needsIngredients', 'needsInventory', 'needsRecipes', 'needsFoods', 'needsMealLogs'],
    },
    {
      name: 'plan cook',
      state: eatState({
        baseView: 'plan',
        task: {
          kind: 'cook',
          foodId: 'food-1',
          recipeId: 'recipe-1',
          returnTo: 'plan',
          launchContext: {
            date: '2026-07-13',
            mealType: 'dinner',
            servings: 2,
            source: {
              kind: 'plan',
              foodPlanItemId: 'plan-1',
              planItemBaseUpdatedAt: '2026-07-13T00:00:00.000Z',
            },
          },
        },
      }),
      expected: ['needsIngredients', 'needsInventory', 'needsRecipes', 'needsFoodPlan', 'needsFoods', 'needsMealLogs'],
    },
    {
      name: 'meal-create',
      state: eatState({
        task: {
          kind: 'meal-create',
          source: { kind: 'direct' },
          returnTo: 'history',
        },
      }),
      expected: ['needsMembers', 'needsFoodPlan', 'needsFoods', 'needsMealLogs'],
    },
    {
      name: 'plan meal-create',
      state: eatState({
        baseView: 'plan',
        task: {
          kind: 'meal-create',
          source: {
            kind: 'plan',
            foodPlanItemId: 'plan-1',
            planItemBaseUpdatedAt: '2026-07-01T00:00:00.000Z',
          },
          foodId: 'food-1',
          returnTo: 'plan',
        },
      }),
      expected: [
        'needsMembers',
        'needsFoodPlan',
        'needsFoodPlanDetail',
        'needsFoods',
        'needsMealLogs',
      ],
    },
    {
      name: 'meal-detail',
      state: eatState({
        baseView: 'history',
        task: { kind: 'meal-detail', mealLogId: 'meal-1', returnTo: 'history' },
      }),
      expected: ['needsMembers', 'needsFoodPlan', 'needsFoods', 'needsMealLogs'],
    },
    {
      name: 'home',
      state: initialNavigationState,
      expected: [
        'needsMembers',
        'needsIngredients',
        'needsInventory',
        'needsShopping',
        'needsRecipes',
        'needsFoodPlan',
        'needsFoods',
        'needsFoodRecommendations',
        'needsMealLogs',
      ],
    },
    {
      name: 'ingredients',
      state: { primaryTab: 'ingredients' as const, eat: initialNavigationState.eat },
      expected: ['needsIngredients', 'needsInventory', 'needsShopping', 'needsRecipes'],
    },
    {
      name: 'ai',
      state: { primaryTab: 'ai' as const, eat: initialNavigationState.eat },
      expected: ['needsAiConversations'],
    },
    {
      name: 'family',
      state: { primaryTab: 'family' as const, eat: initialNavigationState.eat },
      expected: ['needsMembers', 'needsRecipes', 'needsFoods', 'needsMealLogs', 'needsActivityLogs'],
    },
  ])('derives query scope for $name', ({ state, expected }) => {
    expect(enabledFlags(deriveAppQueryScope(state)).sort()).toEqual([...expected].sort());
  });
});
