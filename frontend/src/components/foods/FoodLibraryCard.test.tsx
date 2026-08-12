// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Food } from '../../api/types';
import {
  FoodLibraryCard,
  buildFoodLibraryCardViewModel,
  type FoodLibraryCardActions,
} from './FoodLibraryCard';
import { FoodWorkspace } from './FoodWorkspace';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mediaRenderState = vi.hoisted(() => ({ count: 0 }));

vi.mock('../MediaPlaceholder', () => ({
  MediaWithPlaceholder: ({ alt }: { alt: string }) => {
    mediaRenderState.count += 1;
    return <span data-media-alt={alt} />;
  },
}));

const baseFood: Food = {
  id: 'food-1',
  family_id: 'family-1',
  name: '番茄炒蛋',
  type: 'selfMade',
  category: '家常菜',
  flavor_tags: [],
  scene_tags: ['晚餐'],
  suitable_meal_types: ['dinner'],
  source_name: '',
  purchase_source: '',
  scene: '工作日晚餐',
  images: [],
  notes: '少油',
  routine_note: '常做',
  price: null,
  rating: 5,
  repurchase: null,
  expiry_date: null,
  stock_quantity: null,
  stock_unit: '',
  storage_location: '',
  favorite: false,
  recipe_id: null,
  row_version: 1,
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
};

describe('FoodLibraryCard pagination rendering', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    mediaRenderState.count = 0;
  });

  it('does not rerender an existing card when a later page is appended', () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const firstModel = buildFoodLibraryCardViewModel(baseFood, [], []);
    const secondModel = buildFoodLibraryCardViewModel(
      { ...baseFood, id: 'food-2', name: '土豆炖牛肉' },
      [],
      [],
    );
    const actionsRef = {
      current: {
        onOpenDetail: vi.fn(),
        onToggleFavorite: vi.fn(),
        onPrimaryAction: vi.fn(),
        onAddShopping: vi.fn(),
        onAddPlan: vi.fn(),
      } satisfies FoodLibraryCardActions,
    };

    act(() => {
      root?.render(
        <>
          <FoodLibraryCard
            model={firstModel}
            actionsRef={actionsRef}
            isUpdatingFavorite={false}
            isQuickAdding={false}
          />
        </>,
      );
    });
    expect(mediaRenderState.count).toBe(1);

    act(() => {
      root?.render(
        <>
          <FoodLibraryCard
            model={firstModel}
            actionsRef={actionsRef}
            isUpdatingFavorite={false}
            isQuickAdding={false}
          />
          <FoodLibraryCard
            model={secondModel}
            actionsRef={actionsRef}
            isUpdatingFavorite={false}
            isQuickAdding={false}
          />
        </>,
      );
    });

    expect(mediaRenderState.count).toBe(2);
  });

  it('appends cards directly inside one stable grid like the ingredient library', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const foods = Array.from({ length: 24 }, (_, index): Food => ({
      ...baseFood,
      id: `food-${index + 1}`,
      name: `食物 ${index + 1}`,
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root?.render(
        <QueryClientProvider client={client}>
          <FoodWorkspace
            foods={foods}
            recipes={[]}
            ingredients={[]}
            inventoryItems={[]}
            mealLogs={[]}
            members={[]}
            foodScenes={[]}
            foodPlanItems={[]}
            foodPlanWeekRange={{ start: '2026-08-10', end: '2026-08-16' }}
            isPhoneViewport={false}
            navigationRequest={null}
            foodPlanNavigationRequest={null}
            createFood={vi.fn()}
            updateFood={vi.fn()}
            updateFoodFavorite={vi.fn()}
            createRecipe={vi.fn()}
            updateRecipe={vi.fn()}
            recordMeal={vi.fn()}
            completeFoodPlanItem={vi.fn()}
            updateMealLog={vi.fn()}
            shoppingItems={[]}
            createShoppingItem={vi.fn()}
            updateShoppingItem={vi.fn()}
            createFoodPlanItem={vi.fn()}
            updateFoodPlanItem={vi.fn()}
            deleteFoodPlanItem={vi.fn()}
            createFoodScene={vi.fn()}
            updateFoodScene={vi.fn()}
            deleteFoodScene={vi.fn()}
            onStartRecipe={vi.fn()}
            onOpenLogs={vi.fn()}
            onFoodPlanPreviousWeek={vi.fn()}
            onFoodPlanCurrentWeek={vi.fn()}
            onFoodPlanNextWeek={vi.fn()}
          />
        </QueryClientProvider>,
      );
    });

    expect(container.querySelectorAll('.food-work-card')).toHaveLength(12);
    const grid = container.querySelector('.food-card-grid');
    expect(grid?.querySelector(':scope > .food-card-page')).toBeNull();
    expect(grid?.querySelectorAll(':scope > .food-work-card')).toHaveLength(12);
    expect(grid?.lastElementChild?.classList.contains('paged-list-status')).toBe(true);
    const mediaRenderCountBeforeLoad = mediaRenderState.count;

    await act(async () => {
      container?.querySelector<HTMLButtonElement>('.paged-list-load-more')?.click();
    });

    expect(container.querySelectorAll('.food-work-card')).toHaveLength(20);
    expect(grid?.querySelectorAll(':scope > .food-work-card')).toHaveLength(20);
    expect(grid?.lastElementChild?.classList.contains('paged-list-status')).toBe(true);
    expect(mediaRenderState.count - mediaRenderCountBeforeLoad).toBe(8);
  });
});
