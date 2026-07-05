import type { CompositionEvent, KeyboardEvent, ReactNode, Ref } from 'react';
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
  searchClassName?: string;
  searchInputRef?: Ref<HTMLInputElement>;
  listClassName?: string;
  optionClassName?: string | ((option: ResourcePickerOption<T>, selected: boolean) => string | undefined);
  onSearchCompositionStart?: (event: CompositionEvent<HTMLInputElement>) => void;
  onSearchCompositionEnd?: (event: CompositionEvent<HTMLInputElement>) => void;
  onSearchKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
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
  searchClassName,
  searchInputRef,
  listClassName,
  optionClassName,
  onSearchCompositionStart,
  onSearchCompositionEnd,
  onSearchKeyDown,
}: ResourcePickerFieldProps<T>) {
  function getOptionClassName(option: ResourcePickerOption<T>) {
    const selected = option.id === value;
    if (typeof optionClassName === 'function') return optionClassName(option, selected);
    return [optionClassName, selected ? 'is-selected' : undefined].filter(Boolean).join(' ') || undefined;
  }

  return (
    <div className={['ui-resource-picker', className].filter(Boolean).join(' ')}>
      <SearchField
        className={searchClassName}
        inputRef={searchInputRef}
        ariaLabel={ariaLabel}
        placeholder={placeholder}
        value={query}
        loading={loading}
        onChange={onQueryChange}
        onCompositionStart={onSearchCompositionStart}
        onCompositionEnd={onSearchCompositionEnd}
        onKeyDown={onSearchKeyDown}
      />
      <div className={['ui-resource-picker-list', listClassName].filter(Boolean).join(' ')} role="listbox" aria-label={`${ariaLabel}结果`}>
        {options.length === 0 ? <p className="ui-resource-picker-empty">{emptyText}</p> : null}
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            role="option"
            aria-selected={option.id === value}
            disabled={option.disabled}
            className={getOptionClassName(option)}
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
