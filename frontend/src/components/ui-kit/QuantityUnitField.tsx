import { DropdownSelect, type DropdownSelectOption } from './DropdownSelect';

export type QuantityUnitFieldProps = {
  quantity: string;
  unit: string;
  unitOptions: readonly DropdownSelectOption<string>[];
  onQuantityChange: (value: string) => void;
  onUnitChange: (value: string) => void;
  quantityLabel?: string;
  unitLabel?: string;
  quantityDisabled?: boolean;
  quantityDisabledReason?: string;
  allowEmptyQuantity?: boolean;
  className?: string;
};

export function QuantityUnitField({
  quantity,
  unit,
  unitOptions,
  onQuantityChange,
  onUnitChange,
  quantityLabel = '数量',
  unitLabel = '单位',
  quantityDisabled = false,
  quantityDisabledReason,
  allowEmptyQuantity = true,
  className,
}: QuantityUnitFieldProps) {
  return (
    <div className={['ui-quantity-unit-field', className, quantityDisabled ? 'is-quantity-disabled' : ''].filter(Boolean).join(' ')}>
      <label className="ui-quantity-unit-number">
        <span>{quantityLabel}</span>
        <input
          aria-label={quantityLabel}
          type="number"
          inputMode="decimal"
          min={allowEmptyQuantity ? undefined : 0}
          step="0.01"
          value={quantity}
          disabled={quantityDisabled}
          onChange={(event) => onQuantityChange(event.target.value)}
        />
      </label>
      <label className="ui-quantity-unit-select">
        <span>{unitLabel}</span>
        <DropdownSelect
          ariaLabel={unitLabel}
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
