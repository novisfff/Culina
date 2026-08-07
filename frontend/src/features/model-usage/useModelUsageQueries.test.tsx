// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '../../api/queryKeys';
import type {
  ModelUsageBreakdown,
  ModelUsageFamilyOverview,
  ModelUsagePersonalOverview,
  ModelUsagePolicy,
} from '../../api/types';
import { currentModelUsagePeriod, useModelUsageQueries } from './useModelUsageQueries';

const modelUsageApi = vi.hoisted(() => ({
  getMyModelUsageOverview: vi.fn(),
  getMyModelUsageBreakdown: vi.fn(),
  getFamilyModelUsageOverview: vi.fn(),
  getFamilyModelUsageBreakdown: vi.fn(),
  getFamilyModelUsagePolicy: vi.fn(),
  getModelUsageAlerts: vi.fn(),
}));

vi.mock('../../api/client', () => ({ api: modelUsageApi }));

function health() {
  return {
    exact_event_count: 1,
    estimated_event_count: 0,
    unpriced_event_count: 0,
    uncertain_attempt_count: 0,
    pending_attempt_count: 0,
    unresolved_unknown_execution_attempt_count: 0,
    conservative_estimated_cost_cny: null,
    known_unmeasured_attempt_count: 0,
    measurement_gap: false,
    measurement_gap_scope: [],
    gap_intervals: [],
  };
}

function personalOverview(overrides: Partial<ModelUsagePersonalOverview> = {}): ModelUsagePersonalOverview {
  return {
    family_id: 'family-a',
    scope: 'me',
    period: '2026-07',
    source: 'raw',
    is_partial_period: false,
    known_priced_cost_cny: '1.000000000000',
    pricing_complete: true,
    unpriced_event_count: 0,
    total_cost_cny: '1.000000000000',
    meter_totals: [{ meter: 'input_tokens', quantity: '10.000000000000' }],
    measurement_health: health(),
    family_budget_state: 'sufficient',
    ...overrides,
  };
}

function familyOverview(overrides: Partial<ModelUsageFamilyOverview> = {}): ModelUsageFamilyOverview {
  return {
    ...personalOverview(),
    scope: 'family',
    monthly_budget_cny: '80.000000000000',
    effective_spend_cny: '1.000000000000',
    reserved_cost_cny: '0.000000000000',
    hard_limit_enabled: false,
    ...overrides,
  };
}

function breakdown(scope: 'me' | 'family' = 'family'): ModelUsageBreakdown {
  return {
    family_id: 'family-a',
    scope,
    period: '2026-07',
    source: 'raw',
    is_partial_period: false,
    group_by: 'capability',
    items: [],
  };
}

function policy(): ModelUsagePolicy {
  return {
    version_number: 1,
    monthly_budget_cny: '80.000000000000',
    alerts_enabled: true,
    hard_limit_enabled: false,
    budget_alert_revision: 1,
    capability_limits: [],
    effective_at: '2026-07-01T00:00:00Z',
  };
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function wrapper(queryClient: QueryClient) {
  return function QueryWrapper(props: PropsWithChildren) {
    return <QueryClientProvider client={queryClient}>{props.children}</QueryClientProvider>;
  };
}

function resolveOwnerQueries(overview: ModelUsageFamilyOverview = familyOverview()) {
  modelUsageApi.getFamilyModelUsageOverview.mockResolvedValue(overview);
  modelUsageApi.getFamilyModelUsageBreakdown.mockResolvedValue(breakdown('family'));
  modelUsageApi.getFamilyModelUsagePolicy.mockResolvedValue(policy());
  modelUsageApi.getModelUsageAlerts.mockResolvedValue([]);
}

describe('useModelUsageQueries', () => {
  beforeEach(() => {
    Object.values(modelUsageApi).forEach((mock) => mock.mockReset());
  });

  it('uses owner-only family endpoints by default and scopes every query to the family', async () => {
    const queryClient = makeQueryClient();
    resolveOwnerQueries();

    const { result } = renderHook(
      () => useModelUsageQueries({ familyId: 'family-a', role: 'Owner', initialPeriod: '2026-07' }),
      { wrapper: wrapper(queryClient) },
    );

    await waitFor(() => expect(result.current.viewModel.state).toBe('ready'));

    expect(result.current.scope).toBe('family');
    expect(modelUsageApi.getFamilyModelUsageOverview).toHaveBeenCalledWith('2026-07');
    expect(modelUsageApi.getFamilyModelUsageBreakdown).toHaveBeenCalledWith('2026-07', 'capability');
    expect(modelUsageApi.getFamilyModelUsagePolicy).toHaveBeenCalledTimes(1);
    expect(modelUsageApi.getModelUsageAlerts).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(queryKeys.modelUsageOverview('family-a', 'family', '2026-07')))
      .toMatchObject({ family_id: 'family-a', scope: 'family' });
  });

  it('forces ordinary members to personal scope and never calls family-only endpoints', async () => {
    const queryClient = makeQueryClient();
    modelUsageApi.getMyModelUsageOverview.mockResolvedValue(personalOverview());
    modelUsageApi.getMyModelUsageBreakdown.mockResolvedValue(breakdown('me'));

    const { result } = renderHook(
      () => useModelUsageQueries({
        familyId: 'family-a',
        role: 'Member',
        initialScope: 'family',
        initialPeriod: '2026-07',
      }),
      { wrapper: wrapper(queryClient) },
    );

    await waitFor(() => expect(result.current.viewModel.state).toBe('ready'));

    expect(result.current.scope).toBe('me');
    expect(modelUsageApi.getMyModelUsageOverview).toHaveBeenCalledWith('2026-07');
    expect(modelUsageApi.getMyModelUsageBreakdown).toHaveBeenCalledWith('2026-07', 'capability');
    expect(modelUsageApi.getFamilyModelUsageOverview).not.toHaveBeenCalled();
    expect(modelUsageApi.getFamilyModelUsageBreakdown).not.toHaveBeenCalled();
    expect(modelUsageApi.getFamilyModelUsagePolicy).not.toHaveBeenCalled();
    expect(modelUsageApi.getModelUsageAlerts).not.toHaveBeenCalled();
  });

  it('changes owner scope, historical period and grouping with distinct query identities', async () => {
    const queryClient = makeQueryClient();
    resolveOwnerQueries();
    modelUsageApi.getMyModelUsageOverview.mockResolvedValue(personalOverview());
    modelUsageApi.getMyModelUsageBreakdown.mockResolvedValue(breakdown('me'));

    const { result } = renderHook(
      () => useModelUsageQueries({ familyId: 'family-a', role: 'Owner', initialPeriod: '2026-07' }),
      { wrapper: wrapper(queryClient) },
    );
    await waitFor(() => expect(result.current.viewModel.state).toBe('ready'));

    act(() => {
      result.current.actions.setScope('me');
      result.current.actions.setPeriod('2026-06');
      result.current.actions.setGroupBy('meter');
    });

    await waitFor(() => expect(modelUsageApi.getMyModelUsageOverview).toHaveBeenCalledWith('2026-06'));
    await waitFor(() => expect(modelUsageApi.getMyModelUsageBreakdown).toHaveBeenCalledWith('2026-06', 'meter'));
    expect(result.current.scope).toBe('me');
    expect(result.current.period).toBe('2026-06');
    expect(result.current.groupBy).toBe('meter');
    expect(queryClient.getQueryState(queryKeys.modelUsageOverview('family-a', 'family', '2026-07'))).toBeDefined();
    expect(queryClient.getQueryState(queryKeys.modelUsageOverview('family-a', 'me', '2026-06'))).toBeDefined();
    expect(queryClient.getQueryState(queryKeys.modelUsageBreakdown('family-a', 'me', '2026-06', 'meter'))).toBeDefined();
  });

  it('cancels the previous family and never flashes its data while the next family is loading', async () => {
    const queryClient = makeQueryClient();
    const cancelQueries = vi.spyOn(queryClient, 'cancelQueries');
    let resolveFamilyBOverview: ((value: ModelUsageFamilyOverview) => void) | undefined;
    let resolveFamilyBBreakdown: ((value: ModelUsageBreakdown) => void) | undefined;
    const familyBOverview = new Promise<ModelUsageFamilyOverview>((resolve) => {
      resolveFamilyBOverview = resolve;
    });
    const familyBBreakdown = new Promise<ModelUsageBreakdown>((resolve) => {
      resolveFamilyBBreakdown = resolve;
    });
    modelUsageApi.getFamilyModelUsageOverview
      .mockResolvedValueOnce(familyOverview({ family_id: 'family-a' }))
      .mockImplementationOnce(() => familyBOverview);
    modelUsageApi.getFamilyModelUsageBreakdown
      .mockResolvedValueOnce(breakdown('family'))
      .mockResolvedValueOnce({ ...breakdown('family'), group_by: 'daily_capability_cost' })
      .mockImplementation(() => familyBBreakdown);
    modelUsageApi.getFamilyModelUsagePolicy.mockResolvedValue(policy());
    modelUsageApi.getModelUsageAlerts.mockResolvedValue([]);

    const { result, rerender } = renderHook(
      ({ familyId }) => useModelUsageQueries({ familyId, role: 'Owner', initialPeriod: '2026-07' }),
      { initialProps: { familyId: 'family-a' }, wrapper: wrapper(queryClient) },
    );
    await waitFor(() => expect(result.current.viewModel).toMatchObject({
      state: 'ready',
      overview: { family_id: 'family-a' },
    }));

    rerender({ familyId: 'family-b' });

    await waitFor(() => expect(cancelQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.modelUsageRoot('family-a'),
    }));
    expect(result.current.viewModel).toMatchObject({ state: 'loading' });
    expect(result.current.overview?.family_id).not.toBe('family-a');

    await act(async () => {
      resolveFamilyBOverview?.(familyOverview({ family_id: 'family-b' }));
      resolveFamilyBBreakdown?.({ ...breakdown('family'), family_id: 'family-b' });
    });
    await waitFor(() => expect(result.current.viewModel).toMatchObject({
      state: 'ready',
      overview: { family_id: 'family-b' },
    }));
  });

  it('keeps cached data visible and reports a refresh error when a background refresh fails', async () => {
    const queryClient = makeQueryClient();
    resolveOwnerQueries();
    const { result } = renderHook(
      () => useModelUsageQueries({ familyId: 'family-a', role: 'Owner', initialPeriod: '2026-07' }),
      { wrapper: wrapper(queryClient) },
    );
    await waitFor(() => expect(result.current.viewModel.state).toBe('ready'));

    modelUsageApi.getFamilyModelUsageOverview.mockRejectedValueOnce(new Error('offline'));
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.modelUsageOverview('family-a', 'family', '2026-07'),
      });
    });

    await waitFor(() => expect(result.current.viewModel).toMatchObject({
      state: 'ready',
      overview: { family_id: 'family-a' },
      refreshError: 'offline',
    }));
  });

  it('returns an alert-supplied period to the current Beijing month when the navigation period is cleared', async () => {
    const queryClient = makeQueryClient();
    resolveOwnerQueries();
    const { result, rerender } = renderHook(
      ({ initialPeriod }) => useModelUsageQueries({
        familyId: 'family-a',
        role: 'Owner',
        initialPeriod,
      }),
      { initialProps: { initialPeriod: '2026-01' as string | null }, wrapper: wrapper(queryClient) },
    );

    await waitFor(() => expect(result.current.period).toBe('2026-01'));
    rerender({ initialPeriod: null });

    await waitFor(() => expect(result.current.period).toBe(currentModelUsagePeriod()));
  });
});
