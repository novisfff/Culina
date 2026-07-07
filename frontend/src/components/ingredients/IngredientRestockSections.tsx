import type { Ingredient, IngredientExpiryMode, InventoryStatus } from '../../api/types';
import { addDateKeyDays } from '../../lib/date';
import { tracksIngredientQuantity } from '../../lib/ingredientTracking';
import { formatDate, INVENTORY_STATUS_LABELS, todayKey } from '../../lib/ui';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
import {
  ActionButton,
  Badge,
  ComboboxField,
  DropdownSelect,
  OptionChipGroup,
  QuantityUnitField,
  TouchRangeField,
} from '../ui-kit';
import {
  formatNumericString,
  INVENTORY_STORAGE_PRESETS,
  resolveExpiryDateFromDays,
  type InventoryPurchasePreset,
} from './ingredientWorkspaceForms';

export type RestockUnitOption = { value: string; label: string };

export function IngredientRestockIdentitySection(props: {
  ingredient: Ingredient | null;
  previewUrl?: string;
  meta: string[];
  badgeLabel: string;
  canSwitch?: boolean;
  onSwitch?: () => void;
}) {
  if (!props.ingredient) {
    return null;
  }

  return (
    <section className="ingredients-restock-identity-card">
      <div className="ingredients-restock-identity-media">
        <MediaWithPlaceholder src={props.previewUrl} alt={props.ingredient.name} />
      </div>
      <div className="ingredients-restock-identity-copy">
        <div className="ingredients-restock-identity-head">
          <div>
            <h4>{props.ingredient.name}</h4>
            <p>{props.meta.join(' · ')}</p>
          </div>
          <Badge>{props.badgeLabel}</Badge>
        </div>
        {props.canSwitch && props.onSwitch ? (
          <ActionButton
            tone="tertiary"
            size="compact"
            type="button"
            className="ingredients-restock-identity-switch"
            onClick={props.onSwitch}
          >
            换一个食材
          </ActionButton>
        ) : null}
      </div>
    </section>
  );
}

export function IngredientRestockQuantitySection(props: {
  ingredient: Ingredient | null;
  quantity: string;
  unit: string;
  unitOptions: RestockUnitOption[];
  selectedUnit: { unit: string } | null;
  normalizedQuantity: number | null;
  onQuantityChange: (quantity: string) => void;
  onUnitChange: (unit: string) => void;
}) {
  const tracksQuantity = tracksIngredientQuantity(props.ingredient);
  const displayUnit = props.unit || props.ingredient?.default_unit || '个';

  return (
    <section className="ingredients-restock-field-group ingredients-restock-quantity-section">
      <div className="ingredients-restock-quantity-row">
        <QuantityUnitField
          className="ingredients-restock-quantity-field"
          quantity={props.quantity}
          unit={displayUnit}
          unitOptions={props.unitOptions}
          quantityDisabled={!tracksQuantity}
          quantityDisabledReason={!tracksQuantity ? '这个食材只记录是否有库存，不填写具体数量。' : undefined}
          onQuantityChange={props.onQuantityChange}
          onUnitChange={props.onUnitChange}
        />
        <section className="ingredients-restock-unit-card">
          <div className="ingredients-restock-unit-card-head">
            <span>单位</span>
            <strong>{displayUnit}</strong>
          </div>
          <p className="subtle">
            {props.ingredient
              ? props.selectedUnit?.unit === props.ingredient.default_unit
                ? '默认按主单位直接记库存'
                : props.normalizedQuantity !== null
                  ? `将记为 ${formatNumericString(props.normalizedQuantity)}${props.ingredient.default_unit} 库存`
                  : '切换单位后会自动折算到主单位'
              : '先选食材，再切换这次录入单位。'}
          </p>
        </section>
      </div>
    </section>
  );
}

export function IngredientRestockPurchaseSection(props: {
  purchaseDate: string;
  purchaseDatePreset: InventoryPurchasePreset;
  onChange: (patch: Partial<{ purchaseDate: string; purchaseDatePreset: InventoryPurchasePreset }>) => void;
}) {
  return (
    <section className="ingredients-restock-field-group">
      <div className="ingredients-restock-field-head">
        <span>购买时间</span>
        <p className="subtle">默认今天，需要时再改。</p>
      </div>
      <OptionChipGroup
        ariaLabel="购买时间"
        value={props.purchaseDatePreset}
        options={[
          { value: 'today', label: '今天' },
          { value: 'yesterday', label: '昨天' },
          { value: 'custom', label: '自定义' },
        ]}
        className="ingredients-restock-choice-row"
        onChange={(purchaseDatePreset) =>
          props.onChange({ purchaseDatePreset: purchaseDatePreset as InventoryPurchasePreset })
        }
      />
      {props.purchaseDatePreset === 'custom' ? (
        <label>
          <span>购买日期</span>
          <input
            className="text-input"
            type="date"
            required
            value={props.purchaseDate}
            onChange={(event) => props.onChange({ purchaseDate: event.target.value, purchaseDatePreset: 'custom' })}
          />
        </label>
      ) : null}
    </section>
  );
}

export function IngredientRestockStorageSection(props: {
  storageLocation: string;
  onChange: (storageLocation: string) => void;
}) {
  return (
    <section className="ingredients-restock-field-group">
      <div className="ingredients-restock-field-head">
        <span>存放位置</span>
        <p className="subtle">按这次实际放的位置点一下。</p>
      </div>
      <ComboboxField
        ariaLabel="保存位置"
        placeholder="选择或输入保存位置"
        value={props.storageLocation}
        options={INVENTORY_STORAGE_PRESETS.map((storage) => ({ value: storage, label: storage }))}
        allowCustom
        onChange={(storageLocation) => props.onChange(String(storageLocation))}
      />
    </section>
  );
}

export function IngredientRestockExpirySection(props: {
  expiryInputMode: IngredientExpiryMode;
  expiryDays: string;
  expiryDate: string;
  purchaseDate: string;
  defaultExpiryDays?: number | null;
  expiryDaysValue: number;
  onChange: (patch: Partial<{ expiryInputMode: IngredientExpiryMode; expiryDays: string; expiryDate: string }>) => void;
}) {
  return (
    <section className="ingredients-restock-field-group">
      <div className="ingredients-restock-field-head">
        <span>到期信息</span>
        <p className="subtle">确认这批食材怎么跟踪到期。</p>
      </div>
      <OptionChipGroup
        ariaLabel="到期信息"
        value={props.expiryInputMode}
        options={[
          { value: 'none', label: '不记录' },
          { value: 'days', label: '几天后到期' },
          { value: 'manual_date', label: '包装到期日' },
        ]}
        className="ingredients-restock-choice-row"
        onChange={(expiryInputMode) => {
          const nextMode = expiryInputMode as IngredientExpiryMode;
          const nextDays = nextMode === 'days' ? props.expiryDays || String(props.defaultExpiryDays ?? 3) : '';
          props.onChange({
            expiryInputMode: nextMode,
            expiryDays: nextDays,
            expiryDate:
              nextMode === 'manual_date'
                ? props.expiryDate
                : nextMode === 'days'
                  ? resolveExpiryDateFromDays(props.purchaseDate, nextDays)
                  : '',
          });
        }}
      />
      {props.expiryInputMode === 'days' ? (
        <div className="ingredients-restock-expiry-grid">
          <TouchRangeField
            label="买后几天到期"
            value={props.expiryDaysValue}
            min={1}
            max={30}
            step={1}
            marks={[1, 3, 7, 14, 30]}
            formatValue={(value) => `${value} 天`}
            onChange={(value) =>
              props.onChange({
                expiryDays: String(value),
                expiryDate: resolveExpiryDateFromDays(props.purchaseDate, String(value)),
              })
            }
          />
          <div className="ingredients-restock-result-card">
            <span>预计到期日</span>
            <strong>{props.expiryDate ? formatDate(props.expiryDate) : '先选天数'}</strong>
            <p>{props.expiryDate ? `${props.purchaseDate} 购入` : '拖动后会自动换算日期'}</p>
          </div>
        </div>
      ) : props.expiryInputMode === 'manual_date' ? (
        <label>
          <span>包装到期日</span>
          <input
            className="text-input"
            type="date"
            required
            value={props.expiryDate}
            onChange={(event) => props.onChange({ expiryDate: event.target.value })}
          />
        </label>
      ) : (
        <p className="ingredients-restock-field-note">这批不跟踪到期提醒。</p>
      )}
    </section>
  );
}

export function IngredientRestockAdvancedSection(props: {
  open: boolean;
  status: InventoryStatus;
  notes: string;
  onOpenChange: (open: boolean) => void;
  onChange: (patch: Partial<{ status: InventoryStatus; notes: string; statusDirty: boolean }>) => void;
  showToggle?: boolean;
}) {
  const statusOptions = Object.entries(INVENTORY_STATUS_LABELS).map(([key, label]) => ({ value: key, label }));
  const showToggle = props.showToggle ?? true;

  return (
    <section className="ingredients-modal-advanced">
      {showToggle ? (
        <button
          className="ghost-button ingredients-modal-advanced-toggle"
          type="button"
          onClick={() => props.onOpenChange(!props.open)}
        >
          {props.open ? '收起更多选项' : '更多选项'}
        </button>
      ) : null}
      {props.open ? (
        <div className="ingredients-modal-advanced-fields">
          <div className="ingredients-restock-status-custom-field">
            <span>状态</span>
            <DropdownSelect
              ariaLabel="选择状态"
              placeholder="选择状态"
              value={props.status}
              options={statusOptions}
              onChange={(val) => props.onChange({ status: val as InventoryStatus, statusDirty: true })}
            />
          </div>
          <label className="span-two">
            <span>备注</span>
            <textarea
              className="text-input"
              rows={3}
              value={props.notes}
              onChange={(event) => props.onChange({ notes: event.target.value })}
            />
          </label>
        </div>
      ) : null}
    </section>
  );
}

export function resolvePurchaseDatePatch(
  patch: Partial<{ purchaseDate: string; purchaseDatePreset: InventoryPurchasePreset }>,
) {
  if (patch.purchaseDatePreset === 'today') {
    return { purchaseDatePreset: 'today' as const, purchaseDate: todayKey() };
  }
  if (patch.purchaseDatePreset === 'yesterday') {
    return { purchaseDatePreset: 'yesterday' as const, purchaseDate: addDateKeyDays(todayKey(), -1) };
  }
  return patch;
}
