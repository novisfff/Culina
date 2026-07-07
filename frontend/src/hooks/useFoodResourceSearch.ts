import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import { queryKeys } from '../api/queryKeys';
import type { Food } from '../api/types';
import { useDebouncedSearchValue, useSearchCompositionState } from './useDebouncedValue';

export const FOOD_RESOURCE_SEARCH_PAGE_SIZE = 20;

type AppliedFoodSearchState = {
  query: string;
  foods: Food[];
  loaded: boolean;
};

export function useFoodResourceSearch(
  query: string,
  options: {
    enabled?: boolean;
    fallbackFoods?: Food[];
    pageSize?: number;
  } = {},
) {
  const enabled = options.enabled ?? true;
  const pageSize = options.pageSize ?? FOOD_RESOURCE_SEARCH_PAGE_SIZE;
  const fallbackFoods = options.fallbackFoods ?? [];
  const normalizedQuery = query.trim();
  const searchComposition = useSearchCompositionState();
  const searchValue = useDebouncedSearchValue(query, { isComposing: searchComposition.isComposing });
  const isFetchingNextPageRef = useRef(false);
  const foodQuery = useInfiniteQuery({
    queryKey: queryKeys.foodPickerSearch(searchValue),
    queryFn: ({ pageParam }) => api.getFoods({ q: searchValue, limit: pageSize, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => (
      lastPage.length === pageSize ? allPages.length * pageSize : undefined
    ),
    enabled: enabled && !searchComposition.isComposing,
    placeholderData: keepPreviousData,
  });
  const [appliedSearch, setAppliedSearch] = useState<AppliedFoodSearchState>({
    query: '',
    foods: fallbackFoods,
    loaded: false,
  });

  useEffect(() => {
    if (!foodQuery.data || foodQuery.isPlaceholderData) return;
    const nextFoods = foodQuery.data.pages.flat();
    if (
      appliedSearch.loaded &&
      appliedSearch.query === searchValue &&
      appliedSearch.foods.length === nextFoods.length &&
      appliedSearch.foods.every((food, index) => food.id === nextFoods[index]?.id)
    ) {
      return;
    }
    setAppliedSearch({
      query: searchValue,
      foods: nextFoods,
      loaded: true,
    });
  }, [appliedSearch, foodQuery.data, foodQuery.isPlaceholderData, searchValue]);

  useEffect(() => {
    isFetchingNextPageRef.current = foodQuery.isFetchingNextPage;
  }, [foodQuery.isFetchingNextPage]);

  const foods = useMemo(() => {
    if (appliedSearch.loaded && appliedSearch.query === searchValue) {
      return appliedSearch.foods;
    }
    if (normalizedQuery) {
      return appliedSearch.foods;
    }
    return fallbackFoods.length > 0 ? fallbackFoods : appliedSearch.foods;
  }, [appliedSearch, fallbackFoods, normalizedQuery, searchValue]);

  const isSearching =
    enabled &&
    !searchComposition.isComposing &&
    (searchValue !== normalizedQuery || (foodQuery.isFetching && !foodQuery.isFetchingNextPage));
  const hasMore =
    enabled &&
    appliedSearch.loaded &&
    appliedSearch.query === searchValue &&
    Boolean(foodQuery.hasNextPage);
  const fetchNextPage = useCallback(() => {
    if (isFetchingNextPageRef.current || !foodQuery.hasNextPage) {
      return Promise.resolve(undefined);
    }
    isFetchingNextPageRef.current = true;
    return foodQuery.fetchNextPage().finally(() => {
      isFetchingNextPageRef.current = false;
    });
  }, [foodQuery]);

  return {
    foods,
    searchValue,
    isSearching,
    isFetchingNextPage: foodQuery.isFetchingNextPage,
    hasMore,
    fetchNextPage,
    findFoodById: (foodId: string) =>
      foods.find((food) => food.id === foodId) ??
      fallbackFoods.find((food) => food.id === foodId) ??
      null,
    onCompositionStart: searchComposition.onCompositionStart,
    onCompositionEnd: searchComposition.onCompositionEnd,
  };
}
