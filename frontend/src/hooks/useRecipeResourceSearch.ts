import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import { queryKeys } from '../api/queryKeys';
import type { Recipe } from '../api/types';
import { useDebouncedSearchValue, useSearchCompositionState } from './useDebouncedValue';

export const RECIPE_RESOURCE_SEARCH_PAGE_SIZE = 20;

type AppliedRecipeSearchState = {
  query: string;
  recipes: Recipe[];
  loaded: boolean;
};

export function useRecipeResourceSearch(
  query: string,
  options: {
    enabled?: boolean;
    fallbackRecipes?: Recipe[];
    pageSize?: number;
  } = {},
) {
  const enabled = options.enabled ?? true;
  const pageSize = options.pageSize ?? RECIPE_RESOURCE_SEARCH_PAGE_SIZE;
  const fallbackRecipes = options.fallbackRecipes ?? [];
  const normalizedQuery = query.trim();
  const searchComposition = useSearchCompositionState();
  const searchValue = useDebouncedSearchValue(query, { isComposing: searchComposition.isComposing });
  const isFetchingNextPageRef = useRef(false);
  const recipeQuery = useInfiniteQuery({
    queryKey: queryKeys.recipePickerSearch(searchValue),
    queryFn: ({ pageParam }) => api.getRecipes({ q: searchValue, limit: pageSize, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => (
      lastPage.length === pageSize ? allPages.length * pageSize : undefined
    ),
    enabled: enabled && !searchComposition.isComposing,
    placeholderData: keepPreviousData,
  });
  const [appliedSearch, setAppliedSearch] = useState<AppliedRecipeSearchState>({
    query: '',
    recipes: fallbackRecipes,
    loaded: false,
  });

  useEffect(() => {
    if (!recipeQuery.data || recipeQuery.isPlaceholderData) return;
    const nextRecipes = recipeQuery.data.pages.flat();
    if (
      appliedSearch.loaded &&
      appliedSearch.query === searchValue &&
      appliedSearch.recipes.length === nextRecipes.length &&
      appliedSearch.recipes.every((recipe, index) => recipe.id === nextRecipes[index]?.id)
    ) {
      return;
    }
    setAppliedSearch({
      query: searchValue,
      recipes: nextRecipes,
      loaded: true,
    });
  }, [appliedSearch, recipeQuery.data, recipeQuery.isPlaceholderData, searchValue]);

  useEffect(() => {
    isFetchingNextPageRef.current = recipeQuery.isFetchingNextPage;
  }, [recipeQuery.isFetchingNextPage]);

  const recipes = useMemo(() => {
    if (appliedSearch.loaded && appliedSearch.query === searchValue) {
      return appliedSearch.recipes;
    }
    if (normalizedQuery) {
      return appliedSearch.recipes;
    }
    return fallbackRecipes.length > 0 ? fallbackRecipes : appliedSearch.recipes;
  }, [appliedSearch, fallbackRecipes, normalizedQuery, searchValue]);

  const isSearching =
    enabled &&
    !searchComposition.isComposing &&
    (searchValue !== normalizedQuery || (recipeQuery.isFetching && !recipeQuery.isFetchingNextPage));
  const hasMore =
    enabled &&
    appliedSearch.loaded &&
    appliedSearch.query === searchValue &&
    Boolean(recipeQuery.hasNextPage);
  const fetchNextPage = useCallback(() => {
    if (isFetchingNextPageRef.current || !recipeQuery.hasNextPage) {
      return Promise.resolve(undefined);
    }
    isFetchingNextPageRef.current = true;
    return recipeQuery.fetchNextPage().finally(() => {
      isFetchingNextPageRef.current = false;
    });
  }, [recipeQuery]);

  return {
    recipes,
    searchValue,
    isSearching,
    isFetchingNextPage: recipeQuery.isFetchingNextPage,
    hasMore,
    fetchNextPage,
    findRecipeById: (recipeId: string) =>
      recipes.find((recipe) => recipe.id === recipeId) ??
      fallbackRecipes.find((recipe) => recipe.id === recipeId) ??
      null,
    onCompositionStart: searchComposition.onCompositionStart,
    onCompositionEnd: searchComposition.onCompositionEnd,
  };
}
