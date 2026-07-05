import { useMemo, useState } from 'react';

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
}: ComboboxFieldProps<T>) {
  const [query, setQuery] = useState(String(value ?? ''));
  const [isOpen, setIsOpen] = useState(false);
  const visibleOptions = useMemo(() => {
    const normalized = normalizeComboboxText(query);
    if (!normalized) return options;
    return options.filter((option) => normalizeComboboxText(`${option.label} ${option.value} ${option.description ?? ''}`).includes(normalized));
  }, [options, query]);

  function commitCustomValue() {
    const next = query.trim();
    if (allowCustom && next) {
      onChange(next);
      setIsOpen(false);
    }
  }

  return (
    <div className={['ui-combobox-field', className, isOpen ? 'is-open' : '', disabled ? 'is-disabled' : ''].filter(Boolean).join(' ')}>
      <input
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={isOpen}
        aria-autocomplete="list"
        disabled={disabled}
        placeholder={placeholder}
        value={query}
        onFocus={() => setIsOpen(true)}
        onChange={(event) => {
          setQuery(event.target.value);
          setIsOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setIsOpen(false);
          if (event.key === 'Enter') commitCustomValue();
        }}
      />
      {isOpen && (
        <div className="ui-combobox-menu" role="listbox" aria-label={`${ariaLabel}选项`}>
          {visibleOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              onClick={() => {
                setQuery(option.label);
                onChange(option.value);
                setIsOpen(false);
              }}
            >
              <strong>{option.label}</strong>
              {option.description ? <small>{option.description}</small> : null}
            </button>
          ))}
          {allowCustom && query.trim() && !visibleOptions.some((option) => normalizeComboboxText(option.label) === normalizeComboboxText(query)) ? (
            <button type="button" role="option" aria-selected={false} onClick={commitCustomValue}>
              <strong>使用“{query.trim()}”</strong>
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
