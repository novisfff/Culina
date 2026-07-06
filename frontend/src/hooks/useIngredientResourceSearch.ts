import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import { queryKeys } from '../api/queryKeys';
import type { Ingredient } from '../api/types';
import { useDebouncedSearchValue, useSearchCompositionState } from './useDebouncedValue';

export const INGREDIENT_RESOURCE_SEARCH_PAGE_SIZE = 20;

type AppliedIngredientSearchState = {
  query: string;
  ingredients: Ingredient[];
  loaded: boolean;
};

export function useIngredientResourceSearch(
  query: string,
  options: {
    enabled?: boolean;
    fallbackIngredients?: Ingredient[];
    pageSize?: number;
  } = {},
) {
  const enabled = options.enabled ?? true;
  const pageSize = options.pageSize ?? INGREDIENT_RESOURCE_SEARCH_PAGE_SIZE;
  const fallbackIngredients = options.fallbackIngredients ?? [];
  const normalizedQuery = query.trim();
  const searchComposition = useSearchCompositionState();
  const searchValue = useDebouncedSearchValue(query, { isComposing: searchComposition.isComposing });
  const isFetchingNextPageRef = useRef(false);
  const ingredientQuery = useInfiniteQuery({
    queryKey: queryKeys.ingredientPickerSearch(searchValue),
    queryFn: ({ pageParam }) => api.getIngredients({ q: searchValue, limit: pageSize, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => (
      lastPage.length === pageSize ? allPages.length * pageSize : undefined
    ),
    enabled: enabled && !searchComposition.isComposing,
    placeholderData: keepPreviousData,
  });
  const [appliedSearch, setAppliedSearch] = useState<AppliedIngredientSearchState>({
    query: '',
    ingredients: fallbackIngredients,
    loaded: false,
  });

  useEffect(() => {
    if (!ingredientQuery.data || ingredientQuery.isPlaceholderData) return;
    const nextIngredients = ingredientQuery.data.pages.flat();
    if (
      appliedSearch.loaded &&
      appliedSearch.query === searchValue &&
      appliedSearch.ingredients.length === nextIngredients.length &&
      appliedSearch.ingredients.every((ingredient, index) => ingredient.id === nextIngredients[index]?.id)
    ) {
      return;
    }
    setAppliedSearch({
      query: searchValue,
      ingredients: nextIngredients,
      loaded: true,
    });
  }, [appliedSearch, ingredientQuery.data, ingredientQuery.isPlaceholderData, searchValue]);

  useEffect(() => {
    isFetchingNextPageRef.current = ingredientQuery.isFetchingNextPage;
  }, [ingredientQuery.isFetchingNextPage]);

  const ingredients = useMemo(() => {
    if (appliedSearch.loaded && appliedSearch.query === searchValue) {
      return appliedSearch.ingredients;
    }
    if (normalizedQuery) {
      return appliedSearch.ingredients;
    }
    return fallbackIngredients.length > 0 ? fallbackIngredients : appliedSearch.ingredients;
  }, [appliedSearch, fallbackIngredients, normalizedQuery, searchValue]);

  const isSearching =
    enabled &&
    !searchComposition.isComposing &&
    (searchValue !== normalizedQuery || (ingredientQuery.isFetching && !ingredientQuery.isFetchingNextPage));
  const hasMore =
    enabled &&
    appliedSearch.loaded &&
    appliedSearch.query === searchValue &&
    Boolean(ingredientQuery.hasNextPage);
  const fetchNextPage = useCallback(() => {
    if (isFetchingNextPageRef.current || !ingredientQuery.hasNextPage) {
      return Promise.resolve(undefined);
    }
    isFetchingNextPageRef.current = true;
    return ingredientQuery.fetchNextPage().finally(() => {
      isFetchingNextPageRef.current = false;
    });
  }, [ingredientQuery]);

  return {
    ingredients,
    searchValue,
    isSearching,
    isFetchingNextPage: ingredientQuery.isFetchingNextPage,
    hasMore,
    fetchNextPage,
    findIngredientById: (ingredientId: string) =>
      ingredients.find((ingredient) => ingredient.id === ingredientId) ??
      fallbackIngredients.find((ingredient) => ingredient.id === ingredientId) ??
      null,
    findIngredientByName: (ingredientName: string) =>
      ingredients.find((ingredient) => ingredient.name === ingredientName) ??
      fallbackIngredients.find((ingredient) => ingredient.name === ingredientName) ??
      null,
    onCompositionStart: searchComposition.onCompositionStart,
    onCompositionEnd: searchComposition.onCompositionEnd,
  };
}
