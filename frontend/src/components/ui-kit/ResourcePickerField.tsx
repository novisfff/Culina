import type { ReactNode } from 'react';
import { SearchField } from './SearchField';

export type ResourcePickerOption<T extends string> = {
  id: T;
  label: string;
  description?: string;
  image?: ReactNode;
  disabled?: boolean;
};

export type ResourcePickerFieldProps<T extends string> = {
  ariaLabel: string;
  placeholder: string;
  value: T | '';
  query: string;
  options: readonly ResourcePickerOption<T>[];
  onQueryChange: (value: string) => void;
  onChange: (value: T) => void;
  loading?: boolean;
  emptyText?: string;
  className?: string;
};

export function ResourcePickerField<T extends string>({
  ariaLabel,
  placeholder,
  value,
  query,
  options,
  onQueryChange,
  onChange,
  loading = false,
  emptyText = '没有找到匹配项',
  className,
}: ResourcePickerFieldProps<T>) {
  return (
    <div className={['ui-resource-picker', className].filter(Boolean).join(' ')}>
      <SearchField ariaLabel={ariaLabel} placeholder={placeholder} value={query} loading={loading} onChange={onQueryChange} />
      <div className="ui-resource-picker-list" role="listbox" aria-label={`${ariaLabel}结果`}>
        {options.length === 0 ? <p className="ui-resource-picker-empty">{emptyText}</p> : null}
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            role="option"
            aria-selected={option.id === value}
            disabled={option.disabled}
            className={option.id === value ? 'is-selected' : undefined}
            onClick={() => onChange(option.id)}
          >
            {option.image}
            <span>
              <strong>{option.label}</strong>
              {option.description ? <small>{option.description}</small> : null}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
