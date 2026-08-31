import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type { Food } from '../../api/types/food';
import { useDebouncedSearchValue, useSearchCompositionState } from '../../hooks/useDebouncedValue';

export function useFoodWorkspaceSearch(search: string) {
  const normalizedSearch = search.trim();
  const composition = useSearchCompositionState();
  const debouncedSearch = useDebouncedSearchValue(search, { isComposing: composition.isComposing });
  const query = useQuery({
    queryKey: queryKeys.foodSearch(debouncedSearch),
    queryFn: () => api.getFoods({ q: debouncedSearch, limit: 100 }),
    enabled: Boolean(debouncedSearch),
    placeholderData: keepPreviousData,
  });
  const [appliedSearch, setAppliedSearch] = useState('');
  const [appliedResults, setAppliedResults] = useState<Food[]>([]);

  useEffect(() => {
    if (!normalizedSearch) {
      setAppliedSearch('');
      setAppliedResults([]);
      return;
    }
    if (debouncedSearch && !query.isPlaceholderData && query.data) {
      setAppliedSearch(debouncedSearch);
      setAppliedResults(query.data);
    }
  }, [debouncedSearch, normalizedSearch, query.data, query.isPlaceholderData]);

  const matchedFoodIds = useMemo(
    () => (appliedSearch ? Array.from(new Set(appliedResults.map((food) => food.id))) : []),
    [appliedResults, appliedSearch],
  );

  return {
    appliedSearch,
    appliedResults,
    matchedFoodIds,
    searchAwareFoods: appliedSearch ? appliedResults : null,
    composition: {
      onCompositionStart: composition.onCompositionStart,
      onCompositionEnd: composition.onCompositionEnd,
    },
    isFetching: Boolean(normalizedSearch) && !composition.isComposing
      && (appliedSearch !== normalizedSearch || query.isFetching),
  };
}
