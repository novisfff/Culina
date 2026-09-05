import type {
  FamilyModelBindingDraft,
  FamilyModelConfigDraftPayload,
  FamilyModelEmbeddingBindingDraft,
  FamilyModelPriceRate,
  SaveFamilyModelConfigDraftPayload,
} from '../../api/types/modelUsage';

export type FamilyModelSettingsDraft = FamilyModelConfigDraftPayload & {
  base_draft_version_number: number;
  /** The active vector identity can only change through a replacement workflow. */
  active_embedding_binding?: FamilyModelEmbeddingBindingDraft;
};

export type FamilyModelFormValidation = {
  valid: boolean;
  errors: Record<string, string>;
};

export const FAMILY_MODEL_REQUIRED_METERS: Record<FamilyModelBindingDraft['capability'], readonly FamilyModelPriceRate['meter'][]> = {
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
  const bindings = source.bindings.map(cloneBinding);
  return {
    ...source,
    bindings,
    price_rates: normalizeFamilyModelPriceRates(bindings, source.price_rates),
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

export function rebindDraftProviderProfile(
  draft: FamilyModelSettingsDraft,
  fromProfileId: string,
  toProfileId: string,
): FamilyModelSettingsDraft {
  return {
    ...draft,
    bindings: draft.bindings.map((binding) => {
      const isActiveEmbedding = binding.capability === 'embedding'
        && binding.variant_key === 'search'
        && Boolean(draft.active_embedding_binding);
      return binding.provider_profile_id === fromProfileId && !isActiveEmbedding
        ? { ...binding, provider_profile_id: toProfileId }
        : binding;
    }),
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

function defaultUnitQuantity(meter: FamilyModelPriceRate['meter']): string {
  if (meter === 'generated_images') return '1';
  if (meter === 'audio_input_seconds') return '60';
  if (meter === 'tts_characters') return '1000';
  return '1000000';
}

export function normalizeFamilyModelPriceRates(
  bindings: readonly FamilyModelBindingDraft[],
  rates: readonly FamilyModelPriceRate[],
): FamilyModelPriceRate[] {
  const existing = new Map(rates.map((rate) => [rateIdentity(rate), rate]));
  return bindings.flatMap((binding) => {
    if (!binding.enabled) return [];
    return FAMILY_MODEL_REQUIRED_METERS[binding.capability].map((meter) => {
      const identity = `${bindingIdentity(binding)}:${meter}`;
      const current = existing.get(identity);
      if (current) {
        return { ...current, reported_model_aliases: [...current.reported_model_aliases] };
      }
      const requestedModel = binding.requested_model.trim();
      return {
        capability: binding.capability,
        variant_key: binding.variant_key,
        meter,
        unit_quantity: defaultUnitQuantity(meter),
        unit_price: '0',
        source_currency: 'CNY',
        fx_to_cny: '1',
        reported_model_aliases: requestedModel ? [requestedModel] : [],
      };
    });
  });
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
    for (const meter of FAMILY_MODEL_REQUIRED_METERS[binding.capability]) {
      expected.add(`${binding.capability}:${binding.variant_key}:${meter}`);
    }
  }

  const seen = new Set<string>();
  rates.forEach((rate, index) => {
    const identity = rateIdentity(rate);
    if (seen.has(identity)) {
      errors[`price_rates.${index}`] = '同一功能、类型和用量类型的价格重复了。';
    }
    seen.add(identity);
    if (!expected.has(identity)) {
      errors[`price_rates.${index}`] = '这条价格不属于当前启用的模型功能。';
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
  options: { confirmInitialSearchIndex?: boolean } = {},
): SaveFamilyModelConfigDraftPayload {
  const bindings = savedBindings(draft);
  return {
    base_config_revision_id: draft.base_config_revision_id,
    search_profile_id: draft.search_profile_id,
    bindings,
    price_rates: normalizeFamilyModelPriceRates(bindings, draft.price_rates),
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
    ...(options.confirmInitialSearchIndex ? { confirm_initial_search_index: true } : {}),
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
  family_search_initial_confirmation_required: '首次配置搜索模型前需要确认。确认后系统会为家庭内容生成搜索数据并开启搜索；今后更换模型服务、模型或维度时，需要重新生成全部搜索数据。',
  family_search_profile_locked: '搜索设置已生效。请前往“智能搜索”，通过确认流程更换模型服务、模型或维度。',
  family_search_profile_identity_conflict: '这个搜索模型身份之前已经使用过，不能重复创建。请更换模型、维度或服务版本。',
  family_model_settings_version_conflict: '配置已在别处更新，请刷新后继续编辑。',
  family_model_settings_not_configured: '当前家庭还没有可用的模型配置。请先启用功能，并补全模型服务和模型名称。',
  family_model_config_pointer_invalid: '当前配置数据不一致，请刷新后重试；如果仍然失败，需要管理员修复配置。',
  family_model_price_pointer_invalid: '当前价格配置与模型配置不一致，请刷新后重试；如果仍然失败，需要管理员修复配置。',
  family_model_search_profile_pointer_invalid: '当前搜索配置数据不一致，请刷新后重试；如果仍然失败，需要管理员修复配置。',
  family_model_capability_disabled: '当前配置未启用此功能。请先在“功能设置”中启用并补全信息。',
  family_model_provider_disabled: '当前配置使用的服务已停用或已变更。请检查服务状态，修改会自动保存生效。',
  family_model_secret_unavailable: '当前服务的 API 密钥不可用。请修改密钥后重试。',
  family_model_operation_in_progress: '上一次功能测试仍在处理中。请稍候刷新结果，不要重复发起可能计费的请求。',
  family_model_capability_test_ledger_failed: '暂时无法创建模型用量记录，因此没有请求模型。请稍后重试。',
  family_model_capability_test_binding_incomplete: '当前功能信息不完整。请先启用功能，并补全模型服务和模型名称后再测试。',
  family_model_capability_test_transport_failed: '请求模型服务时连接中断，执行结果暂时无法确认。请先查看模型用量记录，不要立即重复测试。',
  family_model_publish_checksum_mismatch: '配置内容已变化，请刷新后重试。',
  family_model_owner_reauthentication_failed: '当前密码不正确，请重新输入后继续。',
  family_model_provider_scope_change_requires_new_profile: '连接范围已变化，请新增服务并重新关联功能。',
  family_model_operation_idempotency_conflict: '本次操作内容已变化，请重新提交。',
  family_model_endpoint_blocked: '服务地址无法使用，请检查后重试。',
  family_model_endpoint_url_invalid: '服务地址格式不正确。请填写以 http://、https://、ws:// 或 wss:// 开头的完整地址。',
  family_model_endpoint_protocol_mismatch: '地址协议与模型服务类型不匹配。普通 API 请使用 HTTP(S)，实时服务请使用 WS(S)。',
  family_model_endpoint_dns_resolution_failed: '无法解析服务地址的域名。请检查域名拼写或 DNS 配置。',
  family_model_endpoint_address_forbidden: '服务地址指向系统禁止访问的本机、链路本地、云元数据或保留网络地址。',
  family_model_endpoint_private_target_not_allowed: '服务地址指向未获许可的私网地址。请联系部署管理员加入私网白名单。',
  family_model_endpoint_insecure_transport_not_allowed: '当前部署不允许公网明文 HTTP/WS。请改用 HTTPS/WSS，或由部署管理员开启不安全传输开关。',
  family_model_provider_protocol_unsupported: '当前模型服务不支持这种地址或验证方式。请检查服务类型、地址和验证方式。',
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
