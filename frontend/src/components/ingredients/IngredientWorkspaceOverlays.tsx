import type { CSSProperties, FormEvent } from 'react';
import type {
  Ingredient,
  IngredientExpiryMode,
  InventoryStatus,
} from '../../api/types';
import { resolveAssetUrl } from '../../lib/assets';
import { addDateKeyDays } from '../../lib/date';
import {
  buildIngredientPlaceholderSvg,
  formatDate,
  formatRelativeDays,
  INVENTORY_STATUS_LABELS,
  todayKey,
} from '../../lib/ui';
import {
  ActionButton,
  Badge,
  EmptyState,
  TouchRangeField,
  TouchStepperField,
  WorkspaceModal,
} from '../ui-kit';
import {
  convertQuantityToDefaultUnit,
  getIngredientUnitOptions,
  resolvePreferredIngredientUnit,
} from '../../lib/ingredientUnits';
import {
  buildDisposableExpiredInventoryItems,
  buildInventoryCardPresentation,
  type IngredientOverlayMode,
  type IngredientSummaryViewModel,
} from './workspaceModel';
import {
  buildConsumeQuickValues,
  clampConsumeQuantity,
  getConsumeRemainingQuantity,
  isConsumeAllSelected,
  resolveConsumeStep,
  resolveInitialConsumeQuantity,
} from './consumeQuickHelpers';
import {
  buildConsumeUnitOptions,
  buildInventoryForm,
  buildUnitPresetOptions,
  clampNumber,
  formatNumericString,
  INVENTORY_STORAGE_PRESETS,
  parseOptionalNumber,
  parsePositiveNumber,
  resolveClampedDaysValue,
  resolveExpiryDateFromDays,
  resolveTouchDefaultValue,
  resolveTouchQuickValues,
  resolveTouchStep,
  type ConsumeDialogFormState,
  type InventoryDrawerFormState,
  type InventoryPurchasePreset,
  type ShoppingDialogFormState,
} from './ingredientWorkspaceForms';

export type PendingShoppingCompletion = {
  itemId: string;
  title: string;
};

type OverlayLayerProps = {
  overlayMode: IngredientOverlayMode;
  closeOverlay: () => void;
  inventoryForm: InventoryDrawerFormState;
  setInventoryForm: (next: InventoryDrawerFormState) => void;
  inventoryAdvancedOpen: boolean;
  setInventoryAdvancedOpen: (next: boolean) => void;
  consumeForm: ConsumeDialogFormState;
  setConsumeForm: (next: ConsumeDialogFormState) => void;
  shoppingForm: ShoppingDialogFormState;
  setShoppingForm: (next: ShoppingDialogFormState) => void;
  destroyExpiredIngredientId: string | null;
  ingredients: Ingredient[];
  ingredientSummaries: IngredientSummaryViewModel[];
  quickRestockIngredients: Ingredient[];
  submitInventory: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  submitConsume: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  submitShopping: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  submitDestroyExpired: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  pendingShoppingToComplete: PendingShoppingCompletion | null;
  isCreatingInventory?: boolean;
  isConsumingInventory?: boolean;
  isDisposingExpiredInventory?: boolean;
  isCreatingShopping?: boolean;
};

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
  const shoppingUnitOptions = buildUnitPresetOptions(props.shoppingForm.unit || '个');
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
      ? resolveAssetUrl(selectedShoppingIngredient.image.url)
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
      ? resolveAssetUrl(selectedInventoryIngredient.image.url)
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
      ? resolveAssetUrl(selectedConsumeSummary.ingredient.image.url)
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
      ? resolveAssetUrl(selectedDestroyExpiredSummary.ingredient.image.url)
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
        <WorkspaceModal
          title="登记这批库存"
          description="把这次买回来的这一批快速记下来。"
          closeLabel="×"
          closeAriaLabel="关闭"
          className="workspace-modal-wide inventory-restock-modal"
          onClose={props.closeOverlay}
        >
          <form className="ingredients-restock-form" onSubmit={(event) => void props.submitInventory(event)}>
            <div className="ingredients-restock-scroll">
              {props.pendingShoppingToComplete && (
                <div className="ingredients-restock-source-note">
                  <Badge>来自待买项</Badge>
                  <span>{props.pendingShoppingToComplete.title}</span>
                </div>
              )}
              {!props.inventoryForm.ingredientLocked && !selectedInventoryIngredient && props.quickRestockIngredients.length > 0 && (
                <section className="ingredients-restock-field-group ingredients-restock-selection-strip">
                  <div className="ingredients-restock-field-head">
                    <span>最近常补</span>
                    <p className="subtle">常用食材点一下就行。</p>
                  </div>
                  <div className="ingredients-restock-choice-row">
                    {props.quickRestockIngredients.map((ingredient) => (
                      <button
                        key={ingredient.id}
                        type="button"
                        className={
                          props.inventoryForm.ingredientId === ingredient.id
                            ? 'ingredients-choice-chip active'
                            : 'ingredients-choice-chip'
                        }
                        onClick={() => syncInventoryIngredient(ingredient, ingredient.name)}
                      >
                        {ingredient.name}
                      </button>
                    ))}
                  </div>
                </section>
              )}

              {!props.inventoryForm.ingredientLocked && !selectedInventoryIngredient && (
                <label className="ingredients-restock-search-field">
                  <span>食材</span>
                  <input
                    className="text-input"
                    list="ingredient-restock-options"
                    placeholder="搜索或选择食材"
                    value={props.inventoryForm.ingredientQuery}
                    onChange={(event) => {
                      const nextQuery = event.target.value;
                      const ingredient = props.ingredients.find((item) => item.name === nextQuery) ?? null;
                      syncInventoryIngredient(ingredient, nextQuery);
                    }}
                  />
                  <datalist id="ingredient-restock-options">
                    {props.ingredients.map((ingredient) => (
                      <option key={ingredient.id} value={ingredient.name} />
                    ))}
                  </datalist>
                </label>
              )}

              {selectedInventoryIngredient && (
                <section className="ingredients-restock-identity-card">
                  <div className="ingredients-restock-identity-media">
                    <img src={selectedIngredientPreview} alt={selectedInventoryIngredient.name} />
                  </div>
                  <div className="ingredients-restock-identity-copy">
                    <div className="ingredients-restock-identity-head">
                      <div>
                        <h4>{selectedInventoryIngredient.name}</h4>
                        <p>{selectedIngredientMeta.join(' · ')}</p>
                      </div>
                      <Badge>{props.inventoryForm.ingredientLocked ? '当前食材' : '已选食材'}</Badge>
                    </div>
                    {!props.inventoryForm.ingredientLocked && (
                      <ActionButton
                        tone="tertiary"
                        size="compact"
                        type="button"
                        className="ingredients-restock-identity-switch"
                        onClick={() => syncInventoryIngredient(null, '')}
                      >
                        换一个食材
                      </ActionButton>
                    )}
                  </div>
                </section>
              )}

              <section className="ingredients-restock-field-group ingredients-restock-quantity-section">
                <div className="ingredients-restock-quantity-row">
                  <TouchStepperField
                    label="数量"
                    value={inventoryQuantityValue}
                    min={inventoryQuantityStep}
                    step={inventoryQuantityStep}
                    quickValues={inventoryQuantityQuickValues}
                    allowCustomInput
                    customInputMode="inline"
                    customInputLabel="直接输入"
                    inputMin={inventoryQuantityStep}
                    inputStep={inventoryQuantityStep}
                    formatValue={(value) => formatNumericString(value)}
                    onChange={(value) =>
                      props.setInventoryForm({
                        ...props.inventoryForm,
                        quantity: formatNumericString(value),
                      })
                    }
                  />
                  <section className="ingredients-restock-unit-card">
                    <div className="ingredients-restock-unit-card-head">
                      <span>单位</span>
                      <strong>{props.inventoryForm.unit || selectedInventoryIngredient?.default_unit || '个'}</strong>
                    </div>
                    <p className="subtle">
                      {selectedInventoryIngredient
                        ? selectedInventoryUnit?.unit === selectedInventoryIngredient.default_unit
                          ? '默认按主单位直接记库存'
                          : inventoryNormalizedQuantity !== null
                            ? `将记为 ${formatNumericString(inventoryNormalizedQuantity)}${selectedInventoryIngredient.default_unit} 库存`
                            : '切换单位后会自动折算到主单位'
                        : '先选食材，再切换这次录入单位。'}
                    </p>
                    <div className="ingredients-restock-unit-chip-row">
                      {(selectedInventoryIngredient
                        ? inventoryUnitOptions
                        : [{ unit: props.inventoryForm.unit || '个', ratio_to_default: 1 }]
                      ).map((option) => (
                        <button
                          key={`inventory-unit-${option.unit}`}
                          type="button"
                          className={
                            props.inventoryForm.unit === option.unit
                              ? 'ingredients-choice-chip ingredients-unit-chip active'
                              : 'ingredients-choice-chip ingredients-unit-chip'
                          }
                          onClick={() =>
                            props.setInventoryForm({
                              ...props.inventoryForm,
                              unit: option.unit,
                            })
                          }
                          disabled={!selectedInventoryIngredient}
                        >
                          {option.unit}
                        </button>
                      ))}
                    </div>
                  </section>
                </div>
              </section>

              <section className="ingredients-restock-field-group">
                <div className="ingredients-restock-field-head">
                  <span>购买时间</span>
                  <p className="subtle">默认今天，需要时再改。</p>
                </div>
                <div className="ingredients-restock-choice-row">
                  {[
                    { value: 'today', label: '今天', date: todayKey() },
                    { value: 'yesterday', label: '昨天', date: addDateKeyDays(todayKey(), -1) },
                    { value: 'custom', label: '自定义', date: props.inventoryForm.purchaseDate },
                  ].map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      className={
                        props.inventoryForm.purchaseDatePreset === item.value
                          ? 'ingredients-choice-chip active'
                          : 'ingredients-choice-chip'
                      }
                      onClick={() =>
                        props.setInventoryForm({
                          ...props.inventoryForm,
                          purchaseDatePreset: item.value as InventoryPurchasePreset,
                          purchaseDate: item.value === 'custom' ? props.inventoryForm.purchaseDate : item.date,
                        })
                      }
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                {props.inventoryForm.purchaseDatePreset === 'custom' && (
                  <label>
                    <span>购买日期</span>
                    <input
                      className="text-input"
                      type="date"
                      required
                      value={props.inventoryForm.purchaseDate}
                      onChange={(event) =>
                        props.setInventoryForm({
                          ...props.inventoryForm,
                          purchaseDate: event.target.value,
                          purchaseDatePreset: 'custom',
                        })
                      }
                    />
                  </label>
                )}
              </section>

              <section className="ingredients-restock-field-group">
                <div className="ingredients-restock-field-head">
                  <span>存放位置</span>
                  <p className="subtle">按这次实际放的位置点一下。</p>
                </div>
                <div className="ingredients-restock-choice-row">
                  {INVENTORY_STORAGE_PRESETS.map((storage) => (
                    <button
                      key={storage}
                      type="button"
                      className={
                        props.inventoryForm.storageLocation === storage
                          ? 'ingredients-choice-chip active'
                          : 'ingredients-choice-chip'
                      }
                      onClick={() =>
                        props.setInventoryForm({
                          ...props.inventoryForm,
                          storageLocation: storage,
                        })
                      }
                    >
                      {storage}
                    </button>
                  ))}
                  <button
                    type="button"
                    className={usesCustomStorage ? 'ingredients-choice-chip active' : 'ingredients-choice-chip'}
                    onClick={() =>
                      props.setInventoryForm({
                        ...props.inventoryForm,
                        storageLocation:
                          usesCustomStorage && props.inventoryForm.storageLocation
                            ? props.inventoryForm.storageLocation
                            : '',
                      })
                    }
                  >
                    其他
                  </button>
                </div>
                {usesCustomStorage && (
                  <label>
                    <span>自定义位置</span>
                    <input
                      className="text-input"
                      value={props.inventoryForm.storageLocation}
                      placeholder="例如 门边小冰箱"
                      onChange={(event) =>
                        props.setInventoryForm({
                          ...props.inventoryForm,
                          storageLocation: event.target.value,
                        })
                      }
                    />
                  </label>
                )}
              </section>

              <section className="ingredients-restock-field-group">
                <div className="ingredients-restock-field-head">
                  <span>到期信息</span>
                  <p className="subtle">确认这批食材怎么跟踪到期。</p>
                </div>
                <div className="ingredients-restock-choice-row">
                  {[
                    { value: 'none', label: '不记录' },
                    { value: 'days', label: '几天后到期' },
                    { value: 'manual_date', label: '包装到期日' },
                  ].map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      className={
                        props.inventoryForm.expiryInputMode === item.value
                          ? 'ingredients-choice-chip active'
                          : 'ingredients-choice-chip'
                      }
                      onClick={() =>
                        props.setInventoryForm({
                          ...props.inventoryForm,
                          expiryInputMode: item.value as IngredientExpiryMode,
                          expiryDays:
                            item.value === 'days'
                              ? props.inventoryForm.expiryDays ||
                                (selectedInventoryIngredient?.default_expiry_days
                                  ? String(selectedInventoryIngredient.default_expiry_days)
                                  : '3')
                              : '',
                          expiryDate:
                            item.value === 'manual_date'
                              ? props.inventoryForm.expiryDate
                              : item.value === 'days'
                                ? resolveExpiryDateFromDays(
                                    props.inventoryForm.purchaseDate,
                                    props.inventoryForm.expiryDays ||
                                      (selectedInventoryIngredient?.default_expiry_days
                                        ? String(selectedInventoryIngredient.default_expiry_days)
                                        : '3')
                                  )
                                : '',
                        })
                      }
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                {props.inventoryForm.expiryInputMode === 'days' ? (
                  <div className="ingredients-restock-expiry-grid">
                    <TouchRangeField
                      label="买后几天到期"
                      value={inventoryExpiryDaysValue}
                      min={1}
                      max={30}
                      step={1}
                      marks={[1, 3, 7, 14, 30]}
                      formatValue={(value) => `${value} 天`}
                      onChange={(value) =>
                        props.setInventoryForm({
                          ...props.inventoryForm,
                          expiryDays: String(value),
                        })
                      }
                    />
                    <div className="ingredients-restock-result-card">
                      <span>预计到期日</span>
                      <strong>
                        {props.inventoryForm.expiryDate ? formatDate(props.inventoryForm.expiryDate) : '先选天数'}
                      </strong>
                      <p>
                        {props.inventoryForm.expiryDate
                          ? `${props.inventoryForm.purchaseDate} 购入`
                          : '拖动后会自动换算日期'}
                      </p>
                    </div>
                  </div>
                ) : props.inventoryForm.expiryInputMode === 'manual_date' ? (
                  <label>
                    <span>包装到期日</span>
                    <input
                      className="text-input"
                      type="date"
                      required
                      value={props.inventoryForm.expiryDate}
                      onChange={(event) =>
                        props.setInventoryForm({ ...props.inventoryForm, expiryDate: event.target.value })
                      }
                    />
                  </label>
                ) : (
                  <p className="ingredients-restock-field-note">这批不跟踪到期提醒。</p>
                )}
              </section>

              <section className="ingredients-modal-advanced">
                <button
                  className="ghost-button ingredients-modal-advanced-toggle"
                  type="button"
                  onClick={() => props.setInventoryAdvancedOpen(!props.inventoryAdvancedOpen)}
                >
                  {props.inventoryAdvancedOpen ? '收起更多选项' : '更多选项'}
                </button>
                {props.inventoryAdvancedOpen && (
                  <div className="form-grid compact-grid ingredients-modal-advanced-fields">
                    <label>
                      <span>状态</span>
                      <select
                        className="text-input"
                        value={props.inventoryForm.status}
                        onChange={(event) =>
                          props.setInventoryForm({
                            ...props.inventoryForm,
                            status: event.target.value as InventoryStatus,
                            statusDirty: true,
                          })
                        }
                      >
                        {Object.entries(INVENTORY_STATUS_LABELS).map(([key, label]) => (
                          <option key={key} value={key}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="span-two">
                      <span>备注</span>
                      <textarea
                        className="text-input"
                        rows={3}
                        value={props.inventoryForm.notes}
                        onChange={(event) =>
                          props.setInventoryForm({ ...props.inventoryForm, notes: event.target.value })
                        }
                      />
                    </label>
                  </div>
                )}
              </section>
            </div>

            <div className="ingredients-restock-footer-bar">
              <div className="workspace-overlay-actions">
                <ActionButton tone="secondary" type="button" onClick={props.closeOverlay}>
                  取消
                </ActionButton>
                <ActionButton
                  tone="primary"
                  type="submit"
                  disabled={props.isCreatingInventory || !props.inventoryForm.ingredientId}
                >
                  {props.isCreatingInventory ? '保存中...' : '保存这批库存'}
                </ActionButton>
              </div>
            </div>
          </form>
        </WorkspaceModal>
      )}

      {props.overlayMode === 'consume' && selectedConsumeSummary && (
        <WorkspaceModal
          title="快速消费"
          description="记下这次实际用掉多少，系统会自动从更早到期的批次开始扣减。"
          closeLabel="×"
          closeAriaLabel="关闭"
          className="consume-quick-modal"
          onClose={props.closeOverlay}
        >
          <form className="consume-quick-form" onSubmit={(event) => void props.submitConsume(event)}>
            <div className="consume-quick-scroll">
              <section className="ingredients-restock-identity-card ingredients-consume-identity-card">
                <div className="ingredients-restock-identity-media">
                  <img src={selectedConsumePreview} alt={selectedConsumeSummary.ingredient.name} />
                </div>
                <div className="ingredients-restock-identity-copy">
                  <div className="ingredients-restock-identity-head">
                    <div>
                      <h4>{selectedConsumeSummary.ingredient.name}</h4>
                      <p>{selectedConsumeMeta.join(' · ')}</p>
                    </div>
                    <div className="consume-quick-identity-badges">
                      <Badge>{selectedConsumeSummary.inventoryItems.length} 条批次</Badge>
                      {consumeIsAllState && <Badge className="consume-quick-state-badge">接近清空</Badge>}
                    </div>
                  </div>
                  <div className="consume-quick-identity-summary">
                    <article className="consume-quick-summary-card is-primary">
                      <span>当前总剩余</span>
                      <strong>{consumeTotalRemainingLabel}</strong>
                      <p>{selectedConsumeSummary.inventoryItems.length} 条批次会参与这次扣减</p>
                    </article>
                    <article className="consume-quick-summary-card">
                      <span>扣减方式</span>
                      <strong>优先更早到期</strong>
                      <p>系统会自动从更早到期的批次开始扣减。</p>
                    </article>
                  </div>
                  <div className="ingredients-consume-stock-strip consume-quick-stock-strip">
                    {consumeUnitOptions.map((item) => (
                      <span key={`${selectedConsumeSummary.ingredient.id}-${item.unit}`} className="ingredient-visual-pill">
                        可按 {item.unit} 记 {formatNumericString(item.available)}
                        {item.unit}
                      </span>
                    ))}
                  </div>
                </div>
              </section>

              <section className="ingredients-restock-field-group ingredients-consume-unit-section">
                <div className="ingredients-restock-field-head">
                  <span>记录单位</span>
                  <p className="subtle">
                    {consumeUnitOptions.length > 1
                      ? '先选这次实际用掉的是哪种单位，切换后数量会自动对齐到该单位剩余量。'
                      : '直接按这个单位记录就行，系统会自动处理批次扣减。'}
                  </p>
                </div>
                {consumeUnitOptions.length === 1 && selectedConsumeUnit ? (
                  <div className="ingredients-consume-unit-single">
                    <div className="ingredients-consume-unit-single-main">
                      <span>当前单位</span>
                      <strong>{selectedConsumeUnit.unit}</strong>
                    </div>
                    <div className="ingredients-consume-unit-single-meta">
                      <span>当前剩余</span>
                      <strong>
                        {formatNumericString(selectedConsumeUnit.available)}
                        {selectedConsumeUnit.unit}
                      </strong>
                    </div>
                  </div>
                ) : (
                  <div className="ingredients-restock-choice-row ingredients-consume-unit-row">
                    {consumeUnitOptions.map((item) => (
                      <button
                        key={`${selectedConsumeSummary.ingredient.id}-${item.unit}`}
                        type="button"
                        className={
                          selectedConsumeUnit?.unit === item.unit
                            ? 'ingredients-choice-chip ingredients-consume-unit-chip active'
                            : 'ingredients-choice-chip ingredients-consume-unit-chip'
                        }
                        onClick={() => updateConsumeUnit(item.unit)}
                      >
                        <span className="ingredients-consume-unit-chip-label">{item.unit}</span>
                        <small>
                          当前剩余 {formatNumericString(item.available)}
                          {item.unit}
                        </small>
                      </button>
                    ))}
                  </div>
                )}
              </section>

              <section
                className={
                  consumeIsAllState
                    ? 'ingredients-restock-field-group ingredients-consume-amount-section is-all'
                    : 'ingredients-restock-field-group ingredients-consume-amount-section'
                }
              >
                <div className="ingredients-restock-field-head">
                  <span>消费量</span>
                  <p className="subtle">拖动滑条快速操作，也可以点快捷值或直接输入来微调。</p>
                </div>
                <div className="consume-quick-live-row">
                  <article className="consume-quick-live-card is-active">
                    <span>本次消费</span>
                    <strong>
                      {selectedConsumeUnit ? `${formatNumericString(consumeQuantityValue)}${selectedConsumeUnit.unit}` : '先选单位'}
                    </strong>
                    <p>滑动时会实时同步到提交结果。</p>
                  </article>
                  <article className={consumeIsAllState ? 'consume-quick-live-card is-warning' : 'consume-quick-live-card'}>
                    <span>消费后剩余</span>
                    <strong>
                      {selectedConsumeUnit
                        ? `${formatNumericString(consumeRemainingQuantity)}${selectedConsumeUnit.unit}`
                        : '先选单位'}
                    </strong>
                    <p>{consumeIsAllState ? '这次会把当前单位库存几乎用完。' : '保留量会随着拖动即时更新。'}</p>
                  </article>
                </div>
                <div
                  className={consumeIsAllState ? 'touch-field touch-range-field consume-quick-range-field is-all' : 'touch-field touch-range-field consume-quick-range-field'}
                >
                  <div className="touch-field-head consume-quick-range-head">
                    <span>拖拉条</span>
                    <label className="consume-quick-range-editor-shell">
                      <input
                        className="consume-quick-range-editor-input"
                        type="number"
                        min={0}
                        max={consumeAvailableQuantity || undefined}
                        step={consumeStep}
                        inputMode="decimal"
                        aria-label="消费量输入"
                        placeholder={formatNumericString(consumeSuggestedQuantity)}
                        value={props.consumeForm.quantity}
                        disabled={!selectedConsumeUnit}
                        onChange={(event) => updateConsumeQuantityInput(event.target.value)}
                      />
                      <strong>{(selectedConsumeUnit?.unit ?? props.consumeForm.unit) || '单位'}</strong>
                    </label>
                  </div>
                  <div className="touch-field-helper">
                    {selectedConsumeUnit
                      ? `当前最多 ${formatNumericString(consumeAvailableQuantity)}${selectedConsumeUnit.unit}，拖动或直接改数字都会同步预估剩余量。`
                      : '先选择单位'}
                  </div>
                  <div className="touch-range-main">
                    <ActionButton
                      tone="secondary"
                      size="compact"
                      type="button"
                      className="touch-stepper-button"
                      aria-label="消费量减少"
                      disabled={!selectedConsumeUnit}
                      onClick={() => updateConsumeQuantity(consumeQuantityValue - consumeStep)}
                    >
                      -
                    </ActionButton>
                    <input
                      className="touch-range-input"
                      type="range"
                      min={0}
                      max={consumeAvailableQuantity || consumeStep}
                      step={consumeStep}
                      value={consumeQuantityValue}
                      style={consumeRangeStyle}
                      disabled={!selectedConsumeUnit}
                      aria-valuetext={
                        selectedConsumeUnit
                          ? `${formatNumericString(consumeQuantityValue)}${selectedConsumeUnit.unit}`
                          : formatNumericString(consumeQuantityValue)
                      }
                      onChange={(event) => updateConsumeQuantity(Number(event.target.value))}
                    />
                    <ActionButton
                      tone="secondary"
                      size="compact"
                      type="button"
                      className="touch-stepper-button"
                      aria-label="消费量增加"
                      disabled={!selectedConsumeUnit}
                      onClick={() => updateConsumeQuantity(consumeQuantityValue + consumeStep)}
                    >
                      +
                    </ActionButton>
                  </div>
                </div>
                {consumeQuickValues.length > 0 && (
                  <div className="consume-quick-shortcut-row">
                    {consumeQuickValues.map((item) => {
                      const isActive = item.isAll
                        ? consumeIsAllState
                        : Math.abs(consumeQuantityValue - item.value) < 0.001;
                      const className = [
                        'consume-quick-shortcut',
                        isActive ? 'active' : '',
                        item.isAll ? 'is-all' : '',
                      ]
                        .filter(Boolean)
                        .join(' ');

                      return (
                        <button
                          key={item.key}
                          type="button"
                          className={className}
                          disabled={!selectedConsumeUnit}
                          onClick={() => updateConsumeQuantity(item.value)}
                        >
                          {item.label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </section>
            </div>

            <div className="consume-quick-footer-bar">
              <div className="consume-quick-footer-summary">
                <span>本次将记录</span>
                <strong>
                  {selectedConsumeUnit ? `${formatNumericString(consumeQuantityValue)}${selectedConsumeUnit.unit}` : '先选单位'}
                </strong>
                <p>
                  {selectedConsumeUnit
                    ? consumeIsAllState
                      ? '提交后这一单位库存会接近清空。'
                      : `提交后剩余 ${formatNumericString(consumeRemainingQuantity)}${selectedConsumeUnit.unit}。`
                    : '系统会自动优先扣减更早到期批次。'}
                </p>
              </div>
              <div className="workspace-overlay-actions">
                <ActionButton tone="secondary" type="button" onClick={props.closeOverlay}>
                  取消
                </ActionButton>
                <ActionButton
                  tone="primary"
                  type="submit"
                  disabled={props.isConsumingInventory || !consumeCanSubmit}
                >
                  {props.isConsumingInventory ? '保存中...' : '记录这次消费'}
                </ActionButton>
              </div>
            </div>
          </form>
        </WorkspaceModal>
      )}

      {props.overlayMode === 'destroyExpired' && selectedDestroyExpiredSummary && (
        <WorkspaceModal
          title="销毁已过期批次"
          description="会将这些过期批次的剩余量清零，但保留批次历史记录和活动日志。"
          closeLabel="×"
          closeAriaLabel="关闭"
          className="workspace-modal-wide destroy-expired-modal"
          onClose={props.closeOverlay}
        >
          <form className="destroy-expired-form" onSubmit={(event) => void props.submitDestroyExpired(event)}>
            <div className="destroy-expired-scroll">
              <section className="ingredients-restock-identity-card destroy-expired-summary-card">
                <div className="ingredients-restock-identity-media">
                  <img src={selectedDestroyExpiredPreview} alt={selectedDestroyExpiredSummary.ingredient.name} />
                </div>
                <div className="ingredients-restock-identity-copy">
                  <div className="ingredients-restock-identity-head">
                    <div>
                      <h4>{selectedDestroyExpiredSummary.ingredient.name}</h4>
                      <p>{selectedDestroyExpiredMeta.join(' · ')}</p>
                    </div>
                    <div className="destroy-expired-summary-badges">
                      <Badge>{destroyExpiredItems.length} 条待销毁</Badge>
                      <Badge>{destroyExpiredPresentation?.headline ?? '未登记'}</Badge>
                    </div>
                  </div>
                  <div className="destroy-expired-summary-grid">
                    <article className="destroy-expired-summary-metric is-primary">
                      <span>本次处理范围</span>
                      <strong>{destroyExpiredItems.length} 条过期批次</strong>
                      <p>仅包含已经过期且当前仍有剩余量的批次。</p>
                    </article>
                    <article className="destroy-expired-summary-metric">
                      <span>处理结果</span>
                      <strong>清零剩余量</strong>
                      <p>批次记录、备注和活动日志都会继续保留。</p>
                    </article>
                  </div>
                </div>
              </section>

              <section className="ingredients-restock-field-group destroy-expired-list-section">
                <div className="ingredients-restock-field-head">
                  <span>将要销毁的批次</span>
                  <p className="subtle">
                    只列出到期日早于今天的剩余批次；今天到期和未来到期不会出现在这里。
                  </p>
                </div>
                {destroyExpiredItems.length > 0 ? (
                  <div className="destroy-expired-list">
                    {destroyExpiredItems.map((item) => (
                      <article key={item.id} className="destroy-expired-item">
                        <div className="destroy-expired-item-head">
                          <div className="destroy-expired-item-title">
                            <strong>{item.remainingLabel}</strong>
                            <span>{item.storageLocation}</span>
                          </div>
                          <div className="destroy-expired-item-badges">
                            <Badge className="destroy-expired-item-badge is-danger">
                              已过期 {formatRelativeDays(item.expiryDate)}
                            </Badge>
                            <Badge>{INVENTORY_STATUS_LABELS[item.status]}</Badge>
                          </div>
                        </div>
                        <div className="destroy-expired-item-meta">
                          <span>购买于 {formatDate(item.purchaseDate)}</span>
                          <span>到期日 {formatDate(item.expiryDate)}</span>
                        </div>
                        <p className="destroy-expired-item-note" title={item.notes || '当前没有备注'}>
                          {item.notes || '当前没有备注'}
                        </p>
                      </article>
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    title="当前没有可销毁的批次"
                    description="这份食材现在没有“已过期且仍有剩余量”的批次，可以直接关闭这个面板。"
                  />
                )}
              </section>
            </div>

            <div className="destroy-expired-footer-bar">
              <div className="destroy-expired-footer-summary">
                <span>确认后将处理</span>
                <strong>{destroyExpiredItems.length} 条过期批次</strong>
                <p>
                  {destroyExpiredItems.length > 0
                    ? '系统会把这些批次的剩余量清零，并在刷新后同步库存状态。'
                    : '当前没有可销毁的过期批次。'}
                </p>
              </div>
              <div className="workspace-overlay-actions">
                <ActionButton tone="secondary" type="button" onClick={props.closeOverlay}>
                  取消
                </ActionButton>
                <ActionButton
                  tone="primary"
                  type="submit"
                  disabled={props.isDisposingExpiredInventory || destroyExpiredItems.length === 0}
                >
                  {props.isDisposingExpiredInventory ? '销毁中...' : '确认销毁'}
                </ActionButton>
              </div>
            </div>
          </form>
        </WorkspaceModal>
      )}

      {props.overlayMode === 'shopping' && (
        <WorkspaceModal
          title="新增采购项"
          description="把这次要买的数量和原因快速记下来。"
          closeLabel="×"
          closeAriaLabel="关闭"
          className="workspace-modal-wide shopping-quick-modal"
          onClose={props.closeOverlay}
        >
          <form className="shopping-quick-form" onSubmit={(event) => void props.submitShopping(event)}>
            <div className="shopping-quick-scroll">
              {selectedShoppingIngredient ? (
                <section className="ingredients-restock-identity-card">
                  <div className="ingredients-restock-identity-media">
                    <img src={selectedShoppingIngredientPreview} alt={selectedShoppingIngredient.name} />
                  </div>
                  <div className="ingredients-restock-identity-copy">
                    <div className="ingredients-restock-identity-head">
                      <div>
                        <h4>{selectedShoppingIngredient.name}</h4>
                        <p>{selectedShoppingIngredientMeta.join(' · ')}</p>
                      </div>
                      <Badge>档案食材</Badge>
                    </div>
                  </div>
                </section>
              ) : (
                <label className="shopping-quick-name-field">
                  <span>名称</span>
                  <input
                    className="text-input"
                    list="shopping-ingredient-options"
                    placeholder="输入名称或直接选食材"
                    value={props.shoppingForm.title}
                    onChange={(event) => {
                      const nextTitle = event.target.value;
                      const matchedIngredient = props.ingredients.find((item) => item.name === nextTitle) ?? null;
                      props.setShoppingForm({
                        ...props.shoppingForm,
                        title: nextTitle,
                        unit: matchedIngredient
                          ? resolvePreferredIngredientUnit(matchedIngredient, props.shoppingForm.unit) ||
                            matchedIngredient.default_unit
                          : props.shoppingForm.unit,
                      });
                    }}
                  />
                  <datalist id="shopping-ingredient-options">
                    {props.ingredients.map((ingredient) => (
                      <option key={ingredient.id} value={ingredient.name} />
                    ))}
                  </datalist>
                </label>
              )}

              <section className="ingredients-restock-field-group ingredients-restock-quantity-section">
                <div className="ingredients-restock-quantity-row">
                  <TouchStepperField
                    label="数量"
                    value={shoppingQuantityValue}
                    min={shoppingQuantityStep}
                    step={shoppingQuantityStep}
                    quickValues={shoppingQuantityQuickValues}
                    allowCustomInput
                    customInputMode="inline"
                    customInputLabel="直接输入"
                    inputMin={shoppingQuantityStep}
                    inputStep={shoppingQuantityStep}
                    formatValue={(value) => formatNumericString(value)}
                    helper="常见数量点一下就能完成。"
                    onChange={(value) =>
                      props.setShoppingForm({
                        ...props.shoppingForm,
                        quantity: formatNumericString(value),
                      })
                    }
                  />
                  <section className="ingredients-restock-unit-card">
                    <div className="ingredients-restock-unit-card-head">
                      <span>单位</span>
                      <strong>{props.shoppingForm.unit || selectedShoppingIngredient?.default_unit || '个'}</strong>
                    </div>
                    {selectedShoppingIngredient ? (
                      <>
                        <p className="subtle">默认先用主单位，常用副单位点一下就能切换。</p>
                        <div className="ingredients-restock-unit-chip-row">
                          {shoppingIngredientUnitOptions.map((option) => (
                            <button
                              key={`shopping-unit-${option.unit}`}
                              type="button"
                              className={
                                props.shoppingForm.unit === option.unit
                                  ? 'ingredients-choice-chip ingredients-unit-chip active'
                                  : 'ingredients-choice-chip ingredients-unit-chip'
                              }
                              onClick={() =>
                                props.setShoppingForm({
                                  ...props.shoppingForm,
                                  unit: option.unit,
                                })
                              }
                            >
                              {option.unit}
                            </button>
                          ))}
                        </div>
                      </>
                    ) : (
                      <>
                        <p className="subtle">默认值不对时再改。</p>
                        <details className="ingredients-restock-unit-editor">
                          <summary>修改单位</summary>
                          <input
                            className="text-input"
                            list="shopping-unit-options"
                            value={props.shoppingForm.unit}
                            onChange={(event) =>
                              props.setShoppingForm({ ...props.shoppingForm, unit: event.target.value })
                            }
                          />
                          <datalist id="shopping-unit-options">
                            {shoppingUnitOptions.map((unit) => (
                              <option key={unit} value={unit} />
                            ))}
                          </datalist>
                        </details>
                      </>
                    )}
                  </section>
                </div>
              </section>

              <section className="ingredients-restock-field-group">
                <div className="ingredients-restock-field-head">
                  <span>原因</span>
                  <p className="subtle">留一句自己回头能看懂的备注就行。</p>
                </div>
                <input
                  className="text-input"
                  placeholder="例如 备一份新的，替换临期库存"
                  value={props.shoppingForm.reason}
                  onChange={(event) =>
                    props.setShoppingForm({ ...props.shoppingForm, reason: event.target.value })
                  }
                />
              </section>
            </div>

            <div className="shopping-quick-footer-bar">
              <div className="workspace-overlay-actions">
                <ActionButton tone="secondary" type="button" onClick={props.closeOverlay}>
                  取消
                </ActionButton>
                <ActionButton tone="primary" type="submit" disabled={props.isCreatingShopping}>
                  {props.isCreatingShopping ? '保存中...' : '加入清单'}
                </ActionButton>
              </div>
            </div>
          </form>
        </WorkspaceModal>
      )}
    </div>
  );
}
