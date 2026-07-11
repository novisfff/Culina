// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ExpiryInventoryActionGroup,
  LowStockInventoryActionGroup,
} from '../inventory/inventoryActionModel';
import { HomeMobileDashboard, type HomeMobileDashboardProps } from './HomeMobileDashboard';

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
  return {
    inventoryItemId: overrides.inventoryItemId,
    rowVersion: overrides.rowVersion ?? 1,
    remainingQuantity: overrides.remainingQuantity ?? 1,
    unit: overrides.unit ?? '个',
    storageLocation: overrides.storageLocation ?? '冷藏',
    purchaseDate: overrides.purchaseDate ?? '2026-07-01',
    expiryDate: overrides.expiryDate,
    daysLeft: overrides.daysLeft,
    expiryAlertSnoozedUntil: overrides.expiryAlertSnoozedUntil ?? null,
    expiryReviewedAt: overrides.expiryReviewedAt ?? null,
    expiryReviewedBy: overrides.expiryReviewedBy ?? null,
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

function buildProps(overrides: Partial<HomeMobileDashboardProps> = {}): HomeMobileDashboardProps {
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
    dashboardWeekMealCapacity: 28,
    dashboardPlanDays: [],
    selectedDashboardPlanDay: undefined,
    selectedDashboardPlanDateLabel: '',
    pendingShoppingCount: 0,
    pendingShoppingPreview: [],
    foods: [],
    recipes: [],
    ingredients: [],
    isQuickAdding: false,
    isCreatingFoodPlanItem: false,
    resolveAssetUrl: (url) => url,
    onNavigate: vi.fn(),
    onOpenGlobalSearch: vi.fn(),
    onRecommendationPageChange: vi.fn(),
    onSelectedPlanDateChange: vi.fn(),
    onFoodPlanPreviousWeek: vi.fn(),
    onFoodPlanNextWeek: vi.fn(),
    onQuickStartFood: vi.fn(),
    onHomePlanAddDialogOpen: vi.fn(),
    onHomePlanAddEmptyDialogOpen: vi.fn(),
    onHomePlanDetailOpen: vi.fn(),
    onHomeRestockOpen: vi.fn(),
    onOpenActionGroup: vi.fn(),
    onOpenIngredientShopping: vi.fn(),
    onOpenIngredientPriority: vi.fn(),
    onOpenDetail: vi.fn(),
    ...overrides,
  };
}

function renderMobile(props: Partial<HomeMobileDashboardProps> = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(<HomeMobileDashboard {...buildProps(props)} />);
  });
  return container;
}

describe('HomeMobileDashboard action center', () => {
  it('renders the same first three prepared groups under 今天要处理', () => {
    const view = renderMobile();
    expect(view.textContent).toContain('今天要处理');
    expect(view.textContent).not.toContain('今日待办');
    const rows = view.querySelectorAll('[data-testid="home-action-group"]');
    expect(rows).toHaveLength(3);
    expect(view.textContent).toContain('番茄需要处理');
    expect(view.textContent).toContain('牛奶今天到期');
    expect(view.textContent).toContain('鸡蛋库存不足');
  });

  it('renders one ingredient only once and excludes shopping/meals from the action list', () => {
    const view = renderMobile({ homeInventoryActionGroups: [tomato] });
    const tomatoRows = Array.from(view.querySelectorAll('[data-testid="home-action-group"]')).filter((row) =>
      (row.textContent ?? '').includes('番茄'),
    );
    expect(tomatoRows).toHaveLength(1);
    expect(view.textContent).not.toContain('采购待办');
    expect(view.textContent).not.toContain('已完成餐食');
  });

  it('shows approved empty states', () => {
    const calm = renderMobile({
      homeInventoryActionGroups: [],
      hasLaterInventoryActionGroups: false,
    });
    expect(calm.textContent).toContain('当前库存状态平稳');

    act(() => root?.unmount());
    container?.remove();

    const later = renderMobile({
      homeInventoryActionGroups: [],
      hasLaterInventoryActionGroups: true,
    });
    expect(later.textContent).toContain('今天没有急着处理的食材');
    expect(later.textContent).toContain('4～7 天内的提醒仍可以在食材页查看。');
  });

  it('uses one strong primary action per row with 44px-class targets', () => {
    const onOpenActionGroup = vi.fn();
    const onOpenIngredientShopping = vi.fn();
    const view = renderMobile({
      homeInventoryActionGroups: [tomato, eggs],
      onOpenActionGroup,
      onOpenIngredientShopping,
    });
    const primaries = Array.from(view.querySelectorAll('[data-testid="home-action-primary"]')) as HTMLButtonElement[];
    expect(primaries).toHaveLength(2);
    expect(primaries[0]?.className).toContain('mobile-dashboard-action-primary');
    act(() => {
      primaries[0]?.click();
      primaries[1]?.click();
    });
    expect(onOpenActionGroup).toHaveBeenCalledWith(tomato);
    expect(onOpenIngredientShopping).toHaveBeenCalledWith(eggs.ingredientId);
  });
});
