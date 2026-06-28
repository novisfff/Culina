import { notifyManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/client';
import type { Food, FoodPlanItem, Ingredient, Recipe, SearchResponse } from '../../api/types';
import { GlobalSearchOverlay } from './GlobalSearchOverlay';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let queryClient: QueryClient | null = null;

const ingredient: Ingredient = {
  id: 'ingredient-tomato',
  family_id: 'family-1',
  name: '番茄',
  category: '蔬菜',
  default_unit: '个',
  unit_conversions: [],
  default_storage: '冷藏',
  default_expiry_mode: 'days',
  default_expiry_days: 3,
  default_low_stock_threshold: 1,
  notes: '适合炒蛋',
  image: null,
  created_at: '2026-06-01T00:00:00Z',
  updated_at: '2026-06-01T00:00:00Z',
};

const food: Food = {
  id: 'food-noodle',
  family_id: 'family-1',
  name: '番茄面',
  type: 'selfMade',
  category: '主食',
  flavor_tags: ['酸甜'],
  scene_tags: ['早餐'],
  suitable_meal_types: ['breakfast'],
  source_name: '',
  purchase_source: '',
  scene: '',
  images: [],
  notes: '',
  routine_note: '快手',
  stock_unit: '份',
  favorite: false,
  created_at: '2026-06-01T00:00:00Z',
  updated_at: '2026-06-01T00:00:00Z',
};

const recipe: Recipe = {
  id: 'recipe-egg',
  family_id: 'family-1',
  title: '番茄炒蛋',
  servings: 2,
  prep_minutes: 12,
  difficulty: 'easy',
  ingredient_items: [
    { id: 'ri-1', ingredient_name: '番茄', quantity: 1, unit: '个', note: '' },
    { id: 'ri-2', ingredient_name: '鸡蛋', quantity: 2, unit: '个', note: '' },
  ],
  steps: [],
  tips: '先炒蛋',
  scene_tags: ['家常菜'],
  images: [],
  cook_logs: [],
  created_at: '2026-06-01T00:00:00Z',
  updated_at: '2026-06-01T00:00:00Z',
};

const mealPlan: FoodPlanItem = {
  id: 'plan-dinner',
  family_id: 'family-1',
  user_id: 'user-1',
  food_id: food.id,
  food_name: '番茄面',
  food_type: 'selfMade',
  recipe_id: recipe.id,
  recipe_title: recipe.title,
  plan_date: '2026-06-29',
  meal_type: 'dinner',
  note: '晚餐安排',
  status: 'planned',
  completed_at: null,
  meal_log_id: null,
  created_at: '2026-06-01T00:00:00Z',
  updated_at: '2026-06-01T00:00:00Z',
};

function changeInput(input: HTMLInputElement, value: string) {
  act(() => {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    valueSetter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function waitForSearchRequest() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(api.search).toHaveBeenCalled();
  await act(async () => {
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
  });
}

async function waitForBodyText(text: string) {
  await vi.waitFor(() => {
    expect(document.body.textContent).toContain(text);
  });
}

async function renderOverlay(response: SearchResponse, onSelect = vi.fn()) {
  vi.spyOn(api, 'search').mockImplementation(() => response as unknown as ReturnType<typeof api.search>);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient = client;

  await act(async () => {
    root?.render(
      <QueryClientProvider client={client}>
        <GlobalSearchOverlay open onClose={vi.fn()} onSelect={onSelect} />
      </QueryClientProvider>
    );
    await vi.advanceTimersByTimeAsync(0);
  });

  return { onSelect };
}

beforeEach(() => {
  vi.useFakeTimers();
  notifyManager.setNotifyFunction((callback) => {
    act(callback);
  });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  queryClient?.clear();
  queryClient = null;
  container?.remove();
  container = null;
  document.body.innerHTML = '';
  notifyManager.setNotifyFunction((callback) => {
    callback();
  });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('GlobalSearchOverlay', () => {
  it('searches supported global scopes and renders type labels', async () => {
    await renderOverlay({
      items: [
        {
          entity_type: 'ingredient',
          entity_id: ingredient.id,
          score: 2.9,
          keyword_score: 1,
          semantic_score: 0.8,
          business_score: 0,
          match_reason: ['名称匹配'],
          entity: ingredient,
        },
        {
          entity_type: 'food',
          entity_id: food.id,
          score: 2.7,
          keyword_score: 1,
          semantic_score: 0.7,
          business_score: 0,
          match_reason: ['关键词匹配'],
          entity: food,
        },
        {
          entity_type: 'recipe',
          entity_id: recipe.id,
          score: 2.6,
          keyword_score: 1,
          semantic_score: 0.7,
          business_score: 0,
          match_reason: ['食材匹配'],
          entity: recipe,
        },
        {
          entity_type: 'meal_plan',
          entity_id: mealPlan.id,
          score: 2.5,
          keyword_score: 1,
          semantic_score: 0.6,
          business_score: 0.1,
          match_reason: ['晚餐计划'],
          entity: mealPlan,
        },
      ],
      total: 4,
      query: '番茄',
      search_mode: 'hybrid',
      degraded: true,
    });

    changeInput(document.querySelector<HTMLInputElement>('input[aria-label="搜索食材、食物、菜谱、餐食计划"]')!, '番茄');
    await waitForSearchRequest();

    expect(api.search).toHaveBeenCalledWith({
      q: '番茄',
      scopes: ['ingredient', 'food', 'recipe', 'meal_plan'],
      limit: 20,
      offset: 0,
    });
    await waitForBodyText('食材');
    expect(document.body.textContent).toContain('食物');
    expect(document.body.textContent).toContain('菜谱');
    expect(document.body.textContent).toContain('餐食计划');
    expect(document.body.textContent).toContain('晚餐安排');
    expect(document.body.textContent).toContain('检索结果可能不完整');
  });

  it('emits the selected result', async () => {
    const onSelect = vi.fn();
    await renderOverlay({
      items: [
        {
          entity_type: 'recipe',
          entity_id: recipe.id,
          score: 2.6,
          keyword_score: 1,
          semantic_score: 0.7,
          business_score: 0,
          match_reason: ['食材匹配'],
          entity: recipe,
        },
      ],
      total: 1,
      query: '番茄',
      search_mode: 'hybrid',
      degraded: false,
    }, onSelect);

    changeInput(document.querySelector<HTMLInputElement>('input[aria-label="搜索食材、食物、菜谱、餐食计划"]')!, '番茄');
    await waitForSearchRequest();

    await waitForBodyText('番茄炒蛋');
    const resultButton = Array.from(document.querySelectorAll<HTMLButtonElement>('.global-search-result'))
      .find((button) => button.textContent?.includes('番茄炒蛋'));
    expect(resultButton).toBeTruthy();
    act(() => {
      resultButton?.click();
    });

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({
      entityType: 'recipe',
      entityId: recipe.id,
    }));
  });

  it('clears visible results when the query is cleared', async () => {
    await renderOverlay({
      items: [
        {
          entity_type: 'ingredient',
          entity_id: ingredient.id,
          score: 2.9,
          keyword_score: 1,
          semantic_score: 0.8,
          business_score: 0,
          match_reason: ['名称匹配'],
          entity: ingredient,
        },
      ],
      total: 1,
      query: '番茄',
      search_mode: 'hybrid',
      degraded: false,
    });

    const input = document.querySelector<HTMLInputElement>('input[aria-label="搜索食材、食物、菜谱、餐食计划"]')!;
    changeInput(input, '番茄');
    await waitForSearchRequest();
    await waitForBodyText('番茄');

    act(() => {
      document.querySelector<HTMLButtonElement>('.global-search-clear')?.click();
    });

    expect(input.value).toBe('');
    expect(document.querySelector('.global-search-content')).toBeNull();
    expect(document.body.textContent).not.toContain('适合炒蛋');
  });
});
