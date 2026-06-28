import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type { SearchEntityType, SearchResultItem } from '../../api/types';
import { DashboardIcon } from '../../app/shellIcons';
import { MediaWithPlaceholder } from '../../components/MediaPlaceholder';
import { SearchLoadingIndicator } from '../../components/ui-kit';
import { useDebouncedSearchValue, useSearchCompositionState } from '../../hooks/useDebouncedValue';
import { resolveAssetUrl } from '../../lib/assets';
import { buildGlobalSearchResultView, type GlobalSearchResultView } from './globalSearchModel';

const GLOBAL_SEARCH_SCOPES: SearchEntityType[] = ['ingredient', 'food', 'recipe', 'meal_plan'];
const GLOBAL_SEARCH_LIMIT = 20;

export type GlobalSearchSelection = {
  entityType: SearchEntityType;
  entityId: string;
  item: SearchResultItem;
};

type Props = {
  open: boolean;
  onClose: () => void;
  onSelect: (selection: GlobalSearchSelection) => void;
};

function GlobalSearchResultRow(props: {
  result: GlobalSearchResultView;
  onSelect: (selection: GlobalSearchSelection) => void;
}) {
  const imageUrl = props.result.imageUrl ? resolveAssetUrl(props.result.imageUrl) ?? props.result.imageUrl : undefined;

  return (
    <button
      type="button"
      className={`global-search-result global-search-result-${props.result.tone}`}
      onClick={() =>
        props.onSelect({
          entityType: props.result.entityType,
          entityId: props.result.entityId,
          item: props.result.item,
        })
      }
    >
      <span className="global-search-result-media">
        {imageUrl ? (
          <MediaWithPlaceholder src={imageUrl} alt="" showLabel={false} />
        ) : (
          <span className="global-search-result-icon" aria-hidden="true">
            <DashboardIcon name={props.result.icon} />
          </span>
        )}
      </span>
      <span className="global-search-result-main">
        <span className="global-search-result-head">
          <strong>{props.result.title}</strong>
          <span className="global-search-result-meta">{props.result.meta}</span>
        </span>
        <span className="global-search-result-description">{props.result.description}</span>
        {props.result.matchReasons.length > 0 && (
          <span className="global-search-reason-row">
            {props.result.matchReasons.map((reason) => (
              <span key={reason}>{reason}</span>
            ))}
          </span>
        )}
      </span>
      <span className="global-search-type-pill">
        <DashboardIcon name={props.result.icon} />
        {props.result.typeLabel}
      </span>
    </button>
  );
}

export function GlobalSearchOverlay(props: Props) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const searchComposition = useSearchCompositionState();
  const searchValue = useDebouncedSearchValue(query, { isComposing: searchComposition.isComposing });
  const trimmedQuery = query.trim();

  useEffect(() => {
    if (!props.open) return;
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [props.open]);

  useEffect(() => {
    if (!props.open) {
      setQuery('');
    }
  }, [props.open]);

  const searchQuery = useQuery({
    queryKey: queryKeys.search(searchValue, GLOBAL_SEARCH_SCOPES, GLOBAL_SEARCH_LIMIT, 0),
    queryFn: () =>
      api.search({
        q: searchValue,
        scopes: GLOBAL_SEARCH_SCOPES,
        limit: GLOBAL_SEARCH_LIMIT,
        offset: 0,
      }),
    enabled: props.open && Boolean(searchValue),
    placeholderData: keepPreviousData,
  });

  const searchDataMatchesCurrentQuery = Boolean(searchValue) && searchQuery.data?.query === searchValue;
  const results = useMemo(
    () => (searchDataMatchesCurrentQuery ? searchQuery.data?.items ?? [] : []).map(buildGlobalSearchResultView),
    [searchDataMatchesCurrentQuery, searchQuery.data?.items]
  );
  const isWaitingForDebounce = Boolean(trimmedQuery) && !searchValue;
  const isLoading = isWaitingForDebounce || searchQuery.isFetching;
  const showContent = results.length > 0 || (searchDataMatchesCurrentQuery && Boolean(searchQuery.data?.degraded));

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      props.onClose();
    }
  }

  if (!props.open) return null;

  return createPortal(
    <div className="global-search-root" role="dialog" aria-modal="true" aria-label="全局搜索" onKeyDown={handleKeyDown}>
      <button className="global-search-backdrop" type="button" aria-label="关闭全局搜索" onClick={props.onClose} />
      <section className={showContent ? 'global-search-panel has-content' : 'global-search-panel'} aria-label="全局搜索">
        <div className="global-search-input-row">
          <span className="global-search-input-icon" aria-hidden="true">
            <DashboardIcon name="search" />
          </span>
          <input
            ref={inputRef}
            value={query}
            placeholder="搜索食材、食物、菜谱、餐食计划"
            aria-label="搜索食材、食物、菜谱、餐食计划"
            onChange={(event) => setQuery(event.target.value)}
            onCompositionStart={searchComposition.onCompositionStart}
            onCompositionEnd={searchComposition.onCompositionEnd}
          />
          <SearchLoadingIndicator active={isLoading} className="global-search-loading" />
          {trimmedQuery && (
            <button className="global-search-clear" type="button" aria-label="清空搜索" onClick={() => setQuery('')}>
              <DashboardIcon name="x" />
            </button>
          )}
        </div>

        {showContent && (
          <div className="global-search-content">
            {searchDataMatchesCurrentQuery && searchQuery.data?.degraded && (
              <p className="global-search-degraded">检索结果可能不完整</p>
            )}
            {results.length > 0 && (
              <div className="global-search-result-list" role="list" aria-label="搜索结果">
                {results.map((result) => (
                  <GlobalSearchResultRow key={result.id} result={result} onSelect={props.onSelect} />
                ))}
              </div>
            )}
          </div>
        )}
      </section>
    </div>,
    document.body
  );
}
