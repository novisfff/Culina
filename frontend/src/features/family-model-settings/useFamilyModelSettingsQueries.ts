import { useQuery } from '@tanstack/react-query';
import { familyModelSettingsApi } from '../../api/familyModelSettingsApi';
import { queryKeys } from '../../api/queryKeys';
import type { UserRole } from '../../api/types';

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
  const replacementQuery = useQuery({
    queryKey: queryKeys.familySearchReplacement(args.familyId, args.replacementProfileId ?? ''),
    queryFn: () => familyModelSettingsApi.getSearchReplacement(args.replacementProfileId as string),
    enabled: enabled && Boolean(args.replacementProfileId),
    refetchInterval: (query) => query.state.data?.status === 'provisioning' ? 2_000 : false,
  });

  const queries = [settingsQuery, draftQuery, pricesQuery, replacementQuery];
  const hasSafeData = Boolean(
    settingsQuery.data || draftQuery.data || pricesQuery.data || replacementQuery.data,
  );
  const stale = hasSafeData && queries.some((query) => query.isError);
  const error = queries.find((query) => query.error)?.error ?? null;

  return {
    isOwner,
    enabled,
    settings: settingsQuery.data ?? null,
    draft: draftQuery.data ?? null,
    prices: pricesQuery.data ?? null,
    searchReplacement: replacementQuery.data ?? null,
    stale,
    error,
    isInitialLoading: enabled && !hasSafeData && queries.some((query) => query.isLoading),
    settingsQuery,
    draftQuery,
    pricesQuery,
    replacementQuery,
  };
}
