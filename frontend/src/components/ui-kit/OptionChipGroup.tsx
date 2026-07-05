export type OptionChip<T extends string> = {
  value: T;
  label: string;
  description?: string;
  disabled?: boolean;
};

export type OptionChipGroupProps<T extends string> = {
  ariaLabel: string;
  value: T;
  options: readonly OptionChip<T>[];
  onChange: (value: T) => void;
  className?: string;
};

export function OptionChipGroup<T extends string>({ ariaLabel, value, options, onChange, className }: OptionChipGroupProps<T>) {
  return (
    <div className={['ui-option-chip-group', className].filter(Boolean).join(' ')} role="radiogroup" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          disabled={option.disabled}
          className={option.value === value ? 'ui-option-chip is-selected' : 'ui-option-chip'}
          onClick={() => onChange(option.value)}
        >
          <span>{option.label}</span>
          {option.description ? <small>{option.description}</small> : null}
        </button>
      ))}
    </div>
  );
}
