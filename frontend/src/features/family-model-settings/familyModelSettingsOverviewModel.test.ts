import { describe, expect, it } from 'vitest';
import type { FamilyModelPriceRate, FamilyModelProviderProfile, FamilyModelSettings } from '../../api/types';
import { createEmptyFamilyModelDraft, normalizeFamilyModelPriceRates } from './familyModelSettingsModel';
import { deriveFamilyModelSettingsOverview } from './familyModelSettingsOverviewModel';

function provider(id = 'provider-1'): FamilyModelProviderProfile {
  return {
    id,
    display_name: '家庭主服务',
    adapter_kind: 'openai_compatible_http',
    auth_mode: 'api_key',
    api_base_url: 'https://provider.example/v1',
    websocket_base_url: null,
    options: {},
    status: 'active',
    archived: false,
    version_number: 1,
    profile_version_number: 1,
    credential: { configured: true, version_number: 1, updated_at: '2026-08-20T08:00:00Z' },
    created_at: '2026-08-20T08:00:00Z',
    updated_at: '2026-08-20T08:00:00Z',
  };
}

function settings(profiles: FamilyModelProviderProfile[] = []): FamilyModelSettings {
  return {
    version_number: 1,
    active_config_revision_id: null,
    active_price_version_id: null,
    active_search_profile_id: null,
    provider_profiles: profiles,
    updated_at: '2026-08-20T08:00:00Z',
  };
}

function rate(capability: FamilyModelPriceRate['capability'], variantKey: string, meter: FamilyModelPriceRate['meter']): FamilyModelPriceRate {
  return {
    capability,
    variant_key: variantKey,
    meter,
    unit_quantity: '1000000',
    unit_price: '1',
    source_currency: 'CNY',
    fx_to_cny: '1',
    reported_model_aliases: [],
  };
}

describe('deriveFamilyModelSettingsOverview', () => {
  it('guides an empty family to connect its first AI service', () => {
    const overview = deriveFamilyModelSettingsOverview({
      settings: settings(),
      draft: createEmptyFamilyModelDraft(),
      dirty: false,
    });

    expect(overview.primarySection).toBe('providers');
    expect(overview.primaryLabel).toBe('添加第一个 AI 服务');
    expect(overview.steps.map((step) => step.status)).toEqual(['current', 'upcoming', 'upcoming', 'upcoming']);
    expect(overview.configurationStatus.kind).toBe('unconfigured');
  });

  it('moves from a connected service to capability binding', () => {
    const overview = deriveFamilyModelSettingsOverview({
      settings: settings([provider()]),
      draft: createEmptyFamilyModelDraft(),
      dirty: false,
    });

    expect(overview.providerCount).toBe(1);
    expect(overview.primarySection).toBe('capabilities');
    expect(overview.primaryLabel).toBe('选择需要的功能');
    expect(overview.steps.map((step) => step.status)).toEqual(['complete', 'current', 'upcoming', 'upcoming']);
  });

  it('keeps the service step current when every saved Provider is disabled', () => {
    const disabledProvider = { ...provider(), status: 'disabled' as const };
    const overview = deriveFamilyModelSettingsOverview({
      settings: settings([disabledProvider]),
      draft: createEmptyFamilyModelDraft(),
      dirty: false,
    });

    expect(overview.providerCount).toBe(1);
    expect(overview.primarySection).toBe('providers');
    expect(overview.primaryLabel).toBe('启用可用的 AI 服务');
    expect(overview.steps[0]?.status).toBe('current');
  });

  it('keeps capability binding current until every enabled binding has a usable Provider and model', () => {
    const draft = createEmptyFamilyModelDraft();
    draft.bindings[0] = { ...draft.bindings[0], enabled: true };

    const overview = deriveFamilyModelSettingsOverview({ settings: settings([provider()]), draft, dirty: true });

    expect(overview.enabledCapabilityCount).toBe(1);
    expect(overview.primarySection).toBe('capabilities');
    expect(overview.steps[1]?.status).toBe('current');
    expect(overview.steps[2]?.status).toBe('upcoming');
  });

  it('counts explicit prices without blocking configuration when prices are omitted', () => {
    const draft = createEmptyFamilyModelDraft();
    draft.bindings = draft.bindings.map((binding) => ({
      ...binding,
      enabled: binding.capability === 'llm' || binding.capability === 'image_generation',
      provider_profile_id: binding.capability === 'llm' || binding.capability === 'image_generation' ? 'provider-1' : null,
      requested_model: binding.capability === 'llm' ? 'chat-model' : binding.capability === 'image_generation' ? 'image-model' : '',
    }));

    const overview = deriveFamilyModelSettingsOverview({ settings: settings([provider()]), draft, dirty: true });

    expect(overview.enabledCapabilityCount).toBe(2);
    expect(overview.pricedCapabilityCount).toBe(0);
    expect(overview.primarySection).toBe('review');
    expect(overview.primaryLabel).toBe('检查配置是否完整');
    expect(overview.steps[2]?.status).toBe('complete');
  });

  it('does not count automatically supplied zero prices as manually filled prices', () => {
    const draft = createEmptyFamilyModelDraft();
    draft.bindings[0] = {
      ...draft.bindings[0],
      enabled: true,
      provider_profile_id: 'provider-1',
      requested_model: 'chat-model',
    };
    draft.price_rates = normalizeFamilyModelPriceRates(draft.bindings, []);

    const overview = deriveFamilyModelSettingsOverview({ settings: settings([provider()]), draft, dirty: false });

    expect(overview.pricedCapabilityCount).toBe(0);
  });

  it('guides a fully priced draft to the non-blocking configuration check', () => {
    const draft = createEmptyFamilyModelDraft();
    draft.bindings[0] = {
      ...draft.bindings[0],
      enabled: true,
      provider_profile_id: 'provider-1',
      requested_model: 'chat-model',
    };
    draft.price_rates = [
      rate('llm', 'primary', 'uncached_input_tokens'),
      rate('llm', 'primary', 'cached_input_tokens'),
      rate('llm', 'primary', 'output_tokens'),
    ];

    const overview = deriveFamilyModelSettingsOverview({ settings: settings([provider()]), draft, dirty: true });

    expect(overview.pricedCapabilityCount).toBe(1);
    expect(overview.primarySection).toBe('review');
    expect(overview.primaryLabel).toBe('检查配置是否完整');
    expect(overview.configurationStatus.kind).toBe('saving');
  });

  it('returns to pricing when a stale rule makes the complete draft invalid', () => {
    const draft = createEmptyFamilyModelDraft();
    draft.bindings[0] = {
      ...draft.bindings[0],
      enabled: true,
      provider_profile_id: 'provider-1',
      requested_model: 'chat-model',
    };
    draft.price_rates = [
      rate('llm', 'primary', 'uncached_input_tokens'),
      rate('llm', 'primary', 'cached_input_tokens'),
      rate('llm', 'primary', 'output_tokens'),
      rate('image_generation', 'text', 'generated_images'),
    ];

    const overview = deriveFamilyModelSettingsOverview({ settings: settings([provider()]), draft, dirty: true });

    expect(overview.pricedCapabilityCount).toBe(1);
    expect(overview.primarySection).toBe('prices');
    expect(overview.steps[2]?.status).toBe('current');
    expect(overview.steps[3]?.status).toBe('upcoming');
  });

  it('describes an active clean configuration as automatically applied', () => {
    const draft = createEmptyFamilyModelDraft();
    draft.bindings[0] = {
      ...draft.bindings[0],
      enabled: true,
      provider_profile_id: 'provider-1',
      requested_model: 'chat-model',
    };
    draft.price_rates = [
      rate('llm', 'primary', 'uncached_input_tokens'),
      rate('llm', 'primary', 'cached_input_tokens'),
      rate('llm', 'primary', 'output_tokens'),
    ];
    const activeSettings = {
      ...settings([provider()]),
      active_config_revision_id: 'revision-1',
      active_price_version_id: 'price-1',
    };

    const overview = deriveFamilyModelSettingsOverview({ settings: activeSettings, draft, dirty: false });

    expect(overview.configurationStatus).toEqual({
      kind: 'active',
      label: '配置已生效',
      description: '当前家庭正在使用这份配置，后续修改也会自动保存并生效。',
    });
    expect(overview.title).toBe('家庭 AI 服务已配置');
    expect(overview.primaryLabel).toBe('查看配置是否完整');
  });
});
