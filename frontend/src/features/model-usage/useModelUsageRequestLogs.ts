import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type {
  ModelUsageRequestLogPage,
  ModelUsageScope,
  UserRole,
} from '../../api/types';
import { currentModelUsagePeriod } from './useModelUsageQueries';
import {
  createModelUsageRequestLogFilters,
  toFamilyModelUsageRequestFilters,
  toPersonalModelUsageRequestFilters,
  transitionModelUsageRequestLogScope,
  type ModelUsageRequestLogFilters,
} from './modelUsageRequestLogsModel';

type ScopedFilters = Record<ModelUsageScope, ModelUsageRequestLogFilters>;

export type UseModelUsageRequestLogsArgs = {
  familyId: string;
  role: UserRole;
  initialPeriod?: string | null;
  initialScope?: ModelUsageScope;
};

function personalFilters(filters: ModelUsageRequestLogFilters): ModelUsageRequestLogFilters {
  return { ...filters, provider: '', model: '' };
}

function filtersForScope(scope: ModelUsageScope, filters: ModelUsageRequestLogFilters): ModelUsageRequestLogFilters {
  return scope === 'me' ? personalFilters(filters) : filters;
}

function createScopedFilters(period: string): ScopedFilters {
  const family = createModelUsageRequestLogFilters(period);
  return { family, me: personalFilters(family) };
}

export function useModelUsageRequestLogs(args: UseModelUsageRequestLogsArgs) {
  const queryClient = useQueryClient();
  const isOwner = args.role === 'Owner';
  const initialPeriod = args.initialPeriod ?? currentModelUsagePeriod();
  const initialFilters = useMemo(() => createScopedFilters(initialPeriod), [initialPeriod]);
  const [requestedScope, setRequestedScope] = useState<ModelUsageScope>(
    () => args.initialScope ?? (isOwner ? 'family' : 'me'),
  );
  const [draftFiltersByScope, setDraftFiltersByScope] = useState<ScopedFilters>(initialFilters);
  const [filtersByScope, setFiltersByScope] = useState<ScopedFilters>(initialFilters);
  const draftFiltersRef = useRef<ScopedFilters>(initialFilters);
  const filtersRef = useRef<ScopedFilters>(initialFilters);
  const previousFamilyIdRef = useRef(args.familyId || null);
  const scope: ModelUsageScope = isOwner ? requestedScope : 'me';
  const draftFilters = draftFiltersByScope[scope];
  const filters = filtersByScope[scope];

  useEffect(() => {
    draftFiltersRef.current = initialFilters;
    filtersRef.current = initialFilters;
    setDraftFiltersByScope(initialFilters);
    setFiltersByScope(initialFilters);
  }, [initialFilters]);

  useEffect(() => {
    const previousFamilyId = previousFamilyIdRef.current;
    if (previousFamilyId && previousFamilyId !== args.familyId) {
      void queryClient.cancelQueries({ queryKey: queryKeys.modelUsageRoot(previousFamilyId) });
    }
    previousFamilyIdRef.current = args.familyId || null;
  }, [args.familyId, queryClient]);

  const requestQuery = useQuery<ModelUsageRequestLogPage>({
    queryKey: [
      ...queryKeys.modelUsageRequests(args.familyId, scope, filters.dateFrom, filters.dateTo),
      filters.capability,
      filters.status,
      filters.limit,
      filters.page,
      ...(scope === 'family' ? [filters.provider, filters.model] : []),
    ],
    queryFn: () => {
      if (scope === 'family') {
        return api.getFamilyModelUsageRequests(toFamilyModelUsageRequestFilters(filters));
      }
      return api.getMyModelUsageRequests(toPersonalModelUsageRequestFilters(filters));
    },
    enabled: Boolean(args.familyId) && Boolean(filters.dateFrom) && Boolean(filters.dateTo),
  });

  const setScope = useCallback((nextScope: ModelUsageScope) => {
    if (!isOwner) return;

    const draftSource = nextScope === 'me' ? draftFiltersRef.current[scope] : draftFiltersRef.current[nextScope];
    const nextDraftFilters = {
      ...draftFiltersRef.current,
      [nextScope]: transitionModelUsageRequestLogScope(nextScope, draftSource).filters,
    };
    draftFiltersRef.current = nextDraftFilters;
    setDraftFiltersByScope(nextDraftFilters);

    const filterSource = nextScope === 'me' ? filtersRef.current[scope] : filtersRef.current[nextScope];
    const nextFilters = {
      ...filtersRef.current,
      [nextScope]: transitionModelUsageRequestLogScope(nextScope, filterSource).filters,
    };
    filtersRef.current = nextFilters;
    setFiltersByScope(nextFilters);
    setRequestedScope(nextScope);
  }, [isOwner, scope]);

  const patchDraftFilters = useCallback((patch: Partial<ModelUsageRequestLogFilters>) => {
    const nextDraftFilters = {
      ...draftFiltersRef.current,
      [scope]: filtersForScope(scope, { ...draftFiltersRef.current[scope], ...patch }),
    };
    draftFiltersRef.current = nextDraftFilters;
    setDraftFiltersByScope(nextDraftFilters);
  }, [scope]);

  const applyFilters = useCallback(() => {
    const nextFilters = {
      ...filtersRef.current,
      [scope]: { ...filtersForScope(scope, draftFiltersRef.current[scope]), page: 0 },
    };
    filtersRef.current = nextFilters;
    setFiltersByScope(nextFilters);
  }, [scope]);

  const resetFilters = useCallback(() => {
    const reset = initialFilters[scope];
    const nextDraftFilters = { ...draftFiltersRef.current, [scope]: reset };
    const nextFilters = { ...filtersRef.current, [scope]: reset };
    draftFiltersRef.current = nextDraftFilters;
    filtersRef.current = nextFilters;
    setDraftFiltersByScope(nextDraftFilters);
    setFiltersByScope(nextFilters);
  }, [initialFilters, scope]);

  const setPage = useCallback((page: number) => {
    const nextFilters = {
      ...filtersRef.current,
      [scope]: { ...filtersRef.current[scope], page: Math.max(0, page) },
    };
    filtersRef.current = nextFilters;
    setFiltersByScope(nextFilters);
  }, [scope]);

  const totalPages = Math.max(1, Math.ceil((requestQuery.data?.total ?? 0) / filters.limit));

  return {
    isOwner,
    scope,
    filters,
    draftFilters,
    page: requestQuery.data ?? null,
    totalPages,
    requestQuery,
    actions: {
      setScope,
      patchDraftFilters,
      applyFilters,
      resetFilters,
      setPage,
    },
  };
}
