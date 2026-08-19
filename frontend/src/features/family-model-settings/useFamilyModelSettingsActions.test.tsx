import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { familyModelSettingsApi } from '../../api/familyModelSettingsApi';
import { invalidateAfterFamilyModelSettingsChanged } from '../../api/cacheInvalidation';
import type { FamilyModelConfigDraft, FamilyModelSettings } from '../../api/types';
import { useFamilyModelSettingsActions } from './useFamilyModelSettingsActions';

vi.mock('../../api/familyModelSettingsApi', () => ({
  familyModelSettingsApi: {
    publish: vi.fn(),
    testCapability: vi.fn(),
    saveDraft: vi.fn(),
    validateDraft: vi.fn(),
    createProviderProfile: vi.fn(),
    patchProviderProfile: vi.fn(),
    rotateProviderProfileKey: vi.fn(),
    checkProviderConnection: vi.fn(),
    savePricesDraft: vi.fn(),
    publishPrices: vi.fn(),
    previewSearchReplacement: vi.fn(),
    createSearchReplacement: vi.fn(),
    retrySearchReplacement: vi.fn(),
    cancelSearchReplacement: vi.fn(),
  },
}));

vi.mock('../../api/cacheInvalidation', () => ({
  invalidateAfterFamilyModelSettingsChanged: vi.fn(),
  invalidateAfterFamilySearchReplacementChanged: vi.fn(),
}));

const settings: FamilyModelSettings = {
  version_number: 7,
  active_config_revision_id: 'revision-1',
  active_price_version_id: 'price-1',
  active_search_profile_id: null,
  provider_profiles: [],
  updated_at: '2026-08-18T10:00:00Z',
};

const draft: FamilyModelConfigDraft = {
  base_config_revision_id: 'revision-1',
  draft_version_number: 3,
  payload: {
    base_config_revision_id: 'revision-1',
    search_profile_id: null,
    bindings: [],
    price_rates: [],
    price_draft: null,
    change_note: '配置',
  },
  validation_status: 'valid',
  validation_errors: [],
  updated_at: '2026-08-18T10:00:00Z',
};

function wrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe('useFamilyModelSettingsActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(familyModelSettingsApi.publish).mockResolvedValue({
      config_revision_id: 'revision-2',
      price_version_id: 'price-2',
      settings_version_number: 8,
      config_checksum: 'a'.repeat(64),
      price_checksum: 'b'.repeat(64),
      search_profile_id: null,
    });
  });

  it('uses current versions, confirmation checksums and a stable idempotency key for a structurally equal publish retry', async () => {
    const queryClient = new QueryClient();
    const { result } = renderHook(
      () => useFamilyModelSettingsActions({ familyId: 'family-a', settings, draft, queryClient }),
      { wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider> },
    );
    const publishInput = {
      currentPassword: 'owner-password',
      configChecksum: 'a'.repeat(64),
      priceChecksum: 'b'.repeat(64),
    };

    vi.mocked(familyModelSettingsApi.publish).mockRejectedValueOnce(new Error('network'));
    await expect(result.current.actions.publish(publishInput)).rejects.toThrow('network');
    const firstPayload = vi.mocked(familyModelSettingsApi.publish).mock.calls[0]?.[0];
    expect(firstPayload).toEqual(expect.objectContaining({
      base_settings_version_number: 7,
      base_draft_version_number: 3,
      config_checksum: 'a'.repeat(64),
      price_checksum: 'b'.repeat(64),
      current_password: 'owner-password',
      idempotency_key: expect.any(String),
    }));
    expect(invalidateAfterFamilyModelSettingsChanged).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.actions.publish({ ...publishInput });
    });
    const retryPayload = vi.mocked(familyModelSettingsApi.publish).mock.calls.at(-1)?.[0];
    expect(retryPayload?.idempotency_key).toBe(firstPayload?.idempotency_key);
    expect(invalidateAfterFamilyModelSettingsChanged).toHaveBeenCalledWith(queryClient, 'family-a');

    vi.mocked(familyModelSettingsApi.publish).mockRejectedValueOnce(new Error('network'));
    await act(async () => {
      await expect(result.current.actions.publish({
        currentPassword: 'owner-password',
        configChecksum: 'c'.repeat(64),
        priceChecksum: 'b'.repeat(64),
      })).rejects.toThrow('network');
    });
    expect(vi.mocked(familyModelSettingsApi.publish).mock.calls.at(-1)?.[0]?.idempotency_key)
      .not.toBe(firstPayload?.idempotency_key);
  });

  it('settles a successful publish while its settings refresh continues in the background', async () => {
    const queryClient = new QueryClient();
    let finishRefresh: (() => void) | undefined;
    vi.mocked(invalidateAfterFamilyModelSettingsChanged).mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishRefresh = resolve;
    }));
    const { result } = renderHook(
      () => useFamilyModelSettingsActions({ familyId: 'family-a', settings, draft, queryClient }),
      { wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider> },
    );

    const publish = result.current.actions.publish({
      currentPassword: 'owner-password',
      configChecksum: 'a'.repeat(64),
      priceChecksum: 'b'.repeat(64),
    });

    await waitFor(() => expect(invalidateAfterFamilyModelSettingsChanged).toHaveBeenCalledWith(queryClient, 'family-a'));
    await waitFor(() => expect(result.current.busyAction).toBeNull());

    finishRefresh?.();
    await act(async () => {
      await publish;
    });
  });

  it('settles a successful provider creation while its settings refresh continues in the background', async () => {
    const queryClient = new QueryClient();
    let finishRefresh: (() => void) | undefined;
    vi.mocked(familyModelSettingsApi.createProviderProfile).mockResolvedValue({ id: 'profile-created' } as never);
    vi.mocked(invalidateAfterFamilyModelSettingsChanged).mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishRefresh = resolve;
    }));
    const { result } = renderHook(
      () => useFamilyModelSettingsActions({ familyId: 'family-a', settings, draft, queryClient }),
      { wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider> },
    );

    const create = result.current.actions.createProviderProfile({
      display_name: '家庭主服务',
      adapter_kind: 'openai_compatible_http',
      auth_mode: 'api_key',
      api_base_url: 'https://provider.example/v1',
      api_key: 'write-only-key',
      idempotency_key: 'ignored-by-action',
    });

    await waitFor(() => expect(invalidateAfterFamilyModelSettingsChanged).toHaveBeenCalledWith(queryClient, 'family-a'));
    await waitFor(() => expect(result.current.busyAction).toBeNull());

    finishRefresh?.();
    await act(async () => {
      await create;
    });
  });

  it('settles a successful key rotation while its settings refresh continues in the background', async () => {
    const queryClient = new QueryClient();
    let finishRefresh: (() => void) | undefined;
    vi.mocked(familyModelSettingsApi.rotateProviderProfileKey).mockResolvedValue({
      configured: true,
      secret_version_number: 2,
      updated_at: '2026-08-19T10:00:00Z',
    });
    vi.mocked(invalidateAfterFamilyModelSettingsChanged).mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishRefresh = resolve;
    }));
    const { result } = renderHook(
      () => useFamilyModelSettingsActions({ familyId: 'family-a', settings, draft, queryClient }),
      { wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider> },
    );

    const rotate = result.current.actions.rotateProviderProfileKey('profile-a', {
      current_password: 'owner-password',
      new_api_key: 'write-only-key',
      base_settings_version_number: settings.version_number,
    });

    await waitFor(() => expect(invalidateAfterFamilyModelSettingsChanged).toHaveBeenCalledWith(queryClient, 'family-a'));
    await waitFor(() => expect(result.current.busyAction).toBeNull());

    finishRefresh?.();
    await act(async () => {
      await rotate;
    });
  });

  it('settles a successful capability test while its settings refresh continues in the background', async () => {
    const queryClient = new QueryClient();
    let finishRefresh: (() => void) | undefined;
    vi.mocked(familyModelSettingsApi.testCapability).mockResolvedValue({
      capability: 'llm',
      variant_key: 'primary',
      status: 'succeeded',
      detail: '完成',
      checked_at: '2026-08-19T10:00:00Z',
    });
    vi.mocked(invalidateAfterFamilyModelSettingsChanged).mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishRefresh = resolve;
    }));
    const { result } = renderHook(
      () => useFamilyModelSettingsActions({ familyId: 'family-a', settings, draft, queryClient }),
      { wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider> },
    );

    const testCapability = result.current.actions.testCapability('llm', 'primary', true);

    await waitFor(() => expect(invalidateAfterFamilyModelSettingsChanged).toHaveBeenCalledWith(queryClient, 'family-a'));
    await waitFor(() => expect(result.current.busyAction).toBeNull());

    finishRefresh?.();
    await act(async () => {
      await testCapability;
    });
  });

  it('requires an explicit billable confirmation before a capability test reaches the API', async () => {
    const { result } = renderHook(
      () => useFamilyModelSettingsActions({ familyId: 'family-a', settings, draft, queryClient: new QueryClient() }),
      { wrapper: wrapper() },
    );

    await expect(result.current.actions.testCapability('llm', 'primary', false)).rejects.toThrow(
      '请先确认这会产生真实模型费用。',
    );
    expect(familyModelSettingsApi.testCapability).not.toHaveBeenCalled();

    vi.mocked(familyModelSettingsApi.testCapability).mockResolvedValue({
      capability: 'llm',
      variant_key: 'primary',
      status: 'succeeded',
      detail: '完成',
      checked_at: '2026-08-18T10:00:00Z',
    });
    await act(async () => {
      await result.current.actions.testCapability('llm', 'primary', true);
    });
    expect(familyModelSettingsApi.testCapability).toHaveBeenCalledWith('llm', expect.objectContaining({
      variant_key: 'primary',
      confirm_billable: true,
      idempotency_key: expect.any(String),
    }));
  });
});
