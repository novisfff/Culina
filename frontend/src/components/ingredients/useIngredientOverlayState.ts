import { useEffect, useMemo, useState } from 'react';
import type { Food, Ingredient, ShoppingListItem } from '../../api/types';
import type {
  ExpiryInventoryActionGroup,
  InventoryActionBatch,
  InventoryActionGroup,
} from '../../features/inventory/inventoryActionModel';
import { calendarDaysBetweenDateKeys } from '../../lib/date';
import {
  buildConsumeUnitOptions,
  buildInventoryForm,
  buildShoppingForm,
  buildShoppingFormFromItem,
  defaultConsumeForm,
  formatNumericString,
  resolveExpiryDateFromDays,
  resolveInventoryStatusForStorage,
  type ConsumeDialogFormState,
  type InventoryDrawerFormState,
  type ShoppingDialogFormState,
} from './ingredientWorkspaceForms';
import {
  buildDisposableExpiredInventoryItems,
  type IngredientOverlayMode,
  type IngredientSummaryViewModel,
} from './workspaceModel';
import { resolveInitialConsumeQuantity } from './consumeQuickHelpers';

export type InventoryActionConflictState = 'none' | 'review_again';

type UseIngredientOverlayStateArgs = {
  ingredientOptions: Ingredient[];
  foodOptions: Food[];
  summaries: IngredientSummaryViewModel[];
  inventoryActionGroups: InventoryActionGroup[];
  referenceDate: string;
  onRequireCreate: () => void;
  onOpenShoppingIntake?: (item: ShoppingListItem) => void;
};

function formatQuantityValue(value: number) {
  return String(Number(value.toFixed(2))).replace(/\.0+$/, '');
}

function buildDisposeOnlyExpiryGroup(
  summary: IngredientSummaryViewModel,
  referenceDate: string,
): ExpiryInventoryActionGroup | null {
  const disposable = buildDisposableExpiredInventoryItems(summary, referenceDate);
  if (disposable.length === 0) {
    return null;
  }

  const batches: InventoryActionBatch[] = disposable.map((item) => {
    const expiryDate = item.expiryDate.slice(0, 10);
    return {
      inventoryItemId: item.id,
      rowVersion: item.rowVersion,
      remainingQuantity: item.remainingQuantity,
      unit: item.unit,
      storageLocation: item.storageLocation,
      purchaseDate: item.purchaseDate,
      expiryDate,
      daysLeft: calendarDaysBetweenDateKeys(expiryDate, referenceDate),
      expiryAlertSnoozedUntil: item.expiryAlertSnoozedUntil,
      expiryReviewedAt: item.expiryReviewedAt,
      expiryReviewedBy: item.expiryReviewedBy,
      target: {
        targetKind: 'inventory_item',
        inventoryItemId: item.id,
        expectedRowVersion: item.rowVersion,
      },
    };
  });


  const quantityLabels = (() => {
    const totals = new Map<string, number>();
    const order: string[] = [];
    for (const batch of batches) {
      if (!totals.has(batch.unit)) {
        order.push(batch.unit);
      }
      totals.set(batch.unit, (totals.get(batch.unit) ?? 0) + batch.remainingQuantity);
    }
    return order.map((unit) => `${formatQuantityValue(totals.get(unit) ?? 0)} ${unit}`);
  })();

  const storageLocations = [...new Set(batches.map((batch) => batch.storageLocation).filter(Boolean))];
  const earliest = [...batches].sort(
    (left, right) => left.expiryDate.localeCompare(right.expiryDate) || left.daysLeft - right.daysLeft,
  )[0];

  return {
    kind: 'expiry',
    id: `expiry:${summary.ingredient.id}`,
    ingredientId: summary.ingredient.id,
    ingredientName: summary.ingredient.name,
    severity: 'expired',
    batches: [...batches].sort(
      (left, right) =>
        left.daysLeft - right.daysLeft ||
        left.expiryDate.localeCompare(right.expiryDate) ||
        left.inventoryItemId.localeCompare(right.inventoryItemId),
    ),
    expiredBatchCount: batches.length,
    todayBatchCount: 0,
    soonBatchCount: 0,
    laterBatchCount: 0,
    totalBatchCount: batches.length,
    quantityLabels,
    storageLocations,
    earliestExpiryDate: earliest?.expiryDate ?? null,
    earliestDaysLeft: earliest?.daysLeft ?? null,
    title: `${summary.ingredient.name}需要处理`,
    detail: `${batches.length} 批已过期`,
    primaryAction: 'manage_expiry',
    targetKind: 'inventory_item',
  };
}


export function resolveExpiryInventoryActionGroup(args: {
  ingredientId: string;
  inventoryActionGroups: InventoryActionGroup[];
  summaries: IngredientSummaryViewModel[];
  referenceDate: string;
}): ExpiryInventoryActionGroup | null {
  const shared = args.inventoryActionGroups.find(
    (item): item is ExpiryInventoryActionGroup => item.kind === 'expiry' && item.ingredientId === args.ingredientId,
  );
  const summary = args.summaries.find((item) => item.ingredient.id === args.ingredientId) ?? null;
  const disposeOnly = summary ? buildDisposeOnlyExpiryGroup(summary, args.referenceDate) : null;

  if (shared && disposeOnly) {
    const byId = new Map(shared.batches.map((batch) => [batch.inventoryItemId, batch]));
    for (const batch of disposeOnly.batches) {
      if (!byId.has(batch.inventoryItemId)) {
        byId.set(batch.inventoryItemId, batch);
      }
    }
    const batches = [...byId.values()].sort(
      (left, right) =>
        left.daysLeft - right.daysLeft ||
        left.expiryDate.localeCompare(right.expiryDate) ||
        left.inventoryItemId.localeCompare(right.inventoryItemId),
    );
    if (batches.length === shared.batches.length) {
      return shared;
    }
    const expiredBatchCount = batches.filter((batch) => batch.daysLeft < 0).length;
    const todayBatchCount = batches.filter((batch) => batch.daysLeft === 0).length;
    const soonBatchCount = batches.filter((batch) => batch.daysLeft >= 1 && batch.daysLeft <= 3).length;
    const laterBatchCount = batches.filter((batch) => batch.daysLeft >= 4 && batch.daysLeft <= 7).length;
    const severity =
      expiredBatchCount > 0
        ? 'expired'
        : todayBatchCount > 0
          ? 'expires_today'
          : soonBatchCount > 0
            ? 'expires_soon'
            : 'expires_later';
    const earliest = batches[0] ?? null;
    return {
      ...shared,
      severity,
      batches,
      expiredBatchCount,
      todayBatchCount,
      soonBatchCount,
      laterBatchCount,
      totalBatchCount: batches.length,
      earliestExpiryDate: earliest?.expiryDate ?? shared.earliestExpiryDate,
      earliestDaysLeft: earliest?.daysLeft ?? shared.earliestDaysLeft,
      detail:
        expiredBatchCount > 0 && todayBatchCount + soonBatchCount + laterBatchCount === 0
          ? `${expiredBatchCount} 批已过期`
          : shared.detail,
    };
  }

  return shared ?? disposeOnly;
}

export function useIngredientOverlayState(args: UseIngredientOverlayStateArgs) {
  const [overlayMode, setOverlayMode] = useState<IngredientOverlayMode>(null);
  const [inventoryForm, setInventoryForm] = useState<InventoryDrawerFormState>(
    buildInventoryForm(args.ingredientOptions)
  );
  const [consumeForm, setConsumeForm] = useState<ConsumeDialogFormState>(defaultConsumeForm());
  const [shoppingForm, setShoppingForm] = useState<ShoppingDialogFormState>(buildShoppingForm());
  const [editingShoppingItemId, setEditingShoppingItemId] = useState<string | null>(null);
  const [editingShoppingItemRowVersion, setEditingShoppingItemRowVersion] = useState<number | null>(null);
  const [inventoryActionIngredientId, setInventoryActionIngredientId] = useState<string | null>(null);
  const [inventoryActionBusy, setInventoryActionBusy] = useState(false);
  const [inventoryActionError, setInventoryActionError] = useState<string | null>(null);
  const [inventoryActionConflict, setInventoryActionConflict] = useState<InventoryActionConflictState>('none');
  const [inventoryAdvancedOpen, setInventoryAdvancedOpen] = useState(false);

  useEffect(() => {
    if (inventoryForm.ingredientId && !args.ingredientOptions.some((item) => item.id === inventoryForm.ingredientId)) {
      setInventoryForm(buildInventoryForm(args.ingredientOptions));
    }
  }, [args.ingredientOptions, inventoryForm.ingredientId]);

  useEffect(() => {
    if (
      inventoryActionIngredientId &&
      !args.summaries.some((item) => item.ingredient.id === inventoryActionIngredientId)
    ) {
      setInventoryActionIngredientId(null);
      setInventoryActionBusy(false);
      setInventoryActionError(null);
      setInventoryActionConflict('none');
      if (overlayMode === 'inventoryAction') {
        setOverlayMode(null);
      }
    }
  }, [inventoryActionIngredientId, overlayMode, args.summaries]);

  useEffect(() => {
    if (inventoryForm.expiryInputMode === 'days') {
      const nextExpiryDate = resolveExpiryDateFromDays(inventoryForm.purchaseDate, inventoryForm.expiryDays);
      if (inventoryForm.expiryDate !== nextExpiryDate) {
        setInventoryForm((current) => ({ ...current, expiryDate: nextExpiryDate }));
      }
      return;
    }
    if (inventoryForm.expiryInputMode === 'none' && inventoryForm.expiryDate) {
      setInventoryForm((current) => ({ ...current, expiryDate: '' }));
    }
  }, [inventoryForm.expiryDate, inventoryForm.expiryDays, inventoryForm.expiryInputMode, inventoryForm.purchaseDate]);

  useEffect(() => {
    if (inventoryForm.statusDirty) {
      return;
    }
    const recommendedStatus = resolveInventoryStatusForStorage(inventoryForm.storageLocation);
    if (inventoryForm.status !== recommendedStatus) {
      setInventoryForm((current) => ({ ...current, status: recommendedStatus }));
    }
  }, [inventoryForm.status, inventoryForm.statusDirty, inventoryForm.storageLocation]);

  function clearInventoryActionSelection() {
    setInventoryActionIngredientId(null);
    setInventoryActionBusy(false);
    setInventoryActionError(null);
    setInventoryActionConflict('none');
  }

  function openInventoryOverlay(ingredientId?: string, quantity = '1') {
    if (args.ingredientOptions.length === 0) {
      clearInventoryActionSelection();
      args.onRequireCreate();
      return;
    }
    setEditingShoppingItemId(null);
    setEditingShoppingItemRowVersion(null);
    clearInventoryActionSelection();
    setInventoryForm(
      buildInventoryForm(args.ingredientOptions, ingredientId, {
        quantity,
        ingredientLocked: Boolean(ingredientId),
      })
    );
    setInventoryAdvancedOpen(false);
    setOverlayMode('inventory');
  }

  function buildConsumeFormForIngredient(ingredientId: string): ConsumeDialogFormState {
    const summary = args.summaries.find((item) => item.ingredient.id === ingredientId) ?? null;
    const unitOptions = buildConsumeUnitOptions(
      summary?.ingredient,
      summary?.availableInventoryItems ?? [],
      summary?.ingredient.default_unit
    );
    const selectedUnit = unitOptions[0]?.unit ?? '';
    const availableQuantity = unitOptions[0]?.available ?? 0;

    return {
      ingredientId,
      unit: selectedUnit,
      quantity: availableQuantity > 0 ? formatNumericString(resolveInitialConsumeQuantity(availableQuantity)) : '',
    };
  }

  function openConsumeOverlay(ingredientId: string) {
    const summary = args.summaries.find((item) => item.ingredient.id === ingredientId) ?? null;
    if (!summary || summary.availableInventoryItems.length === 0) {
      return;
    }
    setEditingShoppingItemId(null);
    setEditingShoppingItemRowVersion(null);
    clearInventoryActionSelection();
    setConsumeForm(buildConsumeFormForIngredient(ingredientId));
    setOverlayMode('consume');
  }

  function openInventoryFromShopping(item: ShoppingListItem) {
    // Shopping-origin restock always opens the shared atomic intake workflow.
    if (args.onOpenShoppingIntake) {
      args.onOpenShoppingIntake(item);
      return;
    }
    // Fallback: keep form closed and require create when no intake composition is wired.
    if (args.ingredientOptions.length === 0) {
      clearInventoryActionSelection();
      args.onRequireCreate();
    }
  }

  function openShoppingOverlay(options?: { ingredient?: Ingredient; food?: Food; reason?: string; shoppingItem?: ShoppingListItem }) {
    clearInventoryActionSelection();
    if (options?.shoppingItem) {
      // Only resolve bound targets by stable IDs. Free-text rows must not auto-bind by title.
      const matchedIngredient = options.shoppingItem.ingredient_id
        ? args.ingredientOptions.find((ingredient) => ingredient.id === options.shoppingItem?.ingredient_id) ?? null
        : null;
      const matchedFood = options.shoppingItem.food_id
        ? args.foodOptions.find((food) => food.id === options.shoppingItem?.food_id) ?? null
        : null;
      setEditingShoppingItemId(options.shoppingItem.id);
      setEditingShoppingItemRowVersion(options.shoppingItem.row_version);
      setShoppingForm(buildShoppingFormFromItem(options.shoppingItem, matchedIngredient, matchedFood));
    } else {
      setEditingShoppingItemId(null);
      setEditingShoppingItemRowVersion(null);
      setShoppingForm(buildShoppingForm(options?.ingredient, options?.reason, options?.food));
    }
    setOverlayMode('shopping');
  }

  function resolveInventoryActionGroup(ingredientId: string): ExpiryInventoryActionGroup | null {
    return resolveExpiryInventoryActionGroup({
      ingredientId,
      inventoryActionGroups: args.inventoryActionGroups,
      summaries: args.summaries,
      referenceDate: args.referenceDate,
    });
  }

  function openInventoryActionOverlay(ingredientId: string) {
    const group = resolveInventoryActionGroup(ingredientId);
    if (!group) {
      return;
    }
    setEditingShoppingItemId(null);
    setEditingShoppingItemRowVersion(null);
    setInventoryActionIngredientId(ingredientId);
    setInventoryActionBusy(false);
    setInventoryActionError(null);
    setInventoryActionConflict('none');
    setOverlayMode('inventoryAction');
  }

  // Keep the legacy entry name used across hub/mobile/panels while the dialog is shared.
  const openDestroyExpiredOverlay = openInventoryActionOverlay;

  function closeOverlay() {
    setOverlayMode(null);
    setEditingShoppingItemId(null);
    setEditingShoppingItemRowVersion(null);
    clearInventoryActionSelection();
    setInventoryAdvancedOpen(false);
    setConsumeForm(defaultConsumeForm());
  }

  const inventoryActionGroup = useMemo(() => {
    if (!inventoryActionIngredientId || overlayMode !== 'inventoryAction') {
      return null;
    }
    return resolveInventoryActionGroup(inventoryActionIngredientId);
  }, [
    inventoryActionIngredientId,
    overlayMode,
    args.inventoryActionGroups,
    args.summaries,
    args.referenceDate,
  ]);

  return {
    overlayMode,
    setOverlayMode,
    inventoryForm,
    setInventoryForm,
    consumeForm,
    setConsumeForm,
    shoppingForm,
    setShoppingForm,
    editingShoppingItemId,
    editingShoppingItemRowVersion,
    inventoryActionIngredientId,
    inventoryActionGroup,
    inventoryActionBusy,
    setInventoryActionBusy,
    inventoryActionError,
    setInventoryActionError,
    inventoryActionConflict,
    setInventoryActionConflict,
    inventoryAdvancedOpen,
    setInventoryAdvancedOpen,
    openInventoryOverlay,
    openConsumeOverlay,
    openInventoryFromShopping,
    openShoppingOverlay,
    openInventoryActionOverlay,
    openDestroyExpiredOverlay,
    closeOverlay,
  };
}
