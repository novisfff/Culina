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
import { buildModelUsageTrendWindow } from './modelUsageChartModel';
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
  const currentBusinessDate = businessDateKey(new Date(), 'Asia/Shanghai');
  const trendWindow = useMemo(
    () => buildModelUsageTrendWindow(period, currentBusinessDate),
    [currentBusinessDate, period],
  );
  const supplementalTrendPeriod = trendWindow.periods.find((trendPeriod) => trendPeriod !== period) ?? null;

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
  const primaryDailyTrendQuery = useQuery<ModelUsageBreakdown>({
    queryKey: queryKeys.modelUsageBreakdown(args.familyId, scope, period, 'daily_capability_cost'),
    queryFn: () => scope === 'family'
      ? api.getFamilyModelUsageBreakdown(period, 'daily_capability_cost')
      : api.getMyModelUsageBreakdown(period, 'daily_capability_cost'),
    enabled,
  });
  const supplementalDailyTrendQuery = useQuery<ModelUsageBreakdown>({
    queryKey: queryKeys.modelUsageBreakdown(
      args.familyId,
      scope,
      supplementalTrendPeriod ?? 'supplemental-not-required',
      'daily_capability_cost',
    ),
    queryFn: () => {
      if (!supplementalTrendPeriod) throw new Error('Supplemental trend period is not required');
      return scope === 'family'
        ? api.getFamilyModelUsageBreakdown(supplementalTrendPeriod, 'daily_capability_cost')
        : api.getMyModelUsageBreakdown(supplementalTrendPeriod, 'daily_capability_cost');
    },
    enabled: enabled && Boolean(supplementalTrendPeriod),
  });
  const capabilityBreakdownQuery = useQuery<ModelUsageBreakdown>({
    queryKey: queryKeys.modelUsageBreakdown(args.familyId, scope, period, 'capability'),
    queryFn: () => scope === 'family'
      ? api.getFamilyModelUsageBreakdown(period, 'capability')
      : api.getMyModelUsageBreakdown(period, 'capability'),
    enabled,
  });
  const activeBreakdownQuery = effectiveGroupBy === 'daily_capability_cost'
    ? primaryDailyTrendQuery
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

  const dailyTrend = useMemo<ModelUsageBreakdown | null>(() => {
    const base = primaryDailyTrendQuery.data ?? supplementalDailyTrendQuery.data;
    if (!base) return null;
    const breakdowns = [supplementalDailyTrendQuery.data, primaryDailyTrendQuery.data]
      .filter((item): item is ModelUsageBreakdown => Boolean(item));
    return {
      ...base,
      period,
      items: breakdowns.flatMap((item) => item.items),
      is_partial_period: breakdowns.some((item) => item.is_partial_period),
    };
  }, [period, primaryDailyTrendQuery.data, supplementalDailyTrendQuery.data]);
  const isSupplementalTrendLoading = Boolean(supplementalTrendPeriod)
    && supplementalDailyTrendQuery.isLoading;
  const isSupplementalTrendFetching = Boolean(supplementalTrendPeriod)
    && supplementalDailyTrendQuery.isFetching;
  const supplementalTrendError = supplementalTrendPeriod ? supplementalDailyTrendQuery.error : null;
  const dailyTrendQuery = useMemo(() => ({
    data: dailyTrend,
    isLoading: primaryDailyTrendQuery.isLoading || isSupplementalTrendLoading,
    isFetching: primaryDailyTrendQuery.isFetching || isSupplementalTrendFetching,
    error: primaryDailyTrendQuery.error ?? supplementalTrendError,
    refetch: () => Promise.all([
      primaryDailyTrendQuery.refetch(),
      ...(supplementalTrendPeriod ? [supplementalDailyTrendQuery.refetch()] : []),
    ]),
  }), [
    dailyTrend,
    isSupplementalTrendFetching,
    isSupplementalTrendLoading,
    primaryDailyTrendQuery.error,
    primaryDailyTrendQuery.isFetching,
    primaryDailyTrendQuery.isLoading,
    primaryDailyTrendQuery.refetch,
    supplementalDailyTrendQuery.refetch,
    supplementalTrendError,
    supplementalTrendPeriod,
  ]);

  const viewModel = useMemo(
    () => buildModelUsageWorkspaceViewModel({
      overview: overviewQuery.data ?? null,
      breakdown: activeBreakdownQuery.data ?? null,
      dailyTrend,
      capabilityBreakdown: capabilityBreakdownQuery.data ?? null,
      isInitialLoading: overviewQuery.isLoading && !overviewQuery.data,
      isRefreshing: overviewQuery.isFetching || activeBreakdownQuery.isFetching
        || dailyTrendQuery.isFetching || capabilityBreakdownQuery.isFetching,
      isDailyTrendLoading: dailyTrendQuery.isLoading && !dailyTrendQuery.data,
      isCapabilityBreakdownLoading: capabilityBreakdownQuery.isLoading && !capabilityBreakdownQuery.data,
      error: overviewQuery.error ?? activeBreakdownQuery.error
        ?? dailyTrendQuery.error ?? capabilityBreakdownQuery.error,
    }),
    [
      activeBreakdownQuery.data,
      activeBreakdownQuery.error,
      activeBreakdownQuery.isFetching,
      capabilityBreakdownQuery.data,
      capabilityBreakdownQuery.error,
      capabilityBreakdownQuery.isFetching,
      capabilityBreakdownQuery.isLoading,
      dailyTrend,
      dailyTrendQuery.error,
      dailyTrendQuery.isLoading,
      dailyTrendQuery.isFetching,
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
    capabilityBreakdown: capabilityBreakdownQuery.data ?? null,
    policy: policyQuery.data ?? null,
    alerts: alertsQuery.data ?? [],
    trendWindow,
    overviewQuery,
    breakdownQuery,
    dailyTrendQuery,
    capabilityBreakdownQuery,
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
