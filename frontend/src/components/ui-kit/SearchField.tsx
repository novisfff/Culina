import type { CompositionEvent, ReactNode, Ref } from 'react';
import { SearchLoadingIndicator } from '../ui-kit';

export type SearchFieldProps = {
  ariaLabel: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  onClear?: () => void;
  loading?: boolean;
  disabled?: boolean;
  className?: string;
  inputRef?: Ref<HTMLInputElement>;
  autoFocus?: boolean;
  leadingIcon?: ReactNode;
  leadingIconClassName?: string;
  loadingClassName?: string;
  clearClassName?: string;
  clearIcon?: ReactNode;
  onCompositionStart?: (event: CompositionEvent<HTMLInputElement>) => void;
  onCompositionEnd?: (event: CompositionEvent<HTMLInputElement>) => void;
};

export function SearchField({
  ariaLabel,
  placeholder,
  value,
  onChange,
  onClear,
  loading = false,
  disabled = false,
  className,
  inputRef,
  autoFocus = false,
  leadingIcon,
  leadingIconClassName,
  loadingClassName,
  clearClassName,
  clearIcon = '×',
  onCompositionStart,
  onCompositionEnd,
}: SearchFieldProps) {
  return (
    <div className={['ui-search-field', className, disabled ? 'is-disabled' : ''].filter(Boolean).join(' ')}>
      {leadingIcon ? <span className={['ui-search-field-icon', leadingIconClassName].filter(Boolean).join(' ')} aria-hidden="true">{leadingIcon}</span> : null}
      <input
        ref={inputRef}
        type="search"
        role="searchbox"
        aria-label={ariaLabel}
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        autoFocus={autoFocus}
        onChange={(event) => onChange(event.target.value)}
        onCompositionStart={onCompositionStart}
        onCompositionEnd={onCompositionEnd}
      />
      <SearchLoadingIndicator active={loading} className={['ui-search-field-loading', loadingClassName].filter(Boolean).join(' ')} />
      {value ? (
        <button type="button" className={['ui-search-field-clear', clearClassName].filter(Boolean).join(' ')} aria-label="清空搜索" onClick={onClear ?? (() => onChange(''))} disabled={disabled}>
          {clearIcon}
        </button>
      ) : null}
    </div>
  );
}
