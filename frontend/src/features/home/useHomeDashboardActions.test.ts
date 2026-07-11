import { describe, expect, it, vi } from 'vitest';
import type {
  CorrectInventoryExpiryDateRequest,
  CorrectStateExpiryDateRequest,
  DisposeExpiredInventoryRequest,
  SetInventoryStateAbsentRequest,
  SnoozeExpiryAlertsRequest,
  SnoozeStateExpiryAlertRequest,
  VersionedInventoryItemRef,
} from '../../api/types';
import { ApiError } from '../../api/request';
import type {
  ExpiryInventoryActionGroup,
  InventoryActionGroup,
  LowStockInventoryActionGroup,
} from '../inventory/inventoryActionModel';
import { useHomeDashboardActions } from './useHomeDashboardActions';
import type { HomeActionCompletionSummary } from './useHomeDashboardState';

const tomatoGroup: ExpiryInventoryActionGroup = {
  kind: 'expiry',
  id: 'expiry:ingredient-tomato',
  ingredientId: 'ingredient-tomato',
  ingredientName: '番茄',
  severity: 'expired',
  batches: [
    {
      inventoryItemId: 'inventory-expired-1',
      rowVersion: 7,
      remainingQuantity: 2,
      unit: '个',
      storageLocation: '冷藏',
      purchaseDate: '2026-06-20',
      expiryDate: '2026-06-25',
      daysLeft: -16,
      expiryAlertSnoozedUntil: null,
      expiryReviewedAt: null,
      expiryReviewedBy: null,
      target: {
        targetKind: 'inventory_item',
        inventoryItemId: 'inventory-expired-1',
        expectedRowVersion: 7,
      },
    },
    {
      inventoryItemId: 'inventory-expired-2',
      rowVersion: 3,
      remainingQuantity: 1,
      unit: '个',
      storageLocation: '冷藏',
      purchaseDate: '2026-06-18',
      expiryDate: '2026-06-22',
      daysLeft: -19,
      expiryAlertSnoozedUntil: null,
      expiryReviewedAt: null,
      expiryReviewedBy: null,
      target: {
        targetKind: 'inventory_item',
        inventoryItemId: 'inventory-expired-2',
        expectedRowVersion: 3,
      },
    },
  ],
  expiredBatchCount: 2,
  todayBatchCount: 0,
  soonBatchCount: 0,
  laterBatchCount: 0,
  totalBatchCount: 2,
  quantityLabels: ['3 个'],
  storageLocations: ['冷藏'],
  earliestExpiryDate: '2026-06-22',
  earliestDaysLeft: -19,
  title: '番茄需要处理',
  detail: '2 批已过期',
  primaryAction: 'manage_expiry',
  targetKind: 'inventory_item',
};

const milkGroup: ExpiryInventoryActionGroup = {
  ...tomatoGroup,
  id: 'expiry:ingredient-milk',
  ingredientId: 'ingredient-milk',
  ingredientName: '牛奶',
  title: '牛奶需要处理',
  detail: '1 批已过期',
  batches: [
    {
      ...tomatoGroup.batches[0],
      inventoryItemId: 'inventory-milk-1',
      rowVersion: 1,
      target: {
        targetKind: 'inventory_item',
        inventoryItemId: 'inventory-milk-1',
        expectedRowVersion: 1,
      },
    },
  ],
  expiredBatchCount: 1,
  totalBatchCount: 1,
  quantityLabels: ['2 个'],
};

const saltStateGroup: ExpiryInventoryActionGroup = {
  kind: 'expiry',
  id: 'expiry:ingredient-salt',
  ingredientId: 'ingredient-salt',
  ingredientName: '盐',
  severity: 'expired',
  batches: [
    {
      inventoryItemId: 'state:inventory-state-salt',
      rowVersion: 2,
      remainingQuantity: 1,
      unit: '',
      storageLocation: '常温',
      purchaseDate: '2026-06-01',
      expiryDate: '2026-07-09',
      daysLeft: -2,
      expiryAlertSnoozedUntil: null,
      expiryReviewedAt: null,
      expiryReviewedBy: null,
      presenceOnly: true,
      target: {
        targetKind: 'ingredient_inventory_state',
        ingredientId: 'ingredient-salt',
        stateId: 'inventory-state-salt',
        expectedRowVersion: 2,
      },
    },
  ],
  expiredBatchCount: 1,
  todayBatchCount: 0,
  soonBatchCount: 0,
  laterBatchCount: 0,
  totalBatchCount: 1,
  quantityLabels: ['只记录整体有无'],
  storageLocations: ['常温'],
  earliestExpiryDate: '2026-07-09',
  earliestDaysLeft: -2,
  title: '盐需要处理',
  detail: '只记录整体有无 · 已过期 · 常温',
  primaryAction: 'manage_expiry',
  targetKind: 'ingredient_inventory_state',
};

const tomatoLowStock: LowStockInventoryActionGroup = {
  kind: 'low_stock',
  id: 'low_stock:ingredient-tomato',
  ingredientId: 'ingredient-tomato',
  ingredientName: '番茄',
  availableQuantity: 1,
  unit: '个',
  threshold: 4,
  title: '番茄库存不足',
  detail: '现有 1 个，补货线 4 个',
  primaryAction: 'add_shopping',
};

const versionedItems: VersionedInventoryItemRef[] = [
  { inventory_item_id: 'inventory-expired-1', expected_row_version: 7 },
  { inventory_item_id: 'inventory-expired-2', expected_row_version: 3 },
];

const stateSelectionItems: VersionedInventoryItemRef[] = [
  { inventory_item_id: 'state:inventory-state-salt', expected_row_version: 2 },
];

function createActions(overrides: {
  selectedActionGroup?: InventoryActionGroup | null;
  disposeExpiredInventory?: (payload: DisposeExpiredInventoryRequest) => Promise<unknown>;
  snoozeInventoryExpiryAlerts?: (payload: SnoozeExpiryAlertsRequest) => Promise<unknown>;
  correctInventoryExpiryDate?: (
    inventoryItemId: string,
    payload: CorrectInventoryExpiryDateRequest,
  ) => Promise<unknown>;
  snoozeStateExpiryAlert?: (
    ingredientId: string,
    payload: SnoozeStateExpiryAlertRequest,
  ) => Promise<unknown>;
  correctStateExpiryDate?: (
    ingredientId: string,
    payload: CorrectStateExpiryDateRequest,
  ) => Promise<unknown>;
  setInventoryStateAbsent?: (
    ingredientId: string,
    payload: SetInventoryStateAbsentRequest,
  ) => Promise<unknown>;
  refreshInventoryActions?: () => Promise<InventoryActionGroup[]>;
  completeActionGroup?: (args: {
    ingredientId: string;
    summary: HomeActionCompletionSummary;
    refreshedGroups?: InventoryActionGroup[];
  }) => void;
  closeActionGroup?: () => void;
  showNotice?: ReturnType<typeof vi.fn>;
  setActionDialogBusy?: (busy: boolean) => void;
  setActionDialogError?: (message: string | null) => void;
  setActionDialogConflict?: (state: 'none' | 'review_again') => void;
} = {}) {
  const showNotice = overrides.showNotice ?? vi.fn();
  const completeActionGroup = overrides.completeActionGroup ?? vi.fn();
  const closeActionGroup = overrides.closeActionGroup ?? vi.fn();
  const refreshInventoryActions =
    overrides.refreshInventoryActions ?? vi.fn(async () => [] as InventoryActionGroup[]);
  const disposeExpiredInventory =
    overrides.disposeExpiredInventory ?? vi.fn(async () => undefined);
  const snoozeInventoryExpiryAlerts =
    overrides.snoozeInventoryExpiryAlerts ?? vi.fn(async () => undefined);
  const correctInventoryExpiryDate =
    overrides.correctInventoryExpiryDate ?? vi.fn(async () => undefined);
  const snoozeStateExpiryAlert = overrides.snoozeStateExpiryAlert ?? vi.fn(async () => undefined);
  const correctStateExpiryDate = overrides.correctStateExpiryDate ?? vi.fn(async () => undefined);
  const setInventoryStateAbsent = overrides.setInventoryStateAbsent ?? vi.fn(async () => undefined);
  const setActionDialogBusy = overrides.setActionDialogBusy ?? vi.fn();
  const setActionDialogError = overrides.setActionDialogError ?? vi.fn();
  const setActionDialogConflict = overrides.setActionDialogConflict ?? vi.fn();

  const actions = useHomeDashboardActions({
    showNotice,
    selectedActionGroup: overrides.selectedActionGroup === undefined ? tomatoGroup : overrides.selectedActionGroup,
    homePlanDetailItem: null,
    homePlanDetailForm: { planDate: '2026-07-11', mealType: 'dinner', note: '' },
    homePlanAddFood: null,
    homePlanAddForm: { planDate: '2026-07-11', mealType: 'dinner', note: '' },
    disposeExpiredInventory,
    snoozeInventoryExpiryAlerts,
    correctInventoryExpiryDate,
    snoozeStateExpiryAlert,
    correctStateExpiryDate,
    setInventoryStateAbsent,
    refreshInventoryActions,
    completeActionGroup,
    closeActionGroup,
    setActionDialogBusy,
    setActionDialogError,
    setActionDialogConflict,
    updateFoodPlanItem: vi.fn(async () => undefined),
    deleteFoodPlanItem: vi.fn(async () => undefined),
    createFoodPlanItem: vi.fn(async () => undefined),
    quickAddMeal: vi.fn(async () => {
      throw new Error('unused');
    }),
    closeHomePlanDetail: vi.fn(),
    closeHomePlanAddDialog: vi.fn(),
    setIsHomePlanDetailEditing: vi.fn(),
    startRecipeCook: vi.fn(),
    openMealLogEnrichment: vi.fn(),
  });

  return {
    actions,
    showNotice,
    completeActionGroup,
    closeActionGroup,
    refreshInventoryActions,
    disposeExpiredInventory,
    snoozeInventoryExpiryAlerts,
    correctInventoryExpiryDate,
    snoozeStateExpiryAlert,
    correctStateExpiryDate,
    setInventoryStateAbsent,
    setActionDialogBusy,
    setActionDialogError,
    setActionDialogConflict,
  };
}

describe('useHomeDashboardActions inventory workflow', () => {
  it('disposes selected batches with versioned payload and completes after awaited refresh', async () => {
    const disposeExpiredInventory = vi.fn(async (_payload: DisposeExpiredInventoryRequest) => undefined);
    const refreshInventoryActions = vi.fn(async () => [milkGroup] as InventoryActionGroup[]);
    const completeActionGroup = vi.fn();
    const setActionDialogBusy = vi.fn();
    const { actions } = createActions({
      disposeExpiredInventory,
      refreshInventoryActions,
      completeActionGroup,
      setActionDialogBusy,
    });

    await actions.disposeSelectedInventoryBatches(versionedItems);

    expect(disposeExpiredInventory).toHaveBeenCalledWith({
      ingredient_id: 'ingredient-tomato',
      items: versionedItems,
    });
    expect(JSON.stringify(disposeExpiredInventory.mock.calls[0]?.[0])).not.toContain('inventory_item_ids');
    expect(refreshInventoryActions).toHaveBeenCalledTimes(1);
    expect(completeActionGroup).toHaveBeenCalledWith({
      ingredientId: 'ingredient-tomato',
      summary: {
        title: '已处理番茄',
        message: '过期批次已销毁',
      },
      refreshedGroups: [milkGroup],
    });
    expect(setActionDialogBusy).toHaveBeenCalledWith(true);
    expect(setActionDialogBusy).toHaveBeenLastCalledWith(false);
  });

  it('snoozes with explicit retain_expired action and versioned refs', async () => {
    const snoozeInventoryExpiryAlerts = vi.fn(async (_payload: SnoozeExpiryAlertsRequest) => undefined);
    const refreshInventoryActions = vi.fn(async () => [] as InventoryActionGroup[]);
    const { actions } = createActions({
      snoozeInventoryExpiryAlerts,
      refreshInventoryActions,
    });

    await actions.snoozeSelectedInventoryAlerts({
      action: 'retain_expired',
      items: versionedItems,
      snoozedUntil: '2026-07-12',
    });

    expect(snoozeInventoryExpiryAlerts).toHaveBeenCalledWith({
      action: 'retain_expired',
      ingredient_id: 'ingredient-tomato',
      items: versionedItems,
      snoozed_until: '2026-07-12',
    });
    expect(refreshInventoryActions).toHaveBeenCalledTimes(1);
  });

  it('corrects a single batch expiry date with expected row version', async () => {
    const correctInventoryExpiryDate = vi.fn(
      async (_id: string, _payload: CorrectInventoryExpiryDateRequest) => undefined,
    );
    const refreshInventoryActions = vi.fn(async () => [] as InventoryActionGroup[]);
    const { actions } = createActions({
      correctInventoryExpiryDate,
      refreshInventoryActions,
    });

    await actions.correctSelectedInventoryExpiryDate({
      inventoryItemId: 'inventory-expired-1',
      expectedRowVersion: 7,
      expiryDate: '2026-07-20',
    });

    expect(correctInventoryExpiryDate).toHaveBeenCalledWith('inventory-expired-1', {
      expiry_date: '2026-07-20',
      expected_row_version: 7,
    });
    expect(refreshInventoryActions).toHaveBeenCalledTimes(1);
  });

  it('on 409 with surviving group refreshes and requires review again without closing', async () => {
    const disposeExpiredInventory = vi.fn(async () => {
      throw new ApiError({
        status: 409,
        detail: 'stale',
        path: '/api/inventory/dispose-expired',
        payload: null,
      });
    });
    const refreshInventoryActions = vi.fn(async () => [tomatoGroup] as InventoryActionGroup[]);
    const closeActionGroup = vi.fn();
    const completeActionGroup = vi.fn();
    const setActionDialogConflict = vi.fn();
    const setActionDialogError = vi.fn();
    const showNotice = vi.fn();
    const { actions } = createActions({
      disposeExpiredInventory,
      refreshInventoryActions,
      closeActionGroup,
      completeActionGroup,
      setActionDialogConflict,
      setActionDialogError,
      showNotice,
    });

    await actions.disposeSelectedInventoryBatches(versionedItems);

    expect(refreshInventoryActions).toHaveBeenCalledTimes(1);
    expect(closeActionGroup).not.toHaveBeenCalled();
    expect(completeActionGroup).not.toHaveBeenCalled();
    expect(setActionDialogConflict).toHaveBeenCalledWith('review_again');
    expect(setActionDialogError).toHaveBeenCalledWith(
      expect.stringContaining('家人刚刚改动了这批库存'),
    );
    expect(showNotice).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: '这批库存已由家人处理' }),
    );
  });

  it('on 409 with missing group closes and shows already-handled notice', async () => {
    const disposeExpiredInventory = vi.fn(async () => {
      throw new ApiError({
        status: 409,
        detail: 'stale',
        path: '/api/inventory/dispose-expired',
        payload: null,
      });
    });
    const refreshInventoryActions = vi.fn(async () => [milkGroup] as InventoryActionGroup[]);
    const closeActionGroup = vi.fn();
    const showNotice = vi.fn();
    const setActionDialogConflict = vi.fn();
    const { actions } = createActions({
      disposeExpiredInventory,
      refreshInventoryActions,
      closeActionGroup,
      showNotice,
      setActionDialogConflict,
    });

    await actions.disposeSelectedInventoryBatches(versionedItems);

    expect(closeActionGroup).toHaveBeenCalledTimes(1);
    expect(showNotice).toHaveBeenCalledWith({
      tone: 'success',
      title: '这批库存已由家人处理',
      message: expect.stringContaining('番茄') as string,
    });
    expect(setActionDialogConflict).toHaveBeenCalledWith('none');
  });

  it('preserves dialog inputs on network errors without completing', async () => {
    const disposeExpiredInventory = vi.fn(async () => {
      throw new Error('network down');
    });
    const closeActionGroup = vi.fn();
    const completeActionGroup = vi.fn();
    const refreshInventoryActions = vi.fn(async () => [] as InventoryActionGroup[]);
    const setActionDialogError = vi.fn();
    const setActionDialogConflict = vi.fn();
    const { actions } = createActions({
      disposeExpiredInventory,
      closeActionGroup,
      completeActionGroup,
      refreshInventoryActions,
      setActionDialogError,
      setActionDialogConflict,
    });

    await actions.disposeSelectedInventoryBatches(versionedItems);

    expect(closeActionGroup).not.toHaveBeenCalled();
    expect(completeActionGroup).not.toHaveBeenCalled();
    expect(refreshInventoryActions).not.toHaveBeenCalled();
    expect(setActionDialogConflict).not.toHaveBeenCalledWith('review_again');
    expect(setActionDialogError).toHaveBeenCalledWith('network down');
  });

  it('exposes low-stock secondary action when the completed ingredient becomes low stock', async () => {
    const disposeExpiredInventory = vi.fn(async () => undefined);
    const refreshInventoryActions = vi.fn(
      async () => [tomatoLowStock, milkGroup] as InventoryActionGroup[],
    );
    const completeActionGroup = vi.fn();
    const { actions } = createActions({
      disposeExpiredInventory,
      refreshInventoryActions,
      completeActionGroup,
    });

    await actions.disposeSelectedInventoryBatches(versionedItems);

    expect(completeActionGroup).toHaveBeenCalledWith({
      ingredientId: 'ingredient-tomato',
      summary: {
        title: '已处理番茄',
        message: '过期批次已销毁',
        secondaryActionLabel: '番茄库存已不足，加入采购',
        secondaryActionIngredientId: 'ingredient-tomato',
      },
      refreshedGroups: [tomatoLowStock, milkGroup],
    });
  });

  it('treats write success + refresh failure as completed work, not write failure', async () => {
    const disposeExpiredInventory = vi.fn(async () => undefined);
    const refreshInventoryActions = vi.fn(async () => {
      throw new Error('refresh offline');
    });
    const completeActionGroup = vi.fn();
    const closeActionGroup = vi.fn();
    const setActionDialogError = vi.fn();
    const showNotice = vi.fn();
    const { actions } = createActions({
      disposeExpiredInventory,
      refreshInventoryActions,
      completeActionGroup,
      closeActionGroup,
      setActionDialogError,
      showNotice,
    });

    await actions.disposeSelectedInventoryBatches(versionedItems);

    expect(disposeExpiredInventory).toHaveBeenCalledTimes(1);
    expect(completeActionGroup).not.toHaveBeenCalled();
    expect(closeActionGroup).toHaveBeenCalledTimes(1);
    expect(setActionDialogError).not.toHaveBeenCalledWith('refresh offline');
    expect(showNotice).toHaveBeenCalledWith({
      tone: 'warning',
      title: '操作已完成，但数据刷新失败',
      message: 'refresh offline',
    });
  });

  it('keeps dialog open with review guidance when 409 recovery refresh fails', async () => {
    const disposeExpiredInventory = vi.fn(async () => {
      throw new ApiError({
        status: 409,
        detail: 'stale',
        path: '/api/inventory/dispose-expired',
        payload: null,
      });
    });
    const refreshInventoryActions = vi.fn(async () => {
      throw new Error('conflict refresh failed');
    });
    const closeActionGroup = vi.fn();
    const completeActionGroup = vi.fn();
    const setActionDialogConflict = vi.fn();
    const setActionDialogError = vi.fn();
    const { actions } = createActions({
      disposeExpiredInventory,
      refreshInventoryActions,
      closeActionGroup,
      completeActionGroup,
      setActionDialogConflict,
      setActionDialogError,
    });

    await actions.disposeSelectedInventoryBatches(versionedItems);

    expect(closeActionGroup).not.toHaveBeenCalled();
    expect(completeActionGroup).not.toHaveBeenCalled();
    expect(setActionDialogConflict).toHaveBeenCalledWith('review_again');
    expect(setActionDialogError).toHaveBeenCalledWith(
      '家人可能改动了这批库存，但刷新失败，请稍后重试。',
    );
  });

  it('uses outcome-specific completion copy for snooze and correct', async () => {
    const completeActionGroup = vi.fn();
    const refreshInventoryActions = vi.fn(async () => [] as InventoryActionGroup[]);
    const snoozeInventoryExpiryAlerts = vi.fn(async () => undefined);
    const correctInventoryExpiryDate = vi.fn(async () => undefined);

    const snoozeActions = createActions({
      snoozeInventoryExpiryAlerts,
      refreshInventoryActions,
      completeActionGroup,
    }).actions;
    await snoozeActions.snoozeSelectedInventoryAlerts({
      action: 'retain_expired',
      items: versionedItems,
      snoozedUntil: '2026-07-12',
    });
    expect(completeActionGroup).toHaveBeenLastCalledWith(
      expect.objectContaining({
        summary: expect.objectContaining({ message: '已暂时保留，到提醒日会再出现' }),
      }),
    );

    completeActionGroup.mockClear();
    const correctActions = createActions({
      correctInventoryExpiryDate,
      refreshInventoryActions,
      completeActionGroup,
    }).actions;
    await correctActions.correctSelectedInventoryExpiryDate({
      inventoryItemId: 'inventory-expired-1',
      expectedRowVersion: 7,
      expiryDate: '2026-07-20',
    });
    expect(completeActionGroup).toHaveBeenLastCalledWith(
      expect.objectContaining({
        summary: expect.objectContaining({ message: '到期日已更正' }),
      }),
    );
  });
});

describe('useHomeDashboardActions state-target routing', () => {
  it('disposes presence State via setInventoryStateAbsent and skips batch dispose', async () => {
    const setInventoryStateAbsent = vi.fn(async () => undefined);
    const disposeExpiredInventory = vi.fn(async () => undefined);
    const refreshInventoryActions = vi.fn(async () => [] as InventoryActionGroup[]);
    const completeActionGroup = vi.fn();
    const { actions } = createActions({
      selectedActionGroup: saltStateGroup,
      setInventoryStateAbsent,
      disposeExpiredInventory,
      refreshInventoryActions,
      completeActionGroup,
    });

    await actions.disposeSelectedInventoryBatches(stateSelectionItems);

    expect(setInventoryStateAbsent).toHaveBeenCalledWith('ingredient-salt', {
      state_id: 'inventory-state-salt',
      expected_row_version: 2,
    });
    expect(disposeExpiredInventory).not.toHaveBeenCalled();
    expect(completeActionGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        ingredientId: 'ingredient-salt',
        summary: expect.objectContaining({ message: '已标记为没有' }),
      }),
    );
  });

  it('retains/snoozes presence State via snoozeStateExpiryAlert and skips batch snooze', async () => {
    const snoozeStateExpiryAlert = vi.fn(async () => undefined);
    const snoozeInventoryExpiryAlerts = vi.fn(async () => undefined);
    const refreshInventoryActions = vi.fn(async () => [] as InventoryActionGroup[]);
    const completeActionGroup = vi.fn();
    const { actions } = createActions({
      selectedActionGroup: saltStateGroup,
      snoozeStateExpiryAlert,
      snoozeInventoryExpiryAlerts,
      refreshInventoryActions,
      completeActionGroup,
    });

    await actions.snoozeSelectedInventoryAlerts({
      action: 'retain_expired',
      items: stateSelectionItems,
      snoozedUntil: '2026-07-15',
    });

    expect(snoozeStateExpiryAlert).toHaveBeenCalledWith('ingredient-salt', {
      action: 'retain_expired',
      state_id: 'inventory-state-salt',
      expected_row_version: 2,
      snoozed_until: '2026-07-15',
    });
    expect(snoozeInventoryExpiryAlerts).not.toHaveBeenCalled();
    expect(completeActionGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        ingredientId: 'ingredient-salt',
        summary: expect.objectContaining({ message: '已暂时保留，到提醒日会再出现' }),
      }),
    );
  });

  it('corrects presence State expiry via correctStateExpiryDate and skips batch correct', async () => {
    const correctStateExpiryDate = vi.fn(async () => undefined);
    const correctInventoryExpiryDate = vi.fn(async () => undefined);
    const refreshInventoryActions = vi.fn(async () => [] as InventoryActionGroup[]);
    const completeActionGroup = vi.fn();
    const { actions } = createActions({
      selectedActionGroup: saltStateGroup,
      correctStateExpiryDate,
      correctInventoryExpiryDate,
      refreshInventoryActions,
      completeActionGroup,
    });

    await actions.correctSelectedInventoryExpiryDate({
      inventoryItemId: 'state:inventory-state-salt',
      expectedRowVersion: 2,
      expiryDate: '2026-08-01',
    });

    expect(correctStateExpiryDate).toHaveBeenCalledWith('ingredient-salt', {
      state_id: 'inventory-state-salt',
      expected_row_version: 2,
      expiry_date: '2026-08-01',
    });
    expect(correctInventoryExpiryDate).not.toHaveBeenCalled();
    expect(completeActionGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        ingredientId: 'ingredient-salt',
        summary: expect.objectContaining({ message: '到期日已更正' }),
      }),
    );
  });
});
