// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Food, MealLog, MealLogRecordOperationSummary, RecordMealResponse } from '../../api/types';
import type {
  ExpiryInventoryActionGroup,
  LowStockInventoryActionGroup,
} from '../inventory/inventoryActionModel';
import type { MealRecordResult } from '../meals/useMealRecordResultState';
import { HomeDashboard, type HomeDashboardProps } from './HomeDashboard';
import type { DashboardPlanDay, DashboardRecommendation, HomeHighlightsViewModel } from './homeDashboardModel';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Owner matrix for Home meal write paths (Task 14). */
const homeOwners = {
  historyPrimaryCta: 'recordMeal',
  homeRecommendation: 'recordMeal',
  homePlanComplete: 'completeFoodPlanItem',
} as const;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function batch(
  overrides: Partial<ExpiryInventoryActionGroup['batches'][number]> &
    Pick<ExpiryInventoryActionGroup['batches'][number], 'inventoryItemId' | 'daysLeft' | 'expiryDate'>,
): ExpiryInventoryActionGroup['batches'][number] {
  const inventoryItemId = overrides.inventoryItemId;
  const rowVersion = overrides.rowVersion ?? 1;
  return {
    inventoryItemId,
    rowVersion,
    remainingQuantity: overrides.remainingQuantity ?? 1,
    unit: overrides.unit ?? '个',
    storageLocation: overrides.storageLocation ?? '冷藏',
    purchaseDate: overrides.purchaseDate ?? '2026-07-01',
    expiryDate: overrides.expiryDate,
    daysLeft: overrides.daysLeft,
    expiryAlertSnoozedUntil: overrides.expiryAlertSnoozedUntil ?? null,
    expiryReviewedAt: overrides.expiryReviewedAt ?? null,
    expiryReviewedBy: overrides.expiryReviewedBy ?? null,
    target: overrides.target ?? {
      targetKind: 'inventory_item',
      inventoryItemId,
      expectedRowVersion: rowVersion,
    },
  };
}

const tomato: ExpiryInventoryActionGroup = {
  kind: 'expiry',
  id: 'expiry:ingredient-tomato',
  ingredientId: 'ingredient-tomato',
  ingredientName: '番茄',
  severity: 'expired',
  batches: [
    batch({ inventoryItemId: 'tomato-a', daysLeft: -2, expiryDate: '2026-07-09', remainingQuantity: 2, unit: '盒' }),
    batch({ inventoryItemId: 'tomato-b', daysLeft: 2, expiryDate: '2026-07-13', remainingQuantity: 1, unit: '盒' }),
  ],
  expiredBatchCount: 1,
  todayBatchCount: 0,
  soonBatchCount: 1,
  laterBatchCount: 0,
  totalBatchCount: 2,
  quantityLabels: ['3 盒'],
  storageLocations: ['冷藏'],
  earliestExpiryDate: '2026-07-09',
  earliestDaysLeft: -2,
  title: '番茄需要处理',
  detail: '1 批已过期，1 批 3 天内到期',
  primaryAction: 'manage_expiry',
  targetKind: 'inventory_item',
};

const milk: ExpiryInventoryActionGroup = {
  kind: 'expiry',
  id: 'expiry:ingredient-milk',
  ingredientId: 'ingredient-milk',
  ingredientName: '牛奶',
  severity: 'expires_today',
  batches: [batch({ inventoryItemId: 'milk-a', daysLeft: 0, expiryDate: '2026-07-11', remainingQuantity: 2, unit: '盒' })],
  expiredBatchCount: 0,
  todayBatchCount: 1,
  soonBatchCount: 0,
  laterBatchCount: 0,
  totalBatchCount: 1,
  quantityLabels: ['2 盒'],
  storageLocations: ['冷藏'],
  earliestExpiryDate: '2026-07-11',
  earliestDaysLeft: 0,
  title: '牛奶今天到期',
  detail: '2 盒 · 冷藏',
  primaryAction: 'manage_expiry',
  targetKind: 'inventory_item',
};

const eggs: LowStockInventoryActionGroup = {
  kind: 'low_stock',
  id: 'low_stock:ingredient-egg',
  ingredientId: 'ingredient-egg',
  ingredientName: '鸡蛋',
  availableQuantity: 2,
  unit: '个',
  threshold: 6,
  title: '鸡蛋库存不足',
  detail: '现有 2 个，补货线 6 个',
  primaryAction: 'add_shopping',
};

const fourth: ExpiryInventoryActionGroup = {
  ...milk,
  id: 'expiry:ingredient-tofu',
  ingredientId: 'ingredient-tofu',
  ingredientName: '豆腐',
  title: '豆腐需要处理',
};

function makeFood(index: number): Food {
  return {
    id: `food-${index}`,
    family_id: 'family-1',
    name: `推荐菜 ${index}`,
    type: 'selfMade',
    category: '家常菜',
    flavor_tags: [],
    suitable_meal_types: ['dinner'],
    source_name: '',
    purchase_source: '',
    scene: '',
    images: [],
    notes: '',
    routine_note: '适合今天',
    stock_unit: '份',
    storage_location: '冷藏',
    favorite: false,
    row_version: 1,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
  };
}

function makeRecommendation(index: number): HomeDashboardProps['desktopRecommendations'][number] {
  const food = makeFood(index);
  const recommendation: DashboardRecommendation = {
    recommendation: {
      food,
      score: 0.9 - index * 0.05,
      reasons: [`理由 ${index}`],
      primary_action: 'quick_add_meal',
    },
    coverUrl: undefined,
  };
  return recommendation;
}

function makePlanDay(index: number): HomeDashboardProps['compactPlanDays'][number] {
  const date = `2026-07-${String(6 + index).padStart(2, '0')}`;
  const day: DashboardPlanDay = {
    date,
    weekday: ['一', '二', '三', '四', '五', '六', '日'][index] ?? '一',
    dayLabel: `${6 + index}日`,
    mealItems: [
      { mealType: 'breakfast', items: [] },
      { mealType: 'lunch', items: [] },
      { mealType: 'dinner', items: [] },
      { mealType: 'snack', items: [] },
    ],
    plannedMealCount: 0,
    totalCount: index,
    isToday: index === 0,
    isSelected: index === 0,
  };
  return day;
}

function makeHighlight(index: number): HomeDashboardProps['homeHighlights']['items'][number] {
  const kinds = ['shopping', 'inventory', 'meal_plan', 'meal', 'family'] as const;
  return {
    id: `highlight-${index}`,
    kind: kinds[index % kinds.length],
    summary: `高亮摘要 ${index}`,
    actor_id: `actor-${index}`,
    actor_name: `成员 ${index}`,
    created_at: `2026-07-${String(6 + index).padStart(2, '0')}T10:00:00.000Z`,
  };
}

function emptyHighlights(overrides: Partial<HomeHighlightsViewModel> = {}): HomeHighlightsViewModel {
  return {
    items: [],
    phase: 'empty',
    hasRefreshError: false,
    isRefreshing: false,
    weekCountLabel: '本周协作 0 次',
    ...overrides,
  };
}

function buttonByText(view: ParentNode, label: string) {
  const button = Array.from(view.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!button) throw new Error(`button not found: ${label}`);
  return button as HTMLButtonElement;
}

function buildProps(overrides: Partial<HomeDashboardProps> = {}): HomeDashboardProps {
  return {
    sidebarFamilyName: '测试家庭',
    sidebarMotto: '好好吃饭',
    sidebarLocation: '上海',
    sidebarMemberLabel: '3 人',
    sidebarActivityLabel: '本周 2 次',
    inventoryAlerts: [],
    dashboardStats: [
      { label: '在库食材', value: '4', unit: '种', detail: '库存充足', icon: 'leaf', tone: 'green' },
      { label: '需处理食材', value: '3', unit: '种', detail: '过期、临期或待补货', icon: 'bell', tone: 'coral' },
      { label: '待采购', value: '0', unit: '项', detail: '清单已完成', icon: 'cart', tone: 'yellow' },
      { label: '本周做菜', value: '0', unit: '餐', detail: '计划进行中', icon: 'pot', tone: 'violet' },
    ],
    desktopRecommendations: [],
    mobileRecommendations: [],
    recommendationCount: 0,
    foodRecommendations: null,
    homeInventoryActionGroups: [tomato, milk, eggs],
    hasLaterInventoryActionGroups: false,
    hasFullListInventoryActionGroups: false,
    requiredActions: [
      { kind: 'inventory', group: tomato },
      { kind: 'inventory', group: milk },
      { kind: 'inventory', group: eggs },
    ],
    hasMoreHomeActions: false,
    activeFoodPlanItems: [],
    foodPlanItems: [],
    dashboardWeekMealCapacity: 28,
    dashboardPlanDays: [],
    compactPlanDays: [],
    selectedDashboardPlanDay: undefined,
    selectedDashboardPlanDateLabel: '今天 · 7月6日',
    selectedPlanSummary: '今天 · 7月6日 · 0 项计划',
    pendingShoppingCount: 0,
    pendingShoppingPreview: [],
    dashboardPlanSummary: [],
    foodPlanWeekRange: { start: '2026-07-06', end: '2026-07-12' },
    homeHighlights: emptyHighlights(),
    foods: [],
    recipes: [],
    ingredients: [],
    mealLogs: [],
    inventoryItems: [],
    isQuickAdding: false,
    isCreatingFoodPlanItem: false,
    resolveAssetUrl: (url) => url,
    businessDateKey: '2026-07-15',
    recordMeal: async () => {
      throw new Error('unused');
    },
    loadMealCandidates: async () => [],
    onRecordSuccess: vi.fn(),
    createFoodPlanItem: async () => {
      throw new Error('unused');
    },
    onNavigate: vi.fn(),
    onOpenGlobalSearch: vi.fn(),
    onNextDesktopRecommendations: vi.fn(),
    onNextMobileRecommendation: vi.fn(),
    onStartRecommendedRecipe: vi.fn(),
    onStartPlanRecipe: vi.fn(),
    onSelectedPlanDateChange: vi.fn(),
    onHomePlanAddDialogOpen: vi.fn(),
    onHomePlanAddEmptyDialogOpen: vi.fn(),
    onHomePlanDetailOpen: vi.fn(),
    onHomeRestockOpen: vi.fn(),
    onOpenActionGroup: vi.fn(),
    onOpenIngredientShopping: vi.fn(),
    onOpenIngredientPriority: vi.fn(),
    onOpenShoppingIntake: vi.fn(),
    onOpenFamilyActivity: vi.fn(),
    onOpenFullWeek: vi.fn(),
    onRetryHighlights: vi.fn(),
    onFoodPlanPreviousWeek: vi.fn(),
    onFoodPlanCurrentWeek: vi.fn(),
    onFoodPlanNextWeek: vi.fn(),
    ...overrides,
  };
}

function makeRecordResponse(foodName = '推荐菜 0'): RecordMealResponse {
  const mealLog: MealLog = {
    id: 'meal-recorded-1',
    family_id: 'family-1',
    date: '2026-07-15',
    meal_type: 'dinner',
    food_entries: [
      {
        id: 'entry-1',
        food_id: 'food-0',
        food_name: foodName,
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
    created_at: '2026-07-15T12:00:00.000Z',
    updated_at: '2026-07-15T12:00:00.000Z',
  };
  return {
    meal_log: mealLog,
    created_foods: [],
    outcome: 'created',
    operation: {
      id: 'op-home-1',
      status: 'applied',
      revertible_until: '2026-07-15T12:15:00.000Z',
      can_revert: true,
    },
  };
}

function makeRecordResult(overrides: Partial<MealRecordResult> = {}): MealRecordResult {
  const response = makeRecordResponse();
  return {
    source: 'immediate',
    operationId: response.operation.id,
    mealLogId: response.meal_log.id,
    foods: response.meal_log.food_entries.map((entry) => ({
      food_id: entry.food_id,
      name: entry.food_name,
      cover: {
        id: 'cover-1',
        name: entry.food_name,
        url: `/media/${entry.food_id}.jpg`,
        source: 'upload',
        alt: entry.food_name,
        created_at: '2026-07-15T12:00:00.000Z',
      },
    })),
    previewMedia: null,
    revertibleUntil: response.operation.revertible_until,
    canRevert: true,
    mealLog: response.meal_log,
    rowVersion: response.meal_log.row_version,
    canRate: true,
    ...overrides,
  };
}

function renderDashboard(props: Partial<HomeDashboardProps> = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(<HomeDashboard {...buildProps(props)} />);
  });
  return container;
}

function desktopSurface(view: HTMLElement) {
  const desktop = view.querySelector('.dashboard-page');
  if (!desktop) {
    throw new Error('desktop dashboard surface missing');
  }
  return desktop;
}

describe('HomeDashboard three-question desktop', () => {
  it('keeps the dashboard dense without clipping content on iPad widths', () => {
    const homeStyles = readFileSync(resolve(__dirname, '../../styles/01-home-dashboard.css'), 'utf8');

    expect(homeStyles).toMatch(/@media \(min-width: 768px\) and \(max-width: 1280px\)/);
    expect(homeStyles).toMatch(/\.dashboard-stat-card span:not\(\.dashboard-stat-icon\)[\s\S]*?white-space: nowrap/);
    expect(homeStyles).toMatch(/\.dashboard-stat-card p[\s\S]*?text-overflow: ellipsis/);
    expect(homeStyles).toMatch(/\.dashboard-food-row[\s\S]*?grid-template-columns: repeat\(3, minmax\(260px, 1fr\)\)/);
    expect(homeStyles).toMatch(/\.dashboard-food-row[\s\S]*?overflow-x: auto/);
    expect(homeStyles).toMatch(/\.dashboard-food-row[\s\S]*?scrollbar-width: none/);
    expect(homeStyles).toMatch(/\.dashboard-food-scroller\.can-scroll-left \.dashboard-food-row[\s\S]*?mask-image/);
    expect(homeStyles).toMatch(/\.dashboard-food-scroller\.can-scroll-left\.can-scroll-right \.dashboard-food-row/);
    expect(homeStyles).toMatch(/\.dashboard-food-scroller \{[\s\S]*?overflow: hidden[\s\S]*?border-radius: 14px/);
    expect(homeStyles).not.toMatch(/\.dashboard-food-card \{[^}]*box-shadow:/);
    expect(homeStyles).not.toMatch(/\.dashboard-food-card:hover \{[^}]*box-shadow:/);
    expect(homeStyles).toMatch(/\.dashboard-food-card:hover \{[^}]*border-color: var\(--accent\)/);
    expect(homeStyles).not.toMatch(/\.dashboard-food-card:hover \{[^}]*border-width:/);
    expect(homeStyles).not.toMatch(/\.dashboard-food-card:hover \{[^}]*transform:/);
    expect(homeStyles).toMatch(/\.home-question-one \{[\s\S]*?gap: 6px[\s\S]*?padding: 8px 18px/);
    expect(homeStyles).toMatch(/\.home-compact-days > button[\s\S]*?min-height: 60px[\s\S]*?align-content: start/);
    expect(homeStyles).toMatch(
      /@media \(min-width: 768px\) and \(max-width: 1180px\) \{[\s\S]*?\.home-compact-meal-grid \{[^}]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/,
    );
    expect(homeStyles).toMatch(
      /\.home-compact-meal-foods \{[^}]*grid-template-columns: minmax\(0, 1fr\);/s,
    );
    expect(homeStyles).toMatch(
      /\.home-compact-meal-status-long \{[^}]*display: none;[^}]*\}[\s\S]*?\.home-compact-meal-status-tablet \{[^}]*display: block;/s,
    );
    expect(homeStyles).toMatch(
      /\.home-compact-meal-actions \{[^}]*grid-template-columns: 44px minmax\(0, 1fr\);/s,
    );
    expect(homeStyles).not.toContain('.home-compact-meal-item.is-cooked::before');
  });

  it('passes food cover images into the desktop and tablet compact meal schedule', () => {
    const picturedFood = {
      ...makeFood(0),
      images: [
        {
          id: 'media-plan-food',
          name: '番茄炒蛋.webp',
          url: '/media/番茄炒蛋.webp',
          source: 'upload' as const,
          alt: '番茄炒蛋',
          created_at: '2026-07-01T00:00:00.000Z',
        },
      ],
    };
    const day = makePlanDay(0);
    day.mealItems = day.mealItems.map((meal) =>
      meal.mealType === 'dinner'
        ? {
            ...meal,
            items: [
              {
                id: 'plan-pictured-food',
                family_id: 'family-1',
                user_id: 'user-1',
                food_id: picturedFood.id,
                food_name: '番茄炒蛋',
                food_type: 'dish',
                recipe_id: null,
                recipe_title: '',
                plan_date: day.date,
                meal_type: 'dinner',
                note: '',
                status: 'planned',
                created_at: '2026-07-01T00:00:00.000Z',
                updated_at: '2026-07-01T00:00:00.000Z',
              },
            ],
          }
        : meal,
    );
    day.plannedMealCount = 1;
    day.totalCount = 1;

    const view = renderDashboard({
      foods: [picturedFood],
      compactPlanDays: [day],
      selectedDashboardPlanDay: day,
    });

    expect(
      desktopSurface(view)
        .querySelector<HTMLButtonElement>('button[aria-label="番茄炒蛋，待记录"]')
        ?.querySelector<HTMLImageElement>('.home-compact-meal-item-image')
        ?.getAttribute('src'),
    ).toBe('/media/番茄炒蛋.webp');
  });

  it('renders desktop recommendations, compact week and the two-column lower questions', () => {
    const view = renderDashboard({
      desktopRecommendations: [0, 1, 2].map(makeRecommendation),
      recommendationCount: 3,
      compactPlanDays: Array.from({ length: 7 }, (_, index) => makePlanDay(index)),
      requiredActions: [
        { kind: 'inventory', group: tomato },
        { kind: 'shopping', pendingCount: 5 },
      ],
      homeHighlights: {
        items: Array.from({ length: 5 }, (_, index) => makeHighlight(index)),
        phase: 'ready',
        hasRefreshError: false,
        isRefreshing: false,
        weekCountLabel: '本周协作 5 次',
      },
    });
    const desktop = desktopSurface(view);
    expect(desktop.textContent).toContain('今天吃什么');
    expect(desktop.querySelectorAll('[data-testid="home-recommendation-card"]')).toHaveLength(3);
    expect(desktop.querySelectorAll('[aria-label="七天菜单"] button[aria-label^="选择 "]')).toHaveLength(7);
    expect(desktop.textContent).toContain('今天必须处理什么');
    expect(desktop.textContent).toContain('5 项待采购');
    expect(desktop.textContent).toContain('家里发生了什么');
    expect(desktop.querySelectorAll('[data-testid="home-highlight-row"]')).toHaveLength(5);
    expect(desktop.querySelector('[data-testid="home-lower-grid"]')?.classList.contains('home-dashboard-lower-grid')).toBe(true);
  });

  it('adds a non-recipe recommendation to the selected meal plan', () => {
    const onHomePlanAddDialogOpen = vi.fn();
    const view = renderDashboard({
      desktopRecommendations: [makeRecommendation(0)],
      recommendationCount: 1,
      onHomePlanAddDialogOpen,
    });

    const addPlanButton = buttonByText(desktopSurface(view), '加入计划');
    act(() => addPlanButton.click());

    expect(onHomePlanAddDialogOpen).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'food-0' }),
      'dinner',
    );
  });

  it('opens plan details and quick-adds directly from the selected meal slots', () => {
    const addMeal = vi.fn();
    const openDetail = vi.fn();
    const days = Array.from({ length: 7 }, (_, index) => makePlanDay(index));
    const plannedItem = {
      id: 'plan-1',
      family_id: 'family-1',
      user_id: 'user-1',
      food_id: 'food-1',
      food_name: '番茄炒蛋',
      food_type: 'dish',
      recipe_id: null,
      recipe_title: '',
      plan_date: days[0]!.date,
      meal_type: 'breakfast' as const,
      note: '',
      status: 'planned',
      created_at: '2026-07-01T00:00:00.000Z',
      updated_at: '2026-07-01T00:00:00.000Z',
    };
    days[0] = {
      ...days[0]!,
      mealItems: days[0]!.mealItems.map((meal) =>
        meal.mealType === 'breakfast' ? { ...meal, items: [plannedItem] } : meal,
      ),
      plannedMealCount: 1,
      totalCount: 1,
    };

    const view = renderDashboard({
      compactPlanDays: days,
      selectedDashboardPlanDay: days[0],
      onHomePlanAddEmptyDialogOpen: addMeal,
      onHomePlanDetailOpen: openDetail,
    });
    const desktop = desktopSurface(view);

    act(() => buttonByText(desktop, '番茄炒蛋').click());
    expect(openDetail).toHaveBeenCalledWith(plannedItem);

    const lunchAdd = desktop.querySelector('button[aria-label="为6日午餐安排餐食"]') as HTMLButtonElement | null;
    expect(lunchAdd).not.toBeNull();
    act(() => lunchAdd?.click());
    expect(addMeal).toHaveBeenCalledWith(days[0]!.date, 'lunch');
  });

  it('distinguishes planned and recorded items in the compact calendar', () => {
    const days = Array.from({ length: 7 }, (_, index) => makePlanDay(index));
    const base = {
      id: 'plan-1',
      family_id: 'family-1',
      user_id: 'user-1',
      food_id: 'food-1',
      food_name: '番茄炒蛋',
      food_type: 'selfMade',
      recipe_id: null,
      recipe_title: '',
      plan_date: days[0]!.date,
      meal_type: 'dinner' as const,
      note: '',
      status: 'cooked',
      meal_log_id: 'meal-1',
      created_at: '2026-07-01T00:00:00.000Z',
      updated_at: '2026-07-01T00:00:00.000Z',
    };
    const items = [base, { ...base, id: 'plan-2', food_id: 'food-2', food_name: '米饭', status: 'planned', meal_log_id: null }];
    days[0] = {
      ...days[0]!,
      mealItems: days[0]!.mealItems.map((meal) => meal.mealType === 'dinner' ? { ...meal, items } : meal),
      plannedMealCount: 1,
      totalCount: 2,
    };

    const view = renderDashboard({ compactPlanDays: days, selectedDashboardPlanDay: days[0] });
    const desktop = desktopSurface(view);

    expect(desktop.textContent).toContain('已记录 1 / 2');
    expect(desktop.textContent).toContain('2 项计划 · 已记录 1 项');
    expect(buttonByText(desktop, '番茄炒蛋').getAttribute('aria-label')).toContain('已记录');
    expect(buttonByText(desktop, '米饭').getAttribute('aria-label')).toContain('待记录');
  });

  it('renders local loading/error/stale states without hiding the other two questions', () => {
    const retry = vi.fn();
    const view = renderDashboard({
      homeHighlights: { items: [], phase: 'loading', hasRefreshError: false, isRefreshing: true, weekCountLabel: '本周协作 --' },
      onRetryHighlights: retry,
    });
    expect(view.querySelector('[aria-label="家庭动态加载中"]')).not.toBeNull();
    expect(view.textContent).toContain('今天吃什么');
    expect(view.textContent).toContain('今天必须处理什么');

    act(() => root?.render(<HomeDashboard {...buildProps({
      homeHighlights: { items: [], phase: 'error', hasRefreshError: false, isRefreshing: false, weekCountLabel: '本周协作 --' },
      onRetryHighlights: retry,
    })} />));
    act(() => buttonByText(view, '重试家庭动态').click());
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('shows refresh failure retry on empty highlights phase', () => {
    const retry = vi.fn();
    const view = renderDashboard({
      homeHighlights: {
        items: [],
        phase: 'empty',
        hasRefreshError: true,
        isRefreshing: false,
        weekCountLabel: '本周协作 0 次',
      },
      onRetryHighlights: retry,
    });
    expect(view.textContent).toContain('还没有家庭高亮');
    const refreshRetry = buttonByText(view, '刷新失败，重试');
    act(() => refreshRetry.click());
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('does not own a second activity modal', () => {
    const onOpenFamilyActivity = vi.fn();
    const view = renderDashboard({ onOpenFamilyActivity });
    act(() => buttonByText(view, '查看完整记录').click());
    expect(onOpenFamilyActivity).toHaveBeenCalledTimes(1);
    expect(view.querySelector('[aria-label="家庭活动弹窗"]')).toBeNull();
  });

  it('disables 换一批 at N<=3 and enables it when N>3', () => {
    const onNextDesktopRecommendations = vi.fn();
    const few = renderDashboard({
      desktopRecommendations: [0, 1, 2].map(makeRecommendation),
      recommendationCount: 3,
      onNextDesktopRecommendations,
    });
    const fewButton = buttonByText(desktopSurface(few), '换一批');
    expect(fewButton.querySelector('svg')).not.toBeNull();
    expect(fewButton.disabled).toBe(true);

    act(() => root?.unmount());
    container?.remove();

    const many = renderDashboard({
      desktopRecommendations: [0, 1, 2].map(makeRecommendation),
      recommendationCount: 5,
      onNextDesktopRecommendations,
    });
    const manyButton = buttonByText(desktopSurface(many), '换一批');
    expect(manyButton.disabled).toBe(false);
    act(() => manyButton.click());
    expect(onNextDesktopRecommendations).toHaveBeenCalledTimes(1);
  });

  it('renders only real recommendation cards when N is 1 or 2', () => {
    const one = renderDashboard({
      desktopRecommendations: [makeRecommendation(0)],
      recommendationCount: 1,
    });
    expect(desktopSurface(one).querySelectorAll('[data-testid="home-recommendation-card"]')).toHaveLength(1);

    act(() => root?.unmount());
    container?.remove();

    const two = renderDashboard({
      desktopRecommendations: [0, 1].map(makeRecommendation),
      recommendationCount: 2,
    });
    expect(desktopSurface(two).querySelectorAll('[data-testid="home-recommendation-card"]')).toHaveLength(2);
  });

  it('shows only the available horizontal recommendation directions while scrolling', () => {
    const view = renderDashboard({
      desktopRecommendations: [0, 1, 2].map(makeRecommendation),
      recommendationCount: 3,
    });
    const desktop = desktopSurface(view);
    const scroller = desktop.querySelector('[data-testid="home-recommendation-scroller"]') as HTMLDivElement | null;
    const row = desktop.querySelector('[data-testid="home-recommendation-row"]') as HTMLDivElement | null;
    expect(scroller).not.toBeNull();
    expect(row).not.toBeNull();

    Object.defineProperties(row!, {
      clientWidth: { configurable: true, value: 300 },
      scrollWidth: { configurable: true, value: 900 },
      scrollLeft: { configurable: true, writable: true, value: 0 },
    });

    act(() => row?.dispatchEvent(new Event('scroll', { bubbles: true })));
    expect(scroller?.classList.contains('can-scroll-left')).toBe(false);
    expect(scroller?.classList.contains('can-scroll-right')).toBe(true);

    row!.scrollLeft = 300;
    act(() => row?.dispatchEvent(new Event('scroll', { bubbles: true })));
    expect(scroller?.classList.contains('can-scroll-left')).toBe(true);
    expect(scroller?.classList.contains('can-scroll-right')).toBe(true);

    row!.scrollLeft = 600;
    act(() => row?.dispatchEvent(new Event('scroll', { bubbles: true })));
    expect(scroller?.classList.contains('can-scroll-left')).toBe(true);
    expect(scroller?.classList.contains('can-scroll-right')).toBe(false);
  });

  it('renders at most three prepared required actions and never re-sorts them', () => {
    const view = renderDashboard({
      requiredActions: [
        { kind: 'inventory', group: tomato },
        { kind: 'shopping', pendingCount: 2 },
        { kind: 'inventory', group: eggs },
      ],
      hasMoreHomeActions: true,
    });
    const desktop = desktopSurface(view);
    expect(desktop.textContent).toContain('今天必须处理什么');
    expect(desktop.querySelectorAll('[data-testid="home-action-group"]')).toHaveLength(2);
    expect(desktop.textContent).toContain('番茄需要处理');
    expect(desktop.textContent).toContain('2 项待采购');
    expect(desktop.textContent).toContain('鸡蛋库存不足');
    expect(desktop.textContent).not.toContain('豆腐');
    expect(buttonByText(desktop, '查看全部')).toBeTruthy();
  });

  it('routes inventory and shopping actions without owning overlays', () => {
    const onOpenActionGroup = vi.fn();
    const onOpenIngredientShopping = vi.fn();
    const onOpenIngredientPriority = vi.fn();
    const onOpenShoppingIntake = vi.fn();
    const onOpenReconciliation = vi.fn();
    const view = renderDashboard({
      requiredActions: [
        { kind: 'inventory', group: tomato },
        { kind: 'shopping', pendingCount: 3 },
        { kind: 'inventory', group: eggs },
      ],
      hasMoreHomeActions: true,
      onOpenActionGroup,
      onOpenIngredientShopping,
      onOpenIngredientPriority,
      onOpenShoppingIntake,
      onOpenReconciliation,
    });
    const desktop = desktopSurface(view);

    const primaryButtons = Array.from(
      desktop.querySelectorAll('[data-testid="home-action-primary"]'),
    ) as HTMLButtonElement[];
    expect(primaryButtons.map((button) => button.textContent?.trim())).toEqual(['集中处理', '去登记', '加入采购']);

    act(() => {
      primaryButtons[0]?.click();
      primaryButtons[1]?.click();
      primaryButtons[2]?.click();
    });
    expect(onOpenActionGroup).toHaveBeenCalledWith(tomato);
    expect(onOpenShoppingIntake).toHaveBeenCalledTimes(1);
    expect(onOpenIngredientShopping).toHaveBeenCalledWith(eggs.ingredientId);

    act(() => buttonByText(desktop, '核对库存').click());
    expect(onOpenReconciliation).toHaveBeenCalledWith({ scope: 'suggested' });

    act(() => buttonByText(desktop, '查看全部').click());
    expect(onOpenIngredientPriority).toHaveBeenCalledTimes(1);
  });

  it('shows the shared empty state when required actions are empty', () => {
    const view = renderDashboard({
      requiredActions: [],
      hasMoreHomeActions: false,
    });
    expect(desktopSurface(view).textContent).toContain('今天没有必须处理的事项');
  });

  it('never renders meal or food images inside highlight rows', () => {
    const view = renderDashboard({
      homeHighlights: {
        items: Array.from({ length: 3 }, (_, index) => makeHighlight(index)),
        phase: 'ready',
        hasRefreshError: false,
        isRefreshing: false,
        weekCountLabel: '本周协作 3 次',
      },
    });
    const rows = desktopSurface(view).querySelectorAll('[data-testid="home-highlight-row"]');
    expect(rows).toHaveLength(3);
    rows.forEach((row) => {
      expect(row.querySelector('img')).toBeNull();
      expect(row.querySelector('.media-placeholder')).toBeNull();
    });
  });

  it('keeps fourth inventory action out when already capped upstream', () => {
    const view = renderDashboard({
      requiredActions: [
        { kind: 'inventory', group: tomato },
        { kind: 'inventory', group: milk },
        { kind: 'inventory', group: eggs },
      ],
      homeInventoryActionGroups: [tomato, milk, eggs, fourth],
    });
    const desktop = desktopSurface(view);
    expect(desktop.querySelectorAll('[data-testid="home-action-group"]')).toHaveLength(3);
    expect(desktop.textContent).not.toContain('豆腐');
  });

  it('emits semantic history/ingredients targets instead of legacy TabKey values', () => {
    const onNavigate = vi.fn();
    const view = renderDashboard({ onNavigate });
    const logsButton = Array.from(view.querySelectorAll('button')).find((button) => button.textContent === '查看记录');
    const ingredientsButton = Array.from(view.querySelectorAll('button')).find((button) => button.textContent === '新增食材');
    expect(logsButton).toBeDefined();
    expect(ingredientsButton).toBeDefined();
    act(() => logsButton?.click());
    act(() => ingredientsButton?.click());
    expect(onNavigate).toHaveBeenCalledWith({ workspace: 'eat', view: 'history' });
    expect(onNavigate).toHaveBeenCalledWith({ workspace: 'ingredients' });
    expect(onNavigate).not.toHaveBeenCalledWith('logs');
    expect(onNavigate).not.toHaveBeenCalledWith('ingredients');
    expect(onNavigate).not.toHaveBeenCalledWith('foods');
    expect(onNavigate).not.toHaveBeenCalledWith('recipes');
  });

  it('starts direct cook from food detail with complete recommendation launch context', () => {
    const onStartRecommendedRecipe = vi.fn();
    const onStartPlanRecipe = vi.fn();
    const food = {
      ...makeFood(0),
      recipe_id: 'recipe-direct-1',
    };
    const view = renderDashboard({
      desktopRecommendations: [
        {
          recommendation: {
            food,
            score: 0.95,
            reasons: ['今日推荐'],
            primary_action: 'cook_recipe',
          },
          coverUrl: undefined,
        },
      ],
      recommendationCount: 1,
      foodRecommendations: {
        target_meal_type: 'lunch',
        target_date: '2026-07-14',
        items: [
          {
            food,
            score: 0.95,
            reasons: ['今日推荐'],
            primary_action: 'cook_recipe',
          },
        ],
      },
      onStartRecommendedRecipe,
      onStartPlanRecipe,
    });
    const desktop = desktopSurface(view);
    const card = desktop.querySelector('[data-testid="home-recommendation-card"]') as HTMLElement | null;
    expect(card).not.toBeNull();
    act(() => card?.click());
    const startCook = Array.from(view.querySelectorAll('button')).find((button) => button.textContent?.includes('开始做'));
    expect(startCook).toBeDefined();
    act(() => startCook?.click());
    // Detail cook opens the confirmation dialog (no Recipe-ID-only shortcut).
    const form = view.querySelector('form');
    expect(form).not.toBeNull();
    expect(view.textContent).toContain('确认日期、餐次和份量后开始做');
    act(() => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(onStartRecommendedRecipe).toHaveBeenCalledWith({
      foodId: food.id,
      recipeId: 'recipe-direct-1',
      date: '2026-07-14',
      mealType: 'lunch',
      servings: 1,
    });
    expect(onStartPlanRecipe).not.toHaveBeenCalled();
  });

  it('starts direct cook from quick-meal dialog without creating a plan item', async () => {
    const onStartRecommendedRecipe = vi.fn();
    const onStartPlanRecipe = vi.fn();
    const createFoodPlanItem = vi.fn(async () => {
      throw new Error('quick-meal cook should not create a plan item');
    });
    const food = {
      ...makeFood(0),
      recipe_id: 'recipe-plan-1',
    };
    const view = renderDashboard({
      desktopRecommendations: [
        {
          recommendation: {
            food,
            score: 0.9,
            reasons: ['可做'],
            primary_action: 'cook_recipe',
          },
          coverUrl: undefined,
        },
      ],
      recommendationCount: 1,
      foodRecommendations: {
        target_meal_type: 'dinner',
        target_date: '2026-07-14',
        items: [
          {
            food,
            score: 0.9,
            reasons: ['可做'],
            primary_action: 'cook_recipe',
          },
        ],
      },
      createFoodPlanItem,
      onStartRecommendedRecipe,
      onStartPlanRecipe,
    });
    const desktop = desktopSurface(view);
    const startButton = Array.from(desktop.querySelectorAll('button')).find((button) => button.textContent?.includes('开始做'));
    expect(startButton).toBeDefined();
    act(() => startButton?.click());
    const form = view.querySelector('form');
    expect(form).not.toBeNull();
    await act(async () => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(createFoodPlanItem).not.toHaveBeenCalled();
    expect(onStartPlanRecipe).not.toHaveBeenCalled();
    expect(onStartRecommendedRecipe).toHaveBeenCalledWith({
      foodId: 'food-0',
      recipeId: 'recipe-plan-1',
      date: expect.any(String),
      mealType: expect.any(String),
      servings: 1,
    });
  });
});

describe('HomeDashboard meal recording ownership', () => {
  it('owns recommendation writes via recordMeal', () => {
    expect(homeOwners.homeRecommendation).toBe('recordMeal');
    expect(homeOwners.homePlanComplete).toBe('completeFoodPlanItem');
    expect(homeOwners.historyPrimaryCta).toBe('recordMeal');
  });

  it('opens compact prefilled Food flow from the recommendation detail without re-searching Food', async () => {
    const loadMealCandidates = vi.fn(async () => []);
    const food = makeFood(0);
    const view = renderDashboard({
      desktopRecommendations: [makeRecommendation(0)],
      recommendationCount: 1,
      loadMealCandidates,
      foodRecommendations: {
        target_meal_type: 'dinner',
        target_date: '2026-07-15',
        items: [
          {
            food,
            score: 0.9,
            reasons: ['适合今天'],
            primary_action: 'quick_add_meal',
          },
        ],
      },
    });
    const desktop = desktopSurface(view);
    const recommendationCard = desktop.querySelector<HTMLElement>('[data-testid="home-recommendation-card"]');
    act(() => recommendationCard?.click());
    const recordButton = Array.from(view.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('记到今天'),
    );
    expect(recordButton).toBeDefined();
    await act(async () => {
      recordButton?.click();
    });

    expect(view.textContent).toContain('快速记录');
    expect(view.textContent).toContain('记到今天');
    expect(view.textContent).toContain(food.name);
    expect(view.querySelector('input[type="search"]')).toBeNull();
    expect(view.querySelector('[role="combobox"]')).toBeNull();
    expect(view.textContent).not.toMatch(/搜索食物|搜索菜名/);
    await act(async () => {
      await Promise.resolve();
    });
    expect(loadMealCandidates).toHaveBeenCalled();
  });

  it('records from a Home recommendation detail and shows the shared result bar in one flow', async () => {
    const response = makeRecordResponse('推荐菜 0');
    const recordMeal = vi.fn(async () => response);
    const loadMealCandidates = vi.fn(async () => []);
    const food = makeFood(0);
    const baseProps = buildProps({
      desktopRecommendations: [makeRecommendation(0)],
      recommendationCount: 1,
      recordMeal,
      loadMealCandidates,
      businessDateKey: '2026-07-15',
      foodRecommendations: {
        target_meal_type: 'dinner',
        target_date: '2026-07-15',
        items: [
          {
            food,
            score: 0.9,
            reasons: ['适合今天'],
            primary_action: 'quick_add_meal',
          },
        ],
      },
    });

    function StatefulHome() {
      const [recordResult, setRecordResult] = useState<MealRecordResult | null>(null);
      return (
        <HomeDashboard
          {...baseProps}
          recordResult={recordResult}
          onRecordSuccess={(next) => {
            setRecordResult(makeRecordResult({
              operationId: next.operation.id,
              mealLogId: next.meal_log.id,
              foods: next.meal_log.food_entries.map((entry) => ({
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
              revertibleUntil: next.operation.revertible_until,
              canRevert: next.operation.can_revert,
              mealLog: next.meal_log,
              rowVersion: next.meal_log.row_version,
              canRate: true,
            }));
          }}
        />
      );
    }

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<StatefulHome />);
    });
    const view = container;

    const desktop = desktopSurface(view);
    const recommendationCard = desktop.querySelector<HTMLElement>('[data-testid="home-recommendation-card"]');
    act(() => recommendationCard?.click());
    const recordButton = Array.from(view.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('记到今天'),
    );
    await act(async () => {
      recordButton?.click();
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

    expect(recordMeal).toHaveBeenCalledWith(
      expect.objectContaining({
        date: '2026-07-15',
        meal_type: 'dinner',
        entries: [expect.objectContaining({ food_id: food.id, servings: 1 })],
        target: { kind: 'new' },
      }),
    );

    const bar = view.querySelector('[aria-label="记录结果"]');
    expect(bar).not.toBeNull();
    expect(bar?.textContent).toContain('已记下');
    expect(bar?.textContent).toContain('撤销');
    expect(bar?.textContent).toContain('查看记录');
    expect(bar?.textContent).toContain('推荐菜 0');
    expect(bar?.querySelector('img, [class*="media"], [class*="placeholder"]')).not.toBeNull();
    // Remains on Home surface (no navigation).
    expect(desktopSurface(view).textContent).toContain('今天吃什么');
  });

  it('restores Home result bar from active operation summary', () => {
    const summary: MealLogRecordOperationSummary = {
      id: 'op-restored-1',
      meal_log_id: 'meal-restored-1',
      foods: [
        {
          food_id: 'food-0',
          name: '推荐菜 0',
          food_type: 'selfMade',
          cover: {
            id: 'cover-restored',
            name: '推荐菜 0',
            url: '/media/food-0.jpg',
            source: 'upload',
            alt: '推荐菜 0',
            created_at: '2026-07-15T12:00:00.000Z',
          },
        },
      ],
      preview_media: null,
      revertible_until: '2026-07-15T12:20:00.000Z',
      can_revert: true,
    };
    const restored = makeRecordResult({
      source: 'restored',
      operationId: summary.id,
      mealLogId: summary.meal_log_id,
      foods: summary.foods.map((food) => ({
        food_id: food.food_id,
        name: food.name,
        food_type: food.food_type,
        cover: food.cover ?? null,
      })),
      canRate: false,
      mealLog: null,
      rowVersion: null,
    });
    const view = renderDashboard({ recordResult: restored });
    const bar = view.querySelector('[aria-label="记录结果"]');
    expect(bar).not.toBeNull();
    expect(bar?.getAttribute('data-operation-id')).toBe('op-restored-1');
    expect(bar?.textContent).toContain('已记下');
    expect(bar?.textContent).toContain('撤销');
    expect(bar?.textContent).toContain('查看记录');
  });

  it('defaults meal quick-record date to injected businessDateKey (Asia/Shanghai)', async () => {
    const loadMealCandidates = vi.fn(async () => []);
    const view = renderDashboard({
      desktopRecommendations: [makeRecommendation(0)],
      recommendationCount: 1,
      businessDateKey: '2026-07-12',
      loadMealCandidates,
    });
    const desktop = desktopSurface(view);
    const recommendationCard = desktop.querySelector<HTMLElement>('[data-testid="home-recommendation-card"]');
    act(() => recommendationCard?.click());
    const recordButton = Array.from(view.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('记到今天'),
    );
    await act(async () => {
      recordButton?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    const activeDate = view.querySelector(
      '.meal-quick-record-date-option.is-active',
    ) as HTMLButtonElement | null;
    expect(activeDate).not.toBeNull();
    // Date strip shows month/day for the business date key.
    expect(activeDate?.textContent).toMatch(/7\/12|07\/12|12/);
  });
});
