import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { aiApi } from '../../api/aiApi';
import { queryKeys } from '../../api/queryKeys';
import type { AiAutoExecutionSettings } from '../../api/types';
import { useAiAutoExecutionSettings } from './useAiAutoExecutionSettings';

vi.mock('../../api/aiApi', () => ({ aiApi: { getAiAutoExecutionSettings: vi.fn(), updateAiAutoExecutionPreference: vi.fn(), updateAiAutoExecutionFamilyPolicy: vi.fn() } }));
beforeEach(() => vi.clearAllMocks());
const response = (enabled = false): AiAutoExecutionSettings => ({ catalog_version: '1', consent_notice: { version: 'n1', acknowledged: true }, member_preferences: [{ action_key: 'food.set_favorite', enabled, effective_enabled: enabled, row_version: 1, consent_notice_version: 'n1', requires_reconsent: false }], family_policies: [], limits: {}, server_now: '2026-08-24T00:00:00Z' });

describe('useAiAutoExecutionSettings', () => {
  it('keeps family query data isolated when family changes', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.mocked(aiApi.getAiAutoExecutionSettings).mockImplementation(() => Promise.resolve(response()));
    const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result, rerender } = renderHook(({ familyId }) => useAiAutoExecutionSettings(familyId), { initialProps: { familyId: 'family-a' }, wrapper });
    await waitFor(() => expect(result.current.settings).not.toBeNull());
    rerender({ familyId: 'family-b' });
    expect(result.current.settings).toBeNull();
    await waitFor(() => expect(client.getQueryData(queryKeys.aiAutoExecutionSettings('family-b'))).toBeTruthy());
    expect(client.getQueryData(queryKeys.aiAutoExecutionSettings('family-a'))).toBeTruthy();
  });

  it('does not update the cached enabled state before the server succeeds', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.mocked(aiApi.getAiAutoExecutionSettings).mockResolvedValueOnce(response()).mockResolvedValue(response(true));
    let resolve!: (value: AiAutoExecutionSettings) => void;
    vi.mocked(aiApi.updateAiAutoExecutionPreference).mockReturnValue(new Promise((done) => { resolve = done; }));
    const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useAiAutoExecutionSettings('family-a'), { wrapper });
    await waitFor(() => expect(result.current.settings).not.toBeNull());
    await act(async () => { void result.current.update('member', result.current.settings!.member_preferences[0]!, true); });
    expect(result.current.settings?.member_preferences[0]?.enabled).toBe(false);
    await act(async () => { resolve(response(true)); });
    await waitFor(() => expect(result.current.settings?.member_preferences[0]?.enabled).toBe(true));
  });

  it('allows a second setting row to save while the first row is pending', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const twoRows = { ...response(), member_preferences: [
      response().member_preferences[0]!,
      { ...response().member_preferences[0]!, action_key: 'meal_log.rate_food' as const },
    ] };
    vi.mocked(aiApi.getAiAutoExecutionSettings).mockResolvedValue(twoRows);
    vi.mocked(aiApi.updateAiAutoExecutionPreference).mockReturnValue(new Promise(() => undefined));
    const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useAiAutoExecutionSettings('family-a'), { wrapper });
    await waitFor(() => expect(result.current.settings?.member_preferences).toHaveLength(2));
    await act(async () => {
      void result.current.update('member', result.current.settings!.member_preferences[0]!, true);
      void result.current.update('member', result.current.settings!.member_preferences[1]!, true);
    });
    expect(aiApi.updateAiAutoExecutionPreference).toHaveBeenCalledTimes(2);
  });

  it('retains failures for two independently failed rows', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const twoRows = { ...response(), member_preferences: [
      response().member_preferences[0]!,
      { ...response().member_preferences[0]!, action_key: 'meal_log.rate_food' as const },
    ] };
    vi.mocked(aiApi.getAiAutoExecutionSettings).mockResolvedValue(twoRows);
    vi.mocked(aiApi.updateAiAutoExecutionPreference)
      .mockRejectedValueOnce(new Error('first failed'))
      .mockRejectedValueOnce(new Error('second failed'));
    const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useAiAutoExecutionSettings('family-a'), { wrapper });
    await waitFor(() => expect(result.current.settings?.member_preferences).toHaveLength(2));

    await act(async () => {
      void result.current.update('member', result.current.settings!.member_preferences[0]!, true);
      void result.current.update('member', result.current.settings!.member_preferences[1]!, true);
    });

    await waitFor(() => {
      expect(result.current.failureFor('member', 'food.set_favorite')?.message).toBe('设置保存失败，请重试。');
      expect(result.current.failureFor('member', 'meal_log.rate_food')?.message).toBe('设置保存失败，请重试。');
    });
  });

  it('does not let a settled A-family mutation replace B-family cached settings', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const familyA = response(false);
    const familyB = response(false);
    let resolveA!: (value: AiAutoExecutionSettings) => void;
    vi.mocked(aiApi.getAiAutoExecutionSettings)
      .mockResolvedValueOnce(familyA)
      .mockResolvedValue(familyB);
    vi.mocked(aiApi.updateAiAutoExecutionPreference).mockReturnValue(new Promise((done) => { resolveA = done; }));
    const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result, rerender } = renderHook(({ familyId }) => useAiAutoExecutionSettings(familyId), {
      initialProps: { familyId: 'family-a' },
      wrapper,
    });
    await waitFor(() => expect(result.current.settings).not.toBeNull());
    await act(async () => { void result.current.update('member', result.current.settings!.member_preferences[0]!, true); });
    rerender({ familyId: 'family-b' });
    await waitFor(() => expect(result.current.settings?.server_now).toBe(familyB.server_now));

    await act(async () => { resolveA(response(true)); });
    await waitFor(() => expect(result.current.settings?.member_preferences[0]?.enabled).toBe(false));
    expect(client.getQueryData<AiAutoExecutionSettings>(queryKeys.aiAutoExecutionSettings('family-b'))?.member_preferences[0]?.enabled).toBe(false);
  });
});
