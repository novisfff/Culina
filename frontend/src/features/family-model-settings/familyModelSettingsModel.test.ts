import { describe, expect, it } from 'vitest';
import type { FamilyModelBindingDraft, FamilyModelConfigDraftPayload, FamilyModelPriceRate } from '../../api/types';
import {
  createEmptyFamilyModelDraft,
  normalizeFamilyModelPriceRates,
  rebindDraftProviderProfile,
  safeFamilyModelSettingsError,
  toSaveDraftPayload,
  validateFamilyModelPriceRates,
  validateMoneyInput,
} from './familyModelSettingsModel';

const embeddingBinding: FamilyModelBindingDraft = {
  capability: 'embedding',
  variant_key: 'search',
  enabled: true,
  provider_profile_id: 'profile-1',
  requested_model: 'text-embedding-3-small',
  billing_scheme_key: 'embedding-token-v1',
  dimensions: 1536,
};

const embeddingRate: FamilyModelPriceRate = {
  capability: 'embedding',
  variant_key: 'search',
  meter: 'embedding_tokens',
  unit_quantity: '1000',
  unit_price: '0.02',
  source_currency: 'USD',
  fx_to_cny: '7.2',
  reported_model_aliases: [],
};

describe('familyModelSettingsModel', () => {
  it.each(['', '1.', '.5', '-1', 'NaN', '1e3', '0.1234567890123', ' 1'])
    ('rejects a non-canonical money string %s', (value) => {
      expect(validateMoneyInput(value)).toBeDefined();
    });

  it.each(['0', '0.02', '12.345000000000'])('accepts a canonical non-negative money string %s', (value) => {
    expect(validateMoneyInput(value)).toBeUndefined();
  });

  it('creates explicit defaults for every controlled capability variant', () => {
    const draft = createEmptyFamilyModelDraft();
    expect(draft.bindings.map((binding) => `${binding.capability}:${binding.variant_key}`)).toEqual([
      'llm:primary',
      'llm:fallback',
      'image_generation:text',
      'image_generation:reference',
      'stt:default',
      'tts:default',
      'realtime_audio:default',
      'embedding:search',
      'rerank:search',
    ]);
    expect(draft.bindings.every((binding) => !binding.enabled)).toBe(true);
  });

  it('treats omitted prices as zero while still rejecting overlapping rates', () => {
    const missing = validateFamilyModelPriceRates([embeddingBinding], []);
    expect(missing.valid).toBe(true);

    const overlap = validateFamilyModelPriceRates([embeddingBinding], [embeddingRate, { ...embeddingRate }]);
    expect(overlap.valid).toBe(false);
    expect(overlap.errors['price_rates.1']).toContain('重复');
  });

  it('normalizes enabled model meters to zero-priced defaults and removes disabled rates', () => {
    const normalized = normalizeFamilyModelPriceRates([embeddingBinding], []);
    expect(normalized).toEqual([{
      capability: 'embedding',
      variant_key: 'search',
      meter: 'embedding_tokens',
      unit_quantity: '1000000',
      unit_price: '0',
      source_currency: 'CNY',
      fx_to_cny: '1',
      reported_model_aliases: ['text-embedding-3-small'],
    }]);

    expect(normalizeFamilyModelPriceRates([{ ...embeddingBinding, enabled: false }], [embeddingRate])).toEqual([]);
  });

  it('keeps the server-owned active search identity unchanged in a normal draft payload', () => {
    const readyDraft: FamilyModelConfigDraftPayload = {
      base_config_revision_id: 'revision-1',
      search_profile_id: 'active-search-1',
      bindings: [embeddingBinding],
      price_rates: [embeddingRate],
      price_draft: null,
      change_note: '更新价格',
    };

    const payload = toSaveDraftPayload({
      ...readyDraft,
      bindings: [{ ...embeddingBinding, requested_model: 'different-model', dimensions: 3072 }],
      active_embedding_binding: embeddingBinding,
      base_draft_version_number: 3,
    }, 'save-draft-1');

    expect(payload.search_profile_id).toBe('active-search-1');
    expect(payload.bindings).toEqual([embeddingBinding]);
    expect(JSON.stringify(payload)).not.toContain('api_key');
  });

  it('rebinds ordinary capabilities but preserves the active Embedding identity', () => {
    const draft = createEmptyFamilyModelDraft();
    const source = {
      ...draft,
      search_profile_id: 'active-search-1',
      active_embedding_binding: embeddingBinding,
      bindings: draft.bindings.map((binding) => ({
        ...binding,
        enabled: binding.capability === 'llm' || binding.capability === 'embedding',
        provider_profile_id: binding.capability === 'llm' || binding.capability === 'embedding'
          ? 'profile-1'
          : binding.provider_profile_id,
      })) as FamilyModelBindingDraft[],
    };

    const rebound = rebindDraftProviderProfile(source, 'profile-1', 'profile-2');

    expect(rebound.bindings.find((binding) => binding.capability === 'llm')?.provider_profile_id).toBe('profile-2');
    expect(rebound.bindings.find((binding) => binding.capability === 'embedding')?.provider_profile_id).toBe('profile-1');
    expect(rebound.active_embedding_binding).toBe(embeddingBinding);
  });

  it('projects unknown server failures to a safe recovery message', () => {
    const message = safeFamilyModelSettingsError({
      message: 'https://provider.example/v1 Authorization: Bearer secret-value',
    });
    expect(message).toEqual('操作未完成，请检查输入后重试。');
    expect(message).not.toContain('secret-value');
  });

  it.each([
    [
      'family_model_settings_not_configured',
      '当前家庭还没有可用的模型配置。请先启用能力，并补全 Provider 服务和模型名称。',
    ],
    [
      'family_model_capability_disabled',
      '当前配置未启用此能力。请先在能力配置中启用并补全信息。',
    ],
    [
      'family_model_provider_disabled',
      '当前配置绑定的服务已停用或已变更。请检查服务状态，修改会自动保存生效。',
    ],
    [
      'family_model_secret_unavailable',
      '当前服务的 API Key 不可用。请修改 Key 后重试。',
    ],
    [
      'family_model_operation_in_progress',
      '上一次能力测试仍在处理中。请稍候刷新结果，不要重复发起可能计费的请求。',
    ],
    [
      'family_model_capability_test_ledger_failed',
      '暂时无法创建模型用量记录，因此没有调用模型。请稍后重试。',
    ],
    [
      'family_model_capability_test_binding_incomplete',
      '当前能力信息不完整。请先启用能力，并补全 Provider 服务和模型名称后再测试。',
    ],
    [
      'family_model_capability_test_transport_failed',
      '请求模型服务时连接中断，执行结果暂时无法确认。请先查看模型用量记录，不要立即重复测试。',
    ],
    [
      'family_model_endpoint_url_invalid',
      '服务地址格式不正确。请填写以 http://、https://、ws:// 或 wss:// 开头的完整地址。',
    ],
    [
      'family_model_endpoint_protocol_mismatch',
      '地址协议与 Provider 类型不匹配。普通 API 请使用 HTTP(S)，实时服务请使用 WS(S)。',
    ],
    [
      'family_model_endpoint_dns_resolution_failed',
      '无法解析服务地址的域名。请检查域名拼写或 DNS 配置。',
    ],
    [
      'family_model_endpoint_address_forbidden',
      '服务地址指向系统禁止访问的本机、链路本地、云元数据或保留网络地址。',
    ],
    [
      'family_model_endpoint_private_target_not_allowed',
      '服务地址指向未获许可的私网地址。请联系部署管理员加入私网白名单。',
    ],
    [
      'family_model_endpoint_insecure_transport_not_allowed',
      '当前部署不允许公网明文 HTTP/WS。请改用 HTTPS/WSS，或由部署管理员开启不安全传输开关。',
    ],
    [
      'family_model_provider_protocol_unsupported',
      '当前 Provider 类型不支持这个地址协议或认证方式。请检查服务类型、地址和认证方式。',
    ],
  ])('maps %s to an actionable safe message', (code, expectedMessage) => {
    expect(safeFamilyModelSettingsError({ payload: { detail: { code } } })).toBe(expectedMessage);
  });
});
