import type { KeyboardEvent, ReactNode } from 'react';
import { SearchableResourceSelect } from '../../ui-kit';
import type { SearchableResourceOption } from '../../ui-kit';
import { AiDraftField } from './AiDraftField';

export function AiDraftResourceField<T extends string>(props: {
  label: string;
  value: T | '';
  selectedLabel?: string;
  query: string;
  options: readonly SearchableResourceOption<T>[];
  onQueryChange: (value: string) => void;
  onChange: (value: T) => void;
  loading?: boolean;
  loadingMore?: boolean;
  hasMore?: boolean;
  onLoadMore?: () => void;
  disabled?: boolean;
  emptyText?: string;
  children?: ReactNode;
  leadingIcon?: ReactNode;
  placeholder?: string;
  listOpen?: boolean;
  onSearchFocus?: () => void;
  onSearchBlur?: () => void;
  onSearchClear?: () => void;
  onSearchKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
  className?: string;
}) {
  const displayedQuery = props.listOpen === false ? props.selectedLabel ?? props.query : props.query;
  const showingSelectedResource = Boolean(props.listOpen === false && props.selectedLabel);
  const selectedContextVisible = Boolean(
    props.selectedLabel
    && props.listOpen
    && props.query.trim()
    && props.query.trim() !== props.selectedLabel,
  );

  return (
    <AiDraftField label={props.label} className={['ai-draft-resource-field', props.className].filter(Boolean).join(' ')}>
      {selectedContextVisible ? <p className="ai-draft-resource-selected">当前选择：{props.selectedLabel}</p> : null}
      <SearchableResourceSelect
        ariaLabel={props.label}
        placeholder={props.placeholder ?? `搜索${props.label}`}
        value={props.value}
        query={displayedQuery}
        options={props.options}
        loading={props.loading}
        loadingMore={props.loadingMore}
        hasMore={props.hasMore}
        disabled={props.disabled}
        emptyText={props.emptyText}
        listOpen={props.listOpen ?? true}
        showClear={!showingSelectedResource}
        leadingIcon={props.leadingIcon}
        presentation="popover"
        className="ai-draft-resource-select"
        searchClassName={`ai-draft-resource-search${showingSelectedResource ? ' has-selected-resource' : ''}`}
        listClassName="ai-draft-resource-list"
        onQueryChange={props.onQueryChange}
        onChange={props.onChange}
        onLoadMore={props.onLoadMore}
        onSearchFocus={props.onSearchFocus}
        onSearchBlur={props.onSearchBlur}
        onSearchClear={props.onSearchClear}
        onSearchKeyDown={props.onSearchKeyDown}
      />
      {props.children ? <div className="ai-draft-resource-extra">{props.children}</div> : null}
    </AiDraftField>
  );
}
