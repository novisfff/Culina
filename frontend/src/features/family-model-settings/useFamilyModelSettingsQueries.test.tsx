import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { familyModelSettingsApi } from '../../api/familyModelSettingsApi';
import type { FamilyModelConfigDraft, FamilyModelPrices, FamilyModelSettings } from '../../api/types';
import { useFamilyModelSettingsQueries } from './useFamilyModelSettingsQueries';

vi.mock('../../api/familyModelSettingsApi', () => ({
  familyModelSettingsApi: {
    getSettings: vi.fn(),
    getDraft: vi.fn(),
    getPrices: vi.fn(),
    getSearchReplacement: vi.fn(),
    discoverProviderModels: vi.fn(),
  },
}));

const settings = (id: string): FamilyModelSettings => ({
  version_number: 1,
  active_config_revision_id: null,
  active_price_version_id: null,
  active_search_profile_id: null,
  provider_profiles: [],
  updated_at: `2026-08-18T${id === 'family-a' ? '10' : '11'}:00:00Z`,
});

const draft = (id: string): FamilyModelConfigDraft => ({
  base_config_revision_id: null,
  draft_version_number: 0,
  payload: {
    base_config_revision_id: null,
    search_profile_id: null,
    bindings: [],
    price_rates: [],
    price_draft: null,
    change_note: id,
  },
  validation_status: 'unknown',
  validation_errors: [],
  updated_at: null,
});

const prices = (): FamilyModelPrices => ({
  active_config_revision_id: null,
  active_price_version_id: null,
  current_rates: [],
  history: [],
  draft: null,
});

function wrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  return ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe('useFamilyModelSettingsQueries', () => {
  beforeEach(() => {
    vi.mocked(familyModelSettingsApi.getSettings).mockReset();
    vi.mocked(familyModelSettingsApi.getDraft).mockReset();
    vi.mocked(familyModelSettingsApi.getPrices).mockReset();
    vi.mocked(familyModelSettingsApi.getSearchReplacement).mockReset();
    vi.mocked(familyModelSettingsApi.discoverProviderModels).mockReset();
  });

  it('does not issue owner-only requests for a Member', async () => {
    const { result } = renderHook(
      () => useFamilyModelSettingsQueries({ familyId: 'family-a', role: 'Member' }),
      { wrapper: wrapper() },
    );

    await act(async () => undefined);
    expect(result.current.settings).toBeNull();
    expect(familyModelSettingsApi.getSettings).not.toHaveBeenCalled();
    expect(familyModelSettingsApi.getDraft).not.toHaveBeenCalled();
    expect(familyModelSettingsApi.getPrices).not.toHaveBeenCalled();
  });

  it('keeps safe owner data visible and marks it stale after a background refresh fails', async () => {
    vi.mocked(familyModelSettingsApi.getSettings).mockResolvedValue(settings('family-a'));
    vi.mocked(familyModelSettingsApi.getDraft).mockResolvedValue(draft('family-a'));
    vi.mocked(familyModelSettingsApi.getPrices).mockResolvedValue(prices());
    const { result } = renderHook(
      () => useFamilyModelSettingsQueries({ familyId: 'family-a', role: 'Owner' }),
      { wrapper: wrapper() },
    );

    await waitFor(() => expect(result.current.settings?.version_number).toBe(1));
    vi.mocked(familyModelSettingsApi.getSettings).mockRejectedValueOnce(new Error('temporary failure'));
    await act(async () => {
      await result.current.settingsQuery.refetch();
    });

    await waitFor(() => expect(result.current.stale).toBe(true));
    expect(result.current.settings?.version_number).toBe(1);
  });

  it('does not use one family draft as placeholder data for another family', async () => {
    let resolveSettingsB: ((value: FamilyModelSettings) => void) | undefined;
    let resolveDraftB: ((value: FamilyModelConfigDraft) => void) | undefined;
    let resolvePricesB: ((value: FamilyModelPrices) => void) | undefined;
    vi.mocked(familyModelSettingsApi.getSettings)
      .mockResolvedValueOnce(settings('family-a'))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSettingsB = resolve; }));
    vi.mocked(familyModelSettingsApi.getDraft)
      .mockResolvedValueOnce(draft('family-a'))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveDraftB = resolve; }));
    vi.mocked(familyModelSettingsApi.getPrices)
      .mockResolvedValueOnce(prices())
      .mockImplementationOnce(() => new Promise((resolve) => { resolvePricesB = resolve; }));

    const { result, rerender } = renderHook(
      ({ familyId }) => useFamilyModelSettingsQueries({ familyId, role: 'Owner' }),
      { initialProps: { familyId: 'family-a' }, wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.draft?.payload.change_note).toBe('family-a'));

    rerender({ familyId: 'family-b' });
    await waitFor(() => expect(result.current.draft).toBeNull());

    await act(async () => {
      resolveSettingsB?.(settings('family-b'));
      resolveDraftB?.(draft('family-b'));
      resolvePricesB?.(prices());
    });
    await waitFor(() => expect(result.current.draft?.payload.change_note).toBe('family-b'));
  });

  it('reuses a fresh Provider model catalog within the same family', async () => {
    vi.mocked(familyModelSettingsApi.getSettings).mockResolvedValue(settings('family-a'));
    vi.mocked(familyModelSettingsApi.getDraft).mockResolvedValue(draft('family-a'));
    vi.mocked(familyModelSettingsApi.getPrices).mockResolvedValue(prices());
    vi.mocked(familyModelSettingsApi.discoverProviderModels).mockResolvedValue({
      status: 'reachable',
      detail: null,
      checked_at: '2026-08-19T10:00:00Z',
      latency_ms: 12,
      profile_version_number: 1,
      models: ['gpt-4.1-mini'],
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => useFamilyModelSettingsQueries({ familyId: 'family-a', role: 'Owner' }),
      {
        wrapper: ({ children }: PropsWithChildren) => (
          <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        ),
      },
    );

    await act(async () => {
      await result.current.discoverProviderModels('profile-a');
      await result.current.discoverProviderModels('profile-a');
    });

    expect(familyModelSettingsApi.discoverProviderModels).toHaveBeenCalledTimes(1);
    expect(familyModelSettingsApi.discoverProviderModels).toHaveBeenCalledWith('profile-a');
  });

  it('does not reuse a Provider model catalog across families', async () => {
    vi.mocked(familyModelSettingsApi.getSettings).mockImplementation(async () => settings('family-a'));
    vi.mocked(familyModelSettingsApi.getDraft).mockImplementation(async () => draft('family-a'));
    vi.mocked(familyModelSettingsApi.getPrices).mockResolvedValue(prices());
    vi.mocked(familyModelSettingsApi.discoverProviderModels)
      .mockResolvedValueOnce({
        status: 'reachable',
        detail: null,
        checked_at: '2026-08-19T10:00:00Z',
        latency_ms: 12,
        profile_version_number: 1,
        models: ['family-a-model'],
      })
      .mockResolvedValueOnce({
        status: 'reachable',
        detail: null,
        checked_at: '2026-08-19T10:01:00Z',
        latency_ms: 14,
        profile_version_number: 1,
        models: ['family-b-model'],
      });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result, rerender } = renderHook(
      ({ familyId }) => useFamilyModelSettingsQueries({ familyId, role: 'Owner' }),
      {
        initialProps: { familyId: 'family-a' },
        wrapper: ({ children }: PropsWithChildren) => (
          <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        ),
      },
    );

    await expect(result.current.discoverProviderModels('profile-a'))
      .resolves.toEqual(expect.objectContaining({ models: ['family-a-model'] }));
    rerender({ familyId: 'family-b' });
    await expect(result.current.discoverProviderModels('profile-a'))
      .resolves.toEqual(expect.objectContaining({ models: ['family-b-model'] }));

    expect(familyModelSettingsApi.discoverProviderModels).toHaveBeenCalledTimes(2);
  });
});
