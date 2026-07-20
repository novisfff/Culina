// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { createElement, useState } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  Food,
  Ingredient,
  InventoryItem,
  MealLog,
  MediaAsset,
  RecordMealPayload,
  RecordMealResponse,
  Recipe,
  ShoppingListItem,
} from '../../api/types';
import type { FoodPlanNavigationRequest } from '../../app/useAppGlobalSearchNavigation';
import type { MealRecordResult } from '../../features/meals/useMealRecordResultState';
import { todayKey } from '../../lib/ui';
import {
  FoodWorkspace,
  FOOD_CREATE_TYPE_OPTIONS,
  buildFoodPayloadFromForm,
  buildTodayFoodRecommendations,
  filterFoodWorkspaceItems,
  getMobileDefaultFoodSceneCardMedia,
  getMobileFoodSceneFilterState,
  resolveFoodNavigationRequestAction,
  getSuggestedMealTypeForHour,
  type FoodFormState,
} from './FoodWorkspace';
import {
  buildFoodCookingSummaryFromRecipeCards,
  buildFoodRelationViewModel,
  chunkFoodCardPages,
  formatFoodStockQuantity,
  getFoodGovernanceIssueLabels,
  getFoodGovernanceIssues,
  getSecondaryFoodActionLabel,
} from './FoodWorkspaceHelpers';
import {
  buildDirectCookTarget,
  buildPlanCookLaunchContext,
  foodToForm,
  getFoodFormCompletionItems,
  makeBlankFoodForm,
} from './FoodWorkspaceModel';
import { buildRecipeCards } from '../recipes/workspaceModel';

/** Owner matrix for Food/Ingredient meal write paths (Task 15). */
const foodIngredientOwners = {
  foodCardAgain: 'recordMeal',
  takeoutAgain: 'recordMeal',
  diningOutAgain: 'recordMeal',
  foodWorkspacePlanComplete: 'completeFoodPlanItem',
  ingredientFoodRecord: 'recordMeal',
  ingredientInventoryChange: 'inventoryCommand',
} as const;

const recipe: Recipe = {
  id: 'recipe-1',
  family_id: 'family-1',
  title: '番茄炒蛋',
  servings: 2,
  prep_minutes: 12,
  difficulty: 'easy',
  ingredient_items: [],
  steps: [],
  tips: '少油',
  scene_tags: ['晚餐'],
  images: [],
  cook_logs: [],
  created_at: '2026-05-01T10:00:00Z',
  updated_at: '2026-05-01T10:00:00Z',
};

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

const baseFood: Food = {
  id: 'food-1',
  family_id: 'family-1',
  name: '冷冻牛肉饭',
  type: 'instant',
  category: '速食',
  flavor_tags: ['省心'],
  scene_tags: ['加班'],
  suitable_meal_types: ['lunch', 'dinner'],
  source_name: '便利店',
  purchase_source: '楼下便利店',
  scene: '加班',
  images: [],
  notes: '微波炉加热',
  routine_note: '没菜时备用',
  price: 18.9,
  rating: 4,
  repurchase: true,
  expiry_date: '2026-06-01',
  stock_quantity: 2,
  stock_unit: '盒',
  storage_location: '冷冻',
  favorite: true,
  recipe_id: null,
  row_version: 1,
  created_at: '2026-05-01T10:00:00Z',
  updated_at: '2026-05-01T10:00:00Z',
};

const sceneCoverAsset: MediaAsset = {
  id: 'media-scene-cover',
  name: '场景封面',
  url: '/media/scene-cover.jpg',
  source: 'ai',
  alt: '场景封面',
  variants: {
    card: {
      url: '/media/scene-cover-card.jpg',
      width: 640,
      height: 420,
      content_type: 'image/jpeg',
      byte_size: 1200,
    },
  },
  created_at: '2026-05-01T10:00:00Z',
};

const tomato: Ingredient = {
  id: 'ingredient-tomato',
  family_id: 'family-1',
  name: '番茄',
  category: '蔬菜',
  default_unit: '个',
  unit_conversions: [],
  default_storage: '冷藏',
  default_expiry_mode: 'days',
  default_expiry_days: 5,
  default_low_stock_threshold: 1,
  notes: '',
  image: null,
  created_at: '2026-05-01T10:00:00Z',
  updated_at: '2026-05-01T10:00:00Z',
};

const egg: Ingredient = {
  ...tomato,
  id: 'ingredient-egg',
  name: '鸡蛋',
  category: '蛋奶',
  default_unit: '个',
};

const tomatoInventory: InventoryItem = {
  id: 'inventory-tomato',
  family_id: 'family-1',
  ingredient_id: tomato.id,
  ingredient_name: tomato.name,
  quantity: 2,
  remaining_quantity: 2,
  unit: '个',
  status: 'fresh',
  purchase_date: todayKey(),
  expiry_date: todayKey(),
  storage_location: '冷藏',
  notes: '',
  low_stock_threshold: 1,
  created_at: '2026-05-01T10:00:00Z',
  updated_at: '2026-05-01T10:00:00Z',
  row_version: 1,
};

const form: FoodFormState = {
  name: ' 冷冻牛肉饭 ',
  type: 'instant',
  category: '',
  sceneTags: '省心、微辣',
  suitableMealTypes: ['lunch', 'dinner'],
  sourceName: ' 便利店 ',
  purchaseSource: '',
  scene: ' 加班 ',
  notes: ' 微波炉 ',
  routineNote: ' 没菜时备用 ',
  price: '18.9',
  rating: '4',
  repurchase: 'yes',
  expiryDate: '2026-06-01',
  stockQuantity: '2',
  stockUnit: '盒',
  storageLocation: '冷冻',
  favorite: true,
  recipeId: '',
  images: {},
};

function dateOffset(days: number) {
  const [year, month, day] = todayKey().split('-').map(Number);
  const date = new Date(year, month - 1, day + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function makeMealLog(food: Food, date: string, mealType: MealLog['meal_type'] = 'dinner'): MealLog {
  return {
    id: `meal-${food.id}-${date}`,
    family_id: 'family-1',
    date,
    meal_type: mealType,
    food_entries: [{ id: `entry-${food.id}`, food_id: food.id, food_name: food.name, servings: 1, note: '' }],
    participant_user_ids: [],
    notes: '',
    mood: '',
    photos: [],
    deduction_suggestions: [],
    row_version: 1,
    created_at: `${date}T10:00:00Z`,
    updated_at: `${date}T10:00:00Z`,
  };
}

function attachRoot() {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  return container;
}

function makeRecordResponse(food: Food, date = todayKey()): RecordMealResponse {
  const mealLog = makeMealLog(food, date);
  return {
    meal_log: mealLog,
    created_foods: [],
    outcome: 'created',
    operation: {
      id: 'op-food-1',
      status: 'applied',
      revertible_until: `${date}T12:15:00.000Z`,
      can_revert: true,
    },
  };
}

function makeRecordResult(response: RecordMealResponse): MealRecordResult {
  return {
    source: 'immediate',
    operationId: response.operation.id,
    mealLogId: response.meal_log.id,
    foods: response.meal_log.food_entries.map((entry) => ({
      food_id: entry.food_id,
      name: entry.food_name,
      cover: {
        id: `cover-${entry.food_id}`,
        name: entry.food_name,
        url: `/media/${entry.food_id}.jpg`,
        source: 'upload',
        alt: entry.food_name,
        created_at: '2026-07-15T12:00:00.000Z',
      },
    })),
    previewMedia: null,
    revertibleUntil: response.operation.revertible_until,
    canRevert: response.operation.can_revert,
    mealLog: response.meal_log,
    rowVersion: response.meal_log.row_version,
    canRate: true,
  };
}

function renderWorkspace(options: {
  food?: Food;
  isPhoneViewport?: boolean;
  foodPlanNavigationRequest?: FoodPlanNavigationRequest | null;
  foodPlanWeekRange?: { start: string; end: string };
  navigationRequest?: {
    foodId: string;
    requestId: number;
    target?: 'detail' | 'edit' | 'quickMeal';
    quickMealAction?: 'eat' | 'cook';
  } | null;
  recordMeal?: (payload: RecordMealPayload) => Promise<RecordMealResponse>;
  loadMealCandidates?: ReturnType<typeof vi.fn>;
  completeFoodPlanItem?: ReturnType<typeof vi.fn>;
  onRecordSuccess?: (response: RecordMealResponse) => void;
  recordResult?: MealRecordResult | null;
  shoppingItems?: ShoppingListItem[];
  createShoppingItem?: ReturnType<typeof vi.fn>;
  updateShoppingItem?: ReturnType<typeof vi.fn>;
  recipes?: Recipe[];
  ingredients?: Ingredient[];
  inventoryItems?: InventoryItem[];
} = {}) {
  const view = attachRoot();
  const food = options.food ?? baseFood;
  const recordMeal =
    options.recordMeal ?? vi.fn(async () => makeRecordResponse(food));
  const loadMealCandidates = options.loadMealCandidates ?? vi.fn(async () => []);
  const completeFoodPlanItem = options.completeFoodPlanItem ?? vi.fn();
  const onRecordSuccess = options.onRecordSuccess ?? vi.fn();
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  act(() => {
    root?.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(FoodWorkspace, {
          foods: [food],
          recipes: options.recipes ?? [],
          ingredients: options.ingredients ?? [],
          inventoryItems: options.inventoryItems ?? [],
          mealLogs: [],
          members: [],
          foodScenes: [],
          foodPlanItems: [],
          foodPlanWeekRange: options.foodPlanWeekRange ?? { start: todayKey(), end: todayKey() },
          isPhoneViewport: options.isPhoneViewport ?? false,
          navigationRequest:
            options.navigationRequest === undefined
              ? { foodId: food.id, requestId: 1, target: 'quickMeal', quickMealAction: 'eat' }
              : options.navigationRequest,
          foodPlanNavigationRequest: options.foodPlanNavigationRequest ?? null,
          createFood: vi.fn(),
          updateFood: vi.fn(),
          updateFoodFavorite: vi.fn(),
          createRecipe: vi.fn(),
          updateRecipe: vi.fn(),
          recordMeal,
          loadMealCandidates,
          completeFoodPlanItem,
          onRecordSuccess,
          recordResult: options.recordResult ?? null,
          updateMealLog: vi.fn(),
          shoppingItems: options.shoppingItems ?? [],
          createShoppingItem: options.createShoppingItem ?? vi.fn(),
          updateShoppingItem: options.updateShoppingItem ?? vi.fn(),
          createFoodPlanItem: vi.fn(),
          updateFoodPlanItem: vi.fn(),
          deleteFoodPlanItem: vi.fn(),
          createFoodScene: vi.fn(),
          updateFoodScene: vi.fn(),
          deleteFoodScene: vi.fn(),
          onStartRecipe: vi.fn(),
          onOpenLogs: vi.fn(),
          onFoodPlanPreviousWeek: vi.fn(),
          onFoodPlanCurrentWeek: vi.fn(),
          onFoodPlanNextWeek: vi.fn(),
        }),
      ),
    );
  });

  return { client, food, recordMeal, loadMealCandidates, completeFoodPlanItem, onRecordSuccess, view };
}

describe('FoodWorkspace editor composition', () => {
  it('uses the shared modal footer to submit the food editor form', () => {
    const selfMadeFood: Food = {
      ...baseFood,
      id: 'food-self-made-editor',
      name: recipe.title,
      type: 'selfMade',
      recipe_id: recipe.id,
    };
    const { view } = renderWorkspace({
      food: selfMadeFood,
      recipes: [recipe],
      navigationRequest: { foodId: selfMadeFood.id, requestId: 11, target: 'edit' },
    });

    const form = view.querySelector<HTMLFormElement>('#food-editor-form');
    const submit = Array.from(view.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('保存菜谱和资料'));

    expect(form).not.toBeNull();
    expect(submit?.getAttribute('form')).toBe('food-editor-form');
    expect(submit?.closest('.workspace-overlay-footer')).not.toBeNull();
    expect(form?.querySelector('.workspace-rail-actions')).toBeNull();
  });
});

describe('FoodWorkspace meal recording ownership', () => {
  it('owns Food and Ingredient record paths via the Task 15 matrix', () => {
    expect(foodIngredientOwners.foodCardAgain).toBe('recordMeal');
    expect(foodIngredientOwners.takeoutAgain).toBe('recordMeal');
    expect(foodIngredientOwners.diningOutAgain).toBe('recordMeal');
    expect(foodIngredientOwners.foodWorkspacePlanComplete).toBe('completeFoodPlanItem');
    expect(foodIngredientOwners.ingredientFoodRecord).toBe('recordMeal');
    expect(foodIngredientOwners.ingredientInventoryChange).toBe('inventoryCommand');
  });

  it('drops stock and plan fields from Food record surfaces', () => {
    const dialogSource = readFileSync('src/components/foods/FoodQuickMealDialog.tsx', 'utf8');
    expect(dialogSource).not.toContain('同步扣减库存');
    expect(dialogSource).not.toContain('deductStock');
    expect(dialogSource).not.toContain('stockQuantity');

    const workspaceSource = readFileSync('src/components/foods/FoodWorkspace.tsx', 'utf8');
    const dialogPath = 'src/components/foods/FoodQuickMealDialog.tsx';
    void dialogPath;
    expect(workspaceSource).not.toContain('deduct' + '_food_stock');
    expect(workspaceSource).not.toContain('quick' + 'AddMeal');
    expect(workspaceSource).not.toMatch(/food_plan_item_id/);
    expect(workspaceSource).toContain('recordMeal');
    expect(workspaceSource).toContain('completeFoodPlanItem');
    expect(workspaceSource).toContain('MealQuickRecordView');
    expect(workspaceSource).toContain('MealRecordResultBar');
  });

  it('opens compact prefilled Food record without stock controls', async () => {
    const { view, loadMealCandidates } = renderWorkspace();
    expect(view.textContent).toContain('快速记录');
    expect(view.textContent).toContain(baseFood.name);
    const form = view.querySelector('#meal-quick-record-form');
    expect(form).not.toBeNull();
    expect(form?.textContent).not.toMatch(/同步扣减库存|扣减数量/);
    // Compact composer is prefilled — no food re-search inside the form.
    expect(form?.querySelector('input[type="search"]')).toBeNull();
    expect(form?.querySelector('[role="combobox"]')).toBeNull();
    await act(async () => {
      await Promise.resolve();
    });
    expect(loadMealCandidates).toHaveBeenCalled();
  });

  it('records from Food card and shows shared result bar on the Food surface', async () => {
    const response = makeRecordResponse(baseFood);
    const recordMeal = vi.fn(async () => response);
    const loadMealCandidates = vi.fn(async () => []);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    function StatefulFoodWorkspace() {
      const [recordResult, setRecordResult] = useState<MealRecordResult | null>(null);
      return createElement(FoodWorkspace, {
        foods: [baseFood],
        recipes: [],
        ingredients: [],
        inventoryItems: [],
        mealLogs: [],
        members: [],
        foodScenes: [],
        foodPlanItems: [],
        foodPlanWeekRange: { start: todayKey(), end: todayKey() },
        isPhoneViewport: false,
        navigationRequest: {
          foodId: baseFood.id,
          requestId: 1,
          target: 'quickMeal',
          quickMealAction: 'eat',
        },
        foodPlanNavigationRequest: null,
        createFood: vi.fn(),
        updateFood: vi.fn(),
        updateFoodFavorite: vi.fn(),
        createRecipe: vi.fn(),
        updateRecipe: vi.fn(),
        recordMeal,
        loadMealCandidates,
        completeFoodPlanItem: vi.fn(),
        onRecordSuccess: (next) => setRecordResult(makeRecordResult(next)),
        recordResult,
        updateMealLog: vi.fn(),
        shoppingItems: [],
        createShoppingItem: vi.fn(),
        updateShoppingItem: vi.fn(),
        createFoodPlanItem: vi.fn(),
        updateFoodPlanItem: vi.fn(),
        deleteFoodPlanItem: vi.fn(),
        createFoodScene: vi.fn(),
        updateFoodScene: vi.fn(),
        deleteFoodScene: vi.fn(),
        onStartRecipe: vi.fn(),
        onOpenLogs: vi.fn(),
        onFoodPlanPreviousWeek: vi.fn(),
        onFoodPlanCurrentWeek: vi.fn(),
        onFoodPlanNextWeek: vi.fn(),
      });
    }

    const view = attachRoot();
    await act(async () => {
      root?.render(
        createElement(QueryClientProvider, { client }, createElement(StatefulFoodWorkspace)),
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    const form = view.querySelector('#meal-quick-record-form') as HTMLFormElement | null;
    expect(form).not.toBeNull();
    await act(async () => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(recordMeal).toHaveBeenCalledTimes(1);
    expect(recordMeal).toHaveBeenCalledWith(
      expect.objectContaining({
        meal_type: expect.any(String),
        entries: [expect.objectContaining({ food_id: baseFood.id, servings: 1 })],
        target: { kind: 'new' },
      }),
    );
    const firstCallArgs = (recordMeal.mock.calls as unknown as Array<[RecordMealPayload]>)[0];
    const payload = firstCallArgs?.[0];
    expect(payload).toBeDefined();
    expect(payload).not.toHaveProperty('deduct_food_stock');
    expect(payload).not.toHaveProperty('stock_quantity');
    expect(payload).not.toHaveProperty('stock_unit');
    expect(payload).not.toHaveProperty('food_plan_item_id');

    const bar = view.querySelector('[aria-label="记录结果"]');
    expect(bar).not.toBeNull();
    expect(bar?.textContent).toContain('已记下');
    expect(bar?.textContent).toContain('撤销');
    expect(bar?.textContent).toContain('查看记录');
    expect(bar?.textContent).toContain(baseFood.name);
  });

  it('keeps record errors on the compact composer without stock fields', async () => {
    const recordMeal = vi.fn(async () => {
      throw new Error('记录服务暂时不可用');
    });
    const { view } = renderWorkspace({ recordMeal });
    await act(async () => {
      await Promise.resolve();
    });
    const form = view.querySelector('#meal-quick-record-form') as HTMLFormElement | null;
    expect(form).not.toBeNull();
    await act(async () => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(recordMeal).toHaveBeenCalledTimes(1);
    expect(view.textContent).toContain('记录服务暂时不可用');
    expect(view.querySelector('#meal-quick-record-form')).not.toBeNull();
  });
});

describe('food workspace helpers', () => {
  it('uses 编辑档案 for the edit-information action across every food type', () => {
    const foodTypes: Food['type'][] = ['selfMade', 'takeout', 'diningOut', 'readyMade', 'instant'];

    foodTypes.forEach((type) => {
      expect(getSecondaryFoodActionLabel({ ...baseFood, type })).toBe('编辑档案');
    });
  });

  it('chunks tablet food cards into two-item swipe columns', () => {
    const items = Array.from({ length: 7 }, (_, index) => index + 1);

    expect(chunkFoodCardPages(items)).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
      [7],
    ]);
  });

  it('formats food stock display with at most one decimal place', () => {
    expect(formatFoodStockQuantity({ stock_quantity: 13.991, stock_unit: '盒' })).toBe('13.9盒');
    expect(formatFoodStockQuantity({ stock_quantity: 13.94, stock_unit: '盒' })).toBe('13.9盒');
    expect(formatFoodStockQuantity({ stock_quantity: null, stock_unit: '盒' })).toBe('未记录');
  });

  it('builds practical food payload fields for non-recipe foods', () => {
    expect(buildFoodPayloadFromForm(form, [recipe], ['media-1'])).toMatchObject({
      name: '冷冻牛肉饭',
      type: 'instant',
      category: '速食',
      flavor_tags: [],
      scene_tags: ['省心', '微辣'],
      suitable_meal_types: ['lunch', 'dinner'],
      source_name: '便利店',
      purchase_source: '便利店',
      price: 18.9,
      rating: 4,
      repurchase: true,
      stock_quantity: 2,
      storage_location: '冷冻',
      media_ids: ['media-1'],
    });
  });

  it('round-trips ready-like food storage location through food forms', () => {
    expect(makeBlankFoodForm('instant').storageLocation).toBe('常温');
    expect(makeBlankFoodForm('takeout').storageLocation).toBe('');
    expect(foodToForm(baseFood).storageLocation).toBe('冷冻');
    expect(getFoodFormCompletionItems(form, null).some((item) => item.label === '存放位置' && item.done)).toBe(true);
  });

  it('offers home-cooked food as a guided create type', () => {
    expect(FOOD_CREATE_TYPE_OPTIONS.map((item) => item.value)).toEqual(['selfMade', 'takeout', 'diningOut', 'readyMade', 'instant']);
    expect(FOOD_CREATE_TYPE_OPTIONS[0].label).toBe('自做');
  });

  it('filters by normalized type, meal type, and text fields', () => {
    const packaged: Food = { ...baseFood, id: 'food-2', name: '无糖酸奶', type: 'packaged', suitable_meal_types: ['breakfast'] };
    expect(filterFoodWorkspaceItems([baseFood, packaged], '', 'readyMade', 'all')).toEqual([packaged]);
    expect(filterFoodWorkspaceItems([baseFood, packaged], '便利店', 'all', 'dinner')).toEqual([baseFood]);
  });

  it('keeps semantic food matches that do not match local text', () => {
    expect(filterFoodWorkspaceItems([baseFood], '西红柿', 'all', 'all')).toEqual([]);
    expect(filterFoodWorkspaceItems([baseFood], '西红柿', 'all', 'all', 'all', [], [baseFood.id])).toEqual([baseFood]);
  });

  it('keeps all matching foods for mobile paged loading', () => {
    const manyFoods = Array.from({ length: 9 }, (_, index): Food => ({
      ...baseFood,
      id: `food-mobile-${index + 1}`,
      name: `移动食物 ${index + 1}`,
      updated_at: `2026-05-01T10:0${index % 10}:00Z`,
    }));

    expect(filterFoodWorkspaceItems(manyFoods, '', 'all', 'all')).toHaveLength(9);
  });

  it('uses one scene-filter contract for mobile scene cards', () => {
    expect(getMobileFoodSceneFilterState('高蛋白')).toEqual({
      search: '',
      lensFilter: 'all',
      typeFilter: 'all',
      mealFilter: 'all',
      sceneFilter: '高蛋白',
      governanceIssueFilter: 'all',
    });

    expect(getMobileFoodSceneFilterState('工作日晚餐')).toMatchObject({
      search: '',
      lensFilter: 'all',
      mealFilter: 'all',
      sceneFilter: '工作日晚餐',
    });
  });

  it('keeps cross-workspace edit and quick-meal requests pending until the food exists', () => {
    expect(resolveFoodNavigationRequestAction({
      foods: [],
      navigationRequest: { foodId: baseFood.id, requestId: 4, target: 'edit' },
      handledRequestId: null,
    })).toEqual({ kind: 'pending' });

    expect(resolveFoodNavigationRequestAction({
      foods: [baseFood],
      navigationRequest: { foodId: baseFood.id, requestId: 4, target: 'edit' },
      handledRequestId: null,
    })).toMatchObject({ kind: 'edit', food: baseFood, requestId: 4 });

    expect(resolveFoodNavigationRequestAction({
      foods: [baseFood],
      navigationRequest: { foodId: baseFood.id, requestId: 5, target: 'quickMeal', quickMealAction: 'cook' },
      handledRequestId: null,
    })).toMatchObject({ kind: 'quickMeal', food: baseFood, requestId: 5, quickMealAction: 'cook' });

    expect(resolveFoodNavigationRequestAction({
      foods: [baseFood],
      navigationRequest: { foodId: baseFood.id, requestId: 5, target: 'quickMeal', quickMealAction: 'cook' },
      handledRequestId: 5,
    })).toEqual({ kind: 'idle' });
  });

  it('builds direct Cook targets without a plan mutation payload', () => {
    expect(
      buildDirectCookTarget({
        foodId: 'food-1',
        recipeId: 'recipe-1',
        date: '2026-07-15',
        mealType: 'lunch',
        servings: 2.5,
      }),
    ).toEqual({
      workspace: 'eat',
      view: 'cook',
      foodId: 'food-1',
      recipeId: 'recipe-1',
      launchContext: {
        date: '2026-07-15',
        mealType: 'lunch',
        servings: 2.5,
        source: { kind: 'direct' },
      },
    });

    const workspaceSource = readFileSync('src/components/foods/FoodWorkspace.tsx', 'utf8');
    expect(workspaceSource).toContain('buildDirectCookTarget');
    expect(workspaceSource).toContain('// Direct Cook: never create a plan item just to start cooking.');
    // Direct cook no longer creates a FoodPlanItem just to start cooking.
    expect(workspaceSource).not.toMatch(
      /action === 'cook'[\s\S]{0,200}createFoodPlanItem/,
    );
  });

  it('builds plan Cook launch context from the loaded detail timestamp', () => {
    expect(
      buildPlanCookLaunchContext(
        {
          id: 'plan-1',
          plan_date: '2026-07-15',
          meal_type: 'dinner',
          updated_at: '2026-07-12T10:00:00Z',
        },
        { servings: 4 },
      ),
    ).toEqual({
      date: '2026-07-15',
      mealType: 'dinner',
      servings: 4,
      source: {
        kind: 'plan',
        foodPlanItemId: 'plan-1',
        planItemBaseUpdatedAt: '2026-07-12T10:00:00Z',
      },
    });
  });

  it('keeps generated scene media on default mobile scene cards', () => {
    const sceneFood: Food = { ...baseFood, id: 'food-protein', scene_tags: ['高蛋白'] };
    const media = getMobileDefaultFoodSceneCardMedia(
      '高蛋白',
      [sceneFood],
      [{ name: '高蛋白', count: 1, imageUrl: sceneCoverAsset.url, imageAsset: sceneCoverAsset }],
      0
    );

    expect(media.count).toBe(1);
    expect(media.imageFood?.id).toBe(sceneFood.id);
    expect(media.imageUrl).toBe(sceneCoverAsset.url);
    expect(media.imageAsset?.id).toBe(sceneCoverAsset.id);
  });

  it('filters operational food lenses', () => {
    const image = { id: 'media-1', name: '食物图', url: '/food.jpg', source: 'upload' as const, alt: '食物图', created_at: '2026-05-01T10:00:00Z', created_by: null };
    const completeFood: Food = { ...baseFood, images: [image], expiry_date: dateOffset(14) };
    const missingInfo: Food = { ...completeFood, id: 'food-2', name: '待补资料', images: [], suitable_meal_types: [], routine_note: '', notes: '', scene: '', scene_tags: [], source_name: '', purchase_source: '' };
    const expiring: Food = { ...completeFood, id: 'food-3', name: '即期酸奶', type: 'readyMade', expiry_date: todayKey() };
    expect(filterFoodWorkspaceItems([completeFood, missingInfo, expiring], '', 'all', 'all', 'needsInfo')).toEqual([missingInfo]);
    expect(filterFoodWorkspaceItems([completeFood, missingInfo, expiring], '', 'all', 'all', 'expiring')).toEqual([expiring]);
  });

  it('classifies governance issues for batch maintenance', () => {
    const image = { id: 'media-1', name: '食物图', url: '/food.jpg', source: 'upload' as const, alt: '食物图', created_at: '2026-05-01T10:00:00Z', created_by: null };
    const missingAll: Food = {
      ...baseFood,
      images: [],
      suitable_meal_types: [],
      source_name: '',
      purchase_source: '',
      routine_note: '',
      notes: '',
      scene: '',
      scene_tags: [],
      stock_quantity: null,
      stock_unit: '',
      expiry_date: null,
    };
    const completeFood: Food = { ...baseFood, images: [image] };

    expect(getFoodGovernanceIssues(missingAll)).toEqual(['image', 'meal', 'note', 'source', 'stock']);
    expect(getFoodGovernanceIssueLabels(missingAll)).toEqual([
      '缺库存/到期',
      '缺餐别',
      '缺来源',
      '缺图片',
      '缺备注',
    ]);
    expect(getFoodGovernanceIssues(completeFood)).toEqual([]);
  });

  it('treats missing ready-made stock or expiry as incomplete', () => {
    const image = { id: 'media-1', name: '食物图', url: '/food.jpg', source: 'upload' as const, alt: '食物图', created_at: '2026-05-01T10:00:00Z', created_by: null };
    const missingStock: Food = { ...baseFood, id: 'food-stock', images: [image], stock_quantity: null, stock_unit: '', expiry_date: null };

    expect(getFoodGovernanceIssues(missingStock)).toEqual(['stock']);
    expect(filterFoodWorkspaceItems([missingStock], '', 'all', 'all', 'needsInfo')).toEqual([missingStock]);
  });

  it('uses linked recipe images when checking self-made food completeness', () => {
    const image = { id: 'media-recipe', name: '菜谱图', url: '/recipe.jpg', source: 'upload' as const, alt: '菜谱图', created_at: '2026-05-01T10:00:00Z', created_by: null };
    const linkedRecipe: Recipe = { ...recipe, images: [image] };
    const selfMadeFood: Food = {
      ...baseFood,
      id: 'food-self-made',
      name: '番茄炒蛋',
      type: 'selfMade',
      category: '家常菜',
      images: [],
      suitable_meal_types: ['lunch', 'dinner'],
      scene: '工作日',
      notes: '',
      routine_note: '少油',
      recipe_id: linkedRecipe.id,
    };

    expect(getFoodGovernanceIssues(selfMadeFood, [linkedRecipe])).toEqual([]);
    expect(filterFoodWorkspaceItems([selfMadeFood], '', 'all', 'all', 'needsInfo', [linkedRecipe])).toEqual([]);
  });

  it('suggests a meal type from the current hour', () => {
    expect(getSuggestedMealTypeForHour(8)).toBe('breakfast');
    expect(getSuggestedMealTypeForHour(12)).toBe('lunch');
    expect(getSuggestedMealTypeForHour(18)).toBe('dinner');
    expect(getSuggestedMealTypeForHour(23)).toBe('snack');
  });

  it('downranks foods that were eaten very recently', () => {
    const yesterdayDinner: Food = { ...baseFood, id: 'food-recent', name: '昨天刚吃的盖饭', favorite: false, rating: null, repurchase: null, expiry_date: null };
    const freshDinner: Food = { ...baseFood, id: 'food-fresh', name: '今天换个炒饭', favorite: false, rating: null, repurchase: null, expiry_date: null };

    const recommendations = buildTodayFoodRecommendations([yesterdayDinner, freshDinner], [makeMealLog(yesterdayDinner, dateOffset(-1))], {
      mealType: 'dinner',
      today: todayKey(),
    });

    expect(recommendations[0].food.name).toBe('今天换个炒饭');
    expect(recommendations.find((item) => item.food.id === 'food-recent')?.reasons).toContain('最近吃过已降权');
  });

  it('keeps expiring foods high priority even when they were eaten recently', () => {
    const expiringFood: Food = { ...baseFood, id: 'food-expiring', name: '今天到期酸奶', type: 'readyMade', expiry_date: todayKey(), favorite: false, rating: null, repurchase: null };
    const highRatedFood: Food = { ...baseFood, id: 'food-rated', name: '高分便当', expiry_date: null, favorite: true, rating: 5, repurchase: true };

    const recommendations = buildTodayFoodRecommendations([highRatedFood, expiringFood], [makeMealLog(expiringFood, todayKey())], {
      mealType: 'dinner',
      today: todayKey(),
    });

    expect(recommendations[0].food.name).toBe('今天到期酸奶');
    expect(recommendations[0].reasons).toContain('今天需处理');
  });

  it('builds home-cooked recipe relation with availability and shortages', () => {
    const linkedRecipe: Recipe = {
      ...recipe,
      id: 'recipe-linked',
      title: '家常番茄炒蛋',
      ingredient_items: [
        { id: 'recipe-ingredient-tomato', ingredient_id: tomato.id, ingredient_name: tomato.name, quantity: 1, unit: '个', note: '' },
        { id: 'recipe-ingredient-egg', ingredient_id: egg.id, ingredient_name: egg.name, quantity: 2, unit: '个', note: '' },
      ],
    };
    const food: Food = { ...baseFood, id: 'food-home', name: '家常番茄炒蛋', type: 'selfMade', recipe_id: linkedRecipe.id, stock_quantity: null, stock_unit: '' };

    const relation = buildFoodRelationViewModel(food, [linkedRecipe], [tomato, egg], [tomatoInventory], [], [food]);

    expect(relation.linkedRecipeCard?.availabilityLabel).toBe('缺 1 项');
    expect(relation.relationFacts).toContainEqual({ label: '可做程度', value: '缺 1 项' });
    expect(relation.shortagePreview).toEqual(['鸡蛋 2个']);
  });

  it('summarizes home-cooked food cooking state for mobile food cards', () => {
    const linkedRecipe: Recipe = {
      ...recipe,
      id: 'recipe-mobile-linked',
      title: '家常番茄炒蛋',
      ingredient_items: [
        { id: 'recipe-ingredient-tomato', ingredient_id: tomato.id, ingredient_name: tomato.name, quantity: 1, unit: '个', note: '' },
        { id: 'recipe-ingredient-egg', ingredient_id: egg.id, ingredient_name: egg.name, quantity: 2, unit: '个', note: '' },
      ],
      steps: [
        { id: 'step-1', title: '炒蛋', text: '先炒鸡蛋', icon: 'pan', summary: '鸡蛋炒散', estimated_minutes: 3, tip: '', key_points: [] },
        { id: 'step-2', title: '合炒', text: '番茄和鸡蛋合炒', icon: 'pan', summary: '合炒入味', estimated_minutes: 5, tip: '', key_points: [] },
      ],
    };
    const food: Food = { ...baseFood, id: 'food-mobile-home', name: '家常番茄炒蛋', type: 'selfMade', recipe_id: linkedRecipe.id, stock_quantity: null, stock_unit: '' };
    const cards = buildRecipeCards([linkedRecipe], [tomato, egg], [tomatoInventory], [], [food]);

    expect(buildFoodCookingSummaryFromRecipeCards(food, cards)).toMatchObject({
      title: '家常番茄炒蛋',
      availabilityLabel: '缺 1 项',
      metaLabel: '2原料 · 2步',
      shortagePreview: ['鸡蛋 2个'],
      isReady: false,
    });
    expect(buildFoodCookingSummaryFromRecipeCards(baseFood, cards)).toBeNull();
  });

  it('builds meal record relation with count and latest meal', () => {
    const food: Food = { ...baseFood, id: 'food-records', name: '常点牛肉饭' };
    const oldLog = makeMealLog(food, dateOffset(-5), 'lunch');
    const latestLog = makeMealLog(food, dateOffset(-1), 'dinner');

    const relation = buildFoodRelationViewModel(food, [], [], [], [oldLog, latestLog], [food]);

    expect(relation.usage.count).toBe(2);
    expect(relation.lastMealLog?.id).toBe(latestLog.id);
    expect(relation.relationFacts).toContainEqual({ label: '最近一次', value: expect.any(String) });
  });

  it('builds ready-made relation from food stock fields', () => {
    const readyFood: Food = { ...baseFood, id: 'food-ready-stock', type: 'readyMade', name: '冷藏意面', stock_quantity: 3, stock_unit: '盒', expiry_date: todayKey(), purchase_source: '盒马' };

    const relation = buildFoodRelationViewModel(readyFood, [], [tomato], [], [], [readyFood]);

    expect(relation.relationFacts).toContainEqual({ label: '库存剩余', value: '3盒' });
    expect(relation.relationFacts).toContainEqual({ label: '到期', value: '今天到期' });
    expect(relation.detail).toContain('盒马');
  });

  it('builds outside food relation from rating, repurchase and recent meals', () => {
    const outsideFood: Food = { ...baseFood, id: 'food-outside', type: 'takeout', name: '咖喱外卖', rating: 4.5, repurchase: true, source_name: '楼下咖喱' };
    const mealLog = makeMealLog(outsideFood, dateOffset(-2), 'dinner');

    const relation = buildFoodRelationViewModel(outsideFood, [], [], [], [mealLog], [outsideFood]);

    expect(relation.relationFacts).toContainEqual({ label: '餐食记录', value: '1 次' });
    expect(relation.relationFacts).toContainEqual({ label: '复购评分', value: '4.5 分 · 愿意复购' });
    expect(relation.detail).toContain('楼下咖喱');
  });
});

describe('FoodWorkspace shopping-origin restock cutover', () => {
  it('moves ready-food inventory confirmation from the card into the detail header', () => {
    const food: Food = {
      ...baseFood,
      id: 'food-ready-confirmation',
      name: '盒装牛奶',
      type: 'readyMade',
      recipe_id: null,
      stock_quantity: 1,
      stock_unit: '盒',
      storage_location: '常温',
      expiry_date: dateOffset(14),
      inventory_last_confirmed_at: null,
    };
    const { view } = renderWorkspace({ food, navigationRequest: null });
    const card = view.querySelector<HTMLElement>('.food-work-card');

    expect(card?.textContent).not.toContain('从未确认');

    act(() => card?.click());

    const confirmation = view.querySelector('.food-detail-inventory-confirmation');
    expect(confirmation?.textContent).toContain('从未确认');
    expect(confirmation?.closest('.food-detail-status-row')).not.toBeNull();
  });

  it('opens desktop food details from the card without a detail button', () => {
    const { view, food } = renderWorkspace({ navigationRequest: null });
    const card = view.querySelector<HTMLElement>('.food-work-card');

    act(() => card?.click());

    expect(view.querySelector('.food-detail-drawer')).not.toBeNull();
    expect(view.querySelector(`.food-work-card button[aria-label="查看详情：${food.name}"]`)).toBeNull();
  });

  it('opens mobile food details from the card without a detail button', () => {
    const { view, food } = renderWorkspace({ isPhoneViewport: true, navigationRequest: null });
    const card = view.querySelector<HTMLElement>('.mobile-food-library-card');

    act(() => card?.click());

    expect(view.querySelector('.food-detail-drawer')).not.toBeNull();
    expect(view.querySelector(`.mobile-food-library-card button[aria-label="查看详情：${food.name}"]`)).toBeNull();
  });

  it('renders the mobile favorite control as an image overlay instead of a footer action', () => {
    const { view, food } = renderWorkspace({ isPhoneViewport: true, navigationRequest: null });
    const card = view.querySelector('.mobile-food-library-card');
    const favorite = card?.querySelector(`[aria-label="取消收藏：${food.name}"]`);

    expect(card).not.toBeNull();
    expect(favorite).not.toBeNull();
    expect(card?.querySelector('.mobile-food-library-media > .food-favorite-chip')).toBe(favorite);
    expect(card?.querySelector('.mobile-food-card-actions .food-favorite-chip')).toBeNull();
  });

  it('describes an inactive mobile favorite control as a collect action', () => {
    const food = { ...baseFood, favorite: false };
    const { view } = renderWorkspace({ food, isPhoneViewport: true, navigationRequest: null });

    expect(view.querySelector(`[aria-label="收藏：${food.name}"]`)).not.toBeNull();
  });

  it('opens a confirmation dialog before creating a desktop food shopping item', async () => {
    const createShoppingItem = vi.fn();
    const { view, food } = renderWorkspace({ navigationRequest: null, createShoppingItem });
    const trigger = view.querySelector<HTMLButtonElement>(`[aria-label="加入采购：${food.name}"]`);

    await act(async () => trigger?.click());

    expect(trigger).not.toBeNull();
    expect(view.textContent).toContain('确认采购');
    expect(createShoppingItem).not.toHaveBeenCalled();
  });

  it('exposes the food shopping confirmation entry on mobile cards', () => {
    const { view, food } = renderWorkspace({ isPhoneViewport: true, navigationRequest: null });

    expect(view.querySelector(`.mobile-food-library-card [aria-label="加入采购：${food.name}"]`)).not.toBeNull();
  });

  it('exposes the recipe ingredient shopping entry on mobile self-made food cards', () => {
    const selfMadeFood: Food = { ...baseFood, id: 'food-mobile-self-made', type: 'selfMade', recipe_id: recipe.id };
    const { view } = renderWorkspace({ food: selfMadeFood, isPhoneViewport: true, navigationRequest: null });

    expect(view.querySelector(`.mobile-food-library-card [aria-label="加入采购：${selfMadeFood.name}"]`)).not.toBeNull();
  });

  it('opens editable recipe ingredient drafts from a self-made food shopping action', async () => {
    const selfMadeFood: Food = { ...baseFood, id: 'food-self-made', type: 'selfMade', recipe_id: recipe.id };
    const recipeWithIngredient: Recipe = {
      ...recipe,
      ingredient_items: [
        {
          id: 'recipe-ingredient-tomato',
          ingredient_id: tomato.id,
          ingredient_name: tomato.name,
          quantity: 2,
          unit: '个',
          note: '',
        },
      ],
    };
    const createShoppingItem = vi.fn();
    const { view } = renderWorkspace({
      food: selfMadeFood,
      navigationRequest: null,
      recipes: [recipeWithIngredient],
      ingredients: [tomato],
      createShoppingItem,
    });
    const trigger = view.querySelector<HTMLButtonElement>(`[aria-label="加入采购：${selfMadeFood.name}"]`);

    await act(async () => trigger?.click());

    expect(trigger).not.toBeNull();
    expect(view.querySelector('.recipe-shopping-modal')).not.toBeNull();
    expect(view.querySelector('.recipe-shopping-draft-row')?.textContent).toContain('番茄');
    expect(view.querySelector<HTMLInputElement>('.recipe-shopping-draft-row input[value="2"]')).not.toBeNull();
    expect(createShoppingItem).not.toHaveBeenCalled();
  });

  it('does not chain restockFoodStock with updateShoppingItem', () => {
    const source = readFileSync('src/components/foods/FoodWorkspace.tsx', 'utf8');
    const ingredientWorkspace = readFileSync('src/components/ingredients/IngredientWorkspace.tsx', 'utf8');
    expect(source).not.toMatch(/await api\.restockFoodStock[\s\S]{0,400}await props\.updateShoppingItem/);
    expect(ingredientWorkspace).not.toMatch(/await api\.restockFoodStock[\s\S]{0,400}await props\.updateShoppingItem/);
    expect(ingredientWorkspace).toContain('openShoppingIntake');
  });
});

describe('FoodWorkspace discovery composition', () => {
  it('renders the dedicated Pad landscape support surface', () => {
    const { view } = renderWorkspace({ navigationRequest: null });
    const tabletSurface = view.querySelector('.food-tablet-support-surface');

    expect(tabletSurface).not.toBeNull();
    expect(tabletSurface?.querySelectorAll('.food-tablet-management-metric')).toHaveLength(4);
    expect(tabletSurface?.querySelector('.food-tablet-plan-section')).not.toBeNull();
    expect(tabletSurface?.querySelector('.food-tablet-scene-scroller')).not.toBeNull();
    expect(tabletSurface?.textContent).not.toContain('摘要与下一步');
    expect(tabletSurface?.textContent).not.toContain('横向滑动查看更多');
  });

  it('limits the new support layout to Pad landscape and keeps scene cards swipeable', () => {
    const styles = readFileSync('src/styles/06-food-workspace.css', 'utf8');
    const tabletBlock = styles.match(
      /@media \(min-width: 901px\) and \(max-width: 1180px\) and \(orientation: landscape\) \{([\s\S]*?)\n\}/,
    )?.[1] ?? '';

    expect(tabletBlock).toContain('.food-task-sidebar');
    expect(tabletBlock).toContain('display: none');
    expect(tabletBlock).toContain('.food-tablet-support-surface');
    expect(tabletBlock).toContain('display: grid');
    expect(tabletBlock).toContain('.food-tablet-scene-scroller');
    expect(tabletBlock).toContain('overflow-x: auto');
    expect(tabletBlock).toContain('scroll-snap-type: x mandatory');
  });

  it('keeps FoodWorkspace focused on the unified discovery surface', () => {
    const source = readFileSync('src/components/foods/FoodWorkspace.tsx', 'utf8');
    expect(source).toContain('<FoodDiscoverSurface');
    expect(source).toContain('<FoodPlanSurface');
    expect(source).not.toContain("surface?: 'discover' | 'plan'");
    expect(source).not.toContain("props.surface === 'plan'");
  });
});

describe('FoodWorkspace week navigation presentation', () => {
  it('focuses the existing desktop week section for a week request', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    if (!HTMLElement.prototype.scrollIntoView) {
      HTMLElement.prototype.scrollIntoView = vi.fn();
    }
    const { view } = renderWorkspace({
      isPhoneViewport: false,
      navigationRequest: null,
      foodPlanWeekRange: { start: '2026-07-13', end: '2026-07-19' },
      foodPlanNavigationRequest: {
        target: 'week', planDate: '2026-07-15', requestId: 2,
      },
    });
    const week = view.querySelector('[data-testid="food-plan-week-section"]');
    expect(document.activeElement).toBe(week);
    expect(view.querySelector('[role="dialog"][aria-label*="菜单详情"]')).toBeNull();
  });

  it('opens and closes the lightweight mobile week page', () => {
    const { view } = renderWorkspace({
      isPhoneViewport: true,
      navigationRequest: null,
      foodPlanWeekRange: { start: '2026-07-13', end: '2026-07-19' },
      foodPlanNavigationRequest: {
        target: 'week', planDate: '2026-07-15', requestId: 3,
      },
    });
    expect(view.querySelector('main[aria-label="手机周菜单"]')).not.toBeNull();
    expect(view.querySelector('[role="dialog"][aria-label*="菜单详情"]')).toBeNull();
    const back = view.querySelector<HTMLButtonElement>('button[aria-label="返回食物页"]');
    if (!back) throw new Error('mobile week back button missing');
    act(() => back.click());
    expect(view.querySelector('main[aria-label="手机周菜单"]')).toBeNull();
  });
});
