// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ExactIngredientReconciliationGroup,
  FoodReconciliationGroup,
  InventoryOperationResult,
  PresenceIngredientReconciliationGroup,
  ReconciliationBatch,
} from '../../api/types';
import { InventoryReconciliationDialog } from './InventoryReconciliationDialog';
import {
  buildBatchCreateIntent,
  buildBatchUpdateFromGroup,
  buildExactAdjustBatchesIntent,
  buildExactConfirmAllIntent,
  buildFoodConfirmIntent,
  buildFoodSetStockIntent,
  buildPresenceIntent,
  createEmptyDraft,
  type InventoryReconciliationDraft,
  type ReconciliationIntent,
} from './inventoryReconciliationModel';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function makeBatch(
  overrides: Partial<ReconciliationBatch> & Pick<ReconciliationBatch, 'inventory_item_id'>,
): ReconciliationBatch {
  return {
    row_version: 1,
    remaining_quantity: 3,
    unit: '个',
    status: 'fresh',
    purchase_date: '2026-07-01',
    expiry_date: '2026-07-20',
    storage_location: '冷藏',
    notes: '',
    confirmation_status: 'never_confirmed',
    last_confirmed_at: null,
    ...overrides,
  };
}

const exactGroup: ExactIngredientReconciliationGroup = {
  kind: 'exact_ingredient',
  ingredient_id: 'ing-egg',
  ingredient_name: '鸡蛋',
  ingredient_row_version: 4,
  confirmation_status: 'never_confirmed',
  last_confirmed_at: null,
  batches: [
    makeBatch({ inventory_item_id: 'batch-1', remaining_quantity: 4 }),
    makeBatch({
      inventory_item_id: 'batch-expired',
      remaining_quantity: 1,
      expiry_date: '2026-07-01',
      storage_location: '冷藏',
    }),
  ],
  pending_shopping_item_id: null,
};

const presenceGroup: PresenceIngredientReconciliationGroup = {
  kind: 'presence_ingredient',
  ingredient_id: 'ing-salt',
  ingredient_name: '盐',
  ingredient_row_version: 2,
  confirmation_status: 'stale',
  pending_shopping_item_id: null,
  state: {
    id: 'state-salt',
    family_id: 'family-1',
    ingredient_id: 'ing-salt',
    availability_level: 'sufficient',
    inventory_status: 'fresh',
    purchase_date: '2026-06-01',
    expiry_date: null,
    storage_location: '常温',
    notes: '',
    expiry_alert_snoozed_until: null,
    expiry_reviewed_at: null,
    expiry_reviewed_by: null,
    last_confirmed_at: '2026-06-01T00:00:00.000Z',
    last_confirmed_by: null,
    last_confirmation_source: 'manual_entry',
    row_version: 1,
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
  },
};

const foodGroup: FoodReconciliationGroup = {
  kind: 'food',
  food_id: 'food-beef',
  food_name: '卤牛肉',
  row_version: 3,
  stock_quantity: 2,
  stock_unit: '份',
  expiry_date: '2026-07-15',
  storage_location: '冷藏',
  confirmation_status: 'current',
  last_confirmed_at: '2026-07-10T00:00:00.000Z',
};

function makeDraft(intents: ReconciliationIntent[] = []): InventoryReconciliationDraft {
  return {
    ...createEmptyDraft({
      familyId: 'family-1',
      userId: 'user-1',
      scope: 'suggested',
      now: '2026-07-11T08:00:00.000Z',
      clientRequestId: 'client-1',
    }),
    intents,
  };
}

const result: InventoryOperationResult = {
  operation_id: 'op-1',
  operation_type: 'reconciliation',
  status: 'applied',
  applied_at: '2026-07-12T08:01:00.000Z',
  // Keep revertible window in the future relative to the suite wall clock.
  revertible_until: '2099-07-12T08:16:00.000Z',
  can_revert: true,
  summary: {
    title: '本次盘点已完成',
    description: '确认 1 项，调整 1 项',
    confirmed_count: 1,
    adjusted_count: 1,
    completed_count: 2,
    partial_count: 0,
  },
};

function renderDialog(props: Partial<Parameters<typeof InventoryReconciliationDialog>[0]> = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const draft = props.draft ?? makeDraft();
  const groups = props.groups ?? [exactGroup, presenceGroup, foodGroup];
  const defaults: Parameters<typeof InventoryReconciliationDialog>[0] = {
    open: true,
    step: 'review',
    scope: 'suggested',
    draft,
    groups,
    orderedGroups: groups,
    referenceDate: '2026-07-11',
    loading: false,
    busy: false,
    errorMessage: null,
    fieldErrors: [],
    conflictState: 'none',
    result: null,
    summary: {
      confirmCount: draft.intents.filter((intent) => {
        if (intent.kind === 'exact_ingredient') return intent.action === 'confirm_all';
        if (intent.kind === 'presence_ingredient') {
          return intent.availabilityLevel === 'present_unknown' || intent.availabilityLevel === 'sufficient';
        }
        return intent.action === 'confirm';
      }).length,
      adjustedCount: 0,
      lowCount: 0,
      absentCount: 0,
      createdBatchCount: 0,
      totalTouched: draft.intents.length,
    },
    checkedCount: draft.intents.length,
    totalCount: groups.length,
    canSubmit: draft.intents.length > 0,
    expandedBatchGroupKeys: [],
    onClose: vi.fn(),
    onChangeScope: vi.fn(),
    onToggleBatchDetails: vi.fn(),
    onSetIntent: vi.fn(),
    onClearIntent: vi.fn(),
    onGoSummary: vi.fn(),
    onGoReview: vi.fn(),
    onSubmit: vi.fn(),
    onRetry: vi.fn(),
    ...props,
  };
  act(() => {
    root!.render(<InventoryReconciliationDialog {...defaults} />);
  });
  return defaults;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('InventoryReconciliationDialog', () => {
  it('renders scope chips, progress, and household group cards without dense table', () => {
    renderDialog();
    expect(container!.textContent).toContain('快速盘点');
    expect(container!.textContent).toContain('建议确认');
    expect(container!.textContent).toContain('冷藏');
    expect(container!.textContent).toContain('冷冻');
    expect(container!.textContent).toContain('常温');
    expect(container!.textContent).toContain('全部');
    expect(container!.textContent).toContain('进度 0 / 3');
    expect(container!.textContent).toContain('鸡蛋');
    expect(container!.textContent).toContain('盐');
    expect(container!.textContent).toContain('卤牛肉');
    expect(container!.querySelector('table')).toBeNull();
    expect(container!.textContent).toContain('确认无误');
    expect(container!.textContent).toContain('调整数量');
    expect(container!.textContent).toContain('没有了');
    expect(container!.textContent).toContain('还在');
    expect(container!.textContent).toContain('少量');
    expect(container!.textContent).toContain('充足');
    expect(container!.textContent).toContain('聚合库存');
  });

  it('fires exact confirm/adjust/absent actions with exact labels', () => {
    const props = renderDialog();
    const confirm = Array.from(container!.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('确认无误'),
    );
    const adjust = Array.from(container!.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('调整数量'),
    );
    const absent = Array.from(container!.querySelectorAll('button')).find(
      (button) => button.textContent === '没有了' && button.getAttribute('data-field-key')?.includes('ing-egg'),
    );
    expect(confirm).toBeTruthy();
    act(() => {
      confirm!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(props.onSetIntent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'exact_ingredient', action: 'confirm_all' }),
    );

    act(() => {
      adjust!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(props.onSetIntent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'exact_ingredient', action: 'adjust_batches' }),
    );

    act(() => {
      absent!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(props.onSetIntent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'exact_ingredient', action: 'set_absent' }),
    );
  });

  it('renders presence four-state chips and food aggregate warning', () => {
    const props = renderDialog();
    expect(container!.textContent).toContain('只记录整体状态');
    expect(container!.textContent).toContain('成品是聚合库存');

    // Presence chips stay unselected until explicit intent (current state is sufficient).
    const presenceGroupEl = Array.from(
      container!.querySelectorAll('[data-group-key="presence_ingredient:ing-salt"]'),
    )[0];
    expect(presenceGroupEl).toBeTruthy();
    const selectedInPresence = presenceGroupEl.querySelectorAll(
      '.ui-option-chip.is-selected',
    );
    expect(selectedInPresence.length).toBe(0);

    const low = Array.from(container!.querySelectorAll('button')).find((button) => button.textContent === '少量');
    act(() => {
      low!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(props.onSetIntent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'presence_ingredient', availabilityLevel: 'low' }),
    );
  });

  it('renders mapped Food field errors and constrains aggregate stock to one decimal', () => {
    renderDialog({
      groups: [foodGroup],
      orderedGroups: [foodGroup],
      draft: makeDraft([buildFoodSetStockIntent({ group: foodGroup, stockQuantity: '2' })]),
      fieldErrors: [
        {
          targetKey: 'food:food-beef',
          field: 'stockQuantity',
          code: 'invalid_quantity',
          message: '库存数量最多保留 1 位小数。',
        },
        {
          targetKey: 'food:food-beef',
          field: 'storageLocation',
          code: 'invalid_target',
          message: '请填写存放位置。',
        },
      ],
    });

    expect(container!.textContent).toContain('库存数量最多保留 1 位小数。');
    expect(container!.textContent).toContain('请填写存放位置。');
    expect(
      container!.querySelector<HTMLInputElement>('[data-field-key="food:food-beef:stockQuantity"]')?.step,
    ).toBe('0.1');
  });

  it('shows expired physical batch after expansion', () => {
    renderDialog({
      expandedBatchGroupKeys: ['exact_ingredient:ing-egg'],
      draft: makeDraft([buildExactConfirmAllIntent(exactGroup)]),
    });
    expect(container!.textContent).toContain('已过期');
    expect(container!.textContent).toContain('增加漏记批次');
  });

  it('renders mapped exact-batch date and unit errors next to the editable batch controls', () => {
    const update = buildBatchUpdateFromGroup(exactGroup, 'batch-1')!;
    const create = buildBatchCreateIntent({
      clientLineId: 'line-1',
      actualRemainingQuantity: '1',
      unit: '个',
      inventoryStatus: 'fresh',
      purchaseDate: '2026-07-11',
      expiryDate: null,
      storageLocation: '冷藏',
    });
    renderDialog({
      expandedBatchGroupKeys: ['exact_ingredient:ing-egg'],
      draft: makeDraft([
        buildExactAdjustBatchesIntent({
          group: exactGroup,
          updates: [update],
          creates: [create],
        }),
      ]),
      fieldErrors: [
        {
          targetKey: 'exact_ingredient:ing-egg',
          field: 'batch:batch-1:expiryDate',
          code: 'invalid_date_range',
          message: '原批次的到期日不能早于购买日期。',
        },
        {
          targetKey: 'exact_ingredient:ing-egg',
          field: 'create:line-1:unit',
          code: 'incompatible_unit',
          message: '新增批次的单位不受支持。',
        },
      ],
    });

    expect(container!.textContent).toContain('原批次的到期日不能早于购买日期。');
    expect(container!.textContent).toContain('新增批次的单位不受支持。');
    expect(
      container!.querySelector('[data-field-key="exact_ingredient:ing-egg:create:line-1:unit"]'),
    ).toBeTruthy();
  });

  it('batch create click produces adjust intent with create line', () => {
    const props = renderDialog({
      expandedBatchGroupKeys: ['exact_ingredient:ing-egg'],
      draft: makeDraft(),
    });
    const create = Array.from(container!.querySelectorAll('button')).find(
      (button) => button.textContent === '增加漏记批次',
    );
    expect(create).toBeTruthy();
    act(() => {
      create!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(props.onSetIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'exact_ingredient',
        action: 'adjust_batches',
        creates: expect.arrayContaining([
          expect.objectContaining({
            actualRemainingQuantity: '1',
            unit: '个',
          }),
        ]),
      }),
    );
  });

  it('renders submit summary, empty, loading, conflict and result states', () => {
    renderDialog({
      step: 'summary',
      draft: makeDraft([
        buildExactConfirmAllIntent(exactGroup),
        buildPresenceIntent({ group: presenceGroup, availabilityLevel: 'low' }),
        buildFoodConfirmIntent(foodGroup),
      ]),
      summary: {
        confirmCount: 2,
        adjustedCount: 0,
        lowCount: 1,
        absentCount: 0,
        createdBatchCount: 0,
        totalTouched: 3,
      },
      canSubmit: true,
    });
    expect(container!.textContent).toContain('确认提交摘要');
    expect(container!.textContent).toContain('确认无误');
    expect(container!.textContent).toContain('标记少量');
    expect(container!.textContent).toContain('确认提交盘点');

    act(() => root?.unmount());
    container?.remove();
    renderDialog({ loading: true, groups: [], orderedGroups: [], draft: makeDraft() });
    expect(container!.textContent).toContain('正在准备盘点清单');

    act(() => root?.unmount());
    container?.remove();
    renderDialog({ groups: [], orderedGroups: [], draft: makeDraft() });
    expect(container!.textContent).toContain('这个范围没有需要盘点的项目');

    act(() => root?.unmount());
    container?.remove();
    const conflictProps = renderDialog({
      conflictState: 'stale_version',
      errorMessage: '家人可能刚改动了库存',
    });
    expect(container!.textContent).toContain('需要重新确认');
    const retry = Array.from(container!.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('重试提交'),
    );
    act(() => {
      retry!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(conflictProps.onRetry).toHaveBeenCalled();

    act(() => root?.unmount());
    container?.remove();
    renderDialog({ step: 'result', result, draft: makeDraft() });
    expect(container!.textContent).toContain('本次盘点已完成');
    expect(container!.textContent).toContain('可在');
    expect(container!.textContent).toContain('前撤销');
  });

  it('blocks close while busy and exposes mobile action bar', () => {
    const props = renderDialog({ busy: true });
    const closeButtons = Array.from(container!.querySelectorAll('button')).filter((button) =>
      (button.getAttribute('aria-label') || button.textContent || '').includes('关闭'),
    );
    act(() => {
      closeButtons[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(props.onClose).not.toHaveBeenCalled();
    expect(container!.querySelector('.inventory-maintenance-mobile-actions')).not.toBeNull();
    expect(container!.querySelector('.inventory-maintenance-desktop-actions')).not.toBeNull();
  });

  it('changes scope via chips', () => {
    const props = renderDialog();
    const refrigerated = Array.from(container!.querySelectorAll('button')).find(
      (button) => button.textContent === '冷藏',
    );
    act(() => {
      refrigerated!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(props.onChangeScope).toHaveBeenCalledWith('refrigerated');
  });
});
