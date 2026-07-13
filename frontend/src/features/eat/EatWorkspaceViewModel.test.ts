import { describe, expect, it } from 'vitest';
import type { Food, FoodPlanItem, MealLog, Recipe } from '../../api/types';
import type { EatTask } from '../../app/appNavigationModel';
import {
  resolveEatTask,
  weekContaining,
  type ResolveEatTaskInput,
} from './EatWorkspaceViewModel';

function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    id: 'recipe-1',
    family_id: 'family-1',
    title: 'Tomato eggs',
    servings: 2,
    prep_minutes: 15,
    difficulty: 'easy',
    ingredient_items: [],
    steps: [],
    tips: '',
    images: [],
    cook_logs: [],
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeFood(overrides: Partial<Food> = {}): Food {
  return {
    id: 'food-1',
    family_id: 'family-1',
    name: 'Tomato eggs',
    type: 'selfMade',
    category: 'home',
    flavor_tags: [],
    suitable_meal_types: ['dinner'],
    source_name: '',
    purchase_source: '',
    scene: '',
    images: [],
    notes: '',
    routine_note: '',
    stock_unit: '',
    storage_location: '',
    favorite: false,
    recipe_id: 'recipe-1',
    row_version: 1,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function makePlanItem(overrides: Partial<FoodPlanItem> = {}): FoodPlanItem {
  return {
    id: 'plan-1',
    family_id: 'family-1',
    user_id: 'user-1',
    food_id: 'food-1',
    food_name: 'Tomato eggs',
    food_type: 'selfMade',
    recipe_id: 'recipe-1',
    recipe_title: 'Tomato eggs',
    plan_date: '2026-07-15',
    meal_type: 'dinner',
    note: '',
    status: 'planned',
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeMealLog(overrides: Partial<MealLog> = {}): MealLog {
  return {
    id: 'meal-1',
    family_id: 'family-1',
    date: '2026-07-12',
    meal_type: 'dinner',
    food_entries: [],
    participant_user_ids: [],
    notes: '',
    mood: '',
    photos: [],
    deduction_suggestions: [],
    created_at: '2026-07-12T12:00:00.000Z',
    updated_at: '2026-07-12T12:00:00.000Z',
    ...overrides,
  };
}

function baseInput(overrides: Partial<ResolveEatTaskInput> = {}): ResolveEatTaskInput {
  return {
    task: null,
    recipes: [],
    foods: [],
    recipesStatus: 'success',
    foodsStatus: 'success',
    planDetail: null,
    planDetailStatus: 'idle',
    mealLogs: [],
    mealLogsStatus: 'success',
    ...overrides,
  };
}

function resolveRecipeTargetForTest(
  recipes: Array<Partial<Recipe>>,
  foods: Array<Partial<Food>>,
) {
  return resolveEatTask(
    baseInput({
      task: {
        kind: 'recipe-target',
        recipeId: 'recipe-1',
        mode: 'view',
        returnTo: 'discover',
      },
      recipes: recipes.map((recipe) => makeRecipe(recipe)),
      foods: foods.map((food) =>
        makeFood({
          type: 'selfMade',
          recipe_id: 'recipe-1',
          ...food,
        }),
      ),
      recipesStatus: 'success',
      foodsStatus: 'success',
    }),
  );
}

describe('weekContaining', () => {
  it('returns Monday-Sunday range for a midweek plan date', () => {
    expect(weekContaining('2026-07-15')).toEqual({
      start: '2026-07-13',
      end: '2026-07-19',
    });
  });

  it('keeps Sunday inside the same week', () => {
    expect(weekContaining('2026-07-19')).toEqual({
      start: '2026-07-13',
      end: '2026-07-19',
    });
  });
});

describe('resolveEatTask', () => {
  it('returns none when no task is open', () => {
    expect(resolveEatTask(baseInput()).kind).toBe('none');
  });

  it('resolves one Recipe to its unique selfMade Food after both queries succeed', () => {
    expect(
      resolveEatTask({
        task: { kind: 'recipe-target', recipeId: 'recipe-1', mode: 'view', returnTo: 'discover' },
        recipes: [{ id: 'recipe-1' } as Recipe],
        foods: [{ id: 'food-1', recipe_id: 'recipe-1', type: 'selfMade' } as Food],
        recipesStatus: 'success',
        foodsStatus: 'success',
        planDetail: null,
        planDetailStatus: 'idle',
        mealLogs: [],
        mealLogsStatus: 'success',
      }),
    ).toMatchObject({ kind: 'ready-recipe', foodId: 'food-1', recipeId: 'recipe-1' });
  });

  it.each([
    [[], [{ id: 'food-1', recipe_id: 'recipe-1' }], 'recipe-not-found'],
    [[{ id: 'recipe-1' }], [], 'recipe-food-missing'],
    [
      [{ id: 'recipe-1' }],
      [
        { id: 'food-1', recipe_id: 'recipe-1' },
        { id: 'food-2', recipe_id: 'recipe-1' },
      ],
      'recipe-food-ambiguous',
    ],
  ] as const)('returns a recoverable relation state', (recipes, foods, expected) => {
    expect(resolveRecipeTargetForTest([...recipes], [...foods]).kind).toBe(expected);
  });

  it('ignores non-selfMade foods when resolving a recipe target', () => {
    const resolved = resolveEatTask(
      baseInput({
        task: {
          kind: 'recipe-target',
          recipeId: 'recipe-1',
          mode: 'edit',
          returnTo: 'discover',
        },
        recipes: [makeRecipe()],
        foods: [
          makeFood({ id: 'food-takeout', type: 'takeout', recipe_id: 'recipe-1' }),
          makeFood({ id: 'food-1', type: 'selfMade', recipe_id: 'recipe-1' }),
        ],
      }),
    );
    expect(resolved).toMatchObject({
      kind: 'ready-recipe',
      foodId: 'food-1',
      recipeId: 'recipe-1',
      mode: 'edit',
    });
  });

  it('returns loading while recipe or food queries are still pending', () => {
    expect(
      resolveEatTask(
        baseInput({
          task: {
            kind: 'recipe-target',
            recipeId: 'recipe-1',
            mode: 'view',
            returnTo: 'discover',
          },
          recipesStatus: 'pending',
          foodsStatus: 'success',
        }),
      ),
    ).toMatchObject({ kind: 'loading' });

    expect(
      resolveEatTask(
        baseInput({
          task: {
            kind: 'recipe-target',
            recipeId: 'recipe-1',
            mode: 'view',
            returnTo: 'discover',
          },
          recipesStatus: 'success',
          foodsStatus: 'pending',
        }),
      ),
    ).toMatchObject({ kind: 'loading' });
  });

  it('resolves an already-paired recipe task without re-deriving the relation', () => {
    expect(
      resolveEatTask(
        baseInput({
          task: {
            kind: 'recipe',
            foodId: 'food-1',
            recipeId: 'recipe-1',
            mode: 'view',
            returnTo: 'discover',
          },
          recipes: [makeRecipe()],
          foods: [makeFood()],
        }),
      ),
    ).toMatchObject({
      kind: 'ready-recipe',
      foodId: 'food-1',
      recipeId: 'recipe-1',
      mode: 'view',
    });
  });

  it('resolves food detail only after foods settle', () => {
    expect(
      resolveEatTask(
        baseInput({
          task: { kind: 'food-detail', foodId: 'food-1', returnTo: 'discover' },
          foodsStatus: 'pending',
        }),
      ),
    ).toMatchObject({ kind: 'loading' });

    expect(
      resolveEatTask(
        baseInput({
          task: { kind: 'food-detail', foodId: 'food-1', returnTo: 'discover' },
          foods: [makeFood()],
          foodsStatus: 'success',
        }),
      ),
    ).toMatchObject({ kind: 'food', food: expect.objectContaining({ id: 'food-1' }) });

    expect(
      resolveEatTask(
        baseInput({
          task: { kind: 'food-detail', foodId: 'missing', returnTo: 'discover' },
          foods: [makeFood()],
          foodsStatus: 'success',
        }),
      ),
    ).toMatchObject({ kind: 'none' });
  });

  it('resolves plan detail from the ID query and weekContaining(plan_date)', () => {
    const item = makePlanItem({ plan_date: '2026-07-15' });
    expect(
      resolveEatTask(
        baseInput({
          task: { kind: 'plan-detail', foodPlanItemId: 'plan-1', returnTo: 'plan' },
          planDetailStatus: 'pending',
        }),
      ),
    ).toMatchObject({ kind: 'loading' });

    expect(
      resolveEatTask(
        baseInput({
          task: { kind: 'plan-detail', foodPlanItemId: 'plan-1', returnTo: 'plan' },
          planDetail: item,
          planDetailStatus: 'success',
        }),
      ),
    ).toEqual({
      kind: 'plan',
      item,
      week: { start: '2026-07-13', end: '2026-07-19' },
    });

    expect(
      resolveEatTask(
        baseInput({
          task: { kind: 'plan-detail', foodPlanItemId: 'plan-missing', returnTo: 'plan' },
          planDetail: null,
          planDetailStatus: 'error',
        }),
      ),
    ).toEqual({ kind: 'plan-not-found', foodPlanItemId: 'plan-missing' });
  });

  it('resolves cook only when both food and recipe exist', () => {
    const launchContext = {
      date: '2026-07-13',
      mealType: 'dinner' as const,
      servings: 2,
      source: { kind: 'direct' as const },
    };
    const task: EatTask = {
      kind: 'cook',
      foodId: 'food-1',
      recipeId: 'recipe-1',
      launchContext,
      returnTo: 'discover',
    };

    expect(
      resolveEatTask(
        baseInput({
          task,
          recipesStatus: 'pending',
          foodsStatus: 'success',
          foods: [makeFood()],
        }),
      ),
    ).toMatchObject({ kind: 'loading' });

    expect(
      resolveEatTask(
        baseInput({
          task,
          recipes: [makeRecipe()],
          foods: [makeFood()],
        }),
      ),
    ).toMatchObject({
      kind: 'cook',
      food: expect.objectContaining({ id: 'food-1' }),
      recipe: expect.objectContaining({ id: 'recipe-1' }),
      launchContext,
    });

    expect(
      resolveEatTask(
        baseInput({
          task,
          recipes: [],
          foods: [makeFood()],
        }),
      ),
    ).toMatchObject({ kind: 'recipe-not-found', recipeId: 'recipe-1' });
  });

  it('resolves meal-create and attaches plan item only for plan source after detail settles', () => {
    const planItem = makePlanItem();
    const directTask: EatTask = {
      kind: 'meal-create',
      source: { kind: 'direct' },
      foodId: 'food-1',
      date: '2026-07-13',
      mealType: 'lunch',
      returnTo: 'history',
    };
    expect(
      resolveEatTask(
        baseInput({
          task: directTask,
        }),
      ),
    ).toEqual({ kind: 'meal-create', task: directTask, planItem: null });

    const planTask: EatTask = {
      kind: 'meal-create',
      source: {
        kind: 'plan',
        foodPlanItemId: 'plan-1',
        planItemBaseUpdatedAt: '2026-07-01T00:00:00.000Z',
      },
      foodId: 'food-1',
      returnTo: 'plan',
    };

    expect(
      resolveEatTask(
        baseInput({
          task: planTask,
          planDetailStatus: 'pending',
        }),
      ),
    ).toMatchObject({ kind: 'loading' });

    expect(
      resolveEatTask(
        baseInput({
          task: planTask,
          planDetail: planItem,
          planDetailStatus: 'success',
        }),
      ),
    ).toEqual({ kind: 'meal-create', task: planTask, planItem });

    expect(
      resolveEatTask(
        baseInput({
          task: planTask,
          planDetail: null,
          planDetailStatus: 'error',
        }),
      ),
    ).toEqual({ kind: 'plan-not-found', foodPlanItemId: 'plan-1' });
  });

  it('resolves meal detail by exact id', () => {
    const meal = makeMealLog();
    expect(
      resolveEatTask(
        baseInput({
          task: { kind: 'meal-detail', mealLogId: 'meal-1', returnTo: 'history' },
          mealLogsStatus: 'pending',
        }),
      ),
    ).toMatchObject({ kind: 'loading' });

    expect(
      resolveEatTask(
        baseInput({
          task: { kind: 'meal-detail', mealLogId: 'meal-1', returnTo: 'history' },
          mealLogs: [meal],
        }),
      ),
    ).toEqual({ kind: 'meal', mealLog: meal });

    expect(
      resolveEatTask(
        baseInput({
          task: { kind: 'meal-detail', mealLogId: 'missing', returnTo: 'history' },
          mealLogs: [meal],
        }),
      ),
    ).toEqual({ kind: 'meal-not-found', mealLogId: 'missing' });
  });
});
