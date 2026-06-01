import { useMemo, useState, type FormEvent } from 'react';
import type { Ingredient, IngredientExpiryMode, IngredientUnitConversion, InventoryStatus } from '../../api/types';
import { resolveAssetUrl } from '../../lib/assets';
import { addDateKeyDays } from '../../lib/date';
import { buildIngredientPlaceholderSvg, formatDate, INVENTORY_STATUS_LABELS, todayKey } from '../../lib/ui';
import {
  ActionButton,
  Badge,
  TouchRangeField,
  TouchStepperField,
  WorkspaceModal,
} from '../ui-kit';
import type { PendingShoppingCompletion } from './IngredientWorkspaceOverlayTypes';
import {
  formatNumericString,
  INVENTORY_STORAGE_PRESETS,
  resolveExpiryDateFromDays,
  type InventoryDrawerFormState,
  type InventoryPurchasePreset,
} from './ingredientWorkspaceForms';

type IngredientInventoryOverlayProps = {
  closeOverlay: () => void;
  inventoryForm: InventoryDrawerFormState;
  setInventoryForm: (next: InventoryDrawerFormState) => void;
  inventoryAdvancedOpen: boolean;
  setInventoryAdvancedOpen: (next: boolean) => void;
  pendingShoppingToComplete: PendingShoppingCompletion | null;
  quickRestockIngredients: Ingredient[];
  ingredients: Ingredient[];
  selectedInventoryIngredient: Ingredient | null;
  selectedIngredientPreview: string;
  selectedIngredientMeta: string[];
  usesCustomStorage: boolean;
  inventoryUnitOptions: IngredientUnitConversion[];
  selectedInventoryUnit: IngredientUnitConversion | null;
  inventoryNormalizedQuantity: number | null;
  inventoryQuantityValue: number;
  inventoryQuantityStep: number;
  inventoryQuantityQuickValues: number[];
  inventoryExpiryDaysValue: number;
  syncInventoryIngredient: (ingredient: Ingredient | null, ingredientQuery?: string) => void;
  submitInventory: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  isCreatingInventory?: boolean;
};

export function IngredientInventoryOverlay(props: IngredientInventoryOverlayProps) {
  const [ingredientPickerOpen, setIngredientPickerOpen] = useState(false);
  const visibleIngredientOptions = useMemo(() => {
    const query = props.inventoryForm.ingredientQuery.trim().toLowerCase();
    const matched = props.ingredients.filter((ingredient) => {
      if (!query) return true;
      return [ingredient.name, ingredient.category, ingredient.default_storage, ingredient.notes]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query));
    });
    return matched.slice(0, 8);
  }, [props.ingredients, props.inventoryForm.ingredientQuery]);

  return (
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
          {!props.inventoryForm.ingredientLocked &&
            !props.selectedInventoryIngredient &&
            props.quickRestockIngredients.length > 0 && (
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
                      onClick={() => props.syncInventoryIngredient(ingredient, ingredient.name)}
                    >
                      {ingredient.name}
                    </button>
                  ))}
                </div>
              </section>
            )}

          {!props.inventoryForm.ingredientLocked && !props.selectedInventoryIngredient && (
            <div className="ingredients-restock-search-field ingredients-restock-picker-field">
              <span>食材</span>
              <div className="ingredients-restock-picker-shell">
                <input
                  className="text-input"
                  placeholder="搜索或选择食材"
                  value={props.inventoryForm.ingredientQuery}
                  onFocus={() => setIngredientPickerOpen(true)}
                  onBlur={() => window.setTimeout(() => setIngredientPickerOpen(false), 120)}
                  onChange={(event) => {
                    const nextQuery = event.target.value;
                    const ingredient = props.ingredients.find((item) => item.name === nextQuery) ?? null;
                    props.syncInventoryIngredient(ingredient, nextQuery);
                    setIngredientPickerOpen(true);
                  }}
                />
                <button
                  className="ingredients-restock-picker-toggle"
                  type="button"
                  aria-label="展开食材选择"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => setIngredientPickerOpen((current) => !current)}
                >
                  ▼
                </button>
                {ingredientPickerOpen && (
                  <div className="ingredients-restock-picker-menu" role="listbox" aria-label="选择食材">
                    {visibleIngredientOptions.length > 0 ? (
                      visibleIngredientOptions.map((ingredient) => {
                        const imageUrl =
                          resolveAssetUrl(ingredient.image?.url) ?? buildIngredientPlaceholderSvg(ingredient.name);
                        return (
                          <button
                            key={ingredient.id}
                            type="button"
                            role="option"
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => {
                              props.syncInventoryIngredient(ingredient, ingredient.name);
                              setIngredientPickerOpen(false);
                            }}
                          >
                            <img src={imageUrl} alt="" />
                            <span>
                              <strong>{ingredient.name}</strong>
                              <small>
                                {ingredient.category || '未分类'} · 默认 {ingredient.default_unit || '个'} · {ingredient.default_storage || '常温'}
                              </small>
                            </span>
                          </button>
                        );
                      })
                    ) : (
                      <div className="ingredients-restock-picker-empty">没有匹配的食材</div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {props.selectedInventoryIngredient && (
            <section className="ingredients-restock-identity-card">
              <div className="ingredients-restock-identity-media">
                <img src={props.selectedIngredientPreview} alt={props.selectedInventoryIngredient.name} />
              </div>
              <div className="ingredients-restock-identity-copy">
                <div className="ingredients-restock-identity-head">
                  <div>
                    <h4>{props.selectedInventoryIngredient.name}</h4>
                    <p>{props.selectedIngredientMeta.join(' · ')}</p>
                  </div>
                  <Badge>{props.inventoryForm.ingredientLocked ? '当前食材' : '已选食材'}</Badge>
                </div>
                {!props.inventoryForm.ingredientLocked && (
                  <ActionButton
                    tone="tertiary"
                    size="compact"
                    type="button"
                    className="ingredients-restock-identity-switch"
                    onClick={() => props.syncInventoryIngredient(null, '')}
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
                value={props.inventoryQuantityValue}
                min={props.inventoryQuantityStep}
                step={props.inventoryQuantityStep}
                quickValues={props.inventoryQuantityQuickValues}
                allowCustomInput
                customInputMode="inline"
                customInputLabel="直接输入"
                inputMin={props.inventoryQuantityStep}
                inputStep={props.inventoryQuantityStep}
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
                  <strong>{props.inventoryForm.unit || props.selectedInventoryIngredient?.default_unit || '个'}</strong>
                </div>
                <p className="subtle">
                  {props.selectedInventoryIngredient
                    ? props.selectedInventoryUnit?.unit === props.selectedInventoryIngredient.default_unit
                      ? '默认按主单位直接记库存'
                      : props.inventoryNormalizedQuantity !== null
                        ? `将记为 ${formatNumericString(props.inventoryNormalizedQuantity)}${props.selectedInventoryIngredient.default_unit} 库存`
                        : '切换单位后会自动折算到主单位'
                    : '先选食材，再切换这次录入单位。'}
                </p>
                <div className="ingredients-restock-unit-chip-row">
                  {(props.selectedInventoryIngredient
                    ? props.inventoryUnitOptions
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
                      disabled={!props.selectedInventoryIngredient}
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
                className={props.usesCustomStorage ? 'ingredients-choice-chip active' : 'ingredients-choice-chip'}
                onClick={() =>
                  props.setInventoryForm({
                    ...props.inventoryForm,
                    storageLocation:
                      props.usesCustomStorage && props.inventoryForm.storageLocation
                        ? props.inventoryForm.storageLocation
                        : '',
                  })
                }
              >
                其他
              </button>
            </div>
            {props.usesCustomStorage && (
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
                            (props.selectedInventoryIngredient?.default_expiry_days
                              ? String(props.selectedInventoryIngredient.default_expiry_days)
                              : '3')
                          : '',
                      expiryDate:
                        item.value === 'manual_date'
                          ? props.inventoryForm.expiryDate
                          : item.value === 'days'
                            ? resolveExpiryDateFromDays(
                                props.inventoryForm.purchaseDate,
                                props.inventoryForm.expiryDays ||
                                  (props.selectedInventoryIngredient?.default_expiry_days
                                    ? String(props.selectedInventoryIngredient.default_expiry_days)
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
                  value={props.inventoryExpiryDaysValue}
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
  );
}
