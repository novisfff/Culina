import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { queryKeys } from '../api/queryKeys';
export function useFamilyQueries({ isAuthenticated, enabled }: { isAuthenticated: boolean; enabled: boolean }) {
  return { activityLogsQuery: useQuery({ queryKey: queryKeys.activityLogs, queryFn: () => api.getActivityLogs(), enabled: isAuthenticated && enabled }) };
}
