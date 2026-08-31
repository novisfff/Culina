import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { queryKeys } from '../api/queryKeys';
export function useAiQueries({ isAuthenticated, enabled }: { isAuthenticated: boolean; enabled: boolean }) {
  return { aiConversationsQuery: useQuery({ queryKey: queryKeys.aiConversations, queryFn: api.getAiConversations, enabled: isAuthenticated && enabled, refetchInterval: isAuthenticated && enabled ? 2000 : false }) };
}
