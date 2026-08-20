import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { familyModelSettingsApi } from '../../api/familyModelSettingsApi';
import type { FamilyModelConfigDraft, FamilyModelPrices, FamilyModelSettings } from '../../api/types';
import { FamilyModelSettingsWorkspace } from './FamilyModelSettingsWorkspace';

vi.mock('../../api/familyModelSettingsApi', () => ({
  familyModelSettingsApi: {
    getSettings: vi.fn(),
    getDraft: vi.fn(),
    getPrices: vi.fn(),
    getSearchReplacement: vi.fn(),
    saveDraft: vi.fn(),
    validateDraft: vi.fn(),
    publish: vi.fn(),
    createProviderProfile: vi.fn(),
    patchProviderProfile: vi.fn(),
    rotateProviderProfileKey: vi.fn(),
    checkProviderConnection: vi.fn(),
    savePricesDraft: vi.fn(),
    publishPrices: vi.fn(),
    testCapability: vi.fn(),
    previewSearchReplacement: vi.fn(),
    createSearchReplacement: vi.fn(),
    retrySearchReplacement: vi.fn(),
    cancelSearchReplacement: vi.fn(),
  },
}));

const settings: FamilyModelSettings = {
  version_number: 1,
  active_config_revision_id: null,
  active_price_version_id: null,
  active_search_profile_id: null,
  provider_profiles: [],
  updated_at: '2026-08-19T10:00:00Z',
};

const draft: FamilyModelConfigDraft = {
  base_config_revision_id: null,
  draft_version_number: 0,
  payload: {
    base_config_revision_id: null,
    search_profile_id: null,
    bindings: [],
    price_rates: [],
    price_draft: null,
    change_note: '',
  },
  validation_status: 'unknown',
  validation_errors: [],
  updated_at: null,
};

const prices: FamilyModelPrices = {
  active_config_revision_id: null,
  active_price_version_id: null,
  current_rates: [],
  history: [],
  draft: null,
};

function wrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: PropsWithChildren) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe('FamilyModelSettingsWorkspace', () => {
  beforeEach(() => {
    vi.mocked(familyModelSettingsApi.getSettings).mockReset();
    vi.mocked(familyModelSettingsApi.getDraft).mockReset();
    vi.mocked(familyModelSettingsApi.getPrices).mockReset();
    vi.mocked(familyModelSettingsApi.getSettings).mockResolvedValue(settings);
    vi.mocked(familyModelSettingsApi.getDraft).mockResolvedValue(draft);
    vi.mocked(familyModelSettingsApi.getPrices).mockResolvedValue(prices);
  });

  it('shows the first-time Owner workspace without exposing a credential', async () => {
    render(
      <FamilyModelSettingsWorkspace familyId="family-a" role="Owner" isPhoneViewport={false} onBack={() => undefined} />,
      { wrapper: wrapper() },
    );

    await waitFor(() => expect(screen.getByText('尚未配置服务')).toBeVisible());
    expect(screen.getByRole('heading', { name: '家庭 AI 服务' })).toBeVisible();
    expect(screen.queryByText('API Key：')).not.toBeInTheDocument();
  });

  it('offers one state-derived next step and routes it to Provider setup', async () => {
    render(
      <FamilyModelSettingsWorkspace familyId="family-a" role="Owner" isPhoneViewport={false} onBack={() => undefined} />,
      { wrapper: wrapper() },
    );

    const nextStep = await screen.findByRole('button', { name: '连接第一个 AI 服务' });
    expect(screen.getByText('1. 连接服务')).toBeVisible();
    expect(screen.queryByRole('button', { name: '配置能力' })).not.toBeInTheDocument();

    fireEvent.click(nextStep);
    expect(screen.getByRole('heading', { name: 'Provider 档案' })).toBeVisible();
  });

  it('uses the same state-derived next step in the phone action bar', async () => {
    render(
      <FamilyModelSettingsWorkspace familyId="family-a" role="Owner" isPhoneViewport onBack={() => undefined} />,
      { wrapper: wrapper() },
    );

    const nextStep = await screen.findByRole('button', { name: '连接第一个 AI 服务' });
    const footer = document.querySelector('.family-model-settings-mobile-footer');
    expect(footer).not.toBeNull();
    expect(within(footer as HTMLElement).queryByRole('button', { name: '发布复核' })).not.toBeInTheDocument();
    fireEvent.click(nextStep);
    expect(screen.getByRole('heading', { name: 'Provider 档案' })).toBeVisible();
  });

  it('describes an active clean configuration without claiming draft parity', async () => {
    vi.mocked(familyModelSettingsApi.getSettings).mockResolvedValueOnce({
      ...settings,
      active_config_revision_id: 'revision-1',
      active_price_version_id: 'price-1',
    });
    render(
      <FamilyModelSettingsWorkspace familyId="family-a" role="Owner" isPhoneViewport={false} onBack={() => undefined} />,
      { wrapper: wrapper() },
    );

    expect(await screen.findByText('已有发布版本')).toBeVisible();
    expect(screen.getByText(/如需确认服务端草稿是否有变化/)).toBeVisible();
  });

  it('fails safely without mounting Owner settings queries for a Member', () => {
    render(
      <FamilyModelSettingsWorkspace familyId="family-a" role="Member" isPhoneViewport={false} onBack={() => undefined} />,
      { wrapper: wrapper() },
    );

    expect(screen.getByText('仅家庭主理人可以管理 AI 服务')).toBeVisible();
    expect(familyModelSettingsApi.getSettings).not.toHaveBeenCalled();
    expect(familyModelSettingsApi.getDraft).not.toHaveBeenCalled();
    expect(familyModelSettingsApi.getPrices).not.toHaveBeenCalled();
  });

  it('uses an independent phone task page instead of the desktop section rail', async () => {
    const { container } = render(
      <FamilyModelSettingsWorkspace familyId="family-a" role="Owner" isPhoneViewport onBack={() => undefined} />,
      { wrapper: wrapper() },
    );

    await waitFor(() => expect(screen.getByRole('main', { name: '手机家庭 AI 服务' })).toBeVisible());
    expect(container.querySelector('.family-model-settings-desktop')).toBeNull();
    expect(screen.getByRole('button', { name: 'Provider 档案' })).toBeVisible();
  });

  it('routes a browser-back event through the workspace back contract', async () => {
    const onBack = vi.fn();
    render(
      <FamilyModelSettingsWorkspace familyId="family-a" role="Owner" isPhoneViewport={false} onBack={onBack} />,
      { wrapper: wrapper() },
    );

    await waitFor(() => expect(screen.getByText('尚未配置服务')).toBeVisible());
    expect(window.history.state?.culinaWorkspaceGuard).toBe('family-model-settings:family-a');
    await act(async () => {
      window.history.back();
    });

    await waitFor(() => expect(onBack).toHaveBeenCalledTimes(1));
    expect(window.history.state?.culinaWorkspaceGuard).not.toBe('family-model-settings:family-a');
  });

  it('routes Escape through the same back contract when no overlay is open', async () => {
    const onBack = vi.fn();
    render(
      <FamilyModelSettingsWorkspace familyId="family-a" role="Owner" isPhoneViewport={false} onBack={onBack} />,
      { wrapper: wrapper() },
    );

    await waitFor(() => expect(screen.getByText('尚未配置服务')).toBeVisible());
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    await waitFor(() => expect(onBack).toHaveBeenCalledTimes(1));
    expect(window.history.state?.culinaWorkspaceGuard).not.toBe('family-model-settings:family-a');
  });

  it('starts only one history exit while repeated Escape events await popstate', async () => {
    const historyBack = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    render(
      <FamilyModelSettingsWorkspace familyId="family-a" role="Owner" isPhoneViewport={false} onBack={() => undefined} />,
      { wrapper: wrapper() },
    );

    await waitFor(() => expect(screen.getByText('尚未配置服务')).toBeVisible());
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    const historyBackCalls = historyBack.mock.calls.length;
    historyBack.mockRestore();
    expect(historyBackCalls).toBe(1);
  });

  it('shows a recoverable error when an Owner setting read fails before a safe workspace can render', async () => {
    vi.mocked(familyModelSettingsApi.getSettings).mockRejectedValueOnce(new Error('network unavailable'));
    render(
      <FamilyModelSettingsWorkspace familyId="family-a" role="Owner" isPhoneViewport={false} onBack={() => undefined} />,
      { wrapper: wrapper() },
    );

    await waitFor(() => expect(screen.getByText('暂时无法加载家庭 AI 服务')).toBeVisible());
    expect(screen.getByRole('button', { name: '重新加载' })).toBeVisible();
  });

  it('never combines a previous family local draft with the next family settings response', async () => {
    const familyADraft: FamilyModelConfigDraft = {
      ...draft,
      payload: {
        ...draft.payload,
        bindings: [{
          capability: 'llm',
          variant_key: 'primary',
          enabled: true,
          provider_profile_id: 'family-a-profile',
          requested_model: 'family-a-private-model',
          billing_scheme_key: 'llm-split-v1',
          max_output_tokens: 1024,
          supports_vision: false,
          prompt_cache_enabled: false,
        }],
      },
    };
    let resolveSettingsB: ((value: FamilyModelSettings) => void) | undefined;
    const settingsB = new Promise<FamilyModelSettings>((resolve) => {
      resolveSettingsB = resolve;
    });
    const draftB = new Promise<FamilyModelConfigDraft>(() => undefined);
    vi.mocked(familyModelSettingsApi.getSettings)
      .mockReset()
      .mockResolvedValueOnce(settings)
      .mockReturnValueOnce(settingsB);
    vi.mocked(familyModelSettingsApi.getDraft)
      .mockReset()
      .mockResolvedValueOnce(familyADraft)
      .mockReturnValueOnce(draftB);
    vi.mocked(familyModelSettingsApi.getPrices)
      .mockReset()
      .mockResolvedValue(prices);

    const rendered = render(
      <FamilyModelSettingsWorkspace familyId="family-a" role="Owner" isPhoneViewport={false} onBack={() => undefined} />,
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(screen.getByText('1')).toBeVisible());

    rendered.rerender(
      <FamilyModelSettingsWorkspace familyId="family-b" role="Owner" isPhoneViewport={false} onBack={() => undefined} />,
    );
    await act(async () => {
      resolveSettingsB?.({ ...settings, version_number: 2 });
      await settingsB;
    });

    await waitFor(() => expect(screen.getByText('正在加载家庭 AI 服务')).toBeVisible());
    expect(screen.queryByText('1')).not.toBeInTheDocument();
  });
});
