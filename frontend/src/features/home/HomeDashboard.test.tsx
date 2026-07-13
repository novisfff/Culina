// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Food } from '../../api/types';
import type {
  ExpiryInventoryActionGroup,
  LowStockInventoryActionGroup,
} from '../inventory/inventoryActionModel';
import { HomeDashboard, type HomeDashboardProps } from './HomeDashboard';
import type { DashboardPlanDay, DashboardRecommendation, HomeHighlightsViewModel } from './homeDashboardModel';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
    quickAddMeal: async () => undefined,
    createFoodPlanItem: async () => {
      throw new Error('unused');
    },
    onNavigate: vi.fn(),
    onOpenGlobalSearch: vi.fn(),
    onNextDesktopRecommendations: vi.fn(),
    onNextMobileRecommendation: vi.fn(),
    onStartRecipe: vi.fn(),
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

    act(() => buttonByText(desktop, '建议再确认').click());
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
});
