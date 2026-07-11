// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ExpiryInventoryActionGroup,
  InventoryActionGroup,
  LowStockInventoryActionGroup,
} from '../inventory/inventoryActionModel';
import { HomeDashboard, type HomeDashboardProps } from './HomeDashboard';

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
    dashboardRecommendationItems: [],
    dashboardRecommendationPageCount: 1,
    dashboardRecommendations: [],
    foodRecommendations: null,
    homeInventoryActionGroups: [tomato, milk, eggs],
    hasLaterInventoryActionGroups: false,
    hasFullListInventoryActionGroups: false,
    activeFoodPlanItems: [],
    foodPlanItems: [],
    dashboardWeekMealCapacity: 28,
    dashboardPlanDays: [],
    selectedDashboardPlanDay: undefined,
    selectedDashboardPlanDateLabel: '',
    pendingShoppingCount: 0,
    pendingShoppingPreview: [],
    dashboardPlanSummary: [],
    foodPlanWeekRange: { start: '2026-07-06', end: '2026-07-12' },
    foods: [],
    recipes: [],
    ingredients: [],
    members: [],
    mealLogs: [],
    inventoryItems: [],
    activityLogs: [],
    recentMeals: [],
    isQuickAdding: false,
    isCreatingFoodPlanItem: false,
    resolveAssetUrl: (url) => url,
    quickAddMeal: async () => undefined,
    createFoodPlanItem: async () => {
      throw new Error('unused');
    },
    onNavigate: vi.fn(),
    onOpenGlobalSearch: vi.fn(),
    onRecommendationPageChange: vi.fn(),
    onStartRecipe: vi.fn(),
    onSelectedPlanDateChange: vi.fn(),
    onHomePlanAddDialogOpen: vi.fn(),
    onHomePlanAddEmptyDialogOpen: vi.fn(),
    onHomePlanDetailOpen: vi.fn(),
    onHomeRestockOpen: vi.fn(),
    onOpenActionGroup: vi.fn(),
    onOpenIngredientShopping: vi.fn(),
    onOpenIngredientPriority: vi.fn(),
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

describe('HomeDashboard action center', () => {
  it('renders at most three prepared groups under 今天要处理 and never shows shopping/meals', () => {
    const view = renderDashboard({
      homeInventoryActionGroups: [tomato, milk, eggs, fourth].slice(0, 3),
    });
    const desktop = desktopSurface(view);

    expect(desktop.textContent).toContain('今天要处理');
    expect(desktop.textContent).not.toContain('临期优先处理');
    expect(desktop.textContent).not.toContain('今日待办');

    const rows = desktop.querySelectorAll('[data-testid="home-action-group"]');
    expect(rows).toHaveLength(3);
    expect(desktop.textContent).toContain('番茄需要处理');
    expect(desktop.textContent).toContain('牛奶今天到期');
    expect(desktop.textContent).toContain('鸡蛋库存不足');
    expect(desktop.textContent).not.toContain('豆腐');
    const actionPanel = desktop.querySelector('.dashboard-action-panel');
    expect(actionPanel?.querySelectorAll('[data-testid="home-action-group"]')).toHaveLength(3);
    // Shopping/completed meals stay out of the action list itself.
    expect(actionPanel?.textContent).not.toContain('采购提醒');
    expect(actionPanel?.textContent).not.toContain('已完成餐食');
    expect(actionPanel?.textContent).not.toContain('今日待办');
  });

  it('renders one ingredient only once even when multiple batches are represented', () => {
    const view = renderDashboard({
      homeInventoryActionGroups: [tomato],
    });
    const desktop = desktopSurface(view);
    const tomatoMentions = Array.from(desktop.querySelectorAll('[data-testid="home-action-group"]')).filter((row) =>
      (row.textContent ?? '').includes('番茄'),
    );
    expect(tomatoMentions).toHaveLength(1);
    expect(desktop.textContent).toContain('1 批已过期，1 批 3 天内到期');
  });

  it('shows approved empty states for calm and later-only queues', () => {
    const calm = renderDashboard({
      homeInventoryActionGroups: [],
      hasLaterInventoryActionGroups: false,
      hasFullListInventoryActionGroups: false,
    });
    expect(desktopSurface(calm).textContent).toContain('当前库存状态平稳');

    act(() => root?.unmount());
    container?.remove();

    const later = renderDashboard({
      homeInventoryActionGroups: [],
      hasLaterInventoryActionGroups: true,
      hasFullListInventoryActionGroups: true,
    });
    const laterDesktop = desktopSurface(later);
    expect(laterDesktop.textContent).toContain('今天没有急着处理的食材');
    expect(laterDesktop.textContent).toContain('4～7 天内的提醒仍可以在食材页查看。');
  });

  it('routes primary actions for expiry and low stock groups', () => {
    const onOpenActionGroup = vi.fn();
    const onOpenIngredientShopping = vi.fn();
    const onOpenIngredientPriority = vi.fn();
    const view = renderDashboard({
      homeInventoryActionGroups: [tomato, eggs],
      onOpenActionGroup,
      onOpenIngredientShopping,
      onOpenIngredientPriority,
    });
    const desktop = desktopSurface(view);

    const primaryButtons = Array.from(
      desktop.querySelectorAll('[data-testid="home-action-primary"]'),
    ) as HTMLButtonElement[];
    expect(primaryButtons.map((button) => button.textContent?.trim())).toEqual(['集中处理', '加入采购']);

    act(() => {
      primaryButtons[0]?.click();
      primaryButtons[1]?.click();
    });
    expect(onOpenActionGroup).toHaveBeenCalledWith(tomato);
    expect(onOpenIngredientShopping).toHaveBeenCalledWith(eggs.ingredientId);

    const viewAll = Array.from(desktop.querySelectorAll('button')).find((button) => button.textContent?.includes('查看全部'));
    act(() => {
      viewAll?.click();
    });
    expect(onOpenIngredientPriority).toHaveBeenCalledTimes(1);
  });

});
