import { DropdownSelect, type DropdownSelectOption } from './DropdownSelect';

export type QuantityUnitFieldProps = {
  quantity: string;
  unit: string;
  unitOptions: readonly DropdownSelectOption<string>[];
  onQuantityChange: (value: string) => void;
  onUnitChange: (value: string) => void;
  quantityDisabled?: boolean;
  quantityDisabledReason?: string;
  /** Browser step hint; domain validation remains the source of truth. */
  quantityStep?: string;
  /** Optional focus target key attached to the quantity input. */
  quantityFieldKey?: string;
  /** Optional focus target key attached to the unit select trigger. */
  unitFieldKey?: string;
  className?: string;
};

export function QuantityUnitField({
  quantity,
  unit,
  unitOptions,
  onQuantityChange,
  onUnitChange,
  quantityDisabled = false,
  quantityDisabledReason,
  quantityStep = '0.01',
  quantityFieldKey,
  unitFieldKey,
  className,
}: QuantityUnitFieldProps) {
  return (
    <div className={['ui-quantity-unit-field', className].filter(Boolean).join(' ')}>
      <label className="ui-quantity-unit-number">
        <span>数量</span>
        <input
          aria-label="数量"
          type="number"
          inputMode="decimal"
          step={quantityStep}
          value={quantity}
          disabled={quantityDisabled}
          data-field-key={quantityFieldKey}
          onChange={(event) => onQuantityChange(event.target.value)}
        />
      </label>
      <label className="ui-quantity-unit-select">
        <span>单位</span>
        <DropdownSelect
          ariaLabel="单位"
          placeholder="选择单位"
          value={unit}
          options={unitOptions}
          triggerFieldKey={unitFieldKey}
          onChange={(value) => onUnitChange(value)}
        />
      </label>
      {quantityDisabledReason ? <p className="ui-quantity-unit-reason">{quantityDisabledReason}</p> : null}
    </div>
  );
}
