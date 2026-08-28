import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { queryKeys } from '../api/queryKeys';

export function useAppShellQueries({ isAuthenticated }: { isAuthenticated: boolean }) {
  const familyQuery = useQuery({ queryKey: queryKeys.family, queryFn: api.getFamily, enabled: isAuthenticated });
  const membersQuery = useQuery({ queryKey: queryKeys.members, queryFn: api.getMembers, enabled: isAuthenticated });
  const activityHighlightsQuery = useQuery({
    queryKey: queryKeys.activityHighlightList(5),
    queryFn: () => api.getActivityHighlights(5),
    enabled: isAuthenticated,
  });
  return { familyQuery, membersQuery, activityHighlightsQuery };
}
