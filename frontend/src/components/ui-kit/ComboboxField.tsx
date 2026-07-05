import { useEffect, useMemo, useState, type ReactNode } from 'react';

export type ComboboxOption<T extends string> = {
  value: T;
  label: string;
  description?: string;
};

export type ComboboxFieldProps<T extends string> = {
  ariaLabel: string;
  value: T | string;
  options: readonly ComboboxOption<T>[];
  onChange: (value: T | string) => void;
  placeholder: string;
  allowCustom?: boolean;
  disabled?: boolean;
  className?: string;
  inputClassName?: string;
  menuClassName?: string;
  optionClassName?: string;
  customOptionClassName?: string;
  leadingIcon?: ReactNode;
};

function normalizeComboboxText(value: string) {
  return value.trim().toLowerCase();
}

export function ComboboxField<T extends string>({
  ariaLabel,
  value,
  options,
  onChange,
  placeholder,
  allowCustom = false,
  disabled = false,
  className,
  inputClassName,
  menuClassName,
  optionClassName,
  customOptionClassName,
  leadingIcon,
}: ComboboxFieldProps<T>) {
  const [inputValue, setInputValue] = useState(String(value ?? ''));
  const [filterQuery, setFilterQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const visibleOptions = useMemo(() => {
    const normalized = normalizeComboboxText(filterQuery);
    if (!normalized) return options;
    return options.filter((option) => normalizeComboboxText(`${option.label} ${option.value} ${option.description ?? ''}`).includes(normalized));
  }, [options, filterQuery]);

  useEffect(() => {
    setInputValue(String(value ?? ''));
  }, [value]);

  function commitCustomValue() {
    const next = inputValue.trim();
    if (allowCustom && next) {
      onChange(next);
      setIsOpen(false);
    }
  }

  return (
    <div className={['ui-combobox-field', className, isOpen ? 'is-open' : '', disabled ? 'is-disabled' : ''].filter(Boolean).join(' ')}>
      {leadingIcon}
      <input
        className={inputClassName}
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={isOpen}
        aria-autocomplete="list"
        disabled={disabled}
        placeholder={placeholder}
        value={inputValue}
        onFocus={() => {
          setFilterQuery('');
          setIsOpen(true);
        }}
        onChange={(event) => {
          const nextValue = event.target.value;
          setInputValue(nextValue);
          setFilterQuery(nextValue);
          onChange(nextValue);
          setIsOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setIsOpen(false);
          if (event.key === 'Enter') commitCustomValue();
        }}
      />
      {isOpen && (
        <div className={['ui-combobox-menu', menuClassName].filter(Boolean).join(' ')} role="listbox" aria-label={`${ariaLabel}选项`}>
          {visibleOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              className={optionClassName}
              role="option"
              aria-selected={option.value === value}
              onClick={() => {
                setInputValue(option.label);
                setFilterQuery(option.label);
                onChange(option.value);
                setIsOpen(false);
              }}
            >
              <strong>{option.label}</strong>
              {option.description ? <small>{option.description}</small> : null}
            </button>
          ))}
          {allowCustom && inputValue.trim() && !options.some((option) => normalizeComboboxText(option.label) === normalizeComboboxText(inputValue)) ? (
            <button type="button" className={customOptionClassName} role="option" aria-selected={false} onClick={commitCustomValue}>
              <strong>使用自定义：{inputValue.trim()}</strong>
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
