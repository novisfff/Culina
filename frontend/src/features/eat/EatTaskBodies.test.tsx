// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Food,
  FoodPlanItem,
  Ingredient,
  MealLog,
  Recipe,
} from '../../api/types';
import type { CookLaunchContext } from '../../app/appNavigationModel';
import {
  EatCookTaskBody,
  EatFoodTaskBody,
  EatMealCreateTaskBody,
  EatRecipeTaskBody,
  buildEatTaskBodies,
} from './EatTaskBodies';

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
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
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
  imageComposerSpies.upload.mockClear();
  imageComposerSpies.generate.mockClear();
  imageComposerSpies.reset.mockClear();
});

describe('buildEatTaskBodies plan complete', () => {
  it('includes food_plan_item_id when completing a plan item', async () => {
    const quickAddMeal = vi.fn(async () => undefined);
    const planItem = makePlanItem({ recipe_id: null });
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
      quickAddMeal,
      onClose: vi.fn(),
      onOpenLogs: vi.fn(),
      onNavigateRecipe: vi.fn(),
      onStartCook: vi.fn(),
      onStartCookWithFood: vi.fn(),
      onQuickAdd: vi.fn(),
      onCookCompleted: vi.fn(),
    });

    render(<>{bodies.planTaskContent}</>);
    await userEvent.click(screen.getByRole('button', { name: '记到今天' }));
    await waitFor(() => {
      expect(quickAddMeal).toHaveBeenCalled();
    });
    expect(quickAddMeal).toHaveBeenCalledWith(
      expect.objectContaining({
        food_id: planItem.food_id,
        food_plan_item_id: planItem.id,
      }),
    );
  });
});

describe('EatMealCreateTaskBody', () => {
  it('includes food_plan_item_id for plan-sourced meal create', async () => {
    const onSubmit = vi.fn(async () => undefined);
    const planItem = makePlanItem();
    const food = makeFood();
    render(
      <EatMealCreateTaskBody
        food={food}
        planItem={planItem}
        recipes={[makeRecipe()]}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: '记录这一餐' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        food_id: food.id,
        food_plan_item_id: planItem.id,
      }),
    );
  });

  it('includes stock deduction fields when deductStock is enabled', async () => {
    const onSubmit = vi.fn(async () => undefined);
    const food = makeReadyFood();
    render(
      <EatMealCreateTaskBody
        food={food}
        planItem={null}
        recipes={[]}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    expect(screen.getByRole('checkbox', { name: /同步扣减库存/i })).toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: '记录这一餐' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        food_id: food.id,
        deduct_food_stock: true,
        stock_quantity: 1,
        stock_unit: '份',
        expected_food_row_version: food.row_version,
      }),
    );
  });
});

describe('EatCookTaskBody finish dialog', () => {
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
