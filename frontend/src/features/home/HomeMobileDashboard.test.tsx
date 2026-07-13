// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Food } from '../../api/types';
import type {
  ExpiryInventoryActionGroup,
  LowStockInventoryActionGroup,
} from '../inventory/inventoryActionModel';
import { HomeMobileDashboard, type HomeMobileDashboardProps } from './HomeMobileDashboard';
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

function makeRecommendation(index: number): HomeMobileDashboardProps['mobileRecommendations'][number] {
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

function makePlanDay(index: number): HomeMobileDashboardProps['compactPlanDays'][number] {
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

function makeHighlight(index: number): HomeMobileDashboardProps['homeHighlights']['items'][number] {
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
    mobileRecommendations: [],
    recommendationCount: 0,
    foodRecommendations: null,
    requiredActions: [
      { kind: 'inventory', group: tomato },
      { kind: 'inventory', group: milk },
      { kind: 'inventory', group: eggs },
    ],
    hasMoreHomeActions: false,
    compactPlanDays: [],
    selectedDashboardPlanDay: undefined,
    selectedPlanSummary: '今天 · 7月6日 · 0 项计划',
    homeHighlights: emptyHighlights(),
    isQuickAdding: false,
    isCreatingFoodPlanItem: false,
    resolveAssetUrl: (url) => url,
    onNavigate: vi.fn(),
    onOpenGlobalSearch: vi.fn(),
    onNextMobileRecommendation: vi.fn(),
    onSelectedPlanDateChange: vi.fn(),
    onFoodPlanPreviousWeek: vi.fn(),
    onFoodPlanCurrentWeek: vi.fn(),
    onFoodPlanNextWeek: vi.fn(),
    onQuickStartFood: vi.fn(),
    onHomePlanAddDialogOpen: vi.fn(),
    onOpenActionGroup: vi.fn(),
    onOpenIngredientShopping: vi.fn(),
    onOpenIngredientPriority: vi.fn(),
    onOpenShoppingIntake: vi.fn(),
    onOpenFamilyActivity: vi.fn(),
    onOpenFullWeek: vi.fn(),
    onRetryHighlights: vi.fn(),
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
  it('renders the same first three prepared groups under 今天必须处理什么', () => {
    const view = renderMobile();
    expect(view.textContent).toContain('今天必须处理什么');
    expect(view.textContent).not.toContain('今日待办');
    const rows = view.querySelectorAll('[data-testid="home-action-group"]');
    expect(rows).toHaveLength(3);
    expect(view.textContent).toContain('番茄需要处理');
    expect(view.textContent).toContain('牛奶今天到期');
    expect(view.textContent).toContain('鸡蛋库存不足');
  });

  it('renders one ingredient only once and excludes shopping/meals from the action list', () => {
    const view = renderMobile({
      requiredActions: [{ kind: 'inventory', group: tomato }],
    });
    const tomatoRows = Array.from(view.querySelectorAll('[data-testid="home-action-group"]')).filter((row) =>
      (row.textContent ?? '').includes('番茄'),
    );
    expect(tomatoRows).toHaveLength(1);
    expect(view.textContent).not.toContain('采购待办');
    expect(view.textContent).not.toContain('已完成餐食');
  });

  it('shows the shared empty state when required actions are empty', () => {
    const view = renderMobile({
      requiredActions: [],
      hasMoreHomeActions: false,
    });
    expect(view.textContent).toContain('今天没有必须处理的事项');
    expect(view.textContent).toContain('库存和采购清单都在可控范围内。');
  });

  it('uses one strong primary action per row with 44px-class targets', () => {
    const onOpenActionGroup = vi.fn();
    const onOpenIngredientShopping = vi.fn();
    const view = renderMobile({
      requiredActions: [
        { kind: 'inventory', group: tomato },
        { kind: 'inventory', group: eggs },
      ],
      onOpenActionGroup,
      onOpenIngredientShopping,
    });
    const primaries = Array.from(view.querySelectorAll('[data-testid="home-action-primary"]')) as HTMLButtonElement[];
    expect(primaries).toHaveLength(2);
    act(() => {
      primaries[0]?.click();
      primaries[1]?.click();
    });
    expect(onOpenActionGroup).toHaveBeenCalledWith(tomato);
    expect(onOpenIngredientShopping).toHaveBeenCalledWith(eggs.ingredientId);
  });
});

describe('HomeMobileDashboard three-question mobile', () => {
  it('keeps the original mobile top structure and stats', () => {
    const view = renderMobile();
    expect(view.textContent).toContain('Culina');
    expect(view.querySelector('button[aria-label="全局搜索"]')).not.toBeNull();
    expect(view.querySelector('button[aria-label="查看提醒"]')).not.toBeNull();
    expect(view.querySelector<HTMLImageElement>('.mobile-dashboard-kitchen img')?.getAttribute('src')).toBe('/assets/kitchen_transparent.webp');
    expect(view.textContent).toContain('测试家庭');
    expect(view.querySelector('[aria-label="家庭信息"]')).not.toBeNull();
    expect(Array.from(view.querySelectorAll('button')).some((button) => button.textContent?.includes('新增食材'))).toBe(true);
    expect(Array.from(view.querySelectorAll('button')).some((button) => button.textContent?.includes('查看记录'))).toBe(true);
    expect(view.querySelectorAll('[data-testid="mobile-home-stat"]')).toHaveLength(4);
  });

  it('renders one full recommendation and advances by one', () => {
    const onNext = vi.fn();
    const view = renderMobile({
      mobileRecommendations: [makeRecommendation(1)],
      recommendationCount: 5,
      onNextMobileRecommendation: onNext,
    });
    expect(view.querySelectorAll('[data-testid="home-recommendation-card"]')).toHaveLength(1);
    expect(view.querySelector('[data-testid="mobile-recommendation-scroller"]')).toBeNull();
    act(() => buttonByText(view, '换一个').click());
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('disables 换一个 only when N <= 1', () => {
    const few = renderMobile({
      mobileRecommendations: [makeRecommendation(0)],
      recommendationCount: 1,
    });
    expect(buttonByText(few, '换一个').disabled).toBe(true);

    act(() => root?.unmount());
    container?.remove();

    const many = renderMobile({
      mobileRecommendations: [makeRecommendation(0)],
      recommendationCount: 2,
    });
    expect(buttonByText(many, '换一个').disabled).toBe(false);
  });

  it('stacks action and highlight questions and limits highlights to three', () => {
    const view = renderMobile({
      homeHighlights: {
        items: Array.from({ length: 5 }, (_, index) => makeHighlight(index)),
        phase: 'ready',
        hasRefreshError: false,
        isRefreshing: false,
        weekCountLabel: '本周协作 5 次',
      },
    });
    const questions = Array.from(view.querySelectorAll('[data-testid="mobile-home-question"]'));
    expect(questions.map((node) => node.getAttribute('data-question'))).toEqual(['1', '2', '3']);
    expect(view.querySelectorAll('[data-testid="home-highlight-row"]')).toHaveLength(3);
  });

  it('renders seven fixed-width calendar buttons in a dedicated scroller', () => {
    const view = renderMobile({
      compactPlanDays: Array.from({ length: 7 }, (_, index) => makePlanDay(index)),
    });
    const scroller = view.querySelector('[data-testid="mobile-home-calendar-scroll"]');
    expect(scroller?.classList.contains('is-mobile-scroll')).toBe(true);
    expect(scroller?.querySelectorAll('button[aria-label^="选择 "]')).toHaveLength(7);
  });

  it('uses 本周协作 -- for no-cache failure and Q2 shopping copy 项待采购', () => {
    const view = renderMobile({
      sidebarActivityLabel: '本周协作 --',
      requiredActions: [{ kind: 'shopping', pendingCount: 5 }],
      homeHighlights: emptyHighlights({
        phase: 'error',
        weekCountLabel: '本周协作 --',
      }),
    });
    expect(view.textContent).toContain('本周协作 --');
    expect(view.textContent).toContain('5 项待采购');
    expect(view.textContent).not.toContain('5 项采购可入库');
  });
});
