import { useState } from 'react';
import type { FamilyModelBindingDraft, FamilyModelPriceRate } from '../../api/types';
import {
  FAMILY_MODEL_REQUIRED_METERS,
  validateFamilyModelPriceRates,
  type FamilyModelSettingsDraft,
} from './familyModelSettingsModel';
import {
  FAMILY_MODEL_CAPABILITY_OPTIONS,
  FAMILY_MODEL_METER_LABELS,
} from './familyModelSettingsOptions';

const PRICE_GROUPS: ReadonlyArray<{
  id: string;
  label: string;
  capabilities: readonly FamilyModelBindingDraft['capability'][];
}> = [
  { id: 'generation', label: '对话与生成', capabilities: ['llm', 'image_generation'] },
  { id: 'voice', label: '语音', capabilities: ['stt', 'tts', 'realtime_audio'] },
  { id: 'search', label: '搜索', capabilities: ['embedding', 'rerank'] },
];

type IndexedRate = {
  rate: FamilyModelPriceRate;
  index: number;
};

function rateId(rate: Pick<FamilyModelPriceRate, 'capability' | 'variant_key' | 'meter'>): string {
  return `${rate.capability}:${rate.variant_key}:${rate.meter}`;
}

function bindingId(binding: Pick<FamilyModelBindingDraft, 'capability' | 'variant_key'>): string {
  return `${binding.capability}:${binding.variant_key}`;
}

function rateBindingId(rate: Pick<FamilyModelPriceRate, 'capability' | 'variant_key'>): string {
  return `${rate.capability}:${rate.variant_key}`;
}

function unitDescription(rate: Pick<FamilyModelPriceRate, 'meter' | 'unit_quantity'>): string {
  const { meter, unit_quantity: quantity } = rate;
  if (meter === 'generated_images') return quantity === '1' ? '张图片' : `${quantity} 张图片`;
  if (meter === 'audio_input_seconds') {
    if (quantity === '60') return '分钟音频';
    if (quantity === '1') return '秒音频';
    return `${quantity} 秒音频`;
  }
  if (meter === 'tts_characters') {
    if (quantity === '1000') return '1 千字符';
    return `${quantity} 字符`;
  }
  if (quantity === '1000000') return '100 万 Token';
  if (quantity === '1000') return '1 千 Token';
  return `${quantity} Token`;
}

function sharedRateValue(
  rates: readonly IndexedRate[],
  field: 'source_currency' | 'fx_to_cny',
): string {
  const first = rates[0]?.rate[field] ?? '';
  return rates.every(({ rate }) => rate[field] === first) ? first : '';
}

function orderedRates(binding: FamilyModelBindingDraft, rates: readonly IndexedRate[]): IndexedRate[] {
  const order = FAMILY_MODEL_REQUIRED_METERS[binding.capability];
  return [...rates].sort((left, right) => order.indexOf(left.rate.meter) - order.indexOf(right.rate.meter));
}

export type ModelPriceEditorProps = {
  draft: FamilyModelSettingsDraft;
  busy: boolean;
  onDraftChange: (draft: FamilyModelSettingsDraft) => void;
};

export function ModelPriceEditor(props: ModelPriceEditorProps) {
  const validation = validateFamilyModelPriceRates(props.draft.bindings, props.draft.price_rates);
  const enabledBindings = props.draft.bindings.filter((binding) => binding.enabled);
  const ratesWithIndexes = props.draft.price_rates.map((rate, index) => ({ rate, index }));
  const pricedBindings = enabledBindings.map((binding) => ({
    binding,
    rates: orderedRates(
      binding,
      ratesWithIndexes.filter(({ rate }) => rateBindingId(rate) === bindingId(binding)),
    ),
  })).filter(({ rates }) => rates.length > 0);
  const [preferredBindingId, setPreferredBindingId] = useState(() => (
    props.draft.price_rates[0] ? rateBindingId(props.draft.price_rates[0]) : ''
  ));
  const selectedBindingId = pricedBindings.some(({ binding }) => bindingId(binding) === preferredBindingId)
    ? preferredBindingId
    : pricedBindings[0] ? bindingId(pricedBindings[0].binding) : '';
  function patchRate(index: number, patch: Partial<FamilyModelPriceRate>) {
    props.onDraftChange({
      ...props.draft,
      price_rates: props.draft.price_rates.map((rate, candidateIndex) => candidateIndex === index ? { ...rate, ...patch } : rate),
    });
  }

  function patchRates(indexes: readonly number[], patch: Partial<FamilyModelPriceRate>) {
    const selected = new Set(indexes);
    props.onDraftChange({
      ...props.draft,
      price_rates: props.draft.price_rates.map((rate, index) => selected.has(index) ? { ...rate, ...patch } : rate),
    });
  }

  function bindingError(binding: FamilyModelBindingDraft, rates: readonly IndexedRate[]): string | undefined {
    for (const { index } of rates) {
      const prefix = `price_rates.${index}`;
      const error = validation.errors[prefix]
        ?? validation.errors[`${prefix}.unit_quantity`]
        ?? validation.errors[`${prefix}.unit_price`]
        ?? validation.errors[`${prefix}.fx_to_cny`]
        ?? validation.errors[`${prefix}.source_currency`];
      if (error) return error;
    }
    const missingPrefix = `price_rates.${binding.capability}.${binding.variant_key}.`;
    return Object.entries(validation.errors).find(([path]) => path.startsWith(missingPrefix))?.[1];
  }

  return (
    <section className="family-model-settings-editor" aria-labelledby="family-model-price-editor-title">
      <div className="family-model-settings-section-head">
        <div>
          <h2 id="family-model-price-editor-title">模型价格</h2>
          <p>价格为可选项。系统会按能力列出常见计费项，未填写的项目按 0 计算。</p>
        </div>
      </div>
      {enabledBindings.length === 0 ? (
        <p className="family-model-settings-empty-inline">请先在“能力配置”中启用至少一项能力。</p>
      ) : null}
      <div className="family-model-settings-price-groups">
        {PRICE_GROUPS.map((group) => {
          const groupedBindings = pricedBindings.filter(({ binding }) => group.capabilities.includes(binding.capability));
          if (groupedBindings.length === 0) return null;
          return (
            <section key={group.id} className="family-model-settings-price-group" aria-labelledby={`family-model-settings-price-group-${group.id}`}>
              <div className="family-model-settings-group-head">
                <h3 id={`family-model-settings-price-group-${group.id}`}>{group.label}</h3>
                <span>{groupedBindings.length} 个模型价格</span>
              </div>
              <div className="family-model-settings-price-list">
                {groupedBindings.map(({ binding, rates }) => {
                  const id = bindingId(binding);
                  const expanded = selectedBindingId === id;
                  const error = bindingError(binding, rates);
                  const currency = sharedRateValue(rates, 'source_currency');
                  const fxToCny = sharedRateValue(rates, 'fx_to_cny');
                  const indexes = rates.map(({ index }) => index);
                  return (
                    <article className={`family-model-settings-price-card ${expanded ? 'is-expanded' : ''}`} key={id}>
                      <div className="family-model-settings-price-head">
                        <button type="button" aria-expanded={expanded} aria-controls={`family-model-settings-price-panel-${id}`} onClick={() => setPreferredBindingId(id)}>
                          <div className="family-model-settings-price-head-info">
                            <div>
                              <strong>{FAMILY_MODEL_CAPABILITY_OPTIONS[binding.capability].label}</strong>
                              <span>{binding.requested_model || '未填写模型'} · {rates.length} 个计费项</span>
                            </div>
                          </div>
                          <span className={`family-model-settings-binding-chevron ${expanded ? 'is-expanded' : ''}`} aria-hidden="true">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="m6 9 6 6 6-6" />
                            </svg>
                          </span>
                        </button>
                        <span className={`family-model-settings-price-status ${error ? 'is-error' : ''}`}>
                          {error ? '待修正' : binding.variant_key}
                        </span>
                      </div>
                      {expanded ? (
                        <div id={`family-model-settings-price-panel-${id}`} className="family-model-settings-price-panel">
                          <div className="family-model-settings-price-panel-head">
                            <strong>计费项</strong>
                            <span>价格单位已按模型类型设置</span>
                          </div>
                          <div className="family-model-settings-meter-grid">
                            {rates.map(({ rate, index }) => {
                              const label = FAMILY_MODEL_METER_LABELS[rate.meter] ?? rate.meter;
                              return (
                                <label className="family-model-settings-meter-field" key={rateId(rate)}>
                                  <span className="family-model-settings-meter-field-label">
                                    <strong>{label}</strong>
                                    <small>{currency || '币种待统一'} / {unitDescription(rate)}</small>
                                  </span>
                                  <input
                                    aria-label={`${label} 单价`}
                                    inputMode="decimal"
                                    value={rate.unit_price}
                                    disabled={props.busy}
                                    onChange={(event) => patchRate(index, { unit_price: event.target.value })}
                                  />
                                </label>
                              );
                            })}
                          </div>
                          <div className="family-model-settings-settlement-row">
                            <div className="family-model-settings-settlement-copy">
                              <strong>结算设置</strong>
                              <span>同一模型的所有计费项共用币种和汇率。</span>
                            </div>
                            <div className="family-model-settings-settlement-fields">
                              <label className="family-model-settings-field">
                                <span>币种</span>
                                <input
                                  value={currency}
                                  placeholder="多个币种"
                                  maxLength={8}
                                  disabled={props.busy}
                                  onChange={(event) => patchRates(indexes, { source_currency: event.target.value.toUpperCase() })}
                                />
                              </label>
                              <label className="family-model-settings-field">
                                <span>兑人民币汇率</span>
                                <input
                                  inputMode="decimal"
                                  value={fxToCny}
                                  placeholder="多个汇率"
                                  disabled={props.busy}
                                  onChange={(event) => patchRates(indexes, { fx_to_cny: event.target.value })}
                                />
                              </label>
                            </div>
                          </div>
                          {rates.some(({ rate }) => rate.unit_price === '0' || /^0\.0+$/.test(rate.unit_price)) ? (
                            <p className="family-model-settings-zero-price-note">当前按 0 元计算，可在获得服务商报价后随时补充。</p>
                          ) : null}
                          {error ? <p className="family-model-settings-field-error" role="alert">{error}</p> : null}
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
      {!validation.valid ? <p className="family-model-settings-validation-note" role="status">部分价格格式需要调整；其他修改仍会自动保存。</p> : null}
    </section>
  );
}
