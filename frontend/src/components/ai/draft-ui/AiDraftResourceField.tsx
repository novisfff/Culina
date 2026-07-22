import type { ReactNode } from 'react';
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
  placeholder?: string;
  listOpen?: boolean;
  onSearchFocus?: () => void;
  onSearchClear?: () => void;
  className?: string;
}) {
  const displayedQuery = props.listOpen === false ? props.selectedLabel ?? props.query : props.query;

  return (
    <AiDraftField label={props.label} className={['ai-draft-resource-field', props.className].filter(Boolean).join(' ')}>
      {props.selectedLabel ? <p className="ai-draft-resource-selected">已选：{props.selectedLabel}</p> : null}
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
        presentation="inline"
        className="ai-draft-resource-select"
        searchClassName="ai-draft-resource-search"
        listClassName="ai-draft-resource-list ai-resource-menu"
        onQueryChange={props.onQueryChange}
        onChange={props.onChange}
        onLoadMore={props.onLoadMore}
        onSearchFocus={props.onSearchFocus}
        onSearchClear={props.onSearchClear}
      />
      {props.children ? <div className="ai-draft-resource-extra">{props.children}</div> : null}
    </AiDraftField>
  );
}
