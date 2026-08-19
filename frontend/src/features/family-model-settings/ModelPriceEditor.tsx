import type { FamilyModelBindingDraft, FamilyModelPriceRate, ModelUsageMeter } from '../../api/types';
import {
  validateFamilyModelPriceRates,
  type FamilyModelSettingsDraft,
} from './familyModelSettingsModel';
import {
  FAMILY_MODEL_CAPABILITY_OPTIONS,
  FAMILY_MODEL_METER_LABELS,
} from './familyModelSettingsOptions';

const REQUIRED_METERS: Record<FamilyModelBindingDraft['capability'], readonly ModelUsageMeter[]> = {
  llm: ['uncached_input_tokens', 'cached_input_tokens', 'output_tokens'],
  image_generation: ['generated_images'],
  stt: ['audio_input_seconds'],
  tts: ['tts_characters'],
  realtime_audio: ['audio_input_seconds', 'tts_characters'],
  embedding: ['embedding_tokens'],
  rerank: ['input_tokens'],
};

function rateId(rate: Pick<FamilyModelPriceRate, 'capability' | 'variant_key' | 'meter'>): string {
  return `${rate.capability}:${rate.variant_key}:${rate.meter}`;
}

function defaultUnitQuantity(meter: ModelUsageMeter): string {
  if (meter === 'generated_images') return '1';
  if (meter === 'audio_input_seconds') return '60';
  if (meter === 'tts_characters') return '1000';
  return '1000000';
}

function unitDescription(meter: ModelUsageMeter): string {
  if (meter === 'generated_images') return '每张图片';
  if (meter === 'audio_input_seconds') return '每分钟音频';
  if (meter === 'tts_characters') return '每 1 千字符';
  return '每 100 万 Token';
}

function rateFor(binding: FamilyModelBindingDraft, meter: ModelUsageMeter): FamilyModelPriceRate {
  return {
    capability: binding.capability,
    variant_key: binding.variant_key,
    meter,
    unit_quantity: defaultUnitQuantity(meter),
    unit_price: '0',
    source_currency: 'CNY',
    fx_to_cny: '1',
    reported_model_aliases: binding.requested_model.trim() ? [binding.requested_model.trim()] : [],
  };
}

export type ModelPriceEditorProps = {
  draft: FamilyModelSettingsDraft;
  busy: boolean;
  onDraftChange: (draft: FamilyModelSettingsDraft) => void;
};

export function ModelPriceEditor(props: ModelPriceEditorProps) {
  const validation = validateFamilyModelPriceRates(props.draft.bindings, props.draft.price_rates);
  const enabledBindings = props.draft.bindings.filter((binding) => binding.enabled);

  function ensureCompleteRates() {
    const known = new Set(props.draft.price_rates.map(rateId));
    const additions = enabledBindings.flatMap((binding) => REQUIRED_METERS[binding.capability]
      .filter((meter) => !known.has(rateId({ capability: binding.capability, variant_key: binding.variant_key, meter })))
      .map((meter) => rateFor(binding, meter)));
    if (additions.length > 0) {
      props.onDraftChange({ ...props.draft, price_rates: [...props.draft.price_rates, ...additions] });
    }
  }

  function patchRate(index: number, patch: Partial<FamilyModelPriceRate>) {
    props.onDraftChange({
      ...props.draft,
      price_rates: props.draft.price_rates.map((rate, candidateIndex) => candidateIndex === index ? { ...rate, ...patch } : rate),
    });
  }

  return (
    <section className="family-model-settings-editor" aria-labelledby="family-model-price-editor-title">
      <div className="family-model-settings-section-head">
        <div>
          <h2 id="family-model-price-editor-title">模型价格</h2>
          <p>为每个启用能力补齐价格。金额和数量按精确字符串保存，不使用浏览器浮点换算。</p>
        </div>
        <button className="ghost-button" type="button" disabled={props.busy || enabledBindings.length === 0} onClick={ensureCompleteRates}>补齐启用能力价格</button>
      </div>
      {enabledBindings.length === 0 ? (
        <p className="family-model-settings-empty-inline">请先在“能力配置”中启用至少一项能力。</p>
      ) : null}
      <div className="family-model-settings-price-list">
        {props.draft.price_rates.map((rate, index) => {
          const errorPrefix = `price_rates.${index}`;
          const error = validation.errors[errorPrefix]
            ?? validation.errors[`${errorPrefix}.unit_quantity`]
            ?? validation.errors[`${errorPrefix}.unit_price`]
            ?? validation.errors[`${errorPrefix}.fx_to_cny`];
          return (
            <article className="family-model-settings-price-card" key={rateId(rate)}>
              <div className="family-model-settings-price-head">
                <div>
                  <strong>{FAMILY_MODEL_CAPABILITY_OPTIONS[rate.capability].label}</strong>
                  <span>{FAMILY_MODEL_METER_LABELS[rate.meter] ?? rate.meter} · {unitDescription(rate.meter)}</span>
                </div>
                <span>{rate.variant_key}</span>
              </div>
              <div className="family-model-settings-form-grid">
                <label className="family-model-settings-field">
                  <span>计价数量</span>
                  <input inputMode="decimal" value={rate.unit_quantity} disabled={props.busy} onChange={(event) => patchRate(index, { unit_quantity: event.target.value })} />
                </label>
                <label className="family-model-settings-field">
                  <span>单价</span>
                  <input inputMode="decimal" value={rate.unit_price} disabled={props.busy} onChange={(event) => patchRate(index, { unit_price: event.target.value })} />
                </label>
                <label className="family-model-settings-field">
                  <span>币种</span>
                  <input value={rate.source_currency} maxLength={8} disabled={props.busy} onChange={(event) => patchRate(index, { source_currency: event.target.value.toUpperCase() })} />
                </label>
                <label className="family-model-settings-field">
                  <span>兑人民币汇率</span>
                  <input inputMode="decimal" value={rate.fx_to_cny} disabled={props.busy} onChange={(event) => patchRate(index, { fx_to_cny: event.target.value })} />
                </label>
              </div>
              {rate.unit_price === '0' || /^0\.0+$/.test(rate.unit_price) ? <p className="family-model-settings-zero-price-note">零价格不会消耗成本预算，请同时设置用量上限。</p> : null}
              {error ? <p className="family-model-settings-field-error" role="alert">{error}</p> : null}
            </article>
          );
        })}
      </div>
      {!validation.valid ? <p className="family-model-settings-validation-note" role="status">请补齐所有启用能力的计量价格后再检查配置。</p> : null}
    </section>
  );
}
