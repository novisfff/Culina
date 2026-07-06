import type { CompositionEvent, KeyboardEvent, ReactNode, Ref, UIEvent } from 'react';
import { SearchField } from './SearchField';

export type SearchableResourceOption<T extends string> = {
  id: T;
  label: string;
  description?: string;
  image?: ReactNode;
  disabled?: boolean;
};

export type SearchableResourceSelectProps<T extends string> = {
  ariaLabel: string;
  placeholder: string;
  value: T | '';
  query: string;
  options: readonly SearchableResourceOption<T>[];
  onQueryChange: (value: string) => void;
  onChange: (value: T) => void;
  loading?: boolean;
  loadingMore?: boolean;
  hasMore?: boolean;
  emptyText?: string;
  disabled?: boolean;
  listOpen?: boolean;
  showSearch?: boolean;
  presentation?: 'inline' | 'popover';
  className?: string;
  searchClassName?: string;
  searchInputId?: string;
  searchInputClassName?: string;
  searchInputRef?: Ref<HTMLInputElement>;
  listClassName?: string;
  optionClassName?: string | ((option: SearchableResourceOption<T>, selected: boolean) => string | undefined);
  loadMoreText?: string;
  loadingMoreText?: string;
  onLoadMore?: () => void;
  onSearchFocus?: () => void;
  onSearchClear?: () => void;
  onSearchCompositionStart?: (event: CompositionEvent<HTMLInputElement>) => void;
  onSearchCompositionEnd?: (event: CompositionEvent<HTMLInputElement>) => void;
  onSearchKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
};

export function SearchableResourceSelect<T extends string>({
  ariaLabel,
  placeholder,
  value,
  query,
  options,
  onQueryChange,
  onChange,
  loading = false,
  loadingMore = false,
  hasMore = false,
  emptyText = '没有找到匹配项',
  disabled = false,
  listOpen = true,
  showSearch = true,
  presentation = 'inline',
  className,
  searchClassName,
  searchInputId,
  searchInputClassName,
  searchInputRef,
  listClassName,
  optionClassName,
  loadMoreText = '加载更多',
  loadingMoreText = '正在加载更多...',
  onLoadMore,
  onSearchFocus,
  onSearchClear,
  onSearchCompositionStart,
  onSearchCompositionEnd,
  onSearchKeyDown,
}: SearchableResourceSelectProps<T>) {
  function getOptionClassName(option: SearchableResourceOption<T>) {
    const selected = option.id === value;
    const customClassName = typeof optionClassName === 'function' ? optionClassName(option, selected) : optionClassName;
    return customClassName;
  }

  function handleListScroll(event: UIEvent<HTMLDivElement>) {
    if (!hasMore || loadingMore || !onLoadMore) return;
    const list = event.currentTarget;
    const distanceToBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
    if (distanceToBottom <= 48) {
      onLoadMore();
    }
  }

  return (
    <div className={['ui-searchable-resource-select', className].filter(Boolean).join(' ')}>
      {showSearch ? (
        <SearchField
          className={searchClassName}
          inputId={searchInputId}
          inputClassName={searchInputClassName}
          inputRef={searchInputRef}
          ariaLabel={ariaLabel}
          placeholder={placeholder}
          value={query}
          loading={loading}
          disabled={disabled}
          onChange={onQueryChange}
          onClear={onSearchClear}
          onCompositionStart={onSearchCompositionStart}
          onCompositionEnd={onSearchCompositionEnd}
          onKeyDown={onSearchKeyDown}
          onFocus={onSearchFocus}
        />
      ) : null}
      {listOpen ? (
        <div
          className={['ui-searchable-resource-select-list', presentation === 'popover' ? 'is-popover' : 'is-inline', listClassName].filter(Boolean).join(' ')}
          role="listbox"
          aria-label={`${ariaLabel}结果`}
          onScroll={handleListScroll}
        >
          {options.length === 0 ? <p className="ui-searchable-resource-select-empty">{emptyText}</p> : null}
          {options.map((option) => {
            const selected = option.id === value;
            return (
              <button
                key={option.id}
                type="button"
                role="option"
                aria-selected={selected}
                disabled={disabled || option.disabled}
                className={getOptionClassName(option)}
                onClick={() => onChange(option.id)}
              >
                {option.image ? (
                  <span className="ui-searchable-resource-select-option-media" aria-hidden="true">
                    {option.image}
                  </span>
                ) : null}
                <span className="ui-searchable-resource-select-option-copy">
                  <strong>{option.label}</strong>
                  {option.description ? <small>{option.description}</small> : null}
                </span>
              </button>
            );
          })}
          {hasMore || loadingMore ? (
            <div className="ui-searchable-resource-select-more">
              {loadingMore ? (
                <span role="status">{loadingMoreText}</span>
              ) : (
                <button type="button" onClick={onLoadMore} disabled={disabled || !onLoadMore}>
                  {loadMoreText}
                </button>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
