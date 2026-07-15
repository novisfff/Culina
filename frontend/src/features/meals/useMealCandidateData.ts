import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type { MealLogCandidate, MealType } from '../../api/types';

export type UseMealCandidateDataArgs = {
  open: boolean;
  date: string;
  mealType: MealType;
};

/**
 * Authoritative candidate query shared by Composer, plan completion and Recipe cook.
 * Never infers candidates from the mealLogs timeline cache.
 */
export function useMealCandidateData(args: UseMealCandidateDataArgs) {
  const enabled = args.open && Boolean(args.date) && Boolean(args.mealType);
  const query = useQuery({
    queryKey: queryKeys.mealCandidates(args.date, args.mealType),
    queryFn: () => api.getMealCandidates(args.date, args.mealType),
    enabled,
  });

  return {
    candidates: (query.data ?? []) as MealLogCandidate[],
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    refetch: query.refetch,
    query,
  };
}
