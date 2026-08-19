import type {
  FamilyModelBindingDraft,
  FamilyModelConfigDraftPayload,
  FamilyModelEmbeddingBindingDraft,
  FamilyModelPriceRate,
  SaveFamilyModelConfigDraftPayload,
} from '../../api/types';

export type FamilyModelSettingsDraft = FamilyModelConfigDraftPayload & {
  base_draft_version_number: number;
  /** The active vector identity can only change through a replacement workflow. */
  active_embedding_binding?: FamilyModelEmbeddingBindingDraft;
};

export type FamilyModelFormValidation = {
  valid: boolean;
  errors: Record<string, string>;
};

const REQUIRED_METERS: Record<FamilyModelBindingDraft['capability'], readonly FamilyModelPriceRate['meter'][]> = {
  llm: ['uncached_input_tokens', 'cached_input_tokens', 'output_tokens'],
  image_generation: ['generated_images'],
  stt: ['audio_input_seconds'],
  tts: ['tts_characters'],
  realtime_audio: ['audio_input_seconds', 'tts_characters'],
  embedding: ['embedding_tokens'],
  rerank: ['input_tokens'],
};

const CANONICAL_MONEY = /^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/;
const CANONICAL_QUANTITY = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/;

function cloneBinding<T extends FamilyModelBindingDraft>(binding: T): T {
  return { ...binding };
}

function emptyBindings(): FamilyModelBindingDraft[] {
  return [
    {
      capability: 'llm',
      variant_key: 'primary',
      enabled: false,
      provider_profile_id: null,
      requested_model: '',
      billing_scheme_key: 'llm-split-v1',
      max_output_tokens: 4096,
      supports_vision: false,
      prompt_cache_enabled: true,
    },
    {
      capability: 'llm',
      variant_key: 'fallback',
      enabled: false,
      provider_profile_id: null,
      requested_model: '',
      billing_scheme_key: 'llm-split-v1',
      max_output_tokens: 2048,
      supports_vision: false,
      prompt_cache_enabled: true,
    },
    {
      capability: 'image_generation',
      variant_key: 'text',
      enabled: false,
      provider_profile_id: null,
      requested_model: '',
      billing_scheme_key: 'image-count-v1',
      image_size: '1024x1024',
      response_format: 'b64_json',
    },
    {
      capability: 'image_generation',
      variant_key: 'reference',
      enabled: false,
      provider_profile_id: null,
      requested_model: '',
      billing_scheme_key: 'image-count-v1',
      image_size: '1024x1024',
      response_format: 'b64_json',
    },
    {
      capability: 'stt',
      variant_key: 'default',
      enabled: false,
      provider_profile_id: null,
      requested_model: '',
      billing_scheme_key: 'stt-seconds-v1',
      language_hint: null,
      hotwords: [],
    },
    {
      capability: 'tts',
      variant_key: 'default',
      enabled: false,
      provider_profile_id: null,
      requested_model: '',
      billing_scheme_key: 'tts-characters-v1',
      voice: null,
      output_format: 'mp3',
    },
    {
      capability: 'realtime_audio',
      variant_key: 'default',
      enabled: false,
      provider_profile_id: null,
      requested_model: '',
      billing_scheme_key: 'realtime-asr-seconds-tts-characters-v1',
      voice: null,
      language_hint: null,
    },
    {
      capability: 'embedding',
      variant_key: 'search',
      enabled: false,
      provider_profile_id: null,
      requested_model: '',
      billing_scheme_key: 'embedding-token-v1',
      dimensions: 1536,
    },
    {
      capability: 'rerank',
      variant_key: 'search',
      enabled: false,
      provider_profile_id: null,
      requested_model: '',
      billing_scheme_key: 'rerank-token-v1',
      top_n: 20,
      instruction: null,
    },
  ];
}

export function createEmptyFamilyModelDraft(): FamilyModelSettingsDraft {
  return {
    base_config_revision_id: null,
    search_profile_id: null,
    bindings: emptyBindings(),
    price_rates: [],
    price_draft: null,
    change_note: '',
    base_draft_version_number: 0,
  };
}

export function createFamilyModelSettingsDraft(
  source: FamilyModelConfigDraftPayload | null | undefined,
  baseDraftVersionNumber = 0,
): FamilyModelSettingsDraft {
  if (!source) return createEmptyFamilyModelDraft();
  const activeEmbedding = source.search_profile_id
    ? source.bindings.find(
      (binding): binding is FamilyModelEmbeddingBindingDraft =>
        binding.capability === 'embedding' && binding.variant_key === 'search',
    )
    : undefined;
  return {
    ...source,
    bindings: source.bindings.map(cloneBinding),
    price_rates: source.price_rates.map((rate) => ({ ...rate, reported_model_aliases: [...rate.reported_model_aliases] })),
    price_draft: source.price_draft
      ? {
        ...source.price_draft,
        rates: source.price_draft.rates.map((rate) => ({ ...rate, reported_model_aliases: [...rate.reported_model_aliases] })),
      }
      : null,
    base_draft_version_number: baseDraftVersionNumber,
    active_embedding_binding: activeEmbedding ? cloneBinding(activeEmbedding) : undefined,
  };
}

export function validateMoneyInput(value: string): string | undefined {
  if (!CANONICAL_MONEY.test(value)) return '金额请使用最多 12 位小数的非负数字。';
  return undefined;
}

function validatePositiveQuantity(value: string): string | undefined {
  if (!CANONICAL_QUANTITY.test(value) || value === '0' || /^0\.0+$/.test(value)) {
    return '数量请使用最多 6 位小数的正数。';
  }
  return undefined;
}

function validatePositiveMoney(value: string, label: string): string | undefined {
  const invalid = validateMoneyInput(value);
  if (invalid || value === '0' || /^0\.0+$/.test(value)) return `${label}请填写大于 0 的金额。`;
  return undefined;
}

function rateIdentity(rate: FamilyModelPriceRate): string {
  return `${rate.capability}:${rate.variant_key}:${rate.meter}`;
}

function bindingIdentity(binding: FamilyModelBindingDraft): string {
  return `${binding.capability}:${binding.variant_key}`;
}

/**
 * Checks only client-visible form facts. The server remains the authoritative
 * validator for adapter compatibility, credential state and price checksums.
 */
export function validateFamilyModelPriceRates(
  bindings: readonly FamilyModelBindingDraft[],
  rates: readonly FamilyModelPriceRate[],
): FamilyModelFormValidation {
  const errors: Record<string, string> = {};
  const expected = new Set<string>();
  for (const binding of bindings) {
    if (!binding.enabled) continue;
    for (const meter of REQUIRED_METERS[binding.capability]) {
      expected.add(`${binding.capability}:${binding.variant_key}:${meter}`);
    }
  }

  const seen = new Set<string>();
  rates.forEach((rate, index) => {
    const identity = rateIdentity(rate);
    if (seen.has(identity)) {
      errors[`price_rates.${index}`] = '同一能力、变体和计量项的价格重复了。';
    }
    seen.add(identity);
    if (!expected.has(identity)) {
      errors[`price_rates.${index}`] = '这条价格不属于当前启用的模型能力。';
    }
    const quantityError = validatePositiveQuantity(rate.unit_quantity);
    if (quantityError) errors[`price_rates.${index}.unit_quantity`] = quantityError;
    const priceError = validateMoneyInput(rate.unit_price);
    if (priceError) errors[`price_rates.${index}.unit_price`] = priceError;
    const fxError = validatePositiveMoney(rate.fx_to_cny, '汇率');
    if (fxError) errors[`price_rates.${index}.fx_to_cny`] = fxError;
    if (!/^[A-Z]{3,8}$/.test(rate.source_currency)) {
      errors[`price_rates.${index}.source_currency`] = '币种请使用 3 到 8 位大写字母。';
    }
  });

  for (const identity of expected) {
    if (!seen.has(identity)) {
      const [capability, variant, meter] = identity.split(':');
      errors[`price_rates.${capability}.${variant}.${meter}`] = '请补充这项已启用能力的完整价格。';
    }
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

function savedBindings(draft: FamilyModelSettingsDraft): FamilyModelBindingDraft[] {
  return draft.bindings.map((binding) => {
    if (binding.capability !== 'embedding' || binding.variant_key !== 'search' || !draft.active_embedding_binding) {
      return cloneBinding(binding);
    }
    return cloneBinding(draft.active_embedding_binding);
  });
}

/** Converts a local edit state into the only server-accepted non-secret draft. */
export function toSaveDraftPayload(
  draft: FamilyModelSettingsDraft,
  idempotencyKey: string,
): SaveFamilyModelConfigDraftPayload {
  return {
    base_config_revision_id: draft.base_config_revision_id,
    search_profile_id: draft.search_profile_id,
    bindings: savedBindings(draft),
    price_rates: draft.price_rates.map((rate) => ({
      ...rate,
      reported_model_aliases: [...rate.reported_model_aliases],
    })),
    price_draft: draft.price_draft
      ? {
        ...draft.price_draft,
        rates: draft.price_draft.rates.map((rate) => ({
          ...rate,
          reported_model_aliases: [...rate.reported_model_aliases],
        })),
      }
      : null,
    change_note: draft.change_note,
    base_draft_version_number: draft.base_draft_version_number,
    idempotency_key: idempotencyKey,
  };
}

function safeErrorCode(reason: unknown): string | null {
  if (!reason || typeof reason !== 'object') return null;
  const payload = 'payload' in reason ? (reason as { payload?: unknown }).payload : undefined;
  if (!payload || typeof payload !== 'object') return null;
  const detail = 'detail' in payload ? (payload as { detail?: unknown }).detail : undefined;
  if (!detail || typeof detail !== 'object') return null;
  const code = 'code' in detail ? (detail as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : null;
}

const SAFE_ERROR_MESSAGES: Record<string, string> = {
  family_model_settings_version_conflict: '设置已更新，请刷新后重新应用草稿。',
  family_model_publish_checksum_mismatch: '发布内容已变化，请刷新后重新确认。',
  family_model_owner_reauthentication_failed: '当前密码不正确，请重新输入后继续。',
  family_model_provider_scope_change_requires_new_profile: '连接范围已变化，请新建服务并重新绑定。',
  family_model_operation_idempotency_conflict: '本次操作内容已变化，请重新提交。',
  family_model_endpoint_blocked: '服务地址无法使用，请检查后重试。',
};

/** Never projects provider response bodies, endpoints, headers or stack details into the UI. */
export function safeFamilyModelSettingsError(reason: unknown): string {
  const code = safeErrorCode(reason);
  return (code && SAFE_ERROR_MESSAGES[code]) || '操作未完成，请检查输入后重试。';
}

export function findFamilyModelBinding(
  bindings: readonly FamilyModelBindingDraft[],
  capability: FamilyModelBindingDraft['capability'],
  variantKey: string,
): FamilyModelBindingDraft | undefined {
  return bindings.find((binding) => bindingIdentity(binding) === `${capability}:${variantKey}`);
}
