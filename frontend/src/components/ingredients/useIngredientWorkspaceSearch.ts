import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type { Ingredient, InventoryItem, InventoryOverviewItem } from '../../api/types';
import { useDebouncedSearchValue, useSearchCompositionState } from '../../hooks/useDebouncedValue';
import { buildUnifiedInventoryGroups, buildUnifiedInventorySummary, filterUnifiedInventoryItems, type InventoryEntryFilter } from './inventoryOverviewModel';
import type { InventoryQuickFilter, InventorySourceFilter } from './useIngredientWorkspaceState';
import type { InventoryStorageFocus } from './ingredientWorkspaceForms';

type Args = {
  ingredients: Ingredient[];
  inventoryItems: InventoryItem[];
  catalogSearch: string;
  inventorySearch: string;
  inventorySourceFilter: InventorySourceFilter;
  inventoryEntryFilter: InventoryEntryFilter;
  inventoryQuickFilter: InventoryQuickFilter;
  inventoryStorageFocus: InventoryStorageFocus;
};

export function useIngredientWorkspaceSearch(args: Args) {
  const normalizedCatalogSearch = args.catalogSearch.trim();
  const normalizedInventorySearch = args.inventorySearch.trim();
  const inventorySearchComposition = useSearchCompositionState();
  const catalogSearchComposition = useSearchCompositionState();
  const inventorySearchValue = useDebouncedSearchValue(args.inventorySearch, { isComposing: inventorySearchComposition.isComposing });
  const catalogSearchValue = useDebouncedSearchValue(args.catalogSearch, { isComposing: catalogSearchComposition.isComposing });
  const catalogSearchQuery = useQuery({
    queryKey: queryKeys.ingredientSearch(catalogSearchValue),
    queryFn: () => api.getIngredients({ q: catalogSearchValue, limit: 100 }),
    enabled: Boolean(catalogSearchValue),
    placeholderData: keepPreviousData,
  });
  const inventorySearchQuery = useQuery({
    queryKey: queryKeys.inventorySearch(inventorySearchValue),
    queryFn: () => api.getInventory({ q: inventorySearchValue }),
    enabled: Boolean(inventorySearchValue),
    placeholderData: keepPreviousData,
  });
  const inventoryOverviewQuery = useQuery({
    queryKey: queryKeys.inventoryOverview(args.inventorySourceFilter, inventorySearchValue),
    queryFn: () => api.getInventoryOverview({ scope: args.inventorySourceFilter, q: inventorySearchValue }),
    placeholderData: (previous) => previous,
  });
  const [appliedCatalogSearch, setAppliedCatalogSearch] = useState('');
  const [appliedCatalogResults, setAppliedCatalogResults] = useState<Ingredient[]>([]);
  const [appliedInventorySearch, setAppliedInventorySearch] = useState('');
  const [appliedInventoryResults, setAppliedInventoryResults] = useState<InventoryItem[]>([]);
  useEffect(() => {
    if (!normalizedCatalogSearch) {
      setAppliedCatalogSearch('');
      setAppliedCatalogResults([]);
      return;
    }
    if (catalogSearchValue && !catalogSearchQuery.isPlaceholderData && catalogSearchQuery.data) {
      setAppliedCatalogSearch(catalogSearchValue);
      setAppliedCatalogResults(catalogSearchQuery.data);
    }
  }, [catalogSearchQuery.data, catalogSearchQuery.isPlaceholderData, catalogSearchValue, normalizedCatalogSearch]);
  useEffect(() => {
    if (!normalizedInventorySearch) {
      setAppliedInventorySearch('');
      setAppliedInventoryResults([]);
      return;
    }
    if (inventorySearchValue && !inventorySearchQuery.isPlaceholderData && inventorySearchQuery.data) {
      setAppliedInventorySearch(inventorySearchValue);
      setAppliedInventoryResults(inventorySearchQuery.data);
    }
  }, [inventorySearchQuery.data, inventorySearchQuery.isPlaceholderData, inventorySearchValue, normalizedInventorySearch]);
  const inventorySearchMatchedIngredientIds = useMemo(() => appliedInventorySearch ? Array.from(new Set(appliedInventoryResults.map((item) => item.ingredient_id))) : [], [appliedInventoryResults, appliedInventorySearch]);
  const catalogSearchMatchedIngredientIds = useMemo(() => appliedCatalogSearch ? Array.from(new Set(appliedCatalogResults.map((item) => item.id))) : [], [appliedCatalogResults, appliedCatalogSearch]);
  const searchAwareIngredients = appliedCatalogSearch ? appliedCatalogResults : args.ingredients;
  const searchAwareInventoryItems = appliedInventorySearch ? appliedInventoryResults : args.inventoryItems;
  const unifiedInventoryItems: InventoryOverviewItem[] = inventoryOverviewQuery.data?.items ?? [];
  const entryFilterBaseUnifiedInventoryItems = useMemo(() => filterUnifiedInventoryItems(unifiedInventoryItems, { source: args.inventorySourceFilter, entry: 'all', quick: args.inventoryQuickFilter, storage: args.inventoryStorageFocus, search: appliedInventorySearch }), [appliedInventorySearch, args.inventoryQuickFilter, args.inventorySourceFilter, args.inventoryStorageFocus, unifiedInventoryItems]);
  const filteredUnifiedInventoryItems = useMemo(() => filterUnifiedInventoryItems(entryFilterBaseUnifiedInventoryItems, { source: args.inventorySourceFilter, entry: args.inventoryEntryFilter, quick: args.inventoryQuickFilter, storage: args.inventoryStorageFocus, search: appliedInventorySearch }), [appliedInventorySearch, entryFilterBaseUnifiedInventoryItems, args.inventoryEntryFilter, args.inventoryQuickFilter, args.inventorySourceFilter, args.inventoryStorageFocus]);
  const unifiedInventoryGroups = useMemo(() => buildUnifiedInventoryGroups(filteredUnifiedInventoryItems), [filteredUnifiedInventoryItems]);
  const unifiedInventorySummary = useMemo(() => buildUnifiedInventorySummary(filteredUnifiedInventoryItems), [filteredUnifiedInventoryItems]);
  const unifiedInventoryEntrySummary = useMemo(() => buildUnifiedInventorySummary(entryFilterBaseUnifiedInventoryItems), [entryFilterBaseUnifiedInventoryItems]);
  const mobileFoodStockItems = useMemo(() => unifiedInventoryItems.filter((item) => item.source_type === 'food'), [unifiedInventoryItems]);
  return {
    catalogSearchComposition, inventorySearchComposition, inventoryOverviewQuery,
    appliedCatalogSearch, appliedInventorySearch, catalogSearchMatchedIngredientIds, inventorySearchMatchedIngredientIds,
    searchAwareIngredients, searchAwareInventoryItems, unifiedInventoryItems, entryFilterBaseUnifiedInventoryItems,
    filteredUnifiedInventoryItems, unifiedInventoryGroups, unifiedInventorySummary, unifiedInventoryEntrySummary, mobileFoodStockItems,
    isCatalogSearchFetching: Boolean(normalizedCatalogSearch) && !catalogSearchComposition.isComposing && (appliedCatalogSearch !== normalizedCatalogSearch || catalogSearchQuery.isFetching),
    isInventorySearchFetching: Boolean(normalizedInventorySearch) && !inventorySearchComposition.isComposing && (appliedInventorySearch !== normalizedInventorySearch || inventorySearchQuery.isFetching),
  };
}
