import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type {
  ModelUsageBreakdown,
  ModelUsageFamilyGroupBy,
  ModelUsageFamilyOverview,
  ModelUsageGroupBy,
  ModelUsagePersonalGroupBy,
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

function isPersonalGroupBy(groupBy: ModelUsageGroupBy): groupBy is ModelUsagePersonalGroupBy {
  return groupBy === 'capability' || groupBy === 'meter' || groupBy === 'daily_capability_cost';
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
  const personalGroupBy: ModelUsagePersonalGroupBy = isPersonalGroupBy(groupBy) ? groupBy : 'capability';
  const effectiveGroupBy: ModelUsageGroupBy = scope === 'me' ? personalGroupBy : groupBy;
  const enabled = Boolean(args.familyId);
  const previousFamilyIdRef = useRef(args.familyId || null);

  useEffect(() => {
    setPeriod(args.initialPeriod ?? currentModelUsagePeriod());
  }, [args.initialPeriod]);

  useEffect(() => {
    const previousFamilyId = previousFamilyIdRef.current;
    if (previousFamilyId && previousFamilyId !== args.familyId) {
      void queryClient.cancelQueries({ queryKey: queryKeys.modelUsageRoot(previousFamilyId) });
    }
    previousFamilyIdRef.current = args.familyId || null;
  }, [args.familyId, queryClient]);

  useEffect(() => {
    if (scope === 'me' && !isPersonalGroupBy(groupBy)) {
      setGroupBy('capability');
    }
  }, [groupBy, scope]);

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
    queryKey: queryKeys.modelUsageBreakdown(args.familyId, scope, period, effectiveGroupBy),
    queryFn: () => scope === 'family'
      ? api.getFamilyModelUsageBreakdown(period, groupBy as ModelUsageFamilyGroupBy)
      : api.getMyModelUsageBreakdown(period, personalGroupBy),
    enabled,
  });
  const dailyTrendQuery = useQuery<ModelUsageBreakdown>({
    queryKey: queryKeys.modelUsageBreakdown(args.familyId, scope, period, 'daily_capability_cost'),
    queryFn: () => scope === 'family'
      ? api.getFamilyModelUsageBreakdown(period, 'daily_capability_cost')
      : api.getMyModelUsageBreakdown(period, 'daily_capability_cost'),
    enabled,
  });
  const activeBreakdownQuery = effectiveGroupBy === 'daily_capability_cost'
    ? dailyTrendQuery
    : breakdownQuery;
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
      breakdown: activeBreakdownQuery.data ?? null,
      dailyTrend: dailyTrendQuery.data ?? null,
      isInitialLoading: overviewQuery.isLoading && !overviewQuery.data,
      isRefreshing: overviewQuery.isFetching || activeBreakdownQuery.isFetching,
      isDailyTrendLoading: dailyTrendQuery.isLoading && !dailyTrendQuery.data,
      error: overviewQuery.error ?? activeBreakdownQuery.error ?? dailyTrendQuery.error,
    }),
    [
      activeBreakdownQuery.data,
      activeBreakdownQuery.error,
      activeBreakdownQuery.isFetching,
      dailyTrendQuery.data,
      dailyTrendQuery.error,
      dailyTrendQuery.isLoading,
      overviewQuery.data,
      overviewQuery.error,
      overviewQuery.isFetching,
      overviewQuery.isLoading,
    ],
  );

  const setScope = useCallback((nextScope: ModelUsageScope) => {
    if (!isOwner) return;
    if (nextScope === 'me' && !isPersonalGroupBy(groupBy)) setGroupBy('capability');
    setRequestedScope(nextScope);
  }, [groupBy, isOwner]);

  return {
    isOwner,
    scope,
    period,
    groupBy: effectiveGroupBy,
    overview: overviewQuery.data ?? null,
    breakdown: activeBreakdownQuery.data ?? null,
    dailyTrend: dailyTrendQuery.data ?? null,
    policy: policyQuery.data ?? null,
    alerts: alertsQuery.data ?? [],
    overviewQuery,
    breakdownQuery,
    dailyTrendQuery,
    activeBreakdownQuery,
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
