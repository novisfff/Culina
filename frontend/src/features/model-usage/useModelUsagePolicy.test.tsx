// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/request';
import { queryKeys } from '../../api/queryKeys';
import type { ModelUsagePolicy } from '../../api/types';
import { useModelUsagePolicy } from './useModelUsagePolicy';

const modelUsageApi = vi.hoisted(() => ({
  getFamilyModelUsagePolicy: vi.fn(),
  updateFamilyModelUsagePolicy: vi.fn(),
}));

vi.mock('../../api/client', () => ({ api: modelUsageApi }));

function policy(overrides: Partial<ModelUsagePolicy> = {}): ModelUsagePolicy {
  return {
    version_number: 3,
    monthly_budget_cny: '80.005000000000',
    alerts_enabled: true,
    hard_limit_enabled: false,
    budget_alert_revision: 2,
    capability_limits: [{
      capability: 'llm',
      limit_kind: 'cost',
      meter: null,
      limit_value: '12.345000000000',
      enabled: true,
    }],
    effective_at: '2026-07-01T00:00:00Z',
    ...overrides,
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

describe('useModelUsagePolicy', () => {
  beforeEach(() => {
    Object.values(modelUsageApi).forEach((mock) => mock.mockReset());
  });

  it('keeps Decimal strings in the policy draft and mutation payload', async () => {
    const queryClient = makeQueryClient();
    modelUsageApi.getFamilyModelUsagePolicy.mockResolvedValue(policy());
    modelUsageApi.updateFamilyModelUsagePolicy.mockResolvedValue(policy());
    const { result } = renderHook(
      () => useModelUsagePolicy({ familyId: 'family-a', role: 'Owner' }),
      { wrapper: wrapper(queryClient) },
    );

    await waitFor(() => expect(result.current.draft?.monthly_budget_cny).toBe('80.005000000000'));
    await act(async () => {
      await result.current.actions.save();
    });

    expect(modelUsageApi.updateFamilyModelUsagePolicy.mock.calls[0]?.[0]).toEqual({
      base_version_number: 3,
      monthly_budget_cny: '80.005000000000',
      alerts_enabled: true,
      hard_limit_enabled: false,
      capability_limits: [{
        capability: 'llm',
        limit_kind: 'cost',
        meter: null,
        limit_value: '12.345000000000',
        enabled: true,
      }],
      confirm_missing_price_impact: false,
    });
  });

  it('blocks a duplicate save while the first policy mutation is pending', async () => {
    const queryClient = makeQueryClient();
    let resolveSave: ((value: ModelUsagePolicy) => void) | undefined;
    const pendingSave = new Promise<ModelUsagePolicy>((resolve) => {
      resolveSave = resolve;
    });
    modelUsageApi.getFamilyModelUsagePolicy.mockResolvedValue(policy());
    modelUsageApi.updateFamilyModelUsagePolicy.mockImplementation(() => pendingSave);
    const { result } = renderHook(
      () => useModelUsagePolicy({ familyId: 'family-a', role: 'Owner' }),
      { wrapper: wrapper(queryClient) },
    );
    await waitFor(() => expect(result.current.draft).not.toBeNull());

    let firstSave: Promise<unknown> | undefined;
    let secondSave: Promise<unknown> | undefined;
    await act(async () => {
      firstSave = result.current.actions.save();
      secondSave = result.current.actions.save();
    });

    expect(modelUsageApi.updateFamilyModelUsagePolicy).toHaveBeenCalledTimes(1);
    await expect(secondSave).resolves.toBeNull();
    await act(async () => {
      resolveSave?.(policy());
      await firstSave;
    });
  });

  it('invalidates only the current family model usage cache after a successful save', async () => {
    const queryClient = makeQueryClient();
    const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');
    modelUsageApi.getFamilyModelUsagePolicy.mockResolvedValue(policy());
    modelUsageApi.updateFamilyModelUsagePolicy.mockResolvedValue(policy());
    const { result } = renderHook(
      () => useModelUsagePolicy({ familyId: 'family-a', role: 'Owner' }),
      { wrapper: wrapper(queryClient) },
    );
    await waitFor(() => expect(result.current.draft).not.toBeNull());

    await act(async () => {
      await result.current.actions.save();
    });

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.modelUsageRoot('family-a') });
    expect(invalidateQueries).not.toHaveBeenCalledWith({ queryKey: queryKeys.modelUsageRoot('family-b') });
    expect(invalidateQueries).not.toHaveBeenCalledWith({ queryKey: ['model-usage'] });
  });

  it('retains the edited draft after an ordinary save failure', async () => {
    const queryClient = makeQueryClient();
    modelUsageApi.getFamilyModelUsagePolicy.mockResolvedValue(policy());
    modelUsageApi.updateFamilyModelUsagePolicy.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(
      () => useModelUsagePolicy({ familyId: 'family-a', role: 'Owner' }),
      { wrapper: wrapper(queryClient) },
    );
    await waitFor(() => expect(result.current.draft).not.toBeNull());

    act(() => {
      result.current.actions.patchDraft({ monthly_budget_cny: '95.005000000000' });
    });
    await act(async () => {
      await expect(result.current.actions.save()).rejects.toThrow('offline');
    });

    expect(result.current.draft?.monthly_budget_cny).toBe('95.005000000000');
    expect(result.current.conflict).toBeNull();
  });

  it('retains the user draft and exposes current policy recovery on a 409 conflict', async () => {
    const queryClient = makeQueryClient();
    const currentPolicy = policy({ version_number: 4, monthly_budget_cny: '90.000000000000' });
    modelUsageApi.getFamilyModelUsagePolicy.mockResolvedValue(policy());
    modelUsageApi.updateFamilyModelUsagePolicy.mockRejectedValue(new ApiError({
      status: 409,
      detail: '预算设置已更新',
      path: '/api/model-usage/family/policy',
      payload: {
        detail: {
          code: 'model_usage_policy_conflict',
          current_policy: currentPolicy,
          current_version_number: 4,
          recovery_hint: 'review_current_policy_and_reapply',
        },
      },
    }));
    const { result } = renderHook(
      () => useModelUsagePolicy({ familyId: 'family-a', role: 'Owner' }),
      { wrapper: wrapper(queryClient) },
    );
    await waitFor(() => expect(result.current.draft).not.toBeNull());

    act(() => {
      result.current.actions.patchDraft({ monthly_budget_cny: '80.005000000000' });
    });
    await act(async () => {
      await expect(result.current.actions.save()).rejects.toThrow('预算设置已更新');
    });

    expect(result.current.conflict).toEqual({
      current_policy: currentPolicy,
      current_version_number: 4,
      recovery_hint: 'review_current_policy_and_reapply',
    });
    expect(result.current.draft?.monthly_budget_cny).toBe('80.005000000000');
  });

  it('keeps the next family draft isolated when a previous-family save settles late', async () => {
    const queryClient = makeQueryClient();
    const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');
    let resolveSave: ((value: ModelUsagePolicy) => void) | undefined;
    const pendingSave = new Promise<ModelUsagePolicy>((resolve) => {
      resolveSave = resolve;
    });
    const familyAPolicy = policy({ monthly_budget_cny: '80.005000000000' });
    const familyBPolicy = policy({ version_number: 9, monthly_budget_cny: '120.000000000000' });
    modelUsageApi.getFamilyModelUsagePolicy
      .mockResolvedValueOnce(familyAPolicy)
      .mockResolvedValueOnce(familyBPolicy);
    modelUsageApi.updateFamilyModelUsagePolicy.mockImplementation(() => pendingSave);
    const { result, rerender } = renderHook(
      ({ familyId }) => useModelUsagePolicy({ familyId, role: 'Owner' }),
      { initialProps: { familyId: 'family-a' }, wrapper: wrapper(queryClient) },
    );
    await waitFor(() => expect(result.current.draft?.monthly_budget_cny).toBe('80.005000000000'));

    const pending = result.current.actions.save();
    rerender({ familyId: 'family-b' });
    await waitFor(() => expect(result.current.draft?.monthly_budget_cny).toBe('120.000000000000'));

    await act(async () => {
      resolveSave?.(familyAPolicy);
      await pending;
    });

    expect(result.current.draft?.monthly_budget_cny).toBe('120.000000000000');
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.modelUsageRoot('family-a') });
    expect(invalidateQueries).not.toHaveBeenCalledWith({ queryKey: queryKeys.modelUsageRoot('family-b') });
  });
});
