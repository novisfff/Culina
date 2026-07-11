import type { CSSProperties } from 'react';
import type { Ingredient } from '../../api/types';
import { resolveAssetUrl } from '../../lib/assets';
import { convertQuantityToDefaultUnit, getIngredientUnitOptions, resolvePreferredIngredientUnit } from '../../lib/ingredientUnits';
import { quantityTrackingLabel, tracksIngredientQuantity } from '../../lib/ingredientTracking';
import { WorkspaceOverlayFrame } from '../ui-kit';
import {
  buildConsumeQuickValues,
  clampConsumeQuantity,
  getConsumeRemainingQuantity,
  isConsumeAllSelected,
  resolveConsumeStep,
  resolveInitialConsumeQuantity,
  type ConsumeQuickPreset,
} from './consumeQuickHelpers';
import {
  buildInventoryForm,
  buildConsumeUnitOptions,
  clampNumber,
  formatNumericString,
  parseOptionalNumber,
  parsePositiveNumber,
  resolveClampedDaysValue,
  resolveTouchDefaultValue,
  resolveTouchQuickValues,
  resolveTouchStep,
} from './ingredientWorkspaceForms';
import { IngredientInventoryOverlay } from './IngredientInventoryOverlay';
import { IngredientConsumeOverlay } from './IngredientConsumeOverlay';
import { InventoryActionDialog } from '../../features/inventory/InventoryActionDialog';
import { IngredientShoppingOverlay } from './IngredientShoppingOverlay';
import type { OverlayLayerProps, PendingShoppingCompletion } from './IngredientWorkspaceOverlayTypes';

export type { PendingShoppingCompletion } from './IngredientWorkspaceOverlayTypes';

const INGREDIENT_WORKSPACE_OVERLAY_ROOT_CLASS = 'ingredient-workspace-overlay-root';

export function IngredientWorkspaceOverlays(props: OverlayLayerProps) {
  if (!props.overlayMode) {
    return null;
  }

  const isInventoryOverlay = props.overlayMode === 'inventory';
  const isConsumeOverlay = props.overlayMode === 'consume';
  const isInventoryActionOverlay = props.overlayMode === 'inventoryAction';
  const isShoppingOverlay = props.overlayMode === 'shopping';
  const selectedInventoryIngredient =
    isInventoryOverlay
      ? props.ingredients.find((item) => item.id === props.inventoryForm.ingredientId) ?? null
      : null;
  const selectedConsumeSummary =
    isConsumeOverlay
      ? props.ingredientSummaries.find((item) => item.ingredient.id === props.consumeForm.ingredientId) ?? null
      : null;
  const selectedInventoryActionGroup =
    isInventoryActionOverlay ? props.inventoryActionGroup : null;
  const consumeUnitOptions = buildConsumeUnitOptions(
    selectedConsumeSummary?.ingredient,
    selectedConsumeSummary?.availableInventoryItems ?? [],
    selectedConsumeSummary?.ingredient.default_unit
  );
  const selectedConsumeUnit =
    consumeUnitOptions.find((item) => item.unit === props.consumeForm.unit) ?? consumeUnitOptions[0] ?? null;
  const consumeAvailableQuantity = selectedConsumeUnit?.available ?? 0;
  const consumeStep = resolveConsumeStep(consumeAvailableQuantity);
  const parsedConsumeQuantity = parseOptionalNumber(props.consumeForm.quantity);
  const consumeSuggestedQuantity = resolveInitialConsumeQuantity(consumeAvailableQuantity);
  const consumeQuantityValue =
    parsedConsumeQuantity !== null ? clampConsumeQuantity(parsedConsumeQuantity, consumeAvailableQuantity) : 0;
  const consumeQuickValues =
    selectedConsumeUnit && consumeAvailableQuantity > 0
      ? buildConsumeQuickValues(selectedConsumeUnit.unit, consumeAvailableQuantity)
      : [];
  const consumeRemainingQuantity = getConsumeRemainingQuantity(consumeAvailableQuantity, consumeQuantityValue);
  const consumeIsAllState = isConsumeAllSelected(consumeQuantityValue, consumeAvailableQuantity);
  const consumeCanSubmit = Boolean(selectedConsumeUnit) && parsedConsumeQuantity !== null && consumeQuantityValue > 0;
  const consumeRangeProgress =
    consumeAvailableQuantity > 0 ? (consumeQuantityValue / consumeAvailableQuantity) * 100 : 0;
  const consumeRangeStyle = {
    '--touch-range-progress': `${clampNumber(consumeRangeProgress, 0, 100)}%`,
  } as CSSProperties;
  const consumeTotalRemainingLabel =
    selectedConsumeSummary?.quantitySummaries[0]?.label ??
    (selectedConsumeUnit ? `${formatNumericString(consumeAvailableQuantity)}${selectedConsumeUnit.unit}` : '暂无库存');
  const inventoryUnitOptions = selectedInventoryIngredient
    ? getIngredientUnitOptions(selectedInventoryIngredient)
    : [];
  const selectedInventoryUnit =
    inventoryUnitOptions.find((item) => item.unit === props.inventoryForm.unit) ?? inventoryUnitOptions[0] ?? null;
  const inventoryNormalizedQuantity =
    selectedInventoryIngredient
      ? (() => {
          const parsedQuantity = parsePositiveNumber(props.inventoryForm.quantity);
          return parsedQuantity !== null
            ? convertQuantityToDefaultUnit(selectedInventoryIngredient, parsedQuantity, props.inventoryForm.unit)
            : null;
        })()
      : null;
  const inventoryExpiryDaysValue = isInventoryOverlay
    ? resolveClampedDaysValue(props.inventoryForm.expiryDays, selectedInventoryIngredient?.default_expiry_days ?? 3)
    : 3;
  const shoppingQuantityValue =
    isShoppingOverlay
      ? parsePositiveNumber(props.shoppingForm.quantity) ??
        resolveTouchDefaultValue(props.shoppingForm.unit || '个', 'quantity')
      : 0;
  const shoppingQuantityStep = isShoppingOverlay ? resolveTouchStep(props.shoppingForm.unit || '个') : 1;
  const shoppingQuantityQuickValues = isShoppingOverlay
    ? resolveTouchQuickValues(props.shoppingForm.unit || '个', 'quantity')
    : [];
  const selectedShoppingIngredient = isShoppingOverlay && props.shoppingForm.title.trim()
    ? props.ingredients.find((item) => item.id === props.shoppingForm.ingredientId) ??
      props.ingredients.find((item) => item.name === props.shoppingForm.title.trim()) ??
      null
    : null;
  const selectedShoppingFood =
    isShoppingOverlay && props.shoppingForm.foodId
      ? props.foods.find((item) => item.id === props.shoppingForm.foodId) ?? null
      : null;
  const shoppingIngredientUnitOptions = selectedShoppingIngredient
    ? getIngredientUnitOptions(selectedShoppingIngredient)
    : [];
  const selectedShoppingIngredientPreview = resolveAssetUrl(selectedShoppingIngredient?.image?.url);
  const selectedShoppingFoodPreview = resolveAssetUrl(selectedShoppingFood?.images?.[0]?.url);
  const selectedShoppingIngredientMeta = selectedShoppingIngredient
    ? [
        selectedShoppingIngredient.category || '未分类',
        quantityTrackingLabel(selectedShoppingIngredient),
        tracksIngredientQuantity(selectedShoppingIngredient) ? `默认 ${selectedShoppingIngredient.default_unit || '个'}` : '做菜不扣减数量',
        selectedShoppingIngredient.default_storage || '常温',
      ]
    : [];
  const selectedShoppingFoodMeta = selectedShoppingFood
    ? [
        selectedShoppingFood.category || '成品速食',
        selectedShoppingFood.storage_location || '常温',
        `默认 ${selectedShoppingFood.stock_unit || '份'}`,
      ]
    : [];
  const selectedIngredientPreview = resolveAssetUrl(selectedInventoryIngredient?.image?.url);
  const selectedIngredientMeta = selectedInventoryIngredient
    ? [
        selectedInventoryIngredient.category || '未分类',
        quantityTrackingLabel(selectedInventoryIngredient),
        tracksIngredientQuantity(selectedInventoryIngredient) ? `默认 ${selectedInventoryIngredient.default_unit || '个'}` : '补充时不填数量',
        selectedInventoryIngredient.default_storage || '常温',
      ]
    : [];
  const selectedConsumePreview = resolveAssetUrl(selectedConsumeSummary?.ingredient.image?.url);
  const selectedConsumeMeta = selectedConsumeSummary
    ? [
        selectedConsumeSummary.ingredient.category || '未分类',
        quantityTrackingLabel(selectedConsumeSummary.ingredient),
        tracksIngredientQuantity(selectedConsumeSummary.ingredient) ? `默认 ${selectedConsumeSummary.ingredient.default_unit || '个'}` : '不扣减数量',
        selectedConsumeSummary.primaryStorage || selectedConsumeSummary.ingredient.default_storage || '常温',
      ]
    : [];
  if (isInventoryActionOverlay && !selectedInventoryActionGroup) {
    return null;
  }

  const isOverlayBusy =
    (isInventoryOverlay && Boolean(props.isCreatingInventory)) ||
    (isConsumeOverlay && Boolean(props.isConsumingInventory)) ||
    (isShoppingOverlay && Boolean(props.isCreatingShopping));

  const closeIfAllowed = () => {
    if (!isOverlayBusy) {
      props.closeOverlay();
    }
  };

  function syncInventoryIngredient(ingredient: Ingredient | null, ingredientQuery = ingredient?.name ?? '') {
    props.setInventoryForm(
      buildInventoryForm(props.ingredients, ingredient?.id, {
        ingredientQuery,
        ingredientLocked: props.inventoryForm.ingredientLocked && Boolean(ingredient),
        quantity: props.inventoryForm.quantity,
        unit: resolvePreferredIngredientUnit(ingredient, props.inventoryForm.unit),
        purchaseDate: props.inventoryForm.purchaseDate,
        purchaseDatePreset: props.inventoryForm.purchaseDatePreset,
        notes: props.inventoryForm.notes,
      })
    );
  }

  function updateConsumeUnit(unit: string) {
    const nextUnit = consumeUnitOptions.find((item) => item.unit === unit) ?? null;
    if (!nextUnit) {
      props.setConsumeForm({ ...props.consumeForm, unit });
      return;
    }
    const currentQuantity = parsePositiveNumber(props.consumeForm.quantity) ?? resolveInitialConsumeQuantity(nextUnit.available);
    props.setConsumeForm({
      ...props.consumeForm,
      unit,
      quantity: formatNumericString(clampConsumeQuantity(currentQuantity, nextUnit.available)),
    });
  }

  function updateConsumeQuantity(value: number) {
    props.setConsumeForm({
      ...props.consumeForm,
      unit: selectedConsumeUnit?.unit ?? props.consumeForm.unit,
      quantity: formatNumericString(clampConsumeQuantity(value, consumeAvailableQuantity)),
    });
  }

  function updateConsumeQuantityInput(value: string) {
    if (!value.trim()) {
      props.setConsumeForm({
        ...props.consumeForm,
        unit: selectedConsumeUnit?.unit ?? props.consumeForm.unit,
        quantity: '',
      });
      return;
    }

    const parsedValue = Number(value);
    if (!Number.isFinite(parsedValue)) {
      props.setConsumeForm({
        ...props.consumeForm,
        unit: selectedConsumeUnit?.unit ?? props.consumeForm.unit,
        quantity: value,
      });
      return;
    }

    updateConsumeQuantity(parsedValue);
  }

  if (isInventoryActionOverlay && selectedInventoryActionGroup) {
    return (
      <InventoryActionDialog
        open
        group={selectedInventoryActionGroup}
        referenceDate={props.inventoryActionReferenceDate}
        busy={props.inventoryActionBusy}
        errorMessage={props.inventoryActionError}
        conflictState={props.inventoryActionConflict}
        overlayRootClassName={INGREDIENT_WORKSPACE_OVERLAY_ROOT_CLASS}
        onClose={props.closeOverlay}
        onDispose={props.disposeSelectedInventoryBatches}
        onSnooze={props.snoozeSelectedInventoryAlerts}
        onCorrectExpiry={props.correctSelectedInventoryExpiryDate}
      />
    );
  }

  return (
    <WorkspaceOverlayFrame
      rootClassName={INGREDIENT_WORKSPACE_OVERLAY_ROOT_CLASS}
      closeOnBackdrop={!isOverlayBusy}
      onClose={closeIfAllowed}
    >
      {isInventoryOverlay && (
        <IngredientInventoryOverlay
          closeOverlay={closeIfAllowed}
          inventoryForm={props.inventoryForm}
          setInventoryForm={props.setInventoryForm}
          inventoryAdvancedOpen={props.inventoryAdvancedOpen}
          setInventoryAdvancedOpen={props.setInventoryAdvancedOpen}
          pendingShoppingToComplete={props.pendingShoppingToComplete}
          quickRestockIngredients={props.quickRestockIngredients}
          ingredients={props.ingredients}
          selectedInventoryIngredient={selectedInventoryIngredient}
          selectedIngredientPreview={selectedIngredientPreview}
          selectedIngredientMeta={selectedIngredientMeta}
          inventoryUnitOptions={inventoryUnitOptions}
          selectedInventoryUnit={selectedInventoryUnit}
          inventoryNormalizedQuantity={inventoryNormalizedQuantity}
          inventoryExpiryDaysValue={inventoryExpiryDaysValue}
          syncInventoryIngredient={syncInventoryIngredient}
          submitInventory={props.submitInventory}
          isCreatingInventory={props.isCreatingInventory}
        />
      )}

      {isConsumeOverlay && selectedConsumeSummary && (
        <IngredientConsumeOverlay
          closeOverlay={closeIfAllowed}
          consumeForm={props.consumeForm}
          selectedConsumeSummary={selectedConsumeSummary}
          selectedConsumePreview={selectedConsumePreview}
          selectedConsumeMeta={selectedConsumeMeta}
          consumeUnitOptions={consumeUnitOptions}
          selectedConsumeUnit={selectedConsumeUnit}
          consumeAvailableQuantity={consumeAvailableQuantity}
          consumeStep={consumeStep}
          consumeSuggestedQuantity={consumeSuggestedQuantity}
          consumeQuantityValue={consumeQuantityValue}
          consumeRemainingQuantity={consumeRemainingQuantity}
          consumeIsAllState={consumeIsAllState}
          consumeCanSubmit={consumeCanSubmit}
          consumeRangeStyle={consumeRangeStyle}
          consumeQuickValues={consumeQuickValues as ConsumeQuickPreset[]}
          consumeTotalRemainingLabel={consumeTotalRemainingLabel}
          updateConsumeUnit={updateConsumeUnit}
          updateConsumeQuantity={updateConsumeQuantity}
          updateConsumeQuantityInput={updateConsumeQuantityInput}
          submitConsume={props.submitConsume}
          isConsumingInventory={props.isConsumingInventory}
        />
      )}

      {isShoppingOverlay && (
        <IngredientShoppingOverlay
          closeOverlay={closeIfAllowed}
          ingredients={props.ingredients}
          foods={props.foods}
          shoppingForm={props.shoppingForm}
          setShoppingForm={props.setShoppingForm}
          selectedShoppingIngredient={selectedShoppingIngredient}
          selectedShoppingFood={selectedShoppingFood}
          selectedShoppingIngredientPreview={selectedShoppingIngredientPreview}
          selectedShoppingFoodPreview={selectedShoppingFoodPreview}
          selectedShoppingIngredientMeta={selectedShoppingIngredientMeta}
          selectedShoppingFoodMeta={selectedShoppingFoodMeta}
          shoppingIngredientUnitOptions={shoppingIngredientUnitOptions}
          shoppingQuantityValue={shoppingQuantityValue}
          shoppingQuantityStep={shoppingQuantityStep}
          shoppingQuantityQuickValues={shoppingQuantityQuickValues}
          submitShopping={props.submitShopping}
          isCreatingShopping={props.isCreatingShopping}
        />
      )}
    </WorkspaceOverlayFrame>
  );
}
