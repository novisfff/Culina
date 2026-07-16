import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type { Food, MealType } from '../../api/types';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { useMealCandidateData } from './useMealCandidateData';

export type UseMealComposerDataArgs = {
  open: boolean;
  date: string;
  mealType: MealType;
  searchQuery: string;
};

const FOOD_PICKER_LIMIT = 20;
const SEARCH_DEBOUNCE_MS = 300;

/**
 * Composer data: food picker search + shared authoritative candidates.
 * Candidate refresh is independent of Food search.
 */
export function useMealComposerData(args: UseMealComposerDataArgs) {
  const debouncedQuery = useDebouncedValue(args.searchQuery.trim(), SEARCH_DEBOUNCE_MS);
  const foodSearchEnabled = args.open && debouncedQuery.length > 0;

  const foodQuery = useQuery({
    queryKey: queryKeys.foodPickerSearch(debouncedQuery),
    queryFn: () => api.getFoods({ q: debouncedQuery, limit: FOOD_PICKER_LIMIT }),
    enabled: foodSearchEnabled,
  });

  const candidates = useMealCandidateData({
    open: args.open,
    date: args.date,
    mealType: args.mealType,
  });

  return {
    foods: (foodQuery.data ?? []) as Food[],
    foodSearchQuery: debouncedQuery,
    isSearchingFoods: foodSearchEnabled && foodQuery.isFetching,
    foodQuery,
    candidates: candidates.candidates,
    isLoadingCandidates: candidates.isLoading,
    isFetchingCandidates: candidates.isFetching,
    candidateError: candidates.error,
    refetchCandidates: candidates.refetch,
    candidateQuery: candidates.query,
  };
}
