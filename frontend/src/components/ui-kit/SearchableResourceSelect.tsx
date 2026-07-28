import { useEffect, useRef, type CompositionEvent, type FocusEvent, type KeyboardEvent, type ReactNode, type Ref, type UIEvent } from 'react';
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
  showClear?: boolean;
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
  leadingIcon?: ReactNode;
  onLoadMore?: () => void;
  onSearchFocus?: () => void;
  onSearchBlur?: () => void;
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
  showClear = true,
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
  leadingIcon,
  onLoadMore,
  onSearchFocus,
  onSearchBlur,
  onSearchClear,
  onSearchCompositionStart,
  onSearchCompositionEnd,
  onSearchKeyDown,
}: SearchableResourceSelectProps<T>) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dismissedByPointerRef = useRef(false);
  const inlineLoadingOnly = presentation === 'inline' && loading && options.length === 0;

  useEffect(() => {
    if (!listOpen || !onSearchBlur) return undefined;

    function handlePointerDown(event: PointerEvent) {
      if (rootRef.current?.contains(event.target as Node)) return;
      dismissedByPointerRef.current = true;
      onSearchBlur?.();
    }

    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [listOpen, onSearchBlur]);

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

  function handleSearchBlur(event: FocusEvent<HTMLDivElement>) {
    const nextFocusedElement = event.relatedTarget;
    if (nextFocusedElement instanceof Node && event.currentTarget.contains(nextFocusedElement)) return;
    if (dismissedByPointerRef.current) {
      dismissedByPointerRef.current = false;
      return;
    }
    onSearchBlur?.();
  }

  return (
    <div
      className={['ui-searchable-resource-select', className].filter(Boolean).join(' ')}
      ref={rootRef}
      onBlur={onSearchBlur ? handleSearchBlur : undefined}
      onFocusCapture={onSearchBlur ? () => {
        dismissedByPointerRef.current = false;
      } : undefined}
    >
      {showSearch ? (
        <SearchField
          className={searchClassName}
          inputId={searchInputId}
          inputClassName={searchInputClassName}
          inputRef={searchInputRef}
          ariaLabel={ariaLabel}
          placeholder={placeholder}
          value={query}
          loading={loading && !inlineLoadingOnly}
          disabled={disabled}
          showClear={showClear}
          leadingIcon={leadingIcon}
          onChange={onQueryChange}
          onClear={onSearchClear}
          onCompositionStart={onSearchCompositionStart}
          onCompositionEnd={onSearchCompositionEnd}
          onKeyDown={onSearchKeyDown}
          onFocus={onSearchFocus}
        />
      ) : null}
      {listOpen && inlineLoadingOnly ? (
        <p className="ui-searchable-resource-select-loading" role="status">正在加载候选项…</p>
      ) : null}
      {listOpen && !inlineLoadingOnly ? (
        <div
          className={['ui-searchable-resource-select-list', presentation === 'popover' ? 'is-popover' : 'is-inline', listClassName].filter(Boolean).join(' ')}
          role="listbox"
          aria-label={`${ariaLabel}结果`}
          onScroll={handleListScroll}
        >
          {options.length === 0 ? (
            loading ? (
              <p className="ui-searchable-resource-select-empty" role="status">正在加载候选项…</p>
            ) : (
              <p className="ui-searchable-resource-select-empty">{emptyText}</p>
            )
          ) : null}
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
          {options.length > 0 && (hasMore || loadingMore) ? (
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
