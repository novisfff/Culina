import type { CSSProperties } from 'react';
import type { Ingredient } from '../../api/types';
import { resolveAssetUrl } from '../../lib/assets';
import { buildIngredientPlaceholderSvg } from '../../lib/ui';
import { convertQuantityToDefaultUnit, getIngredientUnitOptions, resolvePreferredIngredientUnit } from '../../lib/ingredientUnits';
import {
  buildDisposableExpiredInventoryItems,
  buildInventoryCardPresentation,
} from './workspaceModel';
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
  INVENTORY_STORAGE_PRESETS,
  parseOptionalNumber,
  parsePositiveNumber,
  resolveClampedDaysValue,
  resolveTouchDefaultValue,
  resolveTouchQuickValues,
  resolveTouchStep,
} from './ingredientWorkspaceForms';
import { IngredientInventoryOverlay } from './IngredientInventoryOverlay';
import { IngredientConsumeOverlay } from './IngredientConsumeOverlay';
import { IngredientDestroyExpiredOverlay } from './IngredientDestroyExpiredOverlay';
import { IngredientShoppingOverlay } from './IngredientShoppingOverlay';
import type { OverlayLayerProps, PendingShoppingCompletion } from './IngredientWorkspaceOverlayTypes';

export type { PendingShoppingCompletion } from './IngredientWorkspaceOverlayTypes';

export function IngredientWorkspaceOverlays(props: OverlayLayerProps) {
  if (!props.overlayMode) {
    return null;
  }

  const selectedInventoryIngredient =
    props.ingredients.find((item) => item.id === props.inventoryForm.ingredientId) ?? null;
  const selectedConsumeSummary =
    props.ingredientSummaries.find((item) => item.ingredient.id === props.consumeForm.ingredientId) ?? null;
  const selectedDestroyExpiredSummary =
    props.destroyExpiredIngredientId
      ? props.ingredientSummaries.find((item) => item.ingredient.id === props.destroyExpiredIngredientId) ?? null
      : null;
  const destroyExpiredItems = selectedDestroyExpiredSummary
    ? buildDisposableExpiredInventoryItems(selectedDestroyExpiredSummary)
    : [];
  const destroyExpiredPresentation = selectedDestroyExpiredSummary
    ? buildInventoryCardPresentation(selectedDestroyExpiredSummary)
    : null;
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
  const usesCustomStorage = !INVENTORY_STORAGE_PRESETS.includes(
    props.inventoryForm.storageLocation as (typeof INVENTORY_STORAGE_PRESETS)[number]
  );
  const inventoryUnitOptions = selectedInventoryIngredient
    ? getIngredientUnitOptions(selectedInventoryIngredient)
    : [];
  const selectedInventoryUnit =
    inventoryUnitOptions.find((item) => item.unit === props.inventoryForm.unit) ?? inventoryUnitOptions[0] ?? null;
  const inventoryNormalizedQuantity =
    selectedInventoryIngredient && parsePositiveNumber(props.inventoryForm.quantity) !== null
      ? convertQuantityToDefaultUnit(
          selectedInventoryIngredient,
          parsePositiveNumber(props.inventoryForm.quantity) ?? 0,
          props.inventoryForm.unit
        )
      : null;
  const inventoryQuantityValue =
    parsePositiveNumber(props.inventoryForm.quantity) ??
    resolveTouchDefaultValue(props.inventoryForm.unit || selectedInventoryIngredient?.default_unit || '个', 'quantity');
  const inventoryQuantityStep = resolveTouchStep(
    props.inventoryForm.unit || selectedInventoryIngredient?.default_unit || '个'
  );
  const inventoryQuantityQuickValues = resolveTouchQuickValues(
    props.inventoryForm.unit || selectedInventoryIngredient?.default_unit || '个',
    'quantity'
  );
  const inventoryExpiryDaysValue = resolveClampedDaysValue(
    props.inventoryForm.expiryDays,
    selectedInventoryIngredient?.default_expiry_days ?? 3
  );
  const shoppingQuantityValue =
    parsePositiveNumber(props.shoppingForm.quantity) ??
    resolveTouchDefaultValue(props.shoppingForm.unit || '个', 'quantity');
  const shoppingQuantityStep = resolveTouchStep(props.shoppingForm.unit || '个');
  const shoppingQuantityQuickValues = resolveTouchQuickValues(props.shoppingForm.unit || '个', 'quantity');
  const selectedShoppingIngredient = props.shoppingForm.title.trim()
    ? props.ingredients.find((item) => item.name === props.shoppingForm.title.trim()) ?? null
    : null;
  const shoppingIngredientUnitOptions = selectedShoppingIngredient
    ? getIngredientUnitOptions(selectedShoppingIngredient)
    : [];
  const selectedShoppingIngredientPreview =
    selectedShoppingIngredient?.image?.url
      ? resolveAssetUrl(selectedShoppingIngredient.image.url) ??
        buildIngredientPlaceholderSvg((selectedShoppingIngredient?.name ?? props.shoppingForm.title) || '待买项')
      : buildIngredientPlaceholderSvg((selectedShoppingIngredient?.name ?? props.shoppingForm.title) || '待买项');
  const selectedShoppingIngredientMeta = selectedShoppingIngredient
    ? [
        selectedShoppingIngredient.category || '未分类',
        `默认 ${selectedShoppingIngredient.default_unit || '个'}`,
        selectedShoppingIngredient.default_storage || '常温',
      ]
    : [];
  const selectedIngredientPreview =
    selectedInventoryIngredient?.image?.url
      ? resolveAssetUrl(selectedInventoryIngredient.image.url) ??
        buildIngredientPlaceholderSvg(selectedInventoryIngredient?.name ?? '食材')
      : buildIngredientPlaceholderSvg(selectedInventoryIngredient?.name ?? '食材');
  const selectedIngredientMeta = selectedInventoryIngredient
    ? [
        selectedInventoryIngredient.category || '未分类',
        `默认 ${selectedInventoryIngredient.default_unit || '个'}`,
        selectedInventoryIngredient.default_storage || '常温',
      ]
    : [];
  const selectedConsumePreview =
    selectedConsumeSummary?.ingredient.image?.url
      ? resolveAssetUrl(selectedConsumeSummary.ingredient.image.url) ??
        buildIngredientPlaceholderSvg(selectedConsumeSummary?.ingredient.name ?? '食材')
      : buildIngredientPlaceholderSvg(selectedConsumeSummary?.ingredient.name ?? '食材');
  const selectedConsumeMeta = selectedConsumeSummary
    ? [
        selectedConsumeSummary.ingredient.category || '未分类',
        `默认 ${selectedConsumeSummary.ingredient.default_unit || '个'}`,
        selectedConsumeSummary.primaryStorage || selectedConsumeSummary.ingredient.default_storage || '常温',
      ]
    : [];
  const selectedDestroyExpiredPreview =
    selectedDestroyExpiredSummary?.ingredient.image?.url
      ? resolveAssetUrl(selectedDestroyExpiredSummary.ingredient.image.url) ??
        buildIngredientPlaceholderSvg(selectedDestroyExpiredSummary?.ingredient.name ?? '食材')
      : buildIngredientPlaceholderSvg(selectedDestroyExpiredSummary?.ingredient.name ?? '食材');
  const selectedDestroyExpiredMeta = selectedDestroyExpiredSummary
    ? [
        selectedDestroyExpiredSummary.ingredient.category || '未分类',
        `默认 ${selectedDestroyExpiredSummary.ingredient.default_unit || '个'}`,
        selectedDestroyExpiredSummary.primaryStorage || selectedDestroyExpiredSummary.ingredient.default_storage || '常温',
      ]
    : [];

  if (props.overlayMode === 'destroyExpired' && !selectedDestroyExpiredSummary) {
    return null;
  }

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

  return (
    <div className="workspace-overlay-root">
      <div className="workspace-overlay-backdrop" onClick={props.closeOverlay} />

      {props.overlayMode === 'inventory' && (
        <IngredientInventoryOverlay
          closeOverlay={props.closeOverlay}
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
          usesCustomStorage={usesCustomStorage}
          inventoryUnitOptions={inventoryUnitOptions}
          selectedInventoryUnit={selectedInventoryUnit}
          inventoryNormalizedQuantity={inventoryNormalizedQuantity}
          inventoryQuantityValue={inventoryQuantityValue}
          inventoryQuantityStep={inventoryQuantityStep}
          inventoryQuantityQuickValues={inventoryQuantityQuickValues}
          inventoryExpiryDaysValue={inventoryExpiryDaysValue}
          syncInventoryIngredient={syncInventoryIngredient}
          submitInventory={props.submitInventory}
          isCreatingInventory={props.isCreatingInventory}
        />
      )}

      {props.overlayMode === 'consume' && selectedConsumeSummary && (
        <IngredientConsumeOverlay
          closeOverlay={props.closeOverlay}
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

      {props.overlayMode === 'destroyExpired' && selectedDestroyExpiredSummary && (
        <IngredientDestroyExpiredOverlay
          closeOverlay={props.closeOverlay}
          selectedDestroyExpiredSummary={selectedDestroyExpiredSummary}
          selectedDestroyExpiredPreview={selectedDestroyExpiredPreview}
          selectedDestroyExpiredMeta={selectedDestroyExpiredMeta}
          destroyExpiredItems={destroyExpiredItems}
          destroyExpiredHeadline={destroyExpiredPresentation?.headline ?? '未登记'}
          submitDestroyExpired={props.submitDestroyExpired}
          isDisposingExpiredInventory={props.isDisposingExpiredInventory}
        />
      )}

      {props.overlayMode === 'shopping' && (
        <IngredientShoppingOverlay
          closeOverlay={props.closeOverlay}
          ingredients={props.ingredients}
          shoppingForm={props.shoppingForm}
          setShoppingForm={props.setShoppingForm}
          selectedShoppingIngredient={selectedShoppingIngredient}
          selectedShoppingIngredientPreview={selectedShoppingIngredientPreview}
          selectedShoppingIngredientMeta={selectedShoppingIngredientMeta}
          shoppingIngredientUnitOptions={shoppingIngredientUnitOptions}
          shoppingQuantityValue={shoppingQuantityValue}
          shoppingQuantityStep={shoppingQuantityStep}
          shoppingQuantityQuickValues={shoppingQuantityQuickValues}
          submitShopping={props.submitShopping}
          isCreatingShopping={props.isCreatingShopping}
        />
      )}
    </div>
  );
}
