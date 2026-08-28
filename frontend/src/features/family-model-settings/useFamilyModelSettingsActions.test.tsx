import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { familyModelSettingsApi } from '../../api/familyModelSettingsApi';
import { ApiError } from '../../api/request';
import { invalidateAfterFamilyModelSettingsChanged } from '../../api/cacheInvalidation';
import type { FamilyModelConfigDraft, FamilyModelSettings } from '../../api/types';
import { useFamilyModelSettingsActions } from './useFamilyModelSettingsActions';

vi.mock('../../api/familyModelSettingsApi', () => ({
  familyModelSettingsApi: {
    testCapability: vi.fn(),
    saveDraft: vi.fn(),
    validateDraft: vi.fn(),
    createProviderProfile: vi.fn(),
    patchProviderProfile: vi.fn(),
    rotateProviderProfileKey: vi.fn(),
    checkProviderConnection: vi.fn(),
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
  });

  it('only sends the initial search confirmation for an explicit confirmed save', async () => {
    vi.mocked(familyModelSettingsApi.saveDraft).mockResolvedValue(draft);
    const localDraft = {
      ...draft.payload,
      base_draft_version_number: draft.draft_version_number,
    };
    const { result } = renderHook(
      () => useFamilyModelSettingsActions({ familyId: 'family-a', settings, draft, queryClient: new QueryClient() }),
      { wrapper: wrapper() },
    );

    await act(async () => {
      await result.current.actions.saveDraft(localDraft);
    });
    expect(familyModelSettingsApi.saveDraft).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ confirm_initial_search_index: expect.anything() }),
    );

    await act(async () => {
      await result.current.actions.saveDraft(localDraft, { confirmInitialSearchIndex: true });
    });
    expect(familyModelSettingsApi.saveDraft).toHaveBeenLastCalledWith(
      expect.objectContaining({ confirm_initial_search_index: true }),
    );
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

  it('exposes an actionable provider address error without leaking request details', async () => {
    vi.mocked(familyModelSettingsApi.createProviderProfile).mockRejectedValue(new ApiError({
      status: 422,
      detail: '[object Object]',
      path: '/api/family/model-settings/provider-profiles',
      payload: {
        detail: {
          code: 'family_model_endpoint_insecure_transport_not_allowed',
        },
      },
    }));
    const { result } = renderHook(
      () => useFamilyModelSettingsActions({ familyId: 'family-a', settings, draft, queryClient: new QueryClient() }),
      { wrapper: wrapper() },
    );

    await act(async () => {
      await expect(result.current.actions.createProviderProfile({
        display_name: '公网明文服务',
        adapter_kind: 'openai_compatible_http',
        auth_mode: 'api_key',
        api_base_url: 'http://47.93.215.184:31317/v1',
        api_key: 'write-only-key',
        idempotency_key: 'ignored-by-action',
      })).rejects.toBeInstanceOf(ApiError);
    });

    expect(result.current.errorMessage).toBe(
      '当前部署不允许公网明文 HTTP/WS。请改用 HTTPS/WSS，或由部署管理员开启不安全传输开关。',
    );
    expect(result.current.errorMessage).not.toContain('47.93.215.184');
    expect(result.current.errorMessage).not.toContain('write-only-key');
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

    const testCapability = result.current.actions.testCapability('llm', 'primary', true, 7);

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

    await expect(result.current.actions.testCapability('llm', 'primary', false, 7)).rejects.toThrow(
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
      await result.current.actions.testCapability('llm', 'primary', true, 7);
    });
    expect(familyModelSettingsApi.testCapability).toHaveBeenCalledWith('llm', expect.objectContaining({
      variant_key: 'primary',
      confirm_billable: true,
      base_draft_version_number: 7,
      idempotency_key: expect.any(String),
    }));
  });
});
