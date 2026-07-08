import { useEffect, useState } from 'react';
import type { Food, Ingredient, ShoppingListItem } from '../../api/types';
import { resolvePreferredIngredientUnit } from '../../lib/ingredientUnits';
import type { PendingShoppingCompletion } from './IngredientWorkspaceOverlayTypes';
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
import { countDisposableExpiredInventoryItems, type IngredientOverlayMode, type IngredientSummaryViewModel } from './workspaceModel';
import { resolveInitialConsumeQuantity } from './consumeQuickHelpers';

type UseIngredientOverlayStateArgs = {
  ingredientOptions: Ingredient[];
  foodOptions: Food[];
  summaries: IngredientSummaryViewModel[];
  onRequireCreate: () => void;
  onOpenFoodStockFromShopping?: (item: ShoppingListItem) => void;
};

export function useIngredientOverlayState(args: UseIngredientOverlayStateArgs) {
  const [overlayMode, setOverlayMode] = useState<IngredientOverlayMode>(null);
  const [inventoryForm, setInventoryForm] = useState<InventoryDrawerFormState>(
    buildInventoryForm(args.ingredientOptions)
  );
  const [consumeForm, setConsumeForm] = useState<ConsumeDialogFormState>(defaultConsumeForm());
  const [shoppingForm, setShoppingForm] = useState<ShoppingDialogFormState>(buildShoppingForm());
  const [editingShoppingItemId, setEditingShoppingItemId] = useState<string | null>(null);
  const [pendingShoppingToComplete, setPendingShoppingToComplete] = useState<PendingShoppingCompletion | null>(null);
  const [destroyExpiredIngredientId, setDestroyExpiredIngredientId] = useState<string | null>(null);
  const [inventoryAdvancedOpen, setInventoryAdvancedOpen] = useState(false);

  useEffect(() => {
    if (inventoryForm.ingredientId && !args.ingredientOptions.some((item) => item.id === inventoryForm.ingredientId)) {
      setInventoryForm(buildInventoryForm(args.ingredientOptions));
    }
  }, [args.ingredientOptions, inventoryForm.ingredientId]);

  useEffect(() => {
    if (
      destroyExpiredIngredientId &&
      !args.summaries.some((item) => item.ingredient.id === destroyExpiredIngredientId)
    ) {
      setDestroyExpiredIngredientId(null);
      if (overlayMode === 'destroyExpired') {
        setOverlayMode(null);
      }
    }
  }, [destroyExpiredIngredientId, overlayMode, args.summaries]);

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

  function openInventoryOverlay(ingredientId?: string, quantity = '1') {
    if (args.ingredientOptions.length === 0) {
      setPendingShoppingToComplete(null);
      setDestroyExpiredIngredientId(null);
      args.onRequireCreate();
      return;
    }
    setPendingShoppingToComplete(null);
    setEditingShoppingItemId(null);
    setDestroyExpiredIngredientId(null);
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
    setPendingShoppingToComplete(null);
    setEditingShoppingItemId(null);
    setDestroyExpiredIngredientId(null);
    setConsumeForm(buildConsumeFormForIngredient(ingredientId));
    setOverlayMode('consume');
  }

  function openInventoryFromShopping(item: ShoppingListItem) {
    if (item.target_type === 'food' || item.food_id) {
      args.onOpenFoodStockFromShopping?.(item);
      return;
    }
    if (args.ingredientOptions.length === 0) {
      setPendingShoppingToComplete(null);
      setDestroyExpiredIngredientId(null);
      args.onRequireCreate();
      return;
    }
    const normalizedTitle = item.title.trim();
    const matchedIngredient =
      (item.ingredient_id ? args.ingredientOptions.find((ingredient) => ingredient.id === item.ingredient_id) ?? null : null) ??
      args.ingredientOptions.find((ingredient) => ingredient.name === normalizedTitle) ?? null;
    const tracksQuantity = matchedIngredient?.quantity_tracking_mode !== 'not_track_quantity';

    setPendingShoppingToComplete({
      itemId: item.id,
      title: normalizedTitle || item.title,
    });
    setInventoryForm(
      buildInventoryForm(args.ingredientOptions, matchedIngredient?.id, {
        ingredientQuery: matchedIngredient?.name ?? normalizedTitle,
        ingredientLocked: Boolean(matchedIngredient),
        quantity: tracksQuantity ? formatNumericString(item.quantity) : '',
        unit:
          resolvePreferredIngredientUnit(matchedIngredient, item.unit) ||
          matchedIngredient?.default_unit ||
          item.unit.trim() ||
          '个',
      })
    );
    setInventoryAdvancedOpen(false);
    setOverlayMode('inventory');
  }

  function openShoppingOverlay(options?: { ingredient?: Ingredient; food?: Food; reason?: string; shoppingItem?: ShoppingListItem }) {
    setPendingShoppingToComplete(null);
    setDestroyExpiredIngredientId(null);
    if (options?.shoppingItem) {
      const matchedIngredient =
        (options.shoppingItem.ingredient_id
          ? args.ingredientOptions.find((ingredient) => ingredient.id === options.shoppingItem?.ingredient_id) ?? null
          : null) ??
        args.ingredientOptions.find((ingredient) => ingredient.name === options.shoppingItem?.title.trim()) ??
        null;
      const matchedFood =
        options.shoppingItem.food_id
          ? args.foodOptions.find((food) => food.id === options.shoppingItem?.food_id) ?? null
          : null;
      setEditingShoppingItemId(options.shoppingItem.id);
      setShoppingForm(buildShoppingFormFromItem(options.shoppingItem, matchedIngredient, matchedFood));
    } else {
      setEditingShoppingItemId(null);
      setShoppingForm(buildShoppingForm(options?.ingredient, options?.reason, options?.food));
    }
    setOverlayMode('shopping');
  }

  function openDestroyExpiredOverlay(ingredientId: string) {
    const summary = args.summaries.find((item) => item.ingredient.id === ingredientId) ?? null;
    if (!summary || countDisposableExpiredInventoryItems(summary) === 0) {
      return;
    }
    setPendingShoppingToComplete(null);
    setEditingShoppingItemId(null);
    setDestroyExpiredIngredientId(ingredientId);
    setOverlayMode('destroyExpired');
  }

  function closeOverlay() {
    setOverlayMode(null);
    setPendingShoppingToComplete(null);
    setEditingShoppingItemId(null);
    setDestroyExpiredIngredientId(null);
    setInventoryAdvancedOpen(false);
    setConsumeForm(defaultConsumeForm());
  }

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
    pendingShoppingToComplete,
    destroyExpiredIngredientId,
    inventoryAdvancedOpen,
    setInventoryAdvancedOpen,
    openInventoryOverlay,
    openConsumeOverlay,
    openInventoryFromShopping,
    openShoppingOverlay,
    openDestroyExpiredOverlay,
    closeOverlay,
  };
}
