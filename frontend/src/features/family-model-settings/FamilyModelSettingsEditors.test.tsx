import { render, screen, waitFor, within } from '@testing-library/react';
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
import { createEmptyFamilyModelDraft } from './familyModelSettingsModel';
import { ProviderProfileEditor } from './ProviderProfileEditor';
import { PublishReview } from './PublishReview';
import { ModelPriceEditor } from './ModelPriceEditor';

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
    onCheck: vi.fn().mockResolvedValue({ status: 'reachable' }),
    ...overrides,
  };
}

describe('Family model settings editors', () => {
  it('PATCHes an existing Provider with display metadata only', async () => {
    const user = userEvent.setup();
    const props = providerProps();
    render(<ProviderProfileEditor {...props} />);

    await user.clear(screen.getByLabelText('显示名称'));
    await user.type(screen.getByLabelText('显示名称'), '家庭备用服务');
    await user.selectOptions(screen.getByLabelText('状态'), 'disabled');
    await user.click(screen.getByRole('button', { name: '保存档案' }));

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

    const profileList = screen.getByRole('navigation', { name: 'Provider 档案列表' });
    expect(within(profileList).getByRole('button', { name: /家庭主服务/ })).toHaveAttribute('aria-current', 'true');
    await user.click(within(profileList).getByRole('button', { name: /家庭备用服务/ }));

    expect(onSelectProfile).toHaveBeenCalledWith('profile-b');
  });

  it('sends a new API Key only in the immediate create payload and clears the controlled input', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue(profile);
    render(<ProviderProfileEditor {...providerProps({ profiles: [], selectedProfileId: null, onCreate })} />);

    await user.type(screen.getByLabelText('档案名称'), '新的服务');
    await user.type(screen.getByLabelText('API 服务地址'), 'https://new-provider.example/v1');
    await user.type(screen.getByLabelText('API Key'), 'new-api-key');
    await user.click(screen.getByRole('button', { name: '创建档案' }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({
      api_base_url: 'https://new-provider.example/v1',
      api_key: 'new-api-key',
    });
    expect(screen.getByLabelText('API Key')).toHaveValue('');
  });

  it('clears rotation credentials when the Owner cancels the rotation form', async () => {
    const user = userEvent.setup();
    render(<ProviderProfileEditor {...providerProps()} />);

    await user.click(screen.getByRole('button', { name: '轮换 Key' }));
    await user.type(screen.getByLabelText('当前密码'), 'owner-password');
    await user.type(screen.getByLabelText('新的 API Key'), 'rotate-secret');
    await user.click(screen.getByRole('button', { name: '取消' }));
    await user.click(screen.getByRole('button', { name: '轮换 Key' }));

    expect(screen.getByLabelText('当前密码')).toHaveValue('');
    expect(screen.getByLabelText('新的 API Key')).toHaveValue('');
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

    await user.click(screen.getByRole('button', { name: '新建档案' }));
    await user.type(screen.getByLabelText('档案名称'), '替换服务');
    await user.type(screen.getByLabelText('API 服务地址'), 'https://replacement.example/v1');
    await user.type(screen.getByLabelText('API Key'), 'replacement-key');
    await user.click(screen.getByRole('button', { name: '创建档案' }));

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

    await user.click(screen.getByRole('button', { name: '新建档案' }));
    await user.type(screen.getByLabelText('档案名称'), '替换服务');
    await user.type(screen.getByLabelText('API 服务地址'), 'https://replacement.example/v1');
    await user.type(screen.getByLabelText('API Key'), 'replacement-key');
    await user.click(screen.getByRole('button', { name: '创建档案' }));

    await screen.findByRole('button', { name: '重试改绑' });
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onRebindCreatedProfile).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: '重试改绑' }));

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
        onDraftChange={vi.fn()}
        onTestCapability={vi.fn().mockResolvedValue({ status: 'succeeded' })}
      />,
    );

    const heading = screen.getByRole('heading', { name: '搜索向量 · 默认' });
    const card = heading.closest('article');
    if (!card) throw new Error('Expected the Embedding editor card.');
    expect(within(card).getByText('更换这些设置需要完整重建搜索索引。')).toBeVisible();
    expect(within(card).getByRole('checkbox', { name: '已启用' })).toBeDisabled();
    expect(within(card).getByLabelText('Provider 档案')).toBeDisabled();
    expect(within(card).getByLabelText('模型名称')).toBeDisabled();
    expect(within(card).getByLabelText('向量维度')).toBeDisabled();
  });

  it('groups capabilities by task and expands one configuration at a time', async () => {
    const user = userEvent.setup();
    render(
      <CapabilityBindingEditor
        draft={createEmptyFamilyModelDraft()}
        profiles={[profile]}
        busy={false}
        onDraftChange={vi.fn()}
        onTestCapability={vi.fn().mockResolvedValue({ status: 'succeeded' })}
      />,
    );

    expect(screen.getByRole('heading', { name: '对话与生成' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '语音' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '搜索' })).toBeVisible();
    expect(screen.getAllByLabelText('模型名称')).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: /搜索向量 · 默认/ }));
    expect(screen.getAllByLabelText('模型名称')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /搜索向量 · 默认/ })).toHaveAttribute('aria-expanded', 'true');
  });

  it('groups price rules and keeps only the selected rule expanded', async () => {
    const user = userEvent.setup();
    const draft = createEmptyFamilyModelDraft();
    draft.bindings[0] = { ...draft.bindings[0], enabled: true, provider_profile_id: profile.id, requested_model: 'chat-model' };
    draft.price_rates = [
      { capability: 'llm', variant_key: 'primary', meter: 'uncached_input_tokens', unit_quantity: '1000000', unit_price: '1', source_currency: 'CNY', fx_to_cny: '1', reported_model_aliases: [] },
      { capability: 'llm', variant_key: 'primary', meter: 'cached_input_tokens', unit_quantity: '1000000', unit_price: '0.5', source_currency: 'CNY', fx_to_cny: '1', reported_model_aliases: [] },
      { capability: 'llm', variant_key: 'primary', meter: 'output_tokens', unit_quantity: '1000000', unit_price: '2', source_currency: 'CNY', fx_to_cny: '1', reported_model_aliases: [] },
    ];
    render(<ModelPriceEditor draft={draft} busy={false} onDraftChange={vi.fn()} />);

    expect(screen.getByRole('heading', { name: '对话与生成' })).toBeVisible();
    expect(screen.getAllByLabelText('单价')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: /对话与视觉理解 缓存输入 Token/ }));
    expect(screen.getAllByLabelText('单价')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /对话与视觉理解 缓存输入 Token/ })).toHaveAttribute('aria-expanded', 'true');
  });

  it('requires a current password and checksum-bound confirmation before publishing', async () => {
    const user = userEvent.setup();
    const onPublish = vi.fn().mockResolvedValue(undefined);
    const validation: FamilyModelDraftValidation = {
      valid: true,
      draft_version_number: 2,
      errors: [],
      config_checksum: 'config-checksum',
      price_checksum: 'price-checksum',
    };
    render(
      <PublishReview
        settings={settings}
        draft={createEmptyFamilyModelDraft()}
        validation={validation}
        busyAction={null}
        errorMessage={null}
        onValidate={vi.fn().mockResolvedValue(undefined)}
        onPublish={onPublish}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Provider 服务' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '能力与价格' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '搜索索引' })).toBeVisible();

    expect(screen.getByRole('button', { name: '发布配置' })).toBeDisabled();
    await user.type(screen.getByLabelText('当前密码'), 'owner-password');
    await user.click(screen.getByLabelText('我已核对能力、价格和搜索影响'));
    expect(screen.getByRole('button', { name: '发布配置' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: '发布配置' }));

    await waitFor(() => expect(onPublish).toHaveBeenCalledWith({
      currentPassword: 'owner-password',
      configChecksum: 'config-checksum',
      priceChecksum: 'price-checksum',
    }));
  });
});
