import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type {
  ModelUsageBreakdown,
  ModelUsageFamilyOverview,
  ModelUsageGroupBy,
  ModelUsagePersonalOverview,
  ModelUsageScope,
  UserRole,
} from '../../api/types';
import { businessDateKey } from '../../lib/date';
import { buildModelUsageWorkspaceViewModel } from './modelUsageModel';

export function currentModelUsagePeriod(instant: Date = new Date()): string {
  return businessDateKey(instant, 'Asia/Shanghai').slice(0, 7);
}

export interface UseModelUsageQueriesArgs {
  familyId: string;
  role: UserRole;
  initialPeriod?: string | null;
  initialScope?: ModelUsageScope;
  initialGroupBy?: ModelUsageGroupBy;
}

export function useModelUsageQueries(args: UseModelUsageQueriesArgs) {
  const queryClient = useQueryClient();
  const isOwner = args.role === 'Owner';
  const [requestedScope, setRequestedScope] = useState<ModelUsageScope>(
    () => args.initialScope ?? (isOwner ? 'family' : 'me'),
  );
  const [period, setPeriod] = useState(() => args.initialPeriod ?? currentModelUsagePeriod());
  const [groupBy, setGroupBy] = useState<ModelUsageGroupBy>(() => args.initialGroupBy ?? 'capability');
  const scope: ModelUsageScope = isOwner ? requestedScope : 'me';
  const enabled = Boolean(args.familyId);
  const previousFamilyIdRef = useRef(args.familyId || null);

  useEffect(() => {
    if (args.initialPeriod) setPeriod(args.initialPeriod);
  }, [args.initialPeriod]);

  useEffect(() => {
    const previousFamilyId = previousFamilyIdRef.current;
    if (previousFamilyId && previousFamilyId !== args.familyId) {
      void queryClient.cancelQueries({ queryKey: queryKeys.modelUsageRoot(previousFamilyId) });
    }
    previousFamilyIdRef.current = args.familyId || null;
  }, [args.familyId, queryClient]);

  // Do not carry placeholder data across query identities. React Query keeps
  // data for the exact key in its cache, while a family/scope/period change
  // starts empty so the previous household can never flash on screen.
  const overviewQuery = useQuery<ModelUsagePersonalOverview | ModelUsageFamilyOverview>({
    queryKey: queryKeys.modelUsageOverview(args.familyId, scope, period),
    queryFn: () => scope === 'family'
      ? api.getFamilyModelUsageOverview(period)
      : api.getMyModelUsageOverview(period),
    enabled,
  });
  const breakdownQuery = useQuery<ModelUsageBreakdown>({
    queryKey: queryKeys.modelUsageBreakdown(args.familyId, scope, period, groupBy),
    queryFn: () => scope === 'family'
      ? api.getFamilyModelUsageBreakdown(period, groupBy)
      : api.getMyModelUsageBreakdown(period, groupBy),
    enabled,
  });
  const policyQuery = useQuery({
    queryKey: queryKeys.modelUsagePolicy(args.familyId),
    queryFn: api.getFamilyModelUsagePolicy,
    enabled: enabled && isOwner,
  });
  const alertsQuery = useQuery({
    queryKey: queryKeys.modelUsageAlerts(args.familyId),
    queryFn: api.getModelUsageAlerts,
    enabled: enabled && isOwner,
  });

  const viewModel = useMemo(
    () => buildModelUsageWorkspaceViewModel({
      overview: overviewQuery.data ?? null,
      breakdown: breakdownQuery.data ?? null,
      isInitialLoading: overviewQuery.isLoading && !overviewQuery.data,
      isRefreshing: overviewQuery.isFetching || breakdownQuery.isFetching,
      error: overviewQuery.error ?? breakdownQuery.error,
    }),
    [
      breakdownQuery.data,
      breakdownQuery.error,
      breakdownQuery.isFetching,
      overviewQuery.data,
      overviewQuery.error,
      overviewQuery.isFetching,
      overviewQuery.isLoading,
    ],
  );

  const setScope = useCallback((nextScope: ModelUsageScope) => {
    if (isOwner) setRequestedScope(nextScope);
  }, [isOwner]);

  return {
    isOwner,
    scope,
    period,
    groupBy,
    overview: overviewQuery.data ?? null,
    breakdown: breakdownQuery.data ?? null,
    policy: policyQuery.data ?? null,
    alerts: alertsQuery.data ?? [],
    overviewQuery,
    breakdownQuery,
    policyQuery,
    alertsQuery,
    viewModel,
    actions: {
      setScope,
      setPeriod,
      setGroupBy,
    },
  };
}
