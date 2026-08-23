import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ModelUsageFamilyRequestLogPage,
  ModelUsagePersonalRequestLogPage,
} from '../../api/types';
import { useModelUsageRequestLogs } from './useModelUsageRequestLogs';

const modelUsageApi = vi.hoisted(() => ({
  getMyModelUsageRequests: vi.fn(),
  getFamilyModelUsageRequests: vi.fn(),
}));

vi.mock('../../api/client', () => ({ api: modelUsageApi }));

const familyPage: ModelUsageFamilyRequestLogPage = {
  family_id: 'family-a',
  date_from: '2026-08-01',
  date_to: '2026-08-31',
  scope: 'family',
  source: 'raw',
  items: [],
  total: 0,
  limit: 20,
  offset: 0,
};

const personalPage: ModelUsagePersonalRequestLogPage = {
  ...familyPage,
  scope: 'me',
  items: [],
};

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useModelUsageRequestLogs', () => {
  beforeEach(() => {
    modelUsageApi.getMyModelUsageRequests.mockReset();
    modelUsageApi.getFamilyModelUsageRequests.mockReset();
  });

  it('clears diagnostic filters before it enables personal request logs', async () => {
    modelUsageApi.getFamilyModelUsageRequests.mockResolvedValue(familyPage);
    modelUsageApi.getMyModelUsageRequests.mockResolvedValue(personalPage);
    const { result } = renderHook(
      () => useModelUsageRequestLogs({ familyId: 'family-a', role: 'Owner', initialPeriod: '2026-08' }),
      { wrapper: wrapper() },
    );

    await waitFor(() => expect(modelUsageApi.getFamilyModelUsageRequests).toHaveBeenCalled());
    act(() => {
      result.current.actions.patchDraftFilters({ provider: 'openai-compatible', model: 'family-model' });
      result.current.actions.applyFilters();
    });
    await waitFor(() => expect(modelUsageApi.getFamilyModelUsageRequests).toHaveBeenLastCalledWith(
      expect.objectContaining({ provider: 'openai-compatible', model: 'family-model' }),
    ));

    act(() => result.current.actions.setScope('me'));
    await waitFor(() => expect(result.current.scope).toBe('me'));
    await waitFor(() => expect(modelUsageApi.getMyModelUsageRequests).toHaveBeenCalled());
    expect(modelUsageApi.getMyModelUsageRequests).toHaveBeenLastCalledWith(expect.not.objectContaining({
      provider: expect.anything(),
      model: expect.anything(),
    }));
    expect(result.current.filters).toMatchObject({ provider: '', model: '', page: 0 });
  });
});
