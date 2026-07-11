import { DropdownSelect, type DropdownSelectOption } from './DropdownSelect';

export type QuantityUnitFieldProps = {
  quantity: string;
  unit: string;
  unitOptions: readonly DropdownSelectOption<string>[];
  onQuantityChange: (value: string) => void;
  onUnitChange: (value: string) => void;
  quantityDisabled?: boolean;
  quantityDisabledReason?: string;
  /** Optional focus target key attached to the quantity input. */
  quantityFieldKey?: string;
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
  quantityFieldKey,
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
          step="0.01"
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
          onChange={(value) => onUnitChange(value)}
        />
      </label>
      {quantityDisabledReason ? <p className="ui-quantity-unit-reason">{quantityDisabledReason}</p> : null}
    </div>
  );
}
