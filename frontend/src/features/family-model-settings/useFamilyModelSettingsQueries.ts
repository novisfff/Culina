import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { familyModelSettingsApi } from '../../api/familyModelSettingsApi';
import { queryKeys } from '../../api/queryKeys';
import type { UserRole } from '../../api/types/modelUsage';

export interface UseFamilyModelSettingsQueriesArgs {
  familyId: string;
  role: UserRole;
  replacementProfileId?: string | null;
}

/**
 * Composes Owner-only reads. Query keys include the family id and intentionally
 * avoid placeholder data, so a previous household can never flash in a new
 * household's settings surface.
 */
export function useFamilyModelSettingsQueries(args: UseFamilyModelSettingsQueriesArgs) {
  const queryClient = useQueryClient();
  const isOwner = args.role === 'Owner';
  const enabled = Boolean(args.familyId) && isOwner;
  const settingsQuery = useQuery({
    queryKey: queryKeys.familyModelSettings(args.familyId),
    queryFn: familyModelSettingsApi.getSettings,
    enabled,
  });
  const draftQuery = useQuery({
    queryKey: queryKeys.familyModelSettingsDraft(args.familyId),
    queryFn: familyModelSettingsApi.getDraft,
    enabled,
  });
  const pricesQuery = useQuery({
    queryKey: queryKeys.familyModelPriceVersions(args.familyId),
    queryFn: familyModelSettingsApi.getPrices,
    enabled,
  });
  // Resolve the latest candidate on the server so a refresh/reopen can still
  // surface a failed or provisioning replacement even though the old local
  // profile id was discarded.
  const currentReplacementQuery = useQuery({
    queryKey: queryKeys.familySearchReplacementCurrent(args.familyId),
    queryFn: () => familyModelSettingsApi.getCurrentSearchReplacement(),
    enabled,
    refetchInterval: (query) => query.state.data?.status === 'provisioning' ? 2_000 : false,
  });
  const replacementQuery = useQuery({
    queryKey: queryKeys.familySearchReplacement(args.familyId, args.replacementProfileId ?? ''),
    queryFn: () => familyModelSettingsApi.getSearchReplacement(args.replacementProfileId as string),
    enabled: enabled
      && Boolean(args.replacementProfileId)
      && currentReplacementQuery.data?.profile_id !== args.replacementProfileId,
    refetchInterval: (query) => query.state.data?.status === 'provisioning' ? 2_000 : false,
  });

  const queries = [settingsQuery, draftQuery, pricesQuery, currentReplacementQuery, replacementQuery];
  const hasSafeData = Boolean(
    settingsQuery.data || draftQuery.data || pricesQuery.data
      || currentReplacementQuery.data || replacementQuery.data,
  );
  const stale = hasSafeData && queries.some((query) => query.isError);
  const error = queries.find((query) => query.error)?.error ?? null;
  const discoverProviderModels = useCallback((profileId: string) => {
    if (!enabled || !profileId) {
      return Promise.reject(new Error('家庭 AI 服务还没有加载完成，请稍后再试。'));
    }
    return queryClient.fetchQuery({
      queryKey: queryKeys.familyProviderModels(args.familyId, profileId),
      queryFn: () => familyModelSettingsApi.discoverProviderModels(profileId),
      staleTime: 5 * 60 * 1_000,
    });
  }, [args.familyId, enabled, queryClient]);

  return {
    isOwner,
    enabled,
    settings: settingsQuery.data ?? null,
    draft: draftQuery.data ?? null,
    prices: pricesQuery.data ?? null,
    // The server-resolved candidate wins over a stale client-held profile id;
    // this is what lets a failed replacement become visible after refresh.
    searchReplacement: currentReplacementQuery.data ?? replacementQuery.data ?? null,
    stale,
    error,
    isInitialLoading: enabled && !hasSafeData && queries.some((query) => query.isLoading),
    discoverProviderModels,
    settingsQuery,
    draftQuery,
    pricesQuery,
    replacementQuery,
    currentReplacementQuery,
  };
}
