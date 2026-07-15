// @vitest-environment jsdom

import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Food, FoodPlanItem, MealLog } from '../../api/types';
import type { FoodPlanNavigationRequest } from '../../app/useAppGlobalSearchNavigation';
import { useFoodPlanState } from './useFoodPlanState';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

type PlanState = ReturnType<typeof useFoodPlanState>;

const planFood: Food = {
  id: 'food-1',
  family_id: 'family-1',
  name: '番茄炒蛋',
  type: 'selfMade',
  category: '家常',
  flavor_tags: [],
  scene_tags: [],
  suitable_meal_types: ['dinner'],
  source_name: '',
  purchase_source: '',
  scene: '',
  images: [],
  notes: '',
  routine_note: '',
  price: null,
  rating: null,
  repurchase: null,
  expiry_date: null,
  stock_quantity: null,
  stock_unit: '',
  storage_location: '',
  favorite: false,
  recipe_id: null,
  row_version: 1,
  created_at: '2026-06-01T00:00:00.000Z',
  updated_at: '2026-06-01T00:00:00.000Z',
};

const planItem: FoodPlanItem = {
  id: 'plan-1',
  family_id: 'family-1',
  user_id: 'user-1',
  food_id: planFood.id,
  food_name: planFood.name,
  food_type: planFood.type,
  recipe_id: null,
  recipe_title: '',
  plan_date: '2026-07-15',
  meal_type: 'dinner',
  note: '',
  status: 'planned',
  created_at: '2026-06-01T00:00:00.000Z',
  updated_at: '2026-06-01T00:00:00.000Z',
};

type PlanStateInput = Parameters<typeof useFoodPlanState>[0];

function buildPlanStateInput(overrides: Partial<PlanStateInput> = {}): PlanStateInput {
  return {
    foods: [planFood],
    foodPlanItems: [planItem],
    foodPlanWeekRange: { start: '2026-07-13', end: '2026-07-19' },
    navigationRequest: null,
    onNavigateToWeek: vi.fn(),
    showNotice: vi.fn(),
    setFeedback: vi.fn(),
    getDefaultMealType: vi.fn(() => 'dinner' as const),
    createFoodPlanItem: vi.fn(async () => planItem),
    updateFoodPlanItem: vi.fn(async () => planItem),
    deleteFoodPlanItem: vi.fn(async () => undefined),
    quickAddMeal: vi.fn(async () => ({
      id: 'meal-1',
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
    })),
    onStartRecipe: vi.fn(),
    ...overrides,
  };
}

function Harness({
  input,
  onState,
}: {
  input: PlanStateInput;
  onState: (state: PlanState) => void;
}) {
  const state = useFoodPlanState(input);
  useEffect(() => {
    onState(state);
  });
  return (
    <div>
      <span data-testid="detail">{state.activePlanDetailItem?.id ?? ''}</span>
    </div>
  );
}

let latestPlanState: PlanState | null = null;

function renderPlanState(overrides: Partial<PlanStateInput> = {}) {
  const input = buildPlanStateInput(overrides);
  act(() => {
    root?.render(
      <Harness
        input={input}
        onState={(state) => {
          latestPlanState = state;
        }}
      />,
    );
  });
  return latestPlanState;
}

beforeEach(() => {
  latestPlanState = null;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  latestPlanState = null;
});

describe('useFoodPlanState navigation', () => {
  it('handles week navigation without opening plan detail', () => {
    const onNavigateToWeek = vi.fn();
    let state = renderPlanState({
      navigationRequest: { target: 'week', planDate: '2026-07-15', requestId: 9 },
      onNavigateToWeek,
    });
    expect(onNavigateToWeek).toHaveBeenCalledWith('2026-07-15');
    state = latestPlanState!;
    expect(state.activePlanDetailItem).toBeNull();
  });

  it('still opens the exact item for target item navigation', () => {
    const onNavigateToWeek = vi.fn();
    let state = renderPlanState({
      navigationRequest: {
        target: 'item',
        itemId: planItem.id,
        planDate: '2026-07-15',
        requestId: 3,
      },
      onNavigateToWeek,
    });
    state = latestPlanState!;
    expect(state.activePlanDetailItem?.id).toBe(planItem.id);
    expect(onNavigateToWeek).not.toHaveBeenCalled();
  });

  it('handles the same requestId once and accepts a later week request', () => {
    const onNavigateToWeek = vi.fn();
    const firstRequest: FoodPlanNavigationRequest = {
      target: 'week',
      planDate: '2026-07-15',
      requestId: 4,
    };
    renderPlanState({
      navigationRequest: firstRequest,
      onNavigateToWeek,
    });
    expect(onNavigateToWeek).toHaveBeenCalledTimes(1);

    renderPlanState({
      navigationRequest: firstRequest,
      onNavigateToWeek,
    });
    expect(onNavigateToWeek).toHaveBeenCalledTimes(1);

    renderPlanState({
      navigationRequest: {
        target: 'week',
        planDate: '2026-07-16',
        requestId: 5,
      },
      onNavigateToWeek,
    });
    expect(onNavigateToWeek).toHaveBeenCalledTimes(2);
    expect(onNavigateToWeek).toHaveBeenLastCalledWith('2026-07-16');
  });
});

describe('useFoodPlanState completion', () => {
  it('hands the created meal to the enrichment flow after recording the plan item', async () => {
    const createdMeal: MealLog = {
      id: 'meal-created',
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
    };
    const quickAddMeal = vi.fn(async () => createdMeal);
    const onMealRecorded = vi.fn();
    const state = renderPlanState({
      quickAddMeal,
      ...({ onMealRecorded } as unknown as Partial<PlanStateInput>),
    })!;

    await act(async () => {
      await state.completePlanItem(planItem);
    });

    expect(onMealRecorded).toHaveBeenCalledWith(createdMeal, planItem);
  });
});
