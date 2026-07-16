// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import type { ActivityHighlightsResponse, ActivityLog, FoodPlanItem } from '../api/types';
import {
  initialNavigationState,
  type AppNavigationState,
} from './appNavigationModel';
import { useAppWorkspaceQueries } from './useAppWorkspaceQueries';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type WorkspaceQueries = ReturnType<typeof useAppWorkspaceQueries>;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let latest: WorkspaceQueries | null = null;

function navigationForPrimary(
  primaryTab: AppNavigationState['primaryTab'],
): AppNavigationState {
  return {
    ...initialNavigationState,
    primaryTab,
  };
}

function WorkspaceQueriesHarness(props: {
  navigationState: AppNavigationState;
  onState: (state: WorkspaceQueries) => void;
}) {
  const state = useAppWorkspaceQueries({
    navigationState: props.navigationState,
    isAuthenticated: true,
    foodPlanWeekRange: { start: '2026-07-06', end: '2026-07-12' },
  });
  useEffect(() => props.onState(state));
  return null;
}

function renderWorkspaceQueries(navigationState: AppNavigationState) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <WorkspaceQueriesHarness
          navigationState={navigationState}
          onState={(state) => { latest = state; }}
        />
      </QueryClientProvider>
    );
  });
  return {
    client,
    current: () => {
      if (!latest) throw new Error('workspace query harness not ready');
      return latest;
    },
    unmount() {
      act(() => root?.unmount());
      root = null;
      container?.remove();
      container = null;
      latest = null;
    },
  };
}

async function flushQueries() {
  await act(async () => {
    await Promise.resolve();
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  });
  await act(async () => {
    await Promise.resolve();
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  });
}

function stubHomeBootQueries() {
  vi.spyOn(api, 'getFamily').mockResolvedValue({
    id: 'family-1',
    name: 'Culina',
    motto: '',
    location: '',
    food_preferences: [],
    food_avoidances: [],
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ai_recommendations: [],
  });
  vi.spyOn(api, 'getMembers').mockResolvedValue([]);
  vi.spyOn(api, 'getIngredients').mockResolvedValue([]);
  vi.spyOn(api, 'getInventory').mockResolvedValue([]);
  vi.spyOn(api, 'listInventoryStates').mockResolvedValue([]);
  vi.spyOn(api, 'getShoppingList').mockResolvedValue([]);
  vi.spyOn(api, 'getRecipes').mockResolvedValue([]);
  vi.spyOn(api, 'getFoodPlan').mockResolvedValue([]);
  vi.spyOn(api, 'getFoods').mockResolvedValue([]);
  vi.spyOn(api, 'getFoodRecommendations').mockResolvedValue({
    target_meal_type: 'dinner',
    target_date: '2026-07-12',
    items: [],
  });
  vi.spyOn(api, 'getMealLogs').mockResolvedValue([]);
  vi.spyOn(api, 'getActiveMealRecordOperations').mockResolvedValue([]);
  vi.spyOn(api, 'getMealInsights').mockResolvedValue([]);
  vi.spyOn(api, 'getActivityLogs').mockResolvedValue([]);
}

describe('useAppWorkspaceQueries', () => {
  beforeEach(() => {
    latest = null;
    stubHomeBootQueries();
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    container?.remove();
    container = null;
    latest = null;
    vi.restoreAllMocks();
  });

  it('enables five highlights on home without adding them to boot loading', async () => {
    const highlights = vi
      .spyOn(api, 'getActivityHighlights')
      .mockImplementation(() => new Promise<ActivityHighlightsResponse>(() => undefined));
    const harness = renderWorkspaceQueries(navigationForPrimary('home'));
    await flushQueries();
    expect(highlights).toHaveBeenCalledWith(5);
    expect(harness.current().activityHighlightsQuery.isLoading).toBe(true);
    expect(harness.current().isBootLoading).toBe(false);
  });

  it('does not request highlights outside home', async () => {
    const highlights = vi.spyOn(api, 'getActivityHighlights').mockResolvedValue({
      items: [],
      week_highlight_count: 0,
    });
    renderWorkspaceQueries(navigationForPrimary('family'));
    await flushQueries();
    expect(highlights).not.toHaveBeenCalled();
  });

  it('requests highlights but never full activity logs on home', async () => {
    const highlights = vi.spyOn(api, 'getActivityHighlights').mockResolvedValue({
      items: [],
      week_highlight_count: 0,
    });
    const logs = vi.spyOn(api, 'getActivityLogs').mockResolvedValue([]);
    renderWorkspaceQueries(navigationForPrimary('home'));
    await flushQueries();
    expect(highlights).toHaveBeenCalledWith(5);
    expect(logs).not.toHaveBeenCalled();
  });

  it('requests full activity logs without a preview limit on family', async () => {
    const highlights = vi.spyOn(api, 'getActivityHighlights').mockResolvedValue({
      items: [],
      week_highlight_count: 0,
    });
    const logs = vi.spyOn(api, 'getActivityLogs').mockResolvedValue([]);
    renderWorkspaceQueries(navigationForPrimary('family'));
    await flushQueries();
    expect(logs).toHaveBeenCalledWith();
    expect(highlights).not.toHaveBeenCalled();
  });

  it('keeps both activity queries out of boot loading', async () => {
    vi.spyOn(api, 'getActivityHighlights').mockImplementation(
      () => new Promise<ActivityHighlightsResponse>(() => undefined)
    );
    const home = renderWorkspaceQueries(navigationForPrimary('home'));
    await flushQueries();
    expect(home.current().isBootLoading).toBe(false);
    home.unmount();
    vi.spyOn(api, 'getActivityLogs').mockImplementation(
      () => new Promise<ActivityLog[]>(() => undefined)
    );
    const family = renderWorkspaceQueries(navigationForPrimary('family'));
    await flushQueries();
    expect(family.current().isBootLoading).toBe(false);
  });

  it('loads food plan detail for plan-detail without treating it as boot loading', async () => {
    const detail = vi
      .spyOn(api, 'getFoodPlanItem')
      .mockImplementation(() => new Promise<FoodPlanItem>(() => undefined));
    const harness = renderWorkspaceQueries({
      primaryTab: 'eat',
      eat: {
        baseView: 'plan',
        discoverSection: 'all',
        task: {
          kind: 'plan-detail',
          foodPlanItemId: 'plan-1',
          returnTo: 'plan',
        },
      },
    });
    await flushQueries();
    expect(detail).toHaveBeenCalledWith('plan-1');
    expect(harness.current().foodPlanDetailQuery.isLoading).toBe(true);
    expect(harness.current().isBootLoading).toBe(false);
  });

  it('does not request food plan detail outside plan-detail / plan meal-create', async () => {
    const detail = vi.spyOn(api, 'getFoodPlanItem').mockResolvedValue({
      id: 'plan-1',
    } as FoodPlanItem);
    renderWorkspaceQueries({
      primaryTab: 'eat',
      eat: {
        baseView: 'plan',
        discoverSection: 'all',
        task: null,
      },
    });
    await flushQueries();
    expect(detail).not.toHaveBeenCalled();
  });

  it.each([
    ['home', navigationForPrimary('home')],
    [
      'eat food discover',
      {
        primaryTab: 'eat' as const,
        eat: { baseView: 'discover' as const, discoverSection: 'all' as const, task: null },
      },
    ],
    [
      'eat history',
      {
        primaryTab: 'eat' as const,
        eat: { baseView: 'history' as const, discoverSection: 'all' as const, task: null },
      },
    ],
    ['ingredients', navigationForPrimary('ingredients')],
  ])('enables active meal record operations on %s', async (_label, navigationState) => {
    const operations = vi.spyOn(api, 'getActiveMealRecordOperations').mockResolvedValue([]);
    renderWorkspaceQueries(navigationState);
    await flushQueries();
    expect(operations).toHaveBeenCalledWith(true);
  });

  it.each([
    ['ai', navigationForPrimary('ai')],
    ['family', navigationForPrimary('family')],
  ])('disables active meal record operations on %s', async (_label, navigationState) => {
    const operations = vi.spyOn(api, 'getActiveMealRecordOperations').mockResolvedValue([]);
    renderWorkspaceQueries(navigationState);
    await flushQueries();
    expect(operations).not.toHaveBeenCalled();
  });

  it('requests meal insights only on eat history', async () => {
    const insights = vi.spyOn(api, 'getMealInsights').mockResolvedValue([]);
    renderWorkspaceQueries({
      primaryTab: 'eat',
      eat: { baseView: 'history', discoverSection: 'all', task: null },
    });
    await flushQueries();
    expect(insights).toHaveBeenCalledTimes(1);
  });

  it('does not request meal insights on eat discover', async () => {
    const insights = vi.spyOn(api, 'getMealInsights').mockResolvedValue([]);
    renderWorkspaceQueries({
      primaryTab: 'eat',
      eat: { baseView: 'discover', discoverSection: 'all', task: null },
    });
    await flushQueries();
    expect(insights).not.toHaveBeenCalled();
  });

  it('does not request meal insights on home', async () => {
    const insights = vi.spyOn(api, 'getMealInsights').mockResolvedValue([]);
    renderWorkspaceQueries(navigationForPrimary('home'));
    await flushQueries();
    expect(insights).not.toHaveBeenCalled();
  });

  it('excludes meal insights loading from isBootLoading', async () => {
    vi.spyOn(api, 'getMealInsights').mockImplementation(
      () => new Promise(() => undefined) as Promise<never>,
    );
    const harness = renderWorkspaceQueries({
      primaryTab: 'eat',
      eat: { baseView: 'history', discoverSection: 'all', task: null },
    });
    await flushQueries();
    expect(harness.current().mealInsightsQuery.isLoading).toBe(true);
    expect(harness.current().isBootLoading).toBe(false);
  });
});
