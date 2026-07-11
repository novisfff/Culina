// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/request';
import type {
  CorrectInventoryExpiryDateRequest,
  DisposeExpiredInventoryRequest,
  SnoozeExpiryAlertsRequest,
  VersionedInventoryItemRef,
} from '../../api/types';
import type { ExpiryInventoryActionGroup } from '../../features/inventory/inventoryActionModel';
import type {
  ConsumeDialogFormState,
  InventoryDrawerFormState,
  ShoppingDialogFormState,
} from './ingredientWorkspaceForms';
import { IngredientWorkspaceOverlays } from './IngredientWorkspaceOverlays';
import type { OverlayLayerProps } from './IngredientWorkspaceOverlayTypes';
import { useIngredientActionState } from './useIngredientActionState';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

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
      inventoryItemId: 'inventory-upcoming-1',
      rowVersion: 3,
      remainingQuantity: 1,
      unit: '个',
      storageLocation: '冷藏',
      purchaseDate: '2026-07-08',
      expiryDate: '2026-07-13',
      daysLeft: 2,
      expiryAlertSnoozedUntil: null,
      expiryReviewedAt: null,
      expiryReviewedBy: null,
      target: {
        targetKind: 'inventory_item',
        inventoryItemId: 'inventory-upcoming-1',
        expectedRowVersion: 3,
      },
    },
  ],
  expiredBatchCount: 1,
  todayBatchCount: 0,
  soonBatchCount: 1,
  laterBatchCount: 0,
  totalBatchCount: 2,
  quantityLabels: ['3 个'],
  storageLocations: ['冷藏'],
  earliestExpiryDate: '2026-06-25',
  earliestDaysLeft: -16,
  title: '番茄需要处理',
  detail: '1 批已过期，1 批 3 天内到期',
  primaryAction: 'manage_expiry',
  targetKind: 'inventory_item',
};

const versionedItems: VersionedInventoryItemRef[] = [
  { inventory_item_id: 'inventory-expired-1', expected_row_version: 7 },
];

const emptyInventoryForm: InventoryDrawerFormState = {
  ingredientId: '',
  ingredientQuery: '',
  ingredientLocked: false,
  quantity: '1',
  unit: '个',
  status: 'fresh',
  statusDirty: false,
  purchaseDate: '2026-07-11',
  purchaseDatePreset: 'today',
  expiryInputMode: 'days',
  expiryDays: '3',
  expiryDate: '',
  storageLocation: '冷藏',
  notes: '',
};

const emptyConsumeForm: ConsumeDialogFormState = {
  ingredientId: '',
  unit: '',
  quantity: '',
};

const emptyShoppingForm: ShoppingDialogFormState = {
  targetType: 'ingredient',
  title: '',
  quantity: '1',
  unit: '个',
  ingredientId: '',
  foodId: '',
  reason: '',
};

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function baseOverlayProps(overrides: Partial<OverlayLayerProps> = {}): OverlayLayerProps {
  return {
    overlayMode: 'inventoryAction',
    closeOverlay: vi.fn(),
    inventoryForm: emptyInventoryForm,
    setInventoryForm: vi.fn(),
    inventoryAdvancedOpen: false,
    setInventoryAdvancedOpen: vi.fn(),
    consumeForm: emptyConsumeForm,
    setConsumeForm: vi.fn(),
    shoppingForm: emptyShoppingForm,
    setShoppingForm: vi.fn(),
    inventoryActionIngredientId: 'ingredient-tomato',
    inventoryActionGroup: tomatoGroup,
    inventoryActionReferenceDate: '2026-07-11',
    inventoryActionBusy: false,
    inventoryActionError: null,
    inventoryActionConflict: 'none',
    ingredients: [],
    foods: [],
    ingredientSummaries: [],
    quickRestockIngredients: [],
    submitInventory: vi.fn(async () => undefined),
    submitConsume: vi.fn(async () => undefined),
    submitShopping: vi.fn(async () => undefined),
    disposeSelectedInventoryBatches: vi.fn(async () => undefined),
    snoozeSelectedInventoryAlerts: vi.fn(async () => undefined),
    correctSelectedInventoryExpiryDate: vi.fn(async () => undefined),
    ...overrides,
  };
}

function renderOverlays(overrides: Partial<OverlayLayerProps> = {}) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const props = baseOverlayProps(overrides);
  act(() => {
    root?.render(<IngredientWorkspaceOverlays {...props} />);
  });
  return { props, view: container };
}

function clickButton(view: HTMLElement, label: string) {
  const button = [...view.querySelectorAll('button')].find((node) => node.textContent?.includes(label));
  expect(button, `button "${label}"`).toBeTruthy();
  act(() => button?.click());
  return button as HTMLButtonElement;
}

describe('IngredientWorkspaceOverlays inventory action dialog', () => {
  it('renders InventoryActionDialog with versioned batch rows for an expiry group', () => {
    const { view } = renderOverlays();

    expect(view.textContent).toContain('番茄需要处理');
    expect(view.textContent).toContain('已过期批次');
    expect(view.textContent).toContain('即将到期批次');
    expect(view.querySelector('input[value="inventory-expired-1"]')).not.toBeNull();
    expect(view.querySelector('input[value="inventory-upcoming-1"]')).not.toBeNull();
    expect(view.querySelector('.inventory-action-modal')).not.toBeNull();
    expect(view.querySelector('.destroy-expired-row')).toBeNull();
  });

  it('sends explicit retain_expired snooze action type from the shared dialog', async () => {
    const snoozeSelectedInventoryAlerts = vi.fn(async () => undefined);
    const { view } = renderOverlays({ snoozeSelectedInventoryAlerts });

    clickButton(view, '暂时保留');
    await act(async () => {
      clickButton(view, '确认暂时保留');
    });

    expect(snoozeSelectedInventoryAlerts).toHaveBeenCalledWith({
      action: 'retain_expired',
      items: versionedItems,
      snoozedUntil: '2026-07-12',
    });
  });

  it('keeps the dialog open after a stale conflict until refreshed data is reviewed', async () => {
    const disposeSelectedInventoryBatches = vi.fn(async () => {
      throw new ApiError({
        status: 409,
        detail: 'stale',
        path: '/api/inventory/dispose-expired',
        payload: null,
      });
    });
    const closeOverlay = vi.fn();
    const { view } = renderOverlays({
      disposeSelectedInventoryBatches,
      closeOverlay,
      inventoryActionConflict: 'review_again',
      inventoryActionError: '家人刚刚改动了这批库存，请重新选择后再提交。',
    });

    expect(view.textContent).toContain('重新确认');
    expect(view.textContent).toContain('家人刚刚改动了这批库存');

    clickButton(view, '销毁所选批次');
    clickButton(view, '销毁所选批次');
    await act(async () => {
      clickButton(view, '确认销毁');
    });

    expect(disposeSelectedInventoryBatches).toHaveBeenCalledWith(versionedItems);
    expect(closeOverlay).not.toHaveBeenCalled();
    expect(view.querySelector('.inventory-action-modal')).not.toBeNull();
  });
});

describe('useIngredientActionState inventory action mutations', () => {
  function createActions(overrides: {
    inventoryActionIngredientId?: string | null;
    inventoryActionGroup?: ExpiryInventoryActionGroup | null;
    disposeExpiredInventory?: (payload: DisposeExpiredInventoryRequest) => Promise<unknown>;
    snoozeInventoryExpiryAlerts?: (payload: SnoozeExpiryAlertsRequest) => Promise<unknown>;
    correctInventoryExpiryDate?: (
      inventoryItemId: string,
      payload: CorrectInventoryExpiryDateRequest,
    ) => Promise<unknown>;
    refreshInventoryActionGroup?: (
      ingredientId: string,
    ) => Promise<ExpiryInventoryActionGroup | null>;
    closeOverlay?: () => void;
    setInventoryActionBusy?: (busy: boolean) => void;
    setInventoryActionError?: (message: string | null) => void;
    setInventoryActionConflict?: (state: 'none' | 'review_again') => void;
    showNotice?: ReturnType<typeof vi.fn>;
  } = {}) {
    const closeOverlay = overrides.closeOverlay ?? vi.fn();
    const setInventoryActionBusy = overrides.setInventoryActionBusy ?? vi.fn();
    const setInventoryActionError = overrides.setInventoryActionError ?? vi.fn();
    const setInventoryActionConflict = overrides.setInventoryActionConflict ?? vi.fn();
    const showNotice = overrides.showNotice ?? vi.fn();
    const disposeExpiredInventory =
      overrides.disposeExpiredInventory ?? vi.fn(async () => undefined);
    const snoozeInventoryExpiryAlerts =
      overrides.snoozeInventoryExpiryAlerts ?? vi.fn(async () => undefined);
    const correctInventoryExpiryDate =
      overrides.correctInventoryExpiryDate ?? vi.fn(async () => undefined);
    const refreshInventoryActionGroup =
      overrides.refreshInventoryActionGroup ?? vi.fn(async () => null);
    const setSelectedIngredientId = vi.fn();

    const actions = useIngredientActionState({
      ingredientOptions: [],
      foodOptions: [],
      summaries: [],
      inventoryForm: emptyInventoryForm,
      setInventoryForm: vi.fn(),
      setInventoryAdvancedOpen: vi.fn(),
      consumeForm: emptyConsumeForm,
      shoppingForm: emptyShoppingForm,
      setShoppingForm: vi.fn(),
      editingShoppingItemId: null,
        inventoryActionIngredientId:
        overrides.inventoryActionIngredientId === undefined
          ? 'ingredient-tomato'
          : overrides.inventoryActionIngredientId,
      inventoryActionGroup:
        overrides.inventoryActionGroup === undefined ? tomatoGroup : overrides.inventoryActionGroup,
      selectedInventoryIngredient: null,
      setSelectedIngredientId,
      closeOverlay,
      setInventoryActionBusy,
      setInventoryActionError,
      setInventoryActionConflict,
      createInventory: vi.fn(async () => {
        throw new Error('unused');
      }),
      upsertInventoryState: vi.fn(async () => {
        throw new Error('unused');
      }),
      consumeInventory: vi.fn(async () => {
        throw new Error('unused');
      }),
      disposeExpiredInventory,
      snoozeInventoryExpiryAlerts,
      correctInventoryExpiryDate,
      refreshInventoryActionGroup,
      createShoppingItem: vi.fn(async () => {
        throw new Error('unused');
      }),
      updateShoppingItem: vi.fn(async () => {
        throw new Error('unused');
      }),
      showNotice,
      resolveErrorMessage: (reason, fallback) =>
        reason instanceof Error && reason.message.trim() ? reason.message : fallback,
    });

    return {
      actions,
      closeOverlay,
      disposeExpiredInventory,
      snoozeInventoryExpiryAlerts,
      correctInventoryExpiryDate,
      refreshInventoryActionGroup,
      setInventoryActionBusy,
      setInventoryActionError,
      setInventoryActionConflict,
      showNotice,
      setSelectedIngredientId,
    };
  }

  it('disposes with versioned payload and closes after awaited refresh', async () => {
    const disposeExpiredInventory = vi.fn(async (_payload: DisposeExpiredInventoryRequest) => undefined);
    const refreshInventoryActionGroup = vi.fn(async () => null);
    const closeOverlay = vi.fn();
    const { actions, setSelectedIngredientId } = createActions({
      disposeExpiredInventory,
      refreshInventoryActionGroup,
      closeOverlay,
    });

    await actions.disposeSelectedInventoryBatches(versionedItems);

    expect(disposeExpiredInventory).toHaveBeenCalledWith({
      ingredient_id: 'ingredient-tomato',
      items: versionedItems,
    });
    expect(JSON.stringify(disposeExpiredInventory.mock.calls[0]?.[0])).not.toContain('inventory_item_ids');
    expect(refreshInventoryActionGroup).toHaveBeenCalledWith('ingredient-tomato');
    expect(setSelectedIngredientId).toHaveBeenCalledWith('ingredient-tomato');
    expect(closeOverlay).toHaveBeenCalledTimes(1);
  });

  it('snoozes with explicit retain_expired action type', async () => {
    const snoozeInventoryExpiryAlerts = vi.fn(async (_payload: SnoozeExpiryAlertsRequest) => undefined);
    const refreshInventoryActionGroup = vi.fn(async () => null);
    const { actions } = createActions({
      snoozeInventoryExpiryAlerts,
      refreshInventoryActionGroup,
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
  });

  it('on 409 with surviving group keeps dialog open and requires review again', async () => {
    const disposeExpiredInventory = vi.fn(async () => {
      throw new ApiError({
        status: 409,
        detail: 'stale',
        path: '/api/inventory/dispose-expired',
        payload: null,
      });
    });
    const refreshInventoryActionGroup = vi.fn(async () => tomatoGroup);
    const closeOverlay = vi.fn();
    const setInventoryActionConflict = vi.fn();
    const setInventoryActionError = vi.fn();
    const { actions } = createActions({
      disposeExpiredInventory,
      refreshInventoryActionGroup,
      closeOverlay,
      setInventoryActionConflict,
      setInventoryActionError,
    });

    await actions.disposeSelectedInventoryBatches(versionedItems);

    expect(closeOverlay).not.toHaveBeenCalled();
    expect(setInventoryActionConflict).toHaveBeenCalledWith('review_again');
    expect(setInventoryActionError).toHaveBeenCalledWith(
      expect.stringContaining('家人刚刚改动了这批库存'),
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
    const refreshInventoryActionGroup = vi.fn(async () => null);
    const closeOverlay = vi.fn();
    const showNotice = vi.fn();
    const { actions } = createActions({
      disposeExpiredInventory,
      refreshInventoryActionGroup,
      closeOverlay,
      showNotice,
    });

    await actions.disposeSelectedInventoryBatches(versionedItems);

    expect(closeOverlay).toHaveBeenCalledTimes(1);
    expect(showNotice).toHaveBeenCalledWith({
      tone: 'success',
      title: '这批库存已由家人处理',
      message: expect.stringContaining('番茄') as string,
    });
  });
});

describe('useIngredientActionState ordinary presence restock', () => {
  function makeSubmitEvent() {
    return {
      preventDefault: vi.fn(),
    } as unknown as React.FormEvent<HTMLFormElement>;
  }

  it('routes presence manual submit through upsertInventoryState and never createInventory', async () => {
    const createInventory = vi.fn(async () => {
      throw new Error('createInventory must not be called for presence restock');
    });
    const upsertInventoryState = vi.fn(async () => ({
      id: 'state-salt',
      family_id: 'family-1',
      ingredient_id: 'ingredient-salt',
      availability_level: 'sufficient' as const,
      inventory_status: 'fresh' as const,
      purchase_date: '2026-07-11',
      expiry_date: null,
      storage_location: '常温',
      notes: '',
      expiry_alert_snoozed_until: null,
      expiry_reviewed_at: null,
      expiry_reviewed_by: null,
      last_confirmed_at: null,
      last_confirmed_by: null,
      last_confirmation_source: null,
      row_version: 2,
      created_at: '2026-07-11T00:00:00Z',
      updated_at: '2026-07-11T00:00:00Z',
    }));
    const closeOverlay = vi.fn();
    const setSelectedIngredientId = vi.fn();
    const setInventoryForm = vi.fn();
    const setInventoryAdvancedOpen = vi.fn();
    const presenceIngredient = {
      id: 'ingredient-salt',
      family_id: 'family-1',
      name: '盐',
      category: '调料',
      default_unit: '份',
      unit_conversions: [],
      quantity_tracking_mode: 'not_track_quantity' as const,
      default_storage: '常温',
      default_expiry_mode: 'none' as const,
      notes: '',
      row_version: 4,
      created_at: '2026-07-01T00:00:00Z',
      updated_at: '2026-07-01T00:00:00Z',
    };
    const existingState = {
      id: 'state-salt',
      family_id: 'family-1',
      ingredient_id: 'ingredient-salt',
      availability_level: 'low' as const,
      inventory_status: 'opened' as const,
      purchase_date: '2026-06-01',
      expiry_date: null,
      storage_location: '常温',
      notes: '旧备注',
      expiry_alert_snoozed_until: null,
      expiry_reviewed_at: null,
      expiry_reviewed_by: null,
      last_confirmed_at: null,
      last_confirmed_by: null,
      last_confirmation_source: null,
      row_version: 1,
      created_at: '2026-06-01T00:00:00Z',
      updated_at: '2026-06-01T00:00:00Z',
    };
    const inventoryForm: InventoryDrawerFormState = {
      ingredientId: 'ingredient-salt',
      ingredientQuery: '盐',
      ingredientLocked: true,
      quantity: '1',
      unit: '份',
      status: 'fresh',
      statusDirty: false,
      purchaseDate: '2026-07-11',
      purchaseDatePreset: 'today',
      expiryInputMode: 'none',
      expiryDays: '',
      expiryDate: '',
      storageLocation: '常温',
      notes: '新备注',
    };

    const actions = useIngredientActionState({
      ingredientOptions: [presenceIngredient],
      foodOptions: [],
      summaries: [
        {
          ingredient: presenceIngredient,
          inventoryItems: [],
          availableInventoryItems: [],
          inventoryState: existingState,
          alerts: [],
          quantitySummaries: [],
          hasMultipleUnits: false,
          primaryStorage: '常温',
          storageLocations: ['常温'],
          recipeReferences: [],
          latestPurchaseDate: null,
          latestUpdatedAt: '2026-07-01T00:00:00Z',
        },
      ],
      inventoryForm,
      setInventoryForm,
      setInventoryAdvancedOpen,
      consumeForm: emptyConsumeForm,
      shoppingForm: emptyShoppingForm,
      setShoppingForm: vi.fn(),
      editingShoppingItemId: null,
      inventoryActionIngredientId: null,
      inventoryActionGroup: null,
      selectedInventoryIngredient: presenceIngredient,
      setSelectedIngredientId,
      closeOverlay,
      setInventoryActionBusy: vi.fn(),
      setInventoryActionError: vi.fn(),
      setInventoryActionConflict: vi.fn(),
      createInventory,
      upsertInventoryState,
      consumeInventory: vi.fn(async () => {
        throw new Error('unused');
      }),
      disposeExpiredInventory: vi.fn(async () => undefined),
      snoozeInventoryExpiryAlerts: vi.fn(async () => undefined),
      correctInventoryExpiryDate: vi.fn(async () => undefined),
      refreshInventoryActionGroup: vi.fn(async () => null),
      createShoppingItem: vi.fn(async () => {
        throw new Error('unused');
      }),
      updateShoppingItem: vi.fn(async () => {
        throw new Error('unused');
      }),
      showNotice: vi.fn(),
      resolveErrorMessage: (reason, fallback) =>
        reason instanceof Error && reason.message.trim() ? reason.message : fallback,
    });

    await actions.submitInventory(makeSubmitEvent());

    expect(createInventory).not.toHaveBeenCalled();
    expect(upsertInventoryState).toHaveBeenCalledWith('ingredient-salt', {
      expected_ingredient_row_version: 4,
      state_id: 'state-salt',
      expected_state_row_version: 1,
      availability_level: 'sufficient',
      inventory_status: 'fresh',
      purchase_date: '2026-07-11',
      expiry_date: null,
      storage_location: '常温',
      notes: '新备注',
    });
    expect(closeOverlay).toHaveBeenCalledTimes(1);
    expect(setSelectedIngredientId).toHaveBeenCalledWith('ingredient-salt');
  });

  it('keeps exact restock on createInventory', async () => {
    const createInventory = vi.fn(async () => ({
      id: 'inv-1',
      family_id: 'family-1',
      ingredient_id: 'ingredient-egg',
      ingredient_name: '鸡蛋',
      quantity: 6,
      unit: '个',
      status: 'fresh' as const,
      purchase_date: '2026-07-11',
      storage_location: '冷藏',
      notes: '',
      low_stock_threshold: 0,
      created_at: '2026-07-11T00:00:00Z',
      updated_at: '2026-07-11T00:00:00Z',
      row_version: 1,
    }));
    const upsertInventoryState = vi.fn(async () => {
      throw new Error('upsertInventoryState must not be called for exact restock');
    });
    const exactIngredient = {
      id: 'ingredient-egg',
      family_id: 'family-1',
      name: '鸡蛋',
      category: '蛋类',
      default_unit: '个',
      unit_conversions: [],
      quantity_tracking_mode: 'track_quantity' as const,
      default_storage: '冷藏',
      default_expiry_mode: 'days' as const,
      default_expiry_days: 14,
      notes: '',
      row_version: 2,
      created_at: '2026-07-01T00:00:00Z',
      updated_at: '2026-07-01T00:00:00Z',
    };
    const inventoryForm: InventoryDrawerFormState = {
      ingredientId: 'ingredient-egg',
      ingredientQuery: '鸡蛋',
      ingredientLocked: true,
      quantity: '6',
      unit: '个',
      status: 'fresh',
      statusDirty: false,
      purchaseDate: '2026-07-11',
      purchaseDatePreset: 'today',
      expiryInputMode: 'none',
      expiryDays: '',
      expiryDate: '',
      storageLocation: '冷藏',
      notes: '',
    };

    const actions = useIngredientActionState({
      ingredientOptions: [exactIngredient],
      foodOptions: [],
      summaries: [],
      inventoryForm,
      setInventoryForm: vi.fn(),
      setInventoryAdvancedOpen: vi.fn(),
      consumeForm: emptyConsumeForm,
      shoppingForm: emptyShoppingForm,
      setShoppingForm: vi.fn(),
      editingShoppingItemId: null,
      inventoryActionIngredientId: null,
      inventoryActionGroup: null,
      selectedInventoryIngredient: exactIngredient,
      setSelectedIngredientId: vi.fn(),
      closeOverlay: vi.fn(),
      setInventoryActionBusy: vi.fn(),
      setInventoryActionError: vi.fn(),
      setInventoryActionConflict: vi.fn(),
      createInventory,
      upsertInventoryState,
      consumeInventory: vi.fn(async () => {
        throw new Error('unused');
      }),
      disposeExpiredInventory: vi.fn(async () => undefined),
      snoozeInventoryExpiryAlerts: vi.fn(async () => undefined),
      correctInventoryExpiryDate: vi.fn(async () => undefined),
      refreshInventoryActionGroup: vi.fn(async () => null),
      createShoppingItem: vi.fn(async () => {
        throw new Error('unused');
      }),
      updateShoppingItem: vi.fn(async () => {
        throw new Error('unused');
      }),
      showNotice: vi.fn(),
      resolveErrorMessage: (reason, fallback) =>
        reason instanceof Error && reason.message.trim() ? reason.message : fallback,
    });

    await actions.submitInventory(makeSubmitEvent());

    expect(upsertInventoryState).not.toHaveBeenCalled();
    expect(createInventory).toHaveBeenCalledWith({
      ingredient_id: 'ingredient-egg',
      quantity: 6,
      unit: '个',
      status: 'fresh',
      purchase_date: '2026-07-11',
      expiry_date: undefined,
      storage_location: '冷藏',
      notes: '',
    });
  });
});
