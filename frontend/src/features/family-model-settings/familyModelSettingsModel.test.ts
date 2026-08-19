import { describe, expect, it } from 'vitest';
import type { FamilyModelBindingDraft, FamilyModelConfigDraftPayload, FamilyModelPriceRate } from '../../api/types';
import {
  createEmptyFamilyModelDraft,
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

  it('returns field-addressable errors for missing and overlapping enabled price rates', () => {
    const missing = validateFamilyModelPriceRates([embeddingBinding], []);
    expect(missing.valid).toBe(false);
    expect(missing.errors['price_rates.embedding.search.embedding_tokens']).toContain('请补充');

    const overlap = validateFamilyModelPriceRates([embeddingBinding], [embeddingRate, { ...embeddingRate }]);
    expect(overlap.valid).toBe(false);
    expect(overlap.errors['price_rates.1']).toContain('重复');
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

  it('projects unknown server failures to a safe recovery message', () => {
    const message = safeFamilyModelSettingsError({
      message: 'https://provider.example/v1 Authorization: Bearer secret-value',
    });
    expect(message).toEqual('操作未完成，请检查输入后重试。');
    expect(message).not.toContain('secret-value');
  });
});
