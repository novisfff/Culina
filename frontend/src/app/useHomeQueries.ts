import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { queryKeys } from '../api/queryKeys';

export function useHomeQueries({ isAuthenticated, enabled }: { isAuthenticated: boolean; enabled: boolean }) {
  return {
    activeMealRecordOperationsQuery: useQuery({
      queryKey: queryKeys.mealRecordOperations(true),
      queryFn: () => api.getActiveMealRecordOperations(true),
      enabled: isAuthenticated && enabled,
    }),
  };
}
