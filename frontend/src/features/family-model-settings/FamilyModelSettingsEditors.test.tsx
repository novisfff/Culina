import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type {
  FamilyModelConfigDraft,
  FamilyModelDraftValidation,
  FamilyModelEmbeddingBindingDraft,
  FamilyModelProviderProfile,
  FamilyModelSettings,
} from '../../api/types';
import { CapabilityBindingEditor } from './CapabilityBindingEditor';
import { createEmptyFamilyModelDraft, normalizeFamilyModelPriceRates } from './familyModelSettingsModel';
import { ProviderProfileEditor } from './ProviderProfileEditor';
import { ConfigurationCheck } from './ConfigurationCheck';
import { ModelPriceEditor } from './ModelPriceEditor';
import { SearchProfilePanel } from './SearchProfilePanel';

const profile: FamilyModelProviderProfile = {
  id: 'profile-a',
  display_name: '家庭主服务',
  adapter_kind: 'openai_compatible_http',
  auth_mode: 'api_key',
  api_base_url: 'https://provider.example/v1',
  websocket_base_url: null,
  options: { workspace_id: 'kitchen', region: null, project_id: null },
  status: 'active',
  archived: false,
  version_number: 4,
  profile_version_number: 7,
  credential: { configured: true, version_number: 3, updated_at: '2026-08-19T10:00:00Z' },
  created_at: '2026-08-19T10:00:00Z',
  updated_at: '2026-08-19T10:00:00Z',
};

const settings: FamilyModelSettings = {
  version_number: 8,
  active_config_revision_id: null,
  active_price_version_id: null,
  active_search_profile_id: null,
  provider_profiles: [profile],
  updated_at: '2026-08-19T10:00:00Z',
};

function providerProps(overrides: Partial<React.ComponentProps<typeof ProviderProfileEditor>> = {}) {
  return {
    profiles: [profile],
    settingsVersionNumber: settings.version_number,
    selectedProfileId: profile.id,
    busy: false,
    onSelectProfile: vi.fn(),
    onCreate: vi.fn().mockResolvedValue(profile),
    onPatch: vi.fn().mockResolvedValue(profile),
    onRotate: vi.fn().mockResolvedValue({ configured: true }),
    onCheck: vi.fn().mockResolvedValue({
      status: 'reachable',
      detail: null,
      checked_at: '2026-08-19T10:00:00Z',
      latency_ms: 18,
      profile_version_number: 7,
      models: ['gpt-4.1-mini'],
    }),
    ...overrides,
  };
}

async function chooseDropdown(user: ReturnType<typeof userEvent.setup>, label: string, option: RegExp) {
  await user.click(screen.getByRole('button', { name: label }));
  await user.click(screen.getByRole('option', { name: option }));
}

describe('Family model settings editors', () => {
  it('PATCHes an existing Provider with display metadata only', async () => {
    const user = userEvent.setup();
    const props = providerProps();
    render(<ProviderProfileEditor {...props} />);

    await user.clear(screen.getByLabelText('显示名称'));
    await user.type(screen.getByLabelText('显示名称'), '家庭备用服务');
    await chooseDropdown(user, '状态', /^停用/);
    await user.click(screen.getByRole('button', { name: '保存服务' }));

    await waitFor(() => expect(props.onPatch).toHaveBeenCalledWith('profile-a', {
      display_name: '家庭备用服务',
      status: 'disabled',
      base_profile_version_number: 7,
    }));
    expect(JSON.stringify(vi.mocked(props.onPatch).mock.calls)).not.toContain('provider.example');
    expect(JSON.stringify(vi.mocked(props.onPatch).mock.calls)).not.toContain('API Key');
  });

  it('offers a desktop profile list that selects a service before editing it', async () => {
    const user = userEvent.setup();
    const onSelectProfile = vi.fn();
    const backupProfile = { ...profile, id: 'profile-b', display_name: '家庭备用服务', status: 'disabled' as const };
    render(<ProviderProfileEditor {...providerProps({ profiles: [profile, backupProfile], onSelectProfile })} />);

    const profileList = screen.getByRole('navigation', { name: '模型服务列表' });
    expect(within(profileList).getByRole('button', { name: /家庭主服务/ })).toHaveAttribute('aria-current', 'true');
    await user.click(within(profileList).getByRole('button', { name: /家庭备用服务/ }));

    expect(onSelectProfile).toHaveBeenCalledWith('profile-b');
  });

  it('shows a selected unsaved item in the profile list while creating a service', async () => {
    const user = userEvent.setup();
    render(<ProviderProfileEditor {...providerProps()} />);

    await user.click(screen.getByRole('button', { name: '新增服务' }));

    const profileList = screen.getByRole('navigation', { name: '模型服务列表' });
    const createItem = within(profileList).getByRole('button', { name: /新增服务/ });
    expect(createItem).toHaveAttribute('aria-current', 'true');
    expect(within(createItem).getByText('未保存')).toBeVisible();
    expect(within(profileList).getByRole('button', { name: /家庭主服务/ })).not.toHaveAttribute('aria-current');
    expect(screen.getByLabelText('服务名称')).toBeVisible();
  });

  it('opens the first existing Provider instead of an unrelated create form', () => {
    render(<ProviderProfileEditor {...providerProps({ selectedProfileId: null })} />);

    expect(screen.getByLabelText('显示名称')).toHaveValue('家庭主服务');
    expect(screen.queryByLabelText('服务名称')).not.toBeInTheDocument();
    expect(screen.queryByText('服务范围')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /家庭主服务/ })).toHaveAttribute('aria-current', 'true');
  });

  it('sends a new API Key only in the immediate create payload and clears the controlled input', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue(profile);
    render(<ProviderProfileEditor {...providerProps({ profiles: [], selectedProfileId: null, onCreate })} />);

    await user.type(screen.getByLabelText('服务名称'), '新的服务');
    await user.type(screen.getByLabelText('API 地址'), 'https://new-provider.example/v1');
    await user.type(screen.getByLabelText('API 密钥'), 'new-api-key');
    await user.click(screen.getByRole('button', { name: '保存服务' }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({
      api_base_url: 'https://new-provider.example/v1',
      api_key: 'new-api-key',
    });
    expect(onCreate.mock.calls[0]?.[0].options).toEqual({});
    expect(screen.getByLabelText('API 密钥')).toHaveValue('');
  });

  it('根据连接方式只显示对应的地址类型', async () => {
    const user = userEvent.setup();
    render(<ProviderProfileEditor {...providerProps({ profiles: [], selectedProfileId: null })} />);

    expect(screen.queryByRole('heading', { name: '作用域（可选）' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('工作区（可选）')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('区域（可选）')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('项目（可选）')).not.toBeInTheDocument();
    expect(screen.getByLabelText('API 地址')).toBeVisible();
    expect(screen.queryByLabelText('实时地址')).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('API 地址'), 'https://http-provider.example/v1');
    await chooseDropdown(user, '验证方式', /^无需密钥/);

    await chooseDropdown(user, '连接方式', /^OpenAI Realtime/);

    expect(screen.queryByLabelText('API 地址')).not.toBeInTheDocument();
    expect(screen.getByLabelText('实时地址')).toHaveValue('');
    expect(screen.getByRole('button', { name: '验证方式' })).toHaveTextContent('API 密钥');
    expect(screen.getByRole('button', { name: '验证方式' })).toBeDisabled();
    expect(screen.getByLabelText('API 密钥')).toBeVisible();
  });

  it('updates an API Key without asking for the account password', async () => {
    const user = userEvent.setup();
    const props = providerProps();
    render(<ProviderProfileEditor {...props} />);

    await user.click(screen.getByRole('button', { name: '修改密钥' }));

    expect(screen.queryByLabelText('当前密码')).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('新的 API 密钥'), 'rotate-secret');
    await user.click(screen.getByRole('button', { name: '确认修改' }));

    expect(props.onRotate).toHaveBeenCalledWith(profile.id, {
      new_api_key: 'rotate-secret',
      base_settings_version_number: settings.version_number,
    });
    expect(screen.queryByLabelText('新的 API 密钥')).not.toBeInTheDocument();
  });

  it('reports a reachable Provider and the number of discovered models', async () => {
    const user = userEvent.setup();
    render(<ProviderProfileEditor {...providerProps()} />);

    await user.click(screen.getByRole('button', { name: '检查连接' }));

    expect(await screen.findByRole('status')).toHaveTextContent('服务连接正常，已读取 1 个模型。');
  });

  it('explains when a Provider does not support a free connection check', async () => {
    const user = userEvent.setup();
    render(<ProviderProfileEditor {...providerProps({
      onCheck: vi.fn().mockResolvedValue({
        status: 'not_supported',
        detail: '此服务不支持自动检查连接，请在功能设置中手动填写模型。',
        checked_at: '2026-08-19T10:00:00Z',
        latency_ms: null,
        profile_version_number: 7,
        models: [],
      }),
    })} />);

    await user.click(screen.getByRole('button', { name: '检查连接' }));

    expect(await screen.findByRole('status')).toHaveTextContent(
      '此服务不支持自动检查连接，请在功能设置中手动填写模型。',
    );
  });

  it('rebinds the old profile capabilities after creating a replacement profile', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue({ id: 'profile-new' });
    const onRebindCreatedProfile = vi.fn().mockResolvedValue(undefined);
    function Harness() {
      const [selectedProfileId, setSelectedProfileId] = useState<string | null>(profile.id);
      return (
        <ProviderProfileEditor
          {...providerProps({
            onCreate,
            onRebindCreatedProfile,
            selectedProfileId,
            onSelectProfile: setSelectedProfileId,
          })}
        />
      );
    }
    render(<Harness />);

    await user.click(screen.getByRole('button', { name: '新增服务' }));
    await user.type(screen.getByLabelText('服务名称'), '替换服务');
    await user.type(screen.getByLabelText('API 地址'), 'https://replacement.example/v1');
    await user.type(screen.getByLabelText('API 密钥'), 'replacement-key');
    await user.click(screen.getByRole('button', { name: '保存服务' }));

    await waitFor(() => expect(onRebindCreatedProfile).toHaveBeenCalledWith('profile-a', 'profile-new'));
  });

  it('retries only the failed rebind after the replacement profile already exists', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue({ id: 'profile-new' });
    const onRebindCreatedProfile = vi.fn()
      .mockRejectedValueOnce(new Error('draft conflict'))
      .mockResolvedValueOnce(undefined);
    function Harness() {
      const [selectedProfileId, setSelectedProfileId] = useState<string | null>(profile.id);
      return (
        <ProviderProfileEditor
          {...providerProps({
            onCreate,
            onRebindCreatedProfile,
            selectedProfileId,
            onSelectProfile: setSelectedProfileId,
          })}
        />
      );
    }
    render(<Harness />);

    await user.click(screen.getByRole('button', { name: '新增服务' }));
    await user.type(screen.getByLabelText('服务名称'), '替换服务');
    await user.type(screen.getByLabelText('API 地址'), 'https://replacement.example/v1');
    await user.type(screen.getByLabelText('API 密钥'), 'replacement-key');
    await user.click(screen.getByRole('button', { name: '保存服务' }));

    await screen.findByRole('button', { name: '重试关联' });
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onRebindCreatedProfile).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: '重试关联' }));

    await waitFor(() => expect(onRebindCreatedProfile).toHaveBeenCalledTimes(2));
    expect(onRebindCreatedProfile).toHaveBeenNthCalledWith(
      2,
      'profile-a',
      'profile-new',
      { refreshServerDraft: true },
    );
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('locks the active Embedding identity in the normal capability editor', () => {
    const base = createEmptyFamilyModelDraft();
    const embedding = base.bindings.find(
      (binding): binding is FamilyModelEmbeddingBindingDraft =>
        binding.capability === 'embedding' && binding.variant_key === 'search',
    );
    if (!embedding) throw new Error('Expected empty draft to contain the search Embedding binding.');
    const activeEmbedding: FamilyModelEmbeddingBindingDraft = {
      ...embedding,
      enabled: true,
      provider_profile_id: profile.id,
      requested_model: 'text-embedding-3-small',
      dimensions: 1536,
    };
    const draft = {
      ...base,
      search_profile_id: 'search-profile-a',
      active_embedding_binding: activeEmbedding,
      bindings: base.bindings.map((binding) => (
        binding.capability === 'embedding' && binding.variant_key === 'search' ? activeEmbedding : binding
      )),
    };

    render(
      <CapabilityBindingEditor
        draft={draft}
        profiles={[profile]}
        busy={false}
        scope="search"
        embedded
        onDraftChange={vi.fn()}
        onDiscoverModels={vi.fn().mockResolvedValue({ status: 'not_supported', models: [] })}
        onTestCapability={vi.fn().mockResolvedValue({ status: 'succeeded' })}
      />,
    );

    const heading = screen.getByRole('heading', { name: '智能搜索 · 默认' });
    const card = heading.closest('article');
    if (!card) throw new Error('Expected the Embedding editor card.');
    expect(within(card).getByText('搜索设置已生效。更换模型服务、模型或维度时，需要重新生成搜索数据。')).toBeVisible();
    expect(within(card).getByRole('checkbox', { name: '已启用' })).toBeDisabled();
    expect(within(card).getByRole('button', { name: '模型服务' })).toBeDisabled();
    expect(within(card).getByLabelText('模型名称')).toBeDisabled();
    expect(within(card).getByLabelText('模型维度')).toBeDisabled();
  });

  it('groups capabilities by task and expands one configuration at a time', async () => {
    const user = userEvent.setup();
    render(
      <CapabilityBindingEditor
        draft={createEmptyFamilyModelDraft()}
        profiles={[profile]}
        busy={false}
        onDraftChange={vi.fn()}
        onDiscoverModels={vi.fn().mockResolvedValue({ status: 'not_supported', models: [] })}
        onTestCapability={vi.fn().mockResolvedValue({ status: 'succeeded' })}
      />,
    );

    expect(screen.getByRole('heading', { name: '对话与生成' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '语音' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: '搜索' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '智能搜索 · 默认' })).not.toBeInTheDocument();
    expect(screen.getAllByLabelText('模型名称')).toHaveLength(1);
  });

  it('moves Embedding and rerank configuration into the search index surface', () => {
    const draft = createEmptyFamilyModelDraft();
    render(
      <SearchProfilePanel
        settings={settings}
        draft={draft}
        busyAction={null}
        searchReplacement={null}
        replacementProfileId={null}
        actions={{} as React.ComponentProps<typeof SearchProfilePanel>['actions']}
        onReplacementProfileIdChange={vi.fn()}
        onDraftChange={vi.fn()}
        onConfirmInitialSearchIndex={vi.fn().mockResolvedValue(undefined)}
        onDiscoverModels={vi.fn().mockResolvedValue({ status: 'not_supported', models: [] })}
        onTestCapability={vi.fn().mockResolvedValue({ status: 'succeeded' })}
      />,
    );

    expect(screen.getByRole('heading', { name: '智能搜索' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '智能搜索 · 默认' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '搜索排序 · 默认' })).toBeVisible();
  });

  it('shows the unconfigured state when the API omits a null active search profile', () => {
    const draft = createEmptyFamilyModelDraft();
    const { active_search_profile_id: _omitted, ...settingsWithoutActiveSearchProfile } = settings;
    render(
      <SearchProfilePanel
        settings={settingsWithoutActiveSearchProfile}
        draft={draft}
        busyAction={null}
        searchReplacement={null}
        replacementProfileId={null}
        actions={{} as React.ComponentProps<typeof SearchProfilePanel>['actions']}
        onReplacementProfileIdChange={vi.fn()}
        onDraftChange={vi.fn()}
        onConfirmInitialSearchIndex={vi.fn().mockResolvedValue(undefined)}
        onDiscoverModels={vi.fn().mockResolvedValue({ status: 'not_supported', models: [] })}
        onTestCapability={vi.fn().mockResolvedValue({ status: 'succeeded' })}
      />,
    );

    expect(screen.getByText('未配置智能搜索')).toBeVisible();
  });

  it('confirms the first vector identity before saving it', async () => {
    const user = userEvent.setup();
    const draft = createEmptyFamilyModelDraft();
    const onConfirmInitialSearchIndex = vi.fn().mockResolvedValue(undefined);
    render(
      <SearchProfilePanel
        settings={settings}
        draft={draft}
        busyAction={null}
        searchReplacement={null}
        replacementProfileId={null}
        actions={{} as React.ComponentProps<typeof SearchProfilePanel>['actions']}
        onReplacementProfileIdChange={vi.fn()}
        onDraftChange={vi.fn()}
        onConfirmInitialSearchIndex={onConfirmInitialSearchIndex}
        onDiscoverModels={vi.fn().mockResolvedValue({ status: 'not_supported', models: [] })}
        onTestCapability={vi.fn().mockResolvedValue({ status: 'succeeded' })}
      />,
    );

    await user.click(screen.getByRole('button', { name: /智能搜索 · 默认/ }));
    const embeddingCard = screen.getByRole('heading', { name: '智能搜索 · 默认' }).closest('article');
    if (!embeddingCard) throw new Error('Expected the Embedding editor card.');
    await user.click(within(embeddingCard).getByRole('checkbox', { name: '未启用' }));
    await chooseDropdown(user, '模型服务', /家庭主服务/);
    await user.type(screen.getByLabelText('模型名称'), 'text-embedding-3-small');
    await user.click(screen.getByRole('button', { name: '确认搜索模型' }));

    expect(screen.getByRole('dialog', { name: '确认开启智能搜索' })).toBeVisible();
    expect(screen.getByText(/后续更换模型服务、搜索模型或维度时，需要重新生成搜索数据/)).toBeVisible();
    expect(onConfirmInitialSearchIndex).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '确认并开启搜索' }));
    await waitFor(() => expect(onConfirmInitialSearchIndex).toHaveBeenCalledTimes(1));
  });

  it('treats changing an active vector identity as a high-risk rebuild', async () => {
    const user = userEvent.setup();
    const base = createEmptyFamilyModelDraft();
    const embedding = base.bindings.find(
      (binding): binding is FamilyModelEmbeddingBindingDraft => binding.capability === 'embedding',
    );
    if (!embedding) throw new Error('Expected the Embedding binding.');
    const activeEmbedding = {
      ...embedding,
      enabled: true,
      provider_profile_id: profile.id,
      requested_model: 'text-embedding-3-small',
    };
    const activeDraft = {
      ...base,
      search_profile_id: 'search-profile-a',
      active_embedding_binding: activeEmbedding,
      bindings: base.bindings.map((binding) => binding.capability === 'embedding' ? activeEmbedding : binding),
    };

    render(
      <SearchProfilePanel
        settings={{ ...settings, active_search_profile_id: 'search-profile-a' }}
        draft={activeDraft}
        busyAction={null}
        searchReplacement={null}
        replacementProfileId={null}
        actions={{} as React.ComponentProps<typeof SearchProfilePanel>['actions']}
        onReplacementProfileIdChange={vi.fn()}
        onDraftChange={vi.fn()}
        onConfirmInitialSearchIndex={vi.fn().mockResolvedValue(undefined)}
        onDiscoverModels={vi.fn().mockResolvedValue({ status: 'not_supported', models: [] })}
        onTestCapability={vi.fn().mockResolvedValue({ status: 'succeeded' })}
      />,
    );

    expect(screen.getByText('需要谨慎确认')).toBeVisible();
    expect(screen.getByText(/更换模型服务、搜索模型或维度时，需要重新生成搜索数据/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: '更换搜索模型' }));
    expect(screen.getByLabelText('新的搜索模型')).toBeVisible();
    expect(screen.getByRole('button', { name: '查看更新范围' })).toBeDisabled();
  });

  it('shows a restored rebuild failure and lets the Owner retry it', async () => {
    const user = userEvent.setup();
    const draft = createEmptyFamilyModelDraft();
    draft.search_profile_id = 'search-profile-active';
    const retrySearchReplacement = vi.fn().mockResolvedValue(undefined);
    render(
      <SearchProfilePanel
        settings={{ ...settings, active_search_profile_id: 'search-profile-active' }}
        draft={draft}
        busyAction={null}
        searchReplacement={{
          profile_id: 'search-profile-failed',
          status: 'failed',
          total_documents: 276,
          indexed_documents: 0,
          failed_documents: 4,
          budget_blocked_documents: 0,
          retryable: true,
          created_at: '2026-08-19T10:00:00Z',
          activated_at: null,
          failure: {
            code: 'search_embedding_provider_rejected',
            detail: '嵌入服务拒绝了请求（HTTP 400），现有索引未被替换。',
            provider_http_status: 400,
            provider_error_code: 'invalid_dimensions',
            provider_error_message: 'dimensions unsupported',
            request_sent: true,
            execution_certainty: 'confirmed_not_executed',
          },
        }}
        replacementProfileId="search-profile-failed"
        actions={{
          retrySearchReplacement,
          cancelSearchReplacement: vi.fn().mockResolvedValue(undefined),
        } as unknown as React.ComponentProps<typeof SearchProfilePanel>['actions']}
        onReplacementProfileIdChange={vi.fn()}
        onDraftChange={vi.fn()}
        onConfirmInitialSearchIndex={vi.fn().mockResolvedValue(undefined)}
        onDiscoverModels={vi.fn().mockResolvedValue({ status: 'not_supported', models: [] })}
        onTestCapability={vi.fn().mockResolvedValue({ status: 'succeeded' })}
      />,
    );

    expect(screen.getByText('智能搜索准备失败')).toBeVisible();
    expect(screen.getByText('失败 4 项')).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('嵌入服务拒绝了请求（HTTP 400）');
    expect(screen.getByRole('alert')).toHaveTextContent('Provider HTTP 400');
    expect(screen.getByRole('alert')).toHaveTextContent('错误码：invalid_dimensions');
    expect(screen.getByRole('alert')).toHaveTextContent('dimensions unsupported');

    await user.click(screen.getByRole('button', { name: '重试更新' }));
    expect(retrySearchReplacement).toHaveBeenCalledWith('search-profile-failed', {
      base_settings_version_number: settings.version_number,
    });
  });

  it('lets the Owner abandon a failed first search setup and return to editing', async () => {
    const user = userEvent.setup();
    const draft = createEmptyFamilyModelDraft();
    draft.search_profile_id = 'search-profile-initial-failed';
    const cancelSearchReplacement = vi.fn().mockResolvedValue(undefined);
    const onReplacementProfileIdChange = vi.fn();
    render(
      <SearchProfilePanel
        settings={{ ...settings, active_search_profile_id: null }}
        draft={draft}
        busyAction={null}
        searchReplacement={{
          profile_id: 'search-profile-initial-failed',
          status: 'failed',
          total_documents: 12,
          indexed_documents: 0,
          failed_documents: 1,
          budget_blocked_documents: 0,
          retryable: true,
          created_at: '2026-08-19T10:00:00Z',
          activated_at: null,
          failure: {
            code: 'search_embedding_provider_rejected',
            detail: '模型名称无效，首次搜索配置未启用。',
            provider_http_status: null,
            provider_error_code: null,
            provider_error_message: null,
            request_sent: true,
            execution_certainty: 'confirmed_not_executed',
          },
        }}
        replacementProfileId="search-profile-initial-failed"
        actions={{
          retrySearchReplacement: vi.fn().mockResolvedValue(undefined),
          cancelSearchReplacement,
        } as unknown as React.ComponentProps<typeof SearchProfilePanel>['actions']}
        onReplacementProfileIdChange={onReplacementProfileIdChange}
        onDraftChange={vi.fn()}
        onConfirmInitialSearchIndex={vi.fn().mockResolvedValue(undefined)}
        onDiscoverModels={vi.fn().mockResolvedValue({ status: 'not_supported', models: [] })}
        onTestCapability={vi.fn().mockResolvedValue({ status: 'succeeded' })}
      />,
    );

    await user.click(screen.getByRole('button', { name: '放弃并重新配置' }));

    expect(cancelSearchReplacement).toHaveBeenCalledWith('search-profile-initial-failed', {
      base_settings_version_number: settings.version_number,
    });
    expect(onReplacementProfileIdChange).toHaveBeenCalledWith(null);
  });

  it('hides a cancelled replacement progress card while keeping the active index summary', () => {
    const draft = createEmptyFamilyModelDraft();
    draft.search_profile_id = 'profile-a';
    render(
      <SearchProfilePanel
        settings={{ ...settings, active_search_profile_id: 'profile-a' }}
        draft={draft}
        busyAction={null}
        searchReplacement={{
          profile_id: 'search-profile-cancelled',
          status: 'cancelled',
          total_documents: 42,
          indexed_documents: 24,
          failed_documents: 0,
          budget_blocked_documents: 0,
          retryable: false,
          created_at: '2026-08-19T10:00:00Z',
          activated_at: null,
        }}
        replacementProfileId="search-profile-cancelled"
        actions={{} as React.ComponentProps<typeof SearchProfilePanel>['actions']}
        onReplacementProfileIdChange={vi.fn()}
        onDraftChange={vi.fn()}
        onConfirmInitialSearchIndex={vi.fn().mockResolvedValue(undefined)}
        onDiscoverModels={vi.fn().mockResolvedValue({ status: 'not_supported', models: [] })}
        onTestCapability={vi.fn().mockResolvedValue({ status: 'succeeded' })}
      />,
    );

    expect(screen.getByText('当前智能搜索已启用')).toBeVisible();
    expect(screen.queryByRole('heading', { name: '智能搜索更新进度' })).not.toBeInTheDocument();
  });

  it('keeps capability test progress and success feedback inside the button', async () => {
    const user = userEvent.setup();
    const draft = createEmptyFamilyModelDraft();
    draft.bindings[0] = {
      ...draft.bindings[0],
      enabled: true,
      provider_profile_id: profile.id,
      requested_model: 'capability-test-model',
    };
    let resolveTest: ((value: { status: 'succeeded' }) => void) | undefined;
    const onTestCapability = vi.fn(() => new Promise<{ status: 'succeeded' }>((resolve) => {
      resolveTest = resolve;
    }));

    render(
      <CapabilityBindingEditor
        draft={draft}
        profiles={[profile]}
        busy={false}
        onDraftChange={vi.fn()}
        onDiscoverModels={vi.fn().mockResolvedValue({ status: 'not_supported', models: [] })}
        onTestCapability={onTestCapability}
      />,
    );

    await user.click(screen.getByRole('button', { name: '测试功能' }));

    expect(onTestCapability).toHaveBeenCalledWith('llm', 'primary', true);
    const runningButton = screen.getByRole('button', { name: '正在测试' });
    expect(runningButton).toBeDisabled();
    expect(runningButton.querySelector('.family-model-settings-test-spinner')).not.toBeNull();
    expect(screen.queryByRole('status', { name: '能力测试状态' })).not.toBeInTheDocument();

    await act(async () => { resolveTest?.({ status: 'succeeded' }); });
    expect(await screen.findByRole('button', { name: '测试成功' })).toBeEnabled();
  });

  it('offers one test button once the current capability fields are complete', () => {
    const draft = createEmptyFamilyModelDraft();
    draft.bindings[0] = {
      ...draft.bindings[0],
      enabled: true,
      provider_profile_id: profile.id,
      requested_model: 'draft-only-model',
    };

    render(
      <CapabilityBindingEditor
        draft={draft}
        profiles={[profile]}
        busy={false}
        onDraftChange={vi.fn()}
        onDiscoverModels={vi.fn().mockResolvedValue({ status: 'not_supported', models: [] })}
        onTestCapability={vi.fn().mockResolvedValue({ status: 'succeeded' })}
      />,
    );

    expect(screen.queryByLabelText('我确认本次测试可能产生费用')).not.toBeInTheDocument();
    expect(screen.queryByRole('status', { name: '能力测试可用性' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '测试功能' })).toBeEnabled();
  });

  it('keeps draft testing unavailable until Provider and model are complete', () => {
    const draft = createEmptyFamilyModelDraft();
    draft.bindings[0] = { ...draft.bindings[0], enabled: true };

    render(
      <CapabilityBindingEditor
        draft={draft}
        profiles={[profile]}
        busy={false}
        onDraftChange={vi.fn()}
        onDiscoverModels={vi.fn().mockResolvedValue({ status: 'not_supported', models: [] })}
        onTestCapability={vi.fn().mockResolvedValue({ status: 'succeeded' })}
      />,
    );

    expect(screen.queryByLabelText('我确认本次测试可能产生费用')).not.toBeInTheDocument();
    expect(screen.queryByRole('status', { name: '能力测试可用性' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '测试功能' })).toBeDisabled();
  });

  it('shows a safe error inside the capability card when the request fails', async () => {
    const user = userEvent.setup();
    const draft = createEmptyFamilyModelDraft();
    draft.bindings[0] = {
      ...draft.bindings[0],
      enabled: true,
      provider_profile_id: profile.id,
      requested_model: 'capability-test-model',
    };

    render(
      <CapabilityBindingEditor
        draft={draft}
        profiles={[profile]}
        busy={false}
        onDraftChange={vi.fn()}
        onDiscoverModels={vi.fn().mockResolvedValue({ status: 'not_supported', models: [] })}
        onTestCapability={vi.fn().mockRejectedValue({
          payload: { detail: { code: 'family_model_endpoint_dns_resolution_failed' } },
        })}
      />,
    );

    await user.click(screen.getByRole('button', { name: '测试功能' }));

    const retryButton = await screen.findByRole('button', { name: '测试失败，重试' });
    expect(retryButton).toBeEnabled();
    expect(retryButton).toHaveAttribute(
      'title',
      '无法解析服务地址的域名。请检查域名拼写或 DNS 配置。',
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('automatically discovers selectable models from the selected Provider', async () => {
    const user = userEvent.setup();
    const draft = createEmptyFamilyModelDraft();
    draft.bindings[0] = { ...draft.bindings[0], provider_profile_id: profile.id };
    const onDraftChange = vi.fn();
    const onDiscoverModels = vi.fn().mockResolvedValue({
      status: 'reachable',
      models: ['gpt-4.1', 'gpt-4.1-mini'],
    });

    render(
      <CapabilityBindingEditor
        draft={draft}
        profiles={[profile]}
        busy={false}
        onDraftChange={onDraftChange}
        onDiscoverModels={onDiscoverModels}
        onTestCapability={vi.fn().mockResolvedValue({ status: 'succeeded' })}
      />,
    );

    await waitFor(() => expect(onDiscoverModels).toHaveBeenCalledWith(profile.id));
    expect(await screen.findByText('已自动读取 2 个模型，也可以直接输入其他模型名称。')).toBeVisible();

    const modelField = screen.getByRole('combobox', { name: '模型名称' });
    await user.click(modelField);
    await user.click(screen.getByRole('option', { name: 'gpt-4.1-mini' }));

    expect(onDraftChange).toHaveBeenCalledWith(expect.objectContaining({
      bindings: expect.arrayContaining([
        expect.objectContaining({
          capability: 'llm',
          variant_key: 'primary',
          requested_model: 'gpt-4.1-mini',
        }),
      ]),
    }));
  });

  it('selects a Provider through the shared dropdown component', async () => {
    const user = userEvent.setup();
    const onDraftChange = vi.fn();
    render(
      <CapabilityBindingEditor
        draft={createEmptyFamilyModelDraft()}
        profiles={[profile]}
        busy={false}
        onDraftChange={onDraftChange}
        onDiscoverModels={vi.fn().mockResolvedValue({ status: 'not_supported', models: [] })}
        onTestCapability={vi.fn().mockResolvedValue({ status: 'succeeded' })}
      />,
    );

    await chooseDropdown(user, '模型服务', /家庭主服务/);

    expect(onDraftChange).toHaveBeenCalledWith(expect.objectContaining({
      bindings: expect.arrayContaining([
        expect.objectContaining({ capability: 'llm', provider_profile_id: profile.id }),
      ]),
    }));
  });

  it('uses shared dropdowns for image size and response format', async () => {
    const user = userEvent.setup();
    const onDraftChange = vi.fn();
    render(
      <CapabilityBindingEditor
        draft={createEmptyFamilyModelDraft()}
        profiles={[profile]}
        busy={false}
        onDraftChange={onDraftChange}
        onDiscoverModels={vi.fn().mockResolvedValue({ status: 'not_supported', models: [] })}
        onTestCapability={vi.fn().mockResolvedValue({ status: 'succeeded' })}
      />,
    );

    await user.click(screen.getByRole('button', { name: /图片生成 · 文字生成/ }));
    await chooseDropdown(user, '图片尺寸', /^1024 × 1536/);
    await chooseDropdown(user, '返回格式', /^图片链接/);

    expect(onDraftChange).toHaveBeenCalledWith(expect.objectContaining({
      bindings: expect.arrayContaining([
        expect.objectContaining({ capability: 'image_generation', image_size: '1024x1536' }),
      ]),
    }));
    expect(onDraftChange).toHaveBeenCalledWith(expect.objectContaining({
      bindings: expect.arrayContaining([
        expect.objectContaining({ capability: 'image_generation', response_format: 'url' }),
      ]),
    }));
  });

  it('keeps manual model input available when discovery returns no models', async () => {
    const user = userEvent.setup();
    const draft = createEmptyFamilyModelDraft();
    draft.bindings[0] = { ...draft.bindings[0], provider_profile_id: profile.id };
    const onDraftChange = vi.fn();

    render(
      <CapabilityBindingEditor
        draft={draft}
        profiles={[profile]}
        busy={false}
        onDraftChange={onDraftChange}
        onDiscoverModels={vi.fn().mockResolvedValue({ status: 'not_supported', models: [] })}
        onTestCapability={vi.fn().mockResolvedValue({ status: 'succeeded' })}
      />,
    );

    const modelField = screen.getByRole('combobox', { name: '模型名称' });
    await user.type(modelField, 'custom-chat-model');

    expect(onDraftChange).toHaveBeenLastCalledWith(expect.objectContaining({
      bindings: expect.arrayContaining([
        expect.objectContaining({ requested_model: 'custom-chat-model' }),
      ]),
    }));
    expect(await screen.findByText('此服务不支持自动读取模型列表，请手动输入模型名称。')).toBeVisible();
  });

  it('groups one model billing items into one expanded price card', () => {
    const draft = createEmptyFamilyModelDraft();
    draft.bindings[0] = { ...draft.bindings[0], enabled: true, provider_profile_id: profile.id, requested_model: 'chat-model' };
    draft.price_rates = [
      { capability: 'llm', variant_key: 'primary', meter: 'uncached_input_tokens', unit_quantity: '1000000', unit_price: '1', source_currency: 'CNY', fx_to_cny: '1', reported_model_aliases: [] },
      { capability: 'llm', variant_key: 'primary', meter: 'cached_input_tokens', unit_quantity: '1000000', unit_price: '0.5', source_currency: 'CNY', fx_to_cny: '1', reported_model_aliases: [] },
      { capability: 'llm', variant_key: 'primary', meter: 'output_tokens', unit_quantity: '1000000', unit_price: '2', source_currency: 'CNY', fx_to_cny: '1', reported_model_aliases: [] },
    ];
    render(<ModelPriceEditor draft={draft} busy={false} onDraftChange={vi.fn()} />);

    expect(screen.getByRole('heading', { name: '对话与生成' })).toBeVisible();
    expect(screen.getByRole('button', { name: /对话与图片理解.*chat-model.*3 个计费项/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('未缓存输入 Token 单价')).toHaveValue('1');
    expect(screen.getByLabelText('缓存输入 Token 单价')).toHaveValue('0.5');
    expect(screen.getByLabelText('输出 Token 单价')).toHaveValue('2');
    expect(screen.getAllByText('CNY / 100 万 Token')).toHaveLength(3);
    expect(screen.queryByText('计价数量')).not.toBeInTheDocument();
  });

  it('keeps only one model price card expanded while preserving validation markers', async () => {
    const user = userEvent.setup();
    const draft = createEmptyFamilyModelDraft();
    draft.bindings[0] = { ...draft.bindings[0], enabled: true, provider_profile_id: profile.id, requested_model: 'chat-model' };
    draft.bindings[2] = { ...draft.bindings[2], enabled: true, provider_profile_id: profile.id, requested_model: 'image-model' };
    draft.price_rates = [
      { capability: 'llm', variant_key: 'primary', meter: 'uncached_input_tokens', unit_quantity: '1000000', unit_price: '1', source_currency: 'CNY', fx_to_cny: '1', reported_model_aliases: [] },
      { capability: 'llm', variant_key: 'primary', meter: 'cached_input_tokens', unit_quantity: '1000000', unit_price: '0.5', source_currency: 'C', fx_to_cny: '1', reported_model_aliases: [] },
      { capability: 'llm', variant_key: 'primary', meter: 'output_tokens', unit_quantity: '1000000', unit_price: '2', source_currency: 'CNY', fx_to_cny: '1', reported_model_aliases: [] },
      { capability: 'image_generation', variant_key: 'text', meter: 'generated_images', unit_quantity: '1', unit_price: '0.2', source_currency: 'CNY', fx_to_cny: '1', reported_model_aliases: [] },
    ];
    render(<ModelPriceEditor draft={draft} busy={false} onDraftChange={vi.fn()} />);

    const llmTrigger = screen.getByRole('button', { name: /对话与图片理解.*chat-model/ });
    const llmCard = llmTrigger.closest('article');
    if (!llmCard) throw new Error('Expected the invalid model price card.');
    expect(within(llmCard).getByText('待修正')).toBeVisible();

    const imageTrigger = screen.getByRole('button', { name: /图片生成.*image-model/ });
    await user.click(imageTrigger);
    expect(imageTrigger).toHaveAttribute('aria-expanded', 'true');
    expect(llmTrigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByLabelText('生成图片 单价')).toHaveValue('0.2');
    expect(screen.queryByLabelText('未缓存输入 Token 单价')).not.toBeInTheDocument();
  });

  it('shows automatic zero prices without exposing quantity inputs or completion actions', () => {
    function Harness() {
      const [draft, setDraft] = useState(() => {
        const empty = createEmptyFamilyModelDraft();
        empty.bindings[0] = { ...empty.bindings[0], enabled: true, provider_profile_id: profile.id, requested_model: 'chat-model' };
        empty.price_rates = normalizeFamilyModelPriceRates(empty.bindings, []);
        return empty;
      });
      return <ModelPriceEditor draft={draft} busy={false} onDraftChange={setDraft} />;
    }
    render(<Harness />);

    expect(screen.getByRole('button', { name: /对话与图片理解.*3 个计费项/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('未缓存输入 Token 单价')).toHaveValue('0');
    expect(screen.getByLabelText('缓存输入 Token 单价')).toHaveValue('0');
    expect(screen.getByLabelText('输出 Token 单价')).toHaveValue('0');
    expect(screen.queryByText('计价数量')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /补齐计费项|计费项已完整/ })).not.toBeInTheDocument();
  });

  it('summarizes readiness first and shows price coverage beside each model', () => {
    const draft = createEmptyFamilyModelDraft();
    draft.bindings[0] = {
      ...draft.bindings[0],
      enabled: true,
      provider_profile_id: profile.id,
      requested_model: 'chat-model',
    };
    draft.bindings[2] = {
      ...draft.bindings[2],
      enabled: true,
      provider_profile_id: profile.id,
      requested_model: 'image-model',
    };
    draft.price_rates = normalizeFamilyModelPriceRates(draft.bindings, []).map((rate) => (
      rate.capability === 'llm' ? { ...rate, unit_price: '1' } : rate
    ));
    const validation: FamilyModelDraftValidation = {
      valid: true,
      draft_version_number: 2,
      errors: [],
      config_checksum: 'config-checksum',
      price_checksum: 'price-checksum',
    };
    render(
      <ConfigurationCheck
        settings={settings}
        serverDraft={{
          base_config_revision_id: null,
          draft_version_number: 2,
          payload: draft,
          validation_status: 'valid',
          validation_errors: [],
          updated_at: '2026-08-19T10:00:00Z',
        }}
        draft={draft}
        validation={validation}
        busyAction={null}
        errorMessage={null}
        onValidate={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByRole('heading', { name: '模型服务' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '功能与价格' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '智能搜索' })).toBeVisible();

    expect(screen.getByRole('heading', { name: '配置检查' })).toBeVisible();
    expect(screen.getByText(/检查结果只用于提醒/)).toBeVisible();
    expect(screen.getByRole('heading', { name: '配置状态良好' })).toBeVisible();
    expect(screen.getByText('2 项功能已就绪')).toBeVisible();

    const llmRow = screen.getByRole('article', { name: '对话与图片理解 primary' });
    expect(within(llmRow).getByText('家庭主服务 · chat-model')).toBeVisible();
    expect(within(llmRow).getByText('价格已填写')).toBeVisible();
    expect(within(llmRow).getByText('3/3 项')).toBeVisible();

    const imageRow = screen.getByRole('article', { name: '图片生成 text' });
    expect(within(imageRow).getByText('按 0 元计入费用')).toBeVisible();
    expect(within(imageRow).getByText('0/1 项')).toBeVisible();
    expect(screen.queryByText('价格设置可用')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('当前密码')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('我已核对能力、价格和搜索影响')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '发布配置' })).not.toBeInTheDocument();
  });

  it('places authoritative validation reminders in the top status summary', () => {
    const draft = createEmptyFamilyModelDraft();
    const validation: FamilyModelDraftValidation = {
      valid: false,
      draft_version_number: 3,
      errors: [
        { code: 'family_model_provider_required', field: 'bindings.0' },
        { code: 'family_model_requested_model_required', field: 'bindings.0' },
      ],
      config_checksum: null,
      price_checksum: null,
    };

    render(
      <ConfigurationCheck
        settings={settings}
        serverDraft={{
          base_config_revision_id: null,
          draft_version_number: 3,
          payload: draft,
          validation_status: 'invalid',
          validation_errors: validation.errors,
          updated_at: '2026-08-19T10:00:00Z',
        }}
        draft={draft}
        validation={validation}
        busyAction={null}
        errorMessage={null}
        onValidate={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByRole('heading', { name: '还有 2 项需要完善' })).toBeVisible();
    expect(screen.getByText('检查只做提醒，当前可用配置不会被覆盖。')).toBeVisible();
  });
});
