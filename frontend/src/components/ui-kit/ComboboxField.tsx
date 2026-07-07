import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';

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
  customOptionClassName,
  leadingIcon,
}: ComboboxFieldProps<T>) {
  const [inputValue, setInputValue] = useState(String(value ?? ''));
  const [filterQuery, setFilterQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listboxId = useId();

  const visibleOptions = useMemo(() => {
    const normalized = normalizeComboboxText(filterQuery);
    if (!normalized) return options;
    return options.filter((option) => normalizeComboboxText(`${option.label} ${option.value} ${option.description ?? ''}`).includes(normalized));
  }, [options, filterQuery]);

  useEffect(() => {
    setInputValue(String(value ?? ''));
  }, [value]);

  useEffect(() => {
    if (!isOpen) return undefined;

    function handlePointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    }

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  function commitCustomValue() {
    const next = inputValue.trim();
    if (allowCustom && next) {
      onChange(next);
      setIsOpen(false);
    }
  }

  return (
    <div
      className={['ui-combobox-field', className, isOpen ? 'is-open' : '', disabled ? 'is-disabled' : ''].filter(Boolean).join(' ')}
      ref={rootRef}
    >
      {leadingIcon}
      <input
        className={inputClassName}
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={isOpen}
        aria-controls={isOpen ? listboxId : undefined}
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
          const canCommitCustomValue = allowCustom && Boolean(inputValue.trim());
          if (event.key === 'Enter' && canCommitCustomValue) {
            event.preventDefault();
            commitCustomValue();
          }
        }}
      />
      {isOpen && (
        <div id={listboxId} className={['ui-combobox-menu', menuClassName].filter(Boolean).join(' ')} role="listbox" aria-label={`${ariaLabel}选项`}>
          {visibleOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              onClick={() => {
                setInputValue(option.label);
                setFilterQuery(option.label);
                onChange(option.value);
                setIsOpen(false);
              }}
            >
              <span className="ui-dropdown-select-option-copy">
                <strong>{option.label}</strong>
                {option.description ? <small>{option.description}</small> : null}
              </span>
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
