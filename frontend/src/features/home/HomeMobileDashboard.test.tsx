// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Food, FoodPlanItem } from '../../api/types';
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

function makePlanItem(id: string, foodName: string, mealType: FoodPlanItem['meal_type']): FoodPlanItem {
  return {
    id,
    family_id: 'family-1',
    user_id: 'user-1',
    food_id: `food-${id}`,
    food_name: foodName,
    food_type: 'dish',
    recipe_id: null,
    recipe_title: '',
    plan_date: '2026-07-06',
    meal_type: mealType,
    note: '',
    status: 'planned',
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
  };
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
    onHomePlanAddEmptyDialogOpen: vi.fn(),
    onHomePlanDetailOpen: vi.fn(),
    onOpenMealPlans: vi.fn(),
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

  it('renders a compact seven-day strip with collapsed meal details by default', () => {
    const view = renderMobile({
      compactPlanDays: Array.from({ length: 7 }, (_, index) => makePlanDay(index)),
    });
    const dayStrip = view.querySelector('[data-testid="mobile-home-calendar-days"]');
    expect(dayStrip?.classList.contains('is-mobile-grid')).toBe(true);
    expect(dayStrip?.querySelectorAll('button[aria-label^="选择 "]')).toHaveLength(7);
    expect(Array.from(dayStrip?.querySelectorAll('.home-compact-mobile-day-number') ?? []).map((node) => node.textContent)).toEqual([
      '6',
      '7',
      '8',
      '9',
      '10',
      '11',
      '12',
    ]);
    expect(view.querySelector('.home-compact-week-controls')?.querySelectorAll('button')).toHaveLength(2);
    expect(Array.from(view.querySelectorAll('button')).some((button) => button.textContent?.trim() === '回到本周')).toBe(false);
    expect(view.querySelector('.home-compact-day-detail-head')).toBeNull();
    const detail = view.querySelector<HTMLElement>('.home-compact-day-detail');
    const toggle = view.querySelector<HTMLButtonElement>('button[aria-label="展开当天安排"]');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(toggle?.textContent).toContain('今天 · 6日');
    expect(toggle?.textContent).toContain('当天还没有安排');
    expect(detail?.hidden).toBe(true);
    act(() => toggle?.click());
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(toggle?.getAttribute('aria-label')).toBe('收起当天安排');
    expect(detail?.hidden).toBe(false);
    expect(view.querySelector('.home-compact-meal-grid')?.classList.contains('is-mobile-list')).toBe(true);
    expect(view.querySelectorAll('.home-compact-meal-slot')).toHaveLength(4);
    expect(buttonByText(view, '完整周菜单')).toBeTruthy();
    expect(view.textContent).toContain('7月6日 - 7月12日');
  });

  it('shows a thumbnail only for meal items that have a cover image', () => {
    const day = makePlanDay(0);
    const picturedItem = makePlanItem('pictured', '番茄炒蛋', 'dinner');
    const textOnlyItem = makePlanItem('text-only', '清蒸三文鱼', 'snack');
    day.mealItems = day.mealItems.map((meal) => {
      if (meal.mealType === 'dinner') return { ...meal, items: [picturedItem] };
      if (meal.mealType === 'snack') return { ...meal, items: [textOnlyItem] };
      return meal;
    });
    day.plannedMealCount = 2;
    day.totalCount = 2;

    const view = renderMobile({
      compactPlanDays: [day],
      selectedDashboardPlanDay: day,
      resolvePlanItemCoverUrl: (item) => (item.id === picturedItem.id ? '/media/番茄炒蛋.webp' : undefined),
    });

    const toggle = view.querySelector<HTMLButtonElement>('button[aria-label="展开当天安排"]');
    expect(toggle).not.toBeNull();
    act(() => toggle?.click());

    const images = view.querySelectorAll<HTMLImageElement>('.home-compact-meal-item-image');
    expect(images).toHaveLength(1);
    expect(images[0]?.getAttribute('src')).toBe('/media/番茄炒蛋.webp');
    expect(buttonByText(view, '番茄炒蛋').querySelector('img')).toBe(images[0]);
    expect(buttonByText(view, '清蒸三文鱼').querySelector('img')).toBeNull();
  });

  it('offers a return-to-current-week action only when browsing another week', () => {
    const view = renderMobile({
      compactPlanDays: Array.from({ length: 7 }, (_, index) => ({
        ...makePlanDay(index),
        isToday: false,
      })),
    });
    expect(buttonByText(view, '回到本周')).toBeTruthy();
  });

  it('keeps the weekly menu mobile layout vertically compact', () => {
    const mobileStyles = readFileSync(resolve(__dirname, '../../styles/07-mobile.css'), 'utf8');
    expect(mobileStyles).toMatch(/\.home-compact-days\.is-mobile-grid > button \{[^}]*min-height: 60px;/s);
    expect(mobileStyles).toMatch(
      /\.home-compact-calendar \{[^}]*padding: 8px 8px 4px;/s,
    );
    expect(mobileStyles).toMatch(
      /\.mobile-home-question\.mobile-dashboard-panel \{[^}]*padding-bottom: 8px;/s,
    );
    expect(mobileStyles).toMatch(/\.home-compact-meal-grid\.is-mobile-list \{[^}]*gap: 4px;/s);
    expect(mobileStyles).toMatch(
      /\.home-compact-meal-grid\.is-mobile-list \.home-compact-meal-slot \{[^}]*min-height: 52px;/s,
    );
  });

  it('keeps required actions vertically compact on mobile without shrinking touch targets', () => {
    const mobileStyles = readFileSync(resolve(__dirname, '../../styles/07-mobile.css'), 'utf8');

    expect(mobileStyles).toMatch(
      /\.home-required-actions \{[^}]*gap: 6px;[^}]*padding: 12px 14px 10px;/s,
    );
    expect(mobileStyles).toMatch(
      /\.home-required-actions \.home-action-list \{[^}]*gap: 6px;/s,
    );
    expect(mobileStyles).toMatch(
      /\.home-required-actions \.home-action-row \{[^}]*grid-template-columns: 34px minmax\(0, 1fr\) auto;[^}]*min-height: 56px;[^}]*padding: 6px 10px;/s,
    );
    expect(mobileStyles).toMatch(
      /\.home-required-actions \.home-action-icon \{[^}]*width: 32px;[^}]*height: 32px;/s,
    );
    expect(mobileStyles).toMatch(
      /\.home-required-actions \.home-action-row \.solid-button \{[^}]*min-height: 44px;[^}]*height: 44px;/s,
    );
    expect(mobileStyles).toMatch(
      /\.home-required-actions \.home-question-more \{[^}]*min-height: 44px;[^}]*margin-top: -4px;/s,
    );
  });

  it('keeps recommendation badges on one line without overflowing the card', () => {
    const mobileStyles = readFileSync(resolve(__dirname, '../../styles/07-mobile.css'), 'utf8');

    expect(mobileStyles).toMatch(
      /\.mobile-dashboard-badge-row :is\(\.badge, \.ui-status-badge\) \{[^}]*min-width: 0;[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/s,
    );
  });

  it('matches the established food and inventory palette without over-darkening light surfaces', () => {
    const dashboardStyles = readFileSync(resolve(__dirname, '../../styles/01-home-dashboard.css'), 'utf8');
    const mobileStyles = readFileSync(resolve(__dirname, '../../styles/07-mobile.css'), 'utf8');

    expect(dashboardStyles).toMatch(
      /\.home-question-one,\s*\.home-question-panel,\s*\.home-compact-calendar \{[^}]*--home-ink: #241714;[^}]*--home-muted: #776a61;[^}]*--home-faint: #a2948a;/s,
    );
    expect(dashboardStyles).toMatch(
      /\.home-question-panel \{[^}]*border: 1px solid rgba\(92, 67, 48, 0\.09\);[^}]*background: #fff;[^}]*box-shadow: 0 14px 32px rgba\(74, 54, 40, 0\.04\);/s,
    );
    expect(dashboardStyles).toMatch(/\.home-question-head h2 \{[^}]*color: var\(--home-ink\);/s);
    expect(dashboardStyles).toMatch(/\.home-action-row\.tone-expired \{[^}]*background: rgba\(253, 235, 232, 0\.5\);/s);
    expect(dashboardStyles).toMatch(/\.home-action-row\.tone-soon \{[^}]*background: rgba\(253, 244, 219, 0\.52\);/s);
    expect(dashboardStyles).toMatch(/\.home-action-row\.tone-later \{[^}]*background: rgba\(235, 245, 233, 0\.5\);/s);
    expect(dashboardStyles).toMatch(/\.home-compact-days > button\.is-selected \{[^}]*background: #fff2e9;/s);
    expect(mobileStyles).toMatch(
      /\.mobile-home-question\.mobile-dashboard-panel \{[^}]*border: 1px solid rgba\(92, 67, 48, 0\.09\);[^}]*background: #fff;[^}]*box-shadow: 0 14px 32px rgba\(74, 54, 40, 0\.04\);/s,
    );
    expect(mobileStyles).toMatch(
      /\.home-compact-day-toggle \{[^}]*border: 1px solid rgba\(92, 67, 48, 0\.09\);[^}]*color: var\(--home-ink\);[^}]*background: #fffdfa;/s,
    );
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
