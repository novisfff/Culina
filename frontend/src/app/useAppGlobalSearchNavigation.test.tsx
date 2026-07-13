// @vitest-environment jsdom

import { act, useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FoodPlanItem } from '../api/types';
import type { GlobalSearchSelection } from '../features/search/GlobalSearchOverlay';
import type { TabKey } from './AppShell';
import {
  useAppGlobalSearchNavigation,
  type IngredientNavigationRequest,
} from './useAppGlobalSearchNavigation';
import { useAppHomeHandlers } from './useAppHomeHandlers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

type NavApi = ReturnType<typeof useAppGlobalSearchNavigation>;
type HandlerApi = ReturnType<typeof useAppHomeHandlers>;

const planItemFixture: FoodPlanItem = {
  id: 'plan-1',
  family_id: 'family-1',
  user_id: 'user-1',
  food_id: 'food-1',
  food_name: '番茄炒蛋',
  food_type: 'selfMade',
  recipe_id: null,
  recipe_title: '',
  plan_date: '2026-07-15',
  meal_type: 'dinner',
  note: '',
  status: 'planned',
  created_at: '2026-06-01T00:00:00.000Z',
  updated_at: '2026-06-01T00:00:00.000Z',
};

const mealPlanSelection: GlobalSearchSelection = {
  entityType: 'meal_plan',
  entityId: planItemFixture.id,
  item: {
    entity_type: 'meal_plan',
    entity_id: planItemFixture.id,
    score: 1,
    keyword_score: 1,
    semantic_score: 0,
    business_score: 0,
    match_reason: [],
    entity: planItemFixture,
  },
};

function NavigationHarness({
  onReady,
}: {
  onReady: (api: { nav: NavApi; handlers: HandlerApi; activeTab: TabKey }) => void;
}) {
  // Keep mock instances stable across re-renders so call history is preserved.
  const setActiveTab = useRef(vi.fn<(tab: TabKey) => void>()).current;
  const setSelectedRecipePlanDate = useRef(vi.fn<(date: string) => void>()).current;
  setActiveTabMock = setActiveTab;
  setSelectedRecipePlanDateMock = setSelectedRecipePlanDate;
  const nav = useAppGlobalSearchNavigation({
    foods: [],
    isPhoneViewport: false,
    setActiveTab: setActiveTab as never,
    setSelectedRecipePlanDate: setSelectedRecipePlanDate as never,
  });
  const handlers = useAppHomeHandlers({
    ingredientNavigationRequestIdRef: nav.ingredientNavigationRequestIdRef,
    setIngredientNavigationRequest: nav.setIngredientNavigationRequest,
    setActiveTab: setActiveTab as never,
    setHomeRestockShoppingItemId: vi.fn(),
    setHomeRestockForm: vi.fn(),
    setHomeMealDetailId: vi.fn(),
    ingredients: [],
  });

  useEffect(() => {
    onReady({
      nav,
      handlers,
      activeTab: 'home',
    });
  });

  // expose setActiveTab calls via data attribute for inspection
  return <div data-tab-calls={String(setActiveTab.mock.calls.length)} />;
}

let latest: { nav: NavApi; handlers: HandlerApi } | null = null;
let setActiveTabMock: ReturnType<typeof vi.fn> | null = null;
let setSelectedRecipePlanDateMock: ReturnType<typeof vi.fn> | null = null;

function renderNavigation() {
  act(() => {
    root?.render(
      <NavigationHarness
        onReady={(api) => {
          latest = { nav: api.nav, handlers: api.handlers };
        }}
      />,
    );
  });
  return latest;
}

beforeEach(() => {
  latest = null;
  setActiveTabMock = null;
  setSelectedRecipePlanDateMock = null;
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
  latest = null;
  setActiveTabMock = null;
  setSelectedRecipePlanDateMock = null;
});

describe('IngredientNavigationRequest contract', () => {
  it('produces a shopping navigation request for low-stock primary action', () => {
    const api = renderNavigation();
    expect(api).not.toBeNull();

    act(() => {
      api!.handlers.openIngredientShopping('ingredient-egg');
    });

    const request = latest!.nav.ingredientNavigationRequest;
    expect(request).toEqual({
      target: 'shopping',
      ingredientId: 'ingredient-egg',
      requestId: expect.any(Number),
    });
    expect(request && 'ingredientId' in request ? request.ingredientId : null).toBe('ingredient-egg');
  });

  it('produces a priority navigation request for 查看全部 without a synthetic search string', () => {
    const api = renderNavigation();
    expect(api).not.toBeNull();

    act(() => {
      api!.handlers.openIngredientPriority();
    });

    const request = latest!.nav.ingredientNavigationRequest as IngredientNavigationRequest | null;
    expect(request).toEqual({
      target: 'priority',
      requestId: expect.any(Number),
    });
    expect(request && 'ingredientId' in request).toBe(false);
    expect(JSON.stringify(request)).not.toMatch(/search|需处理|query/i);
  });

  it('makes invalid target/ingredient combinations unrepresentable and consumes each requestId once', () => {
    // Type-level: detail/shopping require ingredientId; catalog/priority forbid it.
    const catalog: IngredientNavigationRequest = { target: 'catalog', requestId: 1 };
    const detail: IngredientNavigationRequest = { target: 'detail', ingredientId: 'a', requestId: 2 };
    const shopping: IngredientNavigationRequest = { target: 'shopping', ingredientId: 'b', requestId: 3 };
    const priority: IngredientNavigationRequest = { target: 'priority', requestId: 4 };

    expect(catalog).toMatchObject({ target: 'catalog' });
    expect(detail).toMatchObject({ target: 'detail', ingredientId: 'a' });
    expect(shopping).toMatchObject({ target: 'shopping', ingredientId: 'b' });
    expect(priority).toMatchObject({ target: 'priority' });

    const api = renderNavigation();
    act(() => {
      api!.handlers.openIngredientsCatalog();
    });
    const firstId = latest!.nav.ingredientNavigationRequest?.requestId;
    expect(firstId).toEqual(expect.any(Number));

    act(() => {
      api!.handlers.openIngredientDetail('ingredient-1');
    });
    const secondId = latest!.nav.ingredientNavigationRequest?.requestId;
    expect(secondId).toEqual(expect.any(Number));
    expect(secondId).not.toBe(firstId);

    // Simulating workspace consumption: once a requestId is handled, a duplicate
    // delivery of the same request object must not re-trigger navigation.
    const consumed = new Set<number>();
    function consume(request: IngredientNavigationRequest | null) {
      if (!request || consumed.has(request.requestId)) {
        return false;
      }
      consumed.add(request.requestId);
      return true;
    }

    const current = latest!.nav.ingredientNavigationRequest;
    expect(consume(current)).toBe(true);
    expect(consume(current)).toBe(false);
  });

  it('still routes catalog and detail with the discriminated target field', () => {
    const api = renderNavigation();
    act(() => {
      api!.handlers.openIngredientsCatalog();
    });
    expect(latest!.nav.ingredientNavigationRequest).toEqual({
      target: 'catalog',
      requestId: expect.any(Number),
    });

    act(() => {
      api!.handlers.openIngredientDetail('ingredient-tomato');
    });
    expect(latest!.nav.ingredientNavigationRequest).toEqual({
      target: 'detail',
      ingredientId: 'ingredient-tomato',
      requestId: expect.any(Number),
    });
  });
});

describe('Ingredient navigation consumption contract', () => {
  it('requires a real ingredient ID for shopping and none for priority', () => {
    const shopping: IngredientNavigationRequest = {
      target: 'shopping',
      ingredientId: 'ingredient-egg',
      requestId: 11,
    };
    const priority: IngredientNavigationRequest = {
      target: 'priority',
      requestId: 12,
    };

    expect(shopping.ingredientId.length).toBeGreaterThan(0);
    expect('ingredientId' in priority).toBe(false);
  });

  it('documents once-by-requestId consumption for every discriminated target', () => {
    const requests: IngredientNavigationRequest[] = [
      { target: 'catalog', requestId: 1 },
      { target: 'detail', ingredientId: 'a', requestId: 2 },
      { target: 'shopping', ingredientId: 'b', requestId: 3 },
      { target: 'priority', requestId: 4 },
    ];
    const handled = new Set<number>();
    const consume = (request: IngredientNavigationRequest) => {
      if (handled.has(request.requestId)) {
        return false;
      }
      handled.add(request.requestId);
      return true;
    };

    for (const request of requests) {
      expect(consume(request)).toBe(true);
      expect(consume(request)).toBe(false);
    }
    expect(handled.size).toBe(4);
  });
});

describe('Food plan navigation protocol', () => {
  it('keeps global-search plan results as item targets', () => {
    const api = renderNavigation();
    act(() => api!.nav.handleGlobalSearchSelect(mealPlanSelection));
    expect(latest!.nav.foodPlanNavigationRequest).toEqual({
      target: 'item',
      itemId: mealPlanSelection.entityId,
      planDate: planItemFixture.plan_date,
      requestId: 1,
    });
  });

  it('opens the selected natural week without inventing an item id', () => {
    const api = renderNavigation();
    act(() => api!.nav.openFoodPlanWeek('2026-07-15'));
    expect(setSelectedRecipePlanDateMock).toHaveBeenCalledWith('2026-07-15');
    expect(setActiveTabMock).toHaveBeenCalledWith('foods');
    expect(latest!.nav.foodPlanNavigationRequest).toEqual({
      target: 'week',
      planDate: '2026-07-15',
      requestId: 1,
    });
  });
});
