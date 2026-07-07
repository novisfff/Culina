import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

export type DropdownSelectOption<T extends string> = {
  value: T;
  label: string;
  description?: string;
  icon?: ReactNode;
};

export type DropdownSelectProps<T extends string> = {
  ariaLabel: string;
  placeholder: string;
  value: T | '';
  options: readonly DropdownSelectOption<T>[];
  onChange: (value: T | '') => void;
  labelPrefix?: string;
  clearOption?: { value: ''; label: string; description?: string; icon?: ReactNode };
  disabled?: boolean;
  className?: string;
  triggerClassName?: string;
  menuClassName?: string;
  leadingIcon?: ReactNode;
};

export function DropdownSelect<T extends string>({
  ariaLabel,
  placeholder,
  value,
  options,
  onChange,
  labelPrefix,
  clearOption,
  disabled = false,
  className,
  triggerClassName,
  menuClassName,
  leadingIcon,
}: DropdownSelectProps<T>) {
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listboxId = useId();
  const selectedOption = options.find((option) => option.value === value);
  const triggerText = selectedOption
    ? labelPrefix
      ? `${labelPrefix}: ${selectedOption.label}`
      : selectedOption.label
    : placeholder;
  const allOptions = clearOption ? [clearOption, ...options] : options;

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

  return (
    <div
      className={['ui-dropdown-select', className, isOpen ? 'is-open' : '', disabled ? 'is-disabled' : ''].filter(Boolean).join(' ')}
      ref={rootRef}
    >
      <button
        type="button"
        className={['ui-dropdown-select-trigger', triggerClassName].filter(Boolean).join(' ')}
        aria-label={triggerText}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? listboxId : undefined}
        disabled={disabled}
        onClick={() => setIsOpen((current) => !current)}
      >
        {leadingIcon ? <span className="ui-dropdown-select-leading-icon">{leadingIcon}</span> : null}
        <span className="ui-dropdown-select-trigger-label">{triggerText}</span>
        <span className="ui-dropdown-select-chevron" aria-hidden="true" />
      </button>
      {isOpen && (
        <div id={listboxId} className={['ui-dropdown-select-menu', menuClassName].filter(Boolean).join(' ')} role="listbox" aria-label={ariaLabel}>
          {allOptions.map((option) => {
            const selected = option.value === value;
            return (
              <button
                key={option.value || '__clear'}
                type="button"
                className={['ui-dropdown-select-option', selected ? 'is-selected' : ''].filter(Boolean).join(' ')}
                role="option"
                aria-selected={selected}
                onClick={() => {
                  onChange(option.value);
                  setIsOpen(false);
                }}
              >
                {option.icon ? <span className="ui-dropdown-select-option-icon">{option.icon}</span> : null}
                <span className="ui-dropdown-select-option-copy">
                  <strong>{option.label}</strong>
                  {option.description ? <small>{option.description}</small> : null}
                </span>
                {selected ? (
                  <span className="ui-dropdown-select-option-mark" aria-hidden="true">
                    ✓
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
