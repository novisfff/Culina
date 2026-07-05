import { useMemo, type FormEvent } from 'react';
import type { Ingredient, IngredientExpiryMode, IngredientUnitConversion, InventoryStatus } from '../../api/types';
import { resolveMediaUrl } from '../../lib/assets';
import { addDateKeyDays } from '../../lib/date';
import { tracksIngredientQuantity } from '../../lib/ingredientTracking';
import { formatDate, INVENTORY_STATUS_LABELS, todayKey } from '../../lib/ui';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
import {
  ActionButton,
  Badge,
  ComboboxField,
  DropdownSelect,
  FormActions,
  OptionChipGroup,
  QuantityUnitField,
  ResourcePickerField,
  TouchRangeField,
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
  selectedIngredientPreview?: string;
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
  const tracksQuantity = tracksIngredientQuantity(props.selectedInventoryIngredient);

  const statusOptions = useMemo(() => {
    return Object.entries(INVENTORY_STATUS_LABELS).map(([key, label]) => ({
      value: key,
      label: label,
    }));
  }, []);

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
  const inventoryQuantityUnitOptions = useMemo(() => {
    const currentUnit = props.inventoryForm.unit || props.selectedInventoryIngredient?.default_unit || '个';
    const units = props.selectedInventoryIngredient
      ? [currentUnit, ...props.inventoryUnitOptions.map((option) => option.unit)]
      : [currentUnit];
    return units
      .filter((unit, index, list) => unit && list.indexOf(unit) === index)
      .map((unit) => ({ value: unit, label: unit }));
  }, [props.inventoryForm.unit, props.inventoryUnitOptions, props.selectedInventoryIngredient]);

  return (
    <WorkspaceModal
      title="登记这批库存"
      description="把这次买回来的这一批快速记下来。"
      closeLabel="关闭"
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
                  {props.quickRestockIngredients.map((ingredient) => {
                    const imageUrl = resolveMediaUrl(ingredient.image, 'thumb');
                    return (
                      <button
                        key={ingredient.id}
                        type="button"
                        className={
                          props.inventoryForm.ingredientId === ingredient.id
                            ? 'ingredients-restock-quick-item active'
                            : 'ingredients-restock-quick-item'
                        }
                        onClick={() => props.syncInventoryIngredient(ingredient, ingredient.name)}
                      >
                        <div className="ingredients-restock-quick-avatar">
                          <MediaWithPlaceholder src={imageUrl} alt="" />
                        </div>
                        <span>{ingredient.name}</span>
                      </button>
                    );
                  })}
                </div>
              </section>
            )}

          {!props.inventoryForm.ingredientLocked && !props.selectedInventoryIngredient && (
            <div className="ingredients-restock-search-field ingredients-restock-picker-field">
              <span>食材</span>
              <ResourcePickerField
                className="custom-combobox-container"
                searchClassName="ingredients-restock-resource-search"
                listClassName="custom-combobox-dropdown"
                optionClassName={(option, selected) => selected ? 'custom-combobox-option selected' : 'custom-combobox-option'}
                ariaLabel="选择食材"
                placeholder="搜索或选择食材"
                value={props.inventoryForm.ingredientId}
                query={props.inventoryForm.ingredientQuery}
                options={visibleIngredientOptions.map((ingredient) => ({
                  id: ingredient.id,
                  label: ingredient.name,
                  description: `${ingredient.category || '食材'} · 默认 ${ingredient.default_unit || '个'}`,
                  image: (
                    <div className="custom-combobox-option-avatar">
                      <MediaWithPlaceholder src={resolveMediaUrl(ingredient.image, 'thumb')} alt="" />
                    </div>
                  ),
                }))}
                emptyText="没有匹配的食材"
                onQueryChange={(nextQuery) => {
                  const ingredient = props.ingredients.find((item) => item.name === nextQuery) ?? null;
                  props.syncInventoryIngredient(ingredient, nextQuery);
                }}
                onChange={(ingredientId) => {
                  const ingredient = props.ingredients.find((item) => item.id === ingredientId) ?? null;
                  props.syncInventoryIngredient(ingredient, ingredient?.name ?? '');
                }}
              />
            </div>
          )}

          {props.selectedInventoryIngredient && (
            <section className="ingredients-restock-identity-card">
              <div className="ingredients-restock-identity-media">
                <MediaWithPlaceholder
                  src={props.selectedIngredientPreview}
                  alt={props.selectedInventoryIngredient.name}
                />
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
              <QuantityUnitField
                className="ingredients-restock-quantity-field"
                quantity={props.inventoryForm.quantity}
                unit={props.inventoryForm.unit || props.selectedInventoryIngredient?.default_unit || '个'}
                unitOptions={inventoryQuantityUnitOptions}
                quantityDisabled={!tracksQuantity}
                quantityDisabledReason={!tracksQuantity ? '这个食材只记录是否有库存，不填写具体数量。' : undefined}
                onQuantityChange={(quantity) =>
                  props.setInventoryForm({
                    ...props.inventoryForm,
                    quantity,
                  })
                }
                onUnitChange={(unit) =>
                  props.setInventoryForm({
                    ...props.inventoryForm,
                    unit,
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
              </section>
            </div>
          </section>

          <section className="ingredients-restock-field-group">
            <div className="ingredients-restock-field-head">
              <span>购买时间</span>
              <p className="subtle">默认今天，需要时再改。</p>
            </div>
            <OptionChipGroup
              ariaLabel="购买时间"
              value={props.inventoryForm.purchaseDatePreset}
              options={[
                { value: 'today', label: '今天' },
                { value: 'yesterday', label: '昨天' },
                { value: 'custom', label: '自定义' },
              ]}
              className="ingredients-restock-choice-row"
              onChange={(purchaseDatePreset) =>
                props.setInventoryForm({
                  ...props.inventoryForm,
                  purchaseDatePreset: purchaseDatePreset as InventoryPurchasePreset,
                  purchaseDate:
                    purchaseDatePreset === 'today'
                      ? todayKey()
                      : purchaseDatePreset === 'yesterday'
                        ? addDateKeyDays(todayKey(), -1)
                        : props.inventoryForm.purchaseDate,
                })
              }
            />
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
            <ComboboxField
              ariaLabel="保存位置"
              placeholder="选择或输入保存位置"
              value={props.inventoryForm.storageLocation}
              options={INVENTORY_STORAGE_PRESETS.map((storage) => ({ value: storage, label: storage }))}
              allowCustom
              onChange={(storageLocation) =>
                props.setInventoryForm({
                  ...props.inventoryForm,
                  storageLocation: String(storageLocation),
                })
              }
            />
          </section>

          <section className="ingredients-restock-field-group">
            <div className="ingredients-restock-field-head">
              <span>到期信息</span>
              <p className="subtle">确认这批食材怎么跟踪到期。</p>
            </div>
            <OptionChipGroup
              ariaLabel="到期信息"
              value={props.inventoryForm.expiryInputMode}
              options={[
                { value: 'none', label: '不记录' },
                { value: 'days', label: '几天后到期' },
                { value: 'manual_date', label: '包装到期日' },
              ]}
              className="ingredients-restock-choice-row"
              onChange={(expiryInputMode) =>
                props.setInventoryForm({
                  ...props.inventoryForm,
                  expiryInputMode: expiryInputMode as IngredientExpiryMode,
                  expiryDays:
                    expiryInputMode === 'days'
                      ? props.inventoryForm.expiryDays ||
                        (props.selectedInventoryIngredient?.default_expiry_days
                          ? String(props.selectedInventoryIngredient.default_expiry_days)
                          : '3')
                      : '',
                  expiryDate:
                    expiryInputMode === 'manual_date'
                      ? props.inventoryForm.expiryDate
                      : expiryInputMode === 'days'
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
            />
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
              <div className="ingredients-modal-advanced-fields">
                <div className="ingredients-restock-status-custom-field">
                  <span>状态</span>
                  <DropdownSelect
                    ariaLabel="选择状态"
                    placeholder="选择状态"
                    value={props.inventoryForm.status}
                    options={statusOptions}
                    onChange={(val) =>
                      props.setInventoryForm({
                        ...props.inventoryForm,
                        status: val as InventoryStatus,
                        statusDirty: true,
                      })
                    }
                  />
                </div>
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
          <FormActions
            className="ingredients-restock-actions"
            primaryLabel={tracksQuantity ? '补入库存' : '确认已有'}
            primaryType="submit"
            primaryDisabled={!props.inventoryForm.ingredientId}
            isSubmitting={Boolean(props.isCreatingInventory)}
            secondaryLabel="取消"
            onSecondary={props.closeOverlay}
          />
        </div>
      </form>
    </WorkspaceModal>
  );
}
