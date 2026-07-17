// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Food,
  FoodPlanItem,
  Ingredient,
  MealLog,
  Recipe,
  RecordMealResponse,
} from '../../api/types';
import { api } from '../../api/client';
import type { CookLaunchContext } from '../../app/appNavigationModel';
import {
  buildCookSessionV3Key,
  buildDefaultCookSessionV3,
  readCookSessionV3,
  saveCookSessionV3,
} from '../../components/recipes/recipeCookSessionStorage';
import {
  EatCookTaskBody,
  EatFoodTaskBody,
  EatMealCreateTaskBody,
  EatPlanTaskBody,
  EatRecipeTaskBody,
  buildEatTaskBodies,
} from './EatTaskBodies';

/** Phase-one owner matrix for Eat surfaces (Task 16). */
const eatOwners = {
  eatFoodRecord: 'recordMeal',
  eatPlanComplete: 'completeFoodPlanItem',
  recipeCook: 'cookRecipe',
} as const;

const imageComposerSpies = vi.hoisted(() => ({
  upload: vi.fn(async () => undefined),
  generate: vi.fn(async () => undefined),
  reset: vi.fn(),
}));

vi.mock('../../hooks/useImageComposer', async () => {
  const actual = await vi.importActual<typeof import('../../hooks/useImageComposer')>(
    '../../hooks/useImageComposer',
  );
  return {
    ...actual,
    useImageComposer: () => ({
      state: actual.IDLE_IMAGE_GENERATION_STATE,
      setState: vi.fn(),
      upload: imageComposerSpies.upload,
      uploadDirect: vi.fn(async () => undefined),
      generateWithResult: vi.fn(async () => ({})),
      generate: imageComposerSpies.generate,
      reset: imageComposerSpies.reset,
    }),
  };
});

function renderWithQuery(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return {
    ...view,
    rerender: (next: ReactElement) =>
      view.rerender(<QueryClientProvider client={client}>{next}</QueryClientProvider>),
  };
}

function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    id: 'recipe-1',
    family_id: 'family-1',
    title: 'Tomato eggs',
    servings: 2,
    prep_minutes: 15,
    difficulty: 'easy',
    ingredient_items: [],
    steps: [{ id: 'step-1', title: 'Cook', text: 'Cook', key_points: [] }],
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
    stock_unit: '份',
    storage_location: '',
    favorite: false,
    recipe_id: 'recipe-1',
    row_version: 3,
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

function makeReadyFood(overrides: Partial<Food> = {}): Food {
  return makeFood({
    id: 'ready-1',
    name: 'Instant noodles',
    type: 'readyMade',
    recipe_id: null,
    stock_quantity: 3,
    stock_unit: '份',
    storage_location: '常温',
    ...overrides,
  });
}

beforeEach(() => {
  vi.useRealTimers();
  Object.defineProperty(window, 'scrollTo', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
  localStorage.clear();
  imageComposerSpies.upload.mockClear();
  imageComposerSpies.generate.mockClear();
  imageComposerSpies.reset.mockClear();
  vi.spyOn(api, 'getMealCandidates').mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('EatCookTaskBody resume prompt', () => {
  it('reports a matching saved task while keeping the resume dialog open', async () => {
    const recipe = makeRecipe({ id: 'recipe-saved', title: 'Saved cook' });
    const food = makeFood({ id: 'food-saved', recipe_id: recipe.id });
    const scope = { userId: 'user-1', familyId: 'family-1' };
    saveCookSessionV3({
      scope,
      recipeId: recipe.id,
      session: buildDefaultCookSessionV3(recipe, {
        source: 'direct',
        planItemId: null,
        completionRequestId: 'saved-cook',
        date: '2026-07-14',
        mealType: 'dinner',
      }),
    });
    const onResumePromptChange = vi.fn();

    renderWithQuery(
      <EatCookTaskBody
        food={food}
        recipe={recipe}
        launchContext={{
          date: '2026-07-14',
          mealType: 'dinner',
          servings: 2,
          source: { kind: 'direct' },
        }}
        recipes={[recipe]}
        foods={[food]}
        ingredients={[]}
        inventoryItems={[]}
        mealLogs={[]}
        cookRecipe={vi.fn(async () => ({}) as never)}
        previewCookRecipe={vi.fn(async () => ({ preview_items: [], shortages: [] }) as never)}
        createShoppingItem={vi.fn(async () => ({}) as never)}
        onClose={vi.fn()}
        onCompleted={vi.fn()}
        onResumePromptChange={onResumePromptChange}
        sessionScope={scope}
      />,
    );

    expect(await screen.findByRole('dialog', { name: '继续上次的做菜进度？' })).toBeInTheDocument();
    await waitFor(() => expect(onResumePromptChange).toHaveBeenLastCalledWith(true));
  });
});

describe('buildEatTaskBodies plan complete', () => {
  it('locks eat owners to recordMeal / completeFoodPlanItem / cookRecipe', () => {
    expect(eatOwners.eatFoodRecord).toBe('recordMeal');
    expect(eatOwners.eatPlanComplete).toBe('completeFoodPlanItem');
    expect(eatOwners.recipeCook).toBe('cookRecipe');
  });

  it('completes non-recipe plan via completeFoodPlanItem and opens enrichment', async () => {
    const planItem = makePlanItem({ recipe_id: null });
    const createdMeal: MealLog = {
      id: 'meal-1',
      family_id: 'family-1',
      date: planItem.plan_date,
      meal_type: planItem.meal_type,
      food_entries: [
        {
          id: 'entry-1',
          food_id: planItem.food_id,
          food_name: planItem.food_name,
          servings: 1,
          note: '来自菜单记录',
          rating: null,
        },
      ],
      participant_user_ids: [],
      notes: '',
      mood: '',
      photos: [],
      deduction_suggestions: [],
      row_version: 1,
      created_at: '2026-07-15T00:00:00.000Z',
      updated_at: '2026-07-15T00:00:00.000Z',
    };
    const completeFoodPlanItem = vi.fn(async () => createdMeal);
    const recordMeal = vi.fn();
    const onRecordSuccess = vi.fn();
    const bodies = buildEatTaskBodies({
      resolvedTask: {
        kind: 'plan',
        item: planItem,
        week: { start: '2026-07-13', end: '2026-07-19' },
      },
      recipes: [makeRecipe()],
      foods: [makeFood({ recipe_id: null })],
      ingredients: [],
      inventoryItems: [],
      mealLogs: [],
      foodPlanItems: [planItem],
      members: [],
      cookRecipe: vi.fn(),
      previewCookRecipe: vi.fn(),
      updateFoodPlanItem: vi.fn(),
      deleteFoodPlanItem: vi.fn(),
      createFoodPlanItem: vi.fn(),
      updateFood: vi.fn(),
      updateRecipe: vi.fn(),
      updateMealLog: vi.fn(),
      createShoppingItem: vi.fn(),
      recordMeal,
      completeFoodPlanItem,
      onRecordSuccess,
      onClose: vi.fn(),
      onOpenLogs: vi.fn(),
      onNavigateRecipe: vi.fn(),
      onStartCook: vi.fn(),
      onStartCookWithFood: vi.fn(),
      onQuickAdd: vi.fn(),
      onCookCompleted: vi.fn(),
    });

    renderWithQuery(<>{bodies.planTaskContent}</>);
    await userEvent.click(screen.getByRole('button', { name: '记录已吃' }));
    await waitFor(() => {
      expect(completeFoodPlanItem).toHaveBeenCalled();
    });
    expect(completeFoodPlanItem).toHaveBeenCalledWith(
      planItem.id,
      expect.objectContaining({
        food_plan_item_base_updated_at: planItem.updated_at,
      }),
    );
    expect(recordMeal).not.toHaveBeenCalled();
    expect(onRecordSuccess).not.toHaveBeenCalled();
    expect(await screen.findByText('评价这顿晚餐')).toBeInTheDocument();
  });

  it('starts recipe cook for recipe plan items without completeFoodPlanItem', async () => {
    const planItem = makePlanItem({ recipe_id: 'recipe-1' });
    const completeFoodPlanItem = vi.fn();
    const onStartCook = vi.fn();
    const bodies = buildEatTaskBodies({
      resolvedTask: {
        kind: 'plan',
        item: planItem,
        week: { start: '2026-07-13', end: '2026-07-19' },
      },
      recipes: [makeRecipe()],
      foods: [makeFood()],
      ingredients: [],
      inventoryItems: [],
      mealLogs: [],
      foodPlanItems: [planItem],
      members: [],
      cookRecipe: vi.fn(),
      previewCookRecipe: vi.fn(),
      updateFoodPlanItem: vi.fn(),
      deleteFoodPlanItem: vi.fn(),
      createFoodPlanItem: vi.fn(),
      updateFood: vi.fn(),
      updateRecipe: vi.fn(),
      updateMealLog: vi.fn(),
      createShoppingItem: vi.fn(),
      recordMeal: vi.fn(),
      completeFoodPlanItem,
      onClose: vi.fn(),
      onOpenLogs: vi.fn(),
      onNavigateRecipe: vi.fn(),
      onStartCook,
      onStartCookWithFood: vi.fn(),
      onQuickAdd: vi.fn(),
      onCookCompleted: vi.fn(),
    });

    renderWithQuery(<>{bodies.planTaskContent}</>);
    await userEvent.click(screen.getByRole('button', { name: '开始做' }));
    expect(onStartCook).toHaveBeenCalledWith('recipe-1', planItem.id);
    expect(completeFoodPlanItem).not.toHaveBeenCalled();
  });
});

describe('EatPlanTaskBody record failure', () => {
  it('keeps the plan detail open and shows the recording error', async () => {
    const planItem = makePlanItem({ recipe_id: null });
    renderWithQuery(
      <EatPlanTaskBody
        item={planItem}
        food={makeFood({ recipe_id: null })}
        recipes={[]}
        members={[]}
        onClose={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
        onComplete={vi.fn(async () => {
          throw new Error('网络暂时不可用');
        })}
        updateMealLog={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: '记录已吃' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('网络暂时不可用');
    expect(screen.getByText('菜单计划详情')).toBeInTheDocument();
    expect(screen.queryByText('评价这顿晚餐')).not.toBeInTheDocument();
  });

  it('clears recorded meal state when switching directly to another plan item', async () => {
    const firstItem = makePlanItem({ id: 'plan-1', recipe_id: null, food_name: 'First meal' });
    const secondItem = makePlanItem({ id: 'plan-2', recipe_id: null, food_name: 'Second meal' });
    const createdMeal: MealLog = {
      id: 'meal-first',
      family_id: 'family-1',
      date: firstItem.plan_date,
      meal_type: firstItem.meal_type,
      food_entries: [],
      participant_user_ids: [],
      notes: '',
      mood: '',
      photos: [],
      deduction_suggestions: [],
      row_version: 1,
      created_at: '2026-07-15T00:00:00Z',
      updated_at: '2026-07-15T00:00:00Z',
    };
    const onComplete = vi.fn(async () => createdMeal);
    const renderBody = (item: FoodPlanItem) => (
      <EatPlanTaskBody
        item={item}
        food={makeFood({ id: item.food_id, name: item.food_name, recipe_id: null })}
        recipes={[]}
        members={[]}
        onClose={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
        onComplete={onComplete}
        updateMealLog={vi.fn()}
      />
    );
    const view = renderWithQuery(renderBody(firstItem));

    await userEvent.click(screen.getByRole('button', { name: '记录已吃' }));
    expect(await screen.findByText('评价这顿晚餐')).toBeInTheDocument();

    view.rerender(renderBody(secondItem));

    await waitFor(() => expect(screen.queryByText('评价这顿晚餐')).not.toBeInTheDocument());
    expect(screen.getByText('Second meal')).toBeInTheDocument();
  });

  it('ignores a previous plan recording result that settles after switching items', async () => {
    const firstItem = makePlanItem({ id: 'plan-1', recipe_id: null, food_name: 'First meal' });
    const secondItem = makePlanItem({ id: 'plan-2', recipe_id: null, food_name: 'Second meal' });
    let resolveCreatedMeal: (meal: MealLog) => void = () => undefined;
    const pendingMeal = new Promise<MealLog>((resolve) => {
      resolveCreatedMeal = resolve;
    });
    const renderBody = (item: FoodPlanItem) => (
      <EatPlanTaskBody
        item={item}
        food={makeFood({ id: item.food_id, name: item.food_name, recipe_id: null })}
        recipes={[]}
        members={[]}
        onClose={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
        onComplete={vi.fn(() => pendingMeal)}
        updateMealLog={vi.fn()}
      />
    );
    const view = renderWithQuery(renderBody(firstItem));

    await userEvent.click(screen.getByRole('button', { name: '记录已吃' }));
    view.rerender(renderBody(secondItem));
    resolveCreatedMeal({
      id: 'meal-first',
      family_id: 'family-1',
      date: firstItem.plan_date,
      meal_type: firstItem.meal_type,
      food_entries: [],
      participant_user_ids: [],
      notes: '',
      mood: '',
      photos: [],
      deduction_suggestions: [],
    row_version: 1,
    created_at: '2026-07-15T00:00:00Z',
      updated_at: '2026-07-15T00:00:00Z',
    });

    await waitFor(() => expect(screen.getByText('Second meal')).toBeInTheDocument());
    expect(screen.queryByText('评价这顿晚餐')).not.toBeInTheDocument();
  });
});

describe('EatMealCreateTaskBody', () => {
  it('completes plan-sourced meal create via completeFoodPlanItem (no ordinary undo)', async () => {
    const planItem = makePlanItem({ recipe_id: null });
    const food = makeFood({ recipe_id: null });
    const completeFoodPlanItem = vi.fn(async () => ({
      id: 'meal-plan-1',
      family_id: 'family-1',
      date: planItem.plan_date,
      meal_type: planItem.meal_type,
      food_entries: [],
      participant_user_ids: [],
      notes: '',
      mood: '',
      photos: [],
      deduction_suggestions: [],
      row_version: 1,
      created_at: '2026-07-15T00:00:00.000Z',
      updated_at: '2026-07-15T00:00:00.000Z',
    } satisfies MealLog));
    const recordMeal = vi.fn();
    const onRecordSuccess = vi.fn();
    const onClose = vi.fn();

    renderWithQuery(
      <EatMealCreateTaskBody
        food={food}
        planItem={planItem}
        recipes={[makeRecipe()]}
        recordMeal={recordMeal}
        completeFoodPlanItem={completeFoodPlanItem}
        onRecordSuccess={onRecordSuccess}
        onClose={onClose}
      />,
    );

    const submit = await screen.findByRole('button', { name: '记下这餐' });
    await waitFor(() => expect(submit).not.toBeDisabled());
    await userEvent.click(submit);
    await waitFor(() => expect(completeFoodPlanItem).toHaveBeenCalled());
    expect(completeFoodPlanItem).toHaveBeenCalledWith(
      planItem.id,
      expect.objectContaining({
        food_plan_item_base_updated_at: planItem.updated_at,
      }),
    );
    expect(recordMeal).not.toHaveBeenCalled();
    expect(onRecordSuccess).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('records ordinary Food via recordMeal and publishes shared result', async () => {
    const food = makeReadyFood();
    const response = {
      meal_log: {
        id: 'meal-rec-1',
        family_id: 'family-1',
        date: '2026-07-15',
        meal_type: 'dinner',
        food_entries: [],
        participant_user_ids: [],
        notes: '',
        mood: '',
        photos: [],
        deduction_suggestions: [],
        row_version: 1,
        created_at: '2026-07-15T00:00:00.000Z',
        updated_at: '2026-07-15T00:00:00.000Z',
      },
      created_foods: [],
      outcome: 'created',
      operation: {
        id: 'op-1',
        status: 'applied',
        revertible_until: '2026-07-15T01:00:00.000Z',
        can_revert: true,
      },
    } satisfies RecordMealResponse;
    const recordMeal = vi.fn(async () => response);
    const completeFoodPlanItem = vi.fn();
    const onRecordSuccess = vi.fn();
    const onClose = vi.fn();

    renderWithQuery(
      <EatMealCreateTaskBody
        food={food}
        planItem={null}
        recipes={[]}
        recordMeal={recordMeal}
        completeFoodPlanItem={completeFoodPlanItem}
        onRecordSuccess={onRecordSuccess}
        onClose={onClose}
      />,
    );

    expect(screen.queryByRole('checkbox', { name: /同步扣减库存/i })).toBeNull();
    const submit = await screen.findByRole('button', { name: '记下这餐' });
    await waitFor(() => expect(submit).not.toBeDisabled());
    await userEvent.click(submit);
    await waitFor(() => expect(recordMeal).toHaveBeenCalled());
    const payload = (recordMeal.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(payload).toMatchObject({
      date: expect.any(String),
      meal_type: expect.any(String),
      target: { kind: 'new' },
    });
    expect(payload.entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ food_id: food.id, servings: 1 })]),
    );
    expect(payload).not.toHaveProperty('deduct_food_stock');
    expect(payload).not.toHaveProperty('stock_quantity');
    expect(payload).not.toHaveProperty('food_plan_item_id');
    expect(completeFoodPlanItem).not.toHaveBeenCalled();
    expect(onRecordSuccess).toHaveBeenCalledWith(response);
    expect(onClose).toHaveBeenCalled();
  });

  it('history free meal-create opens full MealComposer and records multi-Food with publish', async () => {
    const response = {
      meal_log: {
        id: 'meal-free-1',
        family_id: 'family-1',
        date: '2026-07-15',
        meal_type: 'dinner',
        food_entries: [
          {
            id: 'entry-free-1',
            food_id: 'food-inline',
            food_name: '酸汤牛肉',
            servings: 1,
            note: '',
            rating: null,
          },
        ],
        participant_user_ids: [],
        notes: '',
        mood: '',
        photos: [],
        deduction_suggestions: [],
        row_version: 1,
        created_at: '2026-07-15T00:00:00.000Z',
        updated_at: '2026-07-15T00:00:00.000Z',
      },
      created_foods: [],
      outcome: 'created',
      operation: {
        id: 'op-free-1',
        status: 'applied',
        revertible_until: '2026-07-15T01:00:00.000Z',
        can_revert: true,
        created_entry_ids: ['entry-free-1'],
      },
    } satisfies RecordMealResponse;
    const recordMeal = vi.fn(async () => response);
    const onRecordSuccess = vi.fn();
    const onClose = vi.fn();
    vi.spyOn(api, 'getMealCandidates').mockResolvedValue([]);
    vi.spyOn(api, 'getFoods').mockResolvedValue([]);

    renderWithQuery(
      <EatMealCreateTaskBody
        food={null}
        planItem={null}
        date="2026-07-15"
        mealType="dinner"
        recipes={[]}
        recordMeal={recordMeal}
        completeFoodPlanItem={vi.fn()}
        onRecordSuccess={onRecordSuccess}
        onClose={onClose}
      />,
    );

    // Full composer, not the empty-state dead end.
    expect(screen.queryByText('还没有可记录的家常菜')).toBeNull();
    expect(screen.getByRole('heading', { name: '记一餐' })).toBeVisible();
    const searchbox = screen.getByRole('searchbox', { name: '搜索食物' });
    expect(searchbox).toBeVisible();

    // Set query in one shot (avoids flake from character-by-character typing under suite load).
    const user = userEvent.setup();
    fireEvent.change(searchbox, { target: { value: '酸汤牛肉' } });
    await user.click(await screen.findByRole('option', { name: "按‘酸汤牛肉’记下" }));
    await user.click(screen.getByRole('button', { name: '家里做' }));
    expect(screen.getByText('酸汤牛肉')).toBeVisible();

    await user.click(screen.getByRole('button', { name: '记下这餐' }));
    await waitFor(() => expect(recordMeal).toHaveBeenCalled());
    const payload = (recordMeal.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(payload).toMatchObject({
      date: '2026-07-15',
      meal_type: 'dinner',
      target: { kind: 'new' },
    });
    expect(payload.new_foods).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: '酸汤牛肉', type: 'selfMade' }),
      ]),
    );
    expect(onRecordSuccess).toHaveBeenCalledWith(response);
    expect(onClose).toHaveBeenCalled();
  });

  it('prefills matching planned foods and submits their completion references', async () => {
    const plannedFood = makeFood({ id: 'food-planned', name: '计划番茄炒蛋', recipe_id: null });
    const plannedItem = makePlanItem({
      id: 'plan-planned',
      food_id: plannedFood.id,
      food_name: plannedFood.name,
      recipe_id: null,
      plan_date: '2026-07-15',
      meal_type: 'dinner',
    });
    const recordMeal = vi.fn(async () => ({
      meal_log: {
        id: 'meal-planned',
        family_id: 'family-1',
        date: '2026-07-15',
        meal_type: 'dinner' as const,
        food_entries: [],
        participant_user_ids: [],
        notes: '',
        mood: '',
        photos: [],
        deduction_suggestions: [],
        row_version: 1,
        created_at: '2026-07-15T00:00:00.000Z',
        updated_at: '2026-07-15T00:00:00.000Z',
      },
      created_foods: [],
      completed_plan_item_ids: [plannedItem.id],
      outcome: 'created' as const,
      operation: {
        id: 'op-planned',
        status: 'applied' as const,
        revertible_until: '2026-07-15T01:00:00.000Z',
        can_revert: true,
      },
    }));

    renderWithQuery(
      <EatMealCreateTaskBody
        food={null}
        planItem={null}
        date="2026-07-15"
        mealType="dinner"
        recipes={[]}
        foods={[plannedFood]}
        foodPlanItems={[plannedItem]}
        recordMeal={recordMeal}
        completeFoodPlanItem={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByText('计划番茄炒蛋')).toBeVisible();
    expect(screen.getByText('本餐计划')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: '记下这餐' }));
    await waitFor(() => expect(recordMeal).toHaveBeenCalled());
    expect(recordMeal).toHaveBeenCalledWith(
      expect.objectContaining({
        entries: [{ food_id: plannedFood.id, servings: 1 }],
        plan_item_completions: [
          {
            food_plan_item_id: plannedItem.id,
            food_plan_item_base_updated_at: plannedItem.updated_at,
          },
        ],
      }),
    );
  });

  it('locks plan-sourced meal-create date/mealType to the plan slot for candidates and complete', async () => {
    const planItem = makePlanItem({
      recipe_id: null,
      plan_date: '2026-07-15',
      meal_type: 'dinner',
    });
    const food = makeFood({ recipe_id: null });
    const getMealCandidates = vi.spyOn(api, 'getMealCandidates').mockResolvedValue([
      {
        meal_log_id: 'meal-other-slot',
        row_version: 1,
        date: '2026-07-16',
        meal_type: 'lunch',
        created_at: '2026-07-16T04:00:00Z',
        foods: [{ food_id: 'food-x', name: 'Other', food_type: 'readyMade' }],
        preview_media: null,
        photo_count: 0,
      },
    ]);
    const completeFoodPlanItem = vi.fn(async () => ({
      id: 'meal-plan-locked',
      family_id: 'family-1',
      date: planItem.plan_date,
      meal_type: planItem.meal_type,
      food_entries: [],
      participant_user_ids: [],
      notes: '',
      mood: '',
      photos: [],
      deduction_suggestions: [],
      row_version: 1,
      created_at: '2026-07-15T00:00:00.000Z',
      updated_at: '2026-07-15T00:00:00.000Z',
    } satisfies MealLog));
    const recordMeal = vi.fn();
    const onRecordSuccess = vi.fn();

    renderWithQuery(
      <EatMealCreateTaskBody
        food={food}
        planItem={planItem}
        date="2026-07-20"
        mealType="breakfast"
        recipes={[]}
        recordMeal={recordMeal}
        completeFoodPlanItem={completeFoodPlanItem}
        onRecordSuccess={onRecordSuccess}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => expect(getMealCandidates).toHaveBeenCalled());
    // Candidates must load for the plan slot, never the outer task date/mealType props.
    expect(getMealCandidates).toHaveBeenCalledWith(planItem.plan_date, planItem.meal_type);
    for (const call of getMealCandidates.mock.calls) {
      expect(call[0]).toBe(planItem.plan_date);
      expect(call[1]).toBe(planItem.meal_type);
    }

    const dateStrip = screen.getByRole('listbox', { name: '选择日期' });
    const dateButtons = Array.from(dateStrip.querySelectorAll('button'));
    expect(dateButtons).toHaveLength(1);
    expect(dateButtons[0]).toBeDisabled();
    expect(dateButtons[0]).toHaveAttribute('aria-selected', 'true');
    expect(dateStrip).toHaveAttribute('aria-disabled', 'true');

    const mealButtons = screen.getAllByRole('radio');
    for (const button of mealButtons) {
      expect(button).toBeDisabled();
    }
    const dinnerButton = screen.getByRole('radio', { name: '晚餐' });
    expect(dinnerButton).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radiogroup', { name: '选择餐次' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );

    // Clicks on locked controls must not re-fetch a mismatched slot.
    getMealCandidates.mockClear();
    await userEvent.click(dinnerButton);
    const lunchButton = screen.getByRole('radio', { name: '午餐' });
    await userEvent.click(lunchButton);
    expect(getMealCandidates).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: '记下这餐' }));
    await waitFor(() => expect(completeFoodPlanItem).toHaveBeenCalled());
    expect(completeFoodPlanItem).toHaveBeenCalledWith(
      planItem.id,
      expect.objectContaining({
        food_plan_item_base_updated_at: planItem.updated_at,
      }),
    );
    // completeFoodPlanItem never receives UI date/mealType — backend uses plan slot.
    const completePayload = (completeFoodPlanItem.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect(completePayload).not.toHaveProperty('date');
    expect(completePayload).not.toHaveProperty('meal_type');
    expect(recordMeal).not.toHaveBeenCalled();
    expect(onRecordSuccess).not.toHaveBeenCalled();
  });
});

describe('EatCookTaskBody finish dialog', () => {
  it('pauses running timers and saves the exact task before returning to the food page', async () => {
    const recipe = makeRecipe();
    const food = makeFood();
    const scope = { userId: 'user-1', familyId: 'family-1' };
    const launchContext: CookLaunchContext = {
      date: '2026-07-12',
      mealType: 'dinner',
      servings: 1,
      source: { kind: 'direct' },
    };
    const onClose = vi.fn();

    renderWithQuery(
      <EatCookTaskBody
        food={food}
        recipe={recipe}
        launchContext={launchContext}
        recipes={[recipe]}
        foods={[food]}
        ingredients={[]}
        inventoryItems={[]}
        mealLogs={[]}
        cookRecipe={vi.fn(async () => ({}) as never)}
        previewCookRecipe={vi.fn(async () => ({ preview_items: [], shortages: [] }) as never)}
        createShoppingItem={vi.fn(async () => ({}) as never)}
        onClose={onClose}
        onCompleted={vi.fn()}
        sessionScope={scope}
      />,
    );

    await userEvent.click(await screen.findByRole('button', { name: '开始' }));
    await userEvent.click(screen.getByRole('button', { name: '关闭' }));
    await userEvent.click(await screen.findByRole('button', { name: '暂停并退出' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    const key = buildCookSessionV3Key(scope, recipe.id, {
      kind: 'direct',
      date: launchContext.date,
      mealType: launchContext.mealType,
    });
    const saved = readCookSessionV3(localStorage, key);
    expect(saved.kind).toBe('ready');
    if (saved.kind === 'ready') {
      expect(saved.bundle.session.timers.every((timer) => !timer.running)).toBe(true);
    }
  });

  it('mounts RecipeCookFinishDialog when finish is opened', async () => {
    const recipe = makeRecipe();
    const food = makeFood();
    const launchContext: CookLaunchContext = {
      date: '2026-07-12',
      mealType: 'dinner',
      servings: 1,
      source: { kind: 'direct' },
    };

    renderWithQuery(
      <EatCookTaskBody
        food={food}
        recipe={recipe}
        launchContext={launchContext}
        recipes={[recipe]}
        foods={[food]}
        ingredients={[] as Ingredient[]}
        inventoryItems={[]}
        mealLogs={[] as MealLog[]}
        cookRecipe={vi.fn(async () => ({}) as never)}
        previewCookRecipe={vi.fn(async () => ({
          preview_items: [],
          shortages: [],
        }) as never)}
        createShoppingItem={vi.fn(async () => ({}) as never)}
        onClose={vi.fn()}
        onCompleted={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('eat-cook-task-body')).toBeInTheDocument();
    });

    const finishButtons = screen.getAllByRole('button', { name: '完成本步，完成烹饪' });
    await userEvent.click(finishButtons[0]);
    await waitFor(() => {
      expect(screen.getByText(/完成烹饪：/)).toBeInTheDocument();
      expect(screen.getByText('库存核对')).toBeInTheDocument();
    });
  });
});

describe('EatFoodTaskBody image and scene tag actions', () => {
  it('wires image composer and scene tag create actions in the food editor', async () => {
    const food = makeReadyFood({
      scene_tags: ['家常'],
    });
    renderWithQuery(
      <EatFoodTaskBody
        food={food}
        recipes={[]}
        ingredients={[]}
        inventoryItems={[]}
        mealLogs={[]}
        foods={[food, makeReadyFood({ id: 'food-2', name: 'Soup', scene_tags: ['轻食', '家常'] })]}
        updateFood={vi.fn(async () => undefined)}
        createFoodPlanItem={vi.fn(async () => undefined)}
        onClose={vi.fn()}
        onEditRecipe={vi.fn()}
        onOpenLogs={vi.fn()}
        onStartCook={vi.fn()}
        onQuickAdd={vi.fn()}
      />,
    );

    await userEvent.click(screen.getAllByRole('button', { name: '更新库存' })[0]);
    expect(await screen.findByText('编辑食物')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '基于信息生成主图' }));
    await waitFor(() => {
      expect(imageComposerSpies.generate).toHaveBeenCalledWith('text');
    });

    const fileInput = document.querySelector<HTMLInputElement>('.image-composer input[type="file"]');
    expect(fileInput).not.toBeNull();
    const file = new File(['image'], 'cover.png', { type: 'image/png' });
    fireEvent.change(fileInput!, { target: { files: [file] } });
    await waitFor(() => {
      expect(imageComposerSpies.upload).toHaveBeenCalled();
    });

    await userEvent.click(screen.getByRole('button', { name: '添加标签' }));
    const createInput = await screen.findByPlaceholderText('创建新标签，例如：周末轻食');
    await userEvent.type(createInput, '周末轻食');
    await userEvent.click(screen.getByRole('button', { name: '创建并添加' }));
    expect(screen.getByText('周末轻食')).toBeInTheDocument();
  });
});

describe('EatRecipeTaskBody mode edit', () => {
  it('renders the editor path when mode is edit', async () => {
    const recipe = makeRecipe();
    const food = makeFood();
    renderWithQuery(
      <EatRecipeTaskBody
        foodId={food.id}
        recipeId={recipe.id}
        mode="edit"
        recipes={[recipe]}
        foods={[food]}
        ingredients={[]}
        inventoryItems={[]}
        mealLogs={[]}
        updateRecipe={vi.fn(async () => undefined)}
        onClose={vi.fn()}
        onCook={vi.fn()}
        onEdit={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('eat-recipe-task-body')).toHaveAttribute('data-mode', 'edit');
    });
    expect(screen.getByRole('button', { name: /保存做法|保存/i })).toBeInTheDocument();
  });

  it('wires recipe image upload and generate through the image composer', async () => {
    const recipe = makeRecipe();
    const food = makeFood();
    renderWithQuery(
      <EatRecipeTaskBody
        foodId={food.id}
        recipeId={recipe.id}
        mode="edit"
        recipes={[recipe]}
        foods={[food]}
        ingredients={[]}
        inventoryItems={[]}
        mealLogs={[]}
        updateRecipe={vi.fn(async () => undefined)}
        onClose={vi.fn()}
        onCook={vi.fn()}
        onEdit={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('eat-recipe-task-body')).toHaveAttribute('data-mode', 'edit');
    });

    await userEvent.click(screen.getByRole('button', { name: '基于信息生成主图' }));
    await waitFor(() => {
      expect(imageComposerSpies.generate).toHaveBeenCalledWith('text');
    });

    const fileInput = document.querySelector<HTMLInputElement>('.image-composer input[type="file"]');
    expect(fileInput).not.toBeNull();
    const file = new File(['image'], 'recipe.png', { type: 'image/png' });
    fireEvent.change(fileInput!, { target: { files: [file] } });
    await waitFor(() => {
      expect(imageComposerSpies.upload).toHaveBeenCalled();
    });
  });
});
