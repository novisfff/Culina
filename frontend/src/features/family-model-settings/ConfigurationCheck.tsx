import { useMemo } from 'react';
import { FAMILY_MODEL_REQUIRED_METERS, validateMoneyInput } from './familyModelSettingsModel';
import { FAMILY_MODEL_CAPABILITY_OPTIONS, profileSupportsCapability } from './familyModelSettingsOptions';
import type { FamilyModelSettingsSurfaceProps } from './familyModelSettingsViewTypes';

type ConfigurationCheckProps = Pick<FamilyModelSettingsSurfaceProps,
  | 'settings'
  | 'serverDraft'
  | 'draft'
  | 'validation'
  | 'busyAction'
  | 'errorMessage'
  | 'onValidate'
>;

type BindingPriceStatus = {
  label: string;
  detail: string;
  tone: 'ready' | 'partial' | 'zero' | 'disabled';
};

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m7 12 3 3 7-7" />
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
      <path d="M10.3 4.3 2.8 17.2A2 2 0 0 0 4.5 20h15a2 2 0 0 0 1.7-2.8L13.7 4.3a2 2 0 0 0-3.4 0Z" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function priceStatusForBinding(
  binding: ConfigurationCheckProps['draft']['bindings'][number],
  rates: ConfigurationCheckProps['draft']['price_rates'],
): BindingPriceStatus {
  if (!binding.enabled) {
    return { label: '未启用', detail: '启用后计算', tone: 'disabled' };
  }

  const expectedMeters = FAMILY_MODEL_REQUIRED_METERS[binding.capability];
  const bindingRates = rates.filter((candidate) => (
    candidate.capability === binding.capability
    && candidate.variant_key === binding.variant_key
    && expectedMeters.includes(candidate.meter)
  ));
  const invalidCount = bindingRates.filter((rate) => validateMoneyInput(rate.unit_price)).length;
  if (invalidCount > 0) {
    return { label: '价格需调整', detail: `${invalidCount} 项格式有误`, tone: 'partial' };
  }
  const positiveCount = expectedMeters.filter((meter) => {
    const rate = bindingRates.find((candidate) => candidate.meter === meter);
    if (!rate) return false;
    const value = Number(rate.unit_price);
    return Number.isFinite(value) && value > 0;
  }).length;
  const detail = `${positiveCount}/${expectedMeters.length} 项`;

  if (positiveCount === expectedMeters.length) {
    return { label: '价格已填写', detail, tone: 'ready' };
  }
  if (positiveCount === 0) {
    return { label: '按 0 计算', detail, tone: 'zero' };
  }
  return { label: '部分已填写', detail, tone: 'partial' };
}

export function ConfigurationCheck(props: ConfigurationCheckProps) {
  const busy = props.busyAction !== null;
  const availableProfiles = useMemo(
    () => props.settings.provider_profiles.filter((profile) => (
      !profile.archived && profile.status === 'active' && profile.credential.configured
    )),
    [props.settings.provider_profiles],
  );
  const enabledBindings = useMemo(
    () => props.draft.bindings.filter((binding) => binding.enabled),
    [props.draft.bindings],
  );
  const readyBindings = useMemo(
    () => enabledBindings.filter((binding) => (
      binding.requested_model.trim().length > 0
      && availableProfiles.some((profile) => (
        profile.id === binding.provider_profile_id && profileSupportsCapability(profile, binding.capability)
      ))
    )),
    [availableProfiles, enabledBindings],
  );
  const pricedBindings = useMemo(
    () => enabledBindings.filter((binding) => priceStatusForBinding(binding, props.draft.price_rates).tone === 'ready'),
    [enabledBindings, props.draft.price_rates],
  );

  const validationStatus = props.validation
    ? (props.validation.valid ? 'valid' : 'invalid')
    : props.serverDraft.validation_status;
  const validationErrors = props.validation?.errors ?? props.serverDraft.validation_errors;
  const hasValidationResult = validationStatus === 'valid' || validationStatus === 'invalid';
  const isValid = validationStatus === 'valid';
  const statusTone = !hasValidationResult ? 'pending' : isValid ? 'ready' : 'warning';
  const statusTitle = !hasValidationResult
    ? '等待配置检查'
    : isValid
      ? '配置状态良好'
      : validationErrors.length > 0
        ? `还有 ${validationErrors.length} 项需要完善`
        : '还有配置需要完善';

  return (
    <section className="family-model-settings-editor family-model-settings-review" aria-labelledby="family-model-settings-review-title">
      <div className="family-model-settings-section-head">
        <div>
          <h2 id="family-model-settings-review-title">配置检查</h2>
          <p>检查结果只用于提醒，不会阻止保存。信息完整后会自动生效，未填写的价格按 0 计算。</p>
        </div>
      </div>

      <section className={`family-model-settings-review-status is-${statusTone}`} aria-labelledby="family-model-settings-review-status-title" aria-live="polite">
        <div className="family-model-settings-review-status-main">
          <span className="family-model-settings-review-status-icon">
            {statusTone === 'ready' ? <CheckIcon /> : statusTone === 'warning' ? <AlertIcon /> : <ClockIcon />}
          </span>
          <div className="family-model-settings-review-status-copy">
            <span className="family-model-settings-review-eyebrow">当前配置状态</span>
            <h3 id="family-model-settings-review-status-title">{statusTitle}</h3>
            <p>{statusTone === 'warning'
              ? '检查只做提醒，当前可用配置不会被覆盖。'
              : statusTone === 'ready'
                ? '完整度检查已通过，后续修改仍会自动保存并在完整后生效。'
                : '配置会自动保存；你可以随时运行检查，确认还有哪些信息可以完善。'}</p>
          </div>
          <button className="ghost-button family-model-settings-review-check-button" type="button" disabled={busy} onClick={() => { void props.onValidate(); }}>
            {busy ? '正在检查…' : hasValidationResult ? '重新检查' : '立即检查'}
          </button>
        </div>
        <dl className="family-model-settings-review-metrics">
          <div>
            <dt>可用服务</dt>
            <dd>{availableProfiles.length} 个</dd>
          </div>
          <div>
            <dt>能力状态</dt>
            <dd>{readyBindings.length} 项能力已就绪</dd>
          </div>
          <div>
            <dt>价格已填</dt>
            <dd>{pricedBindings.length} 个模型</dd>
          </div>
        </dl>
      </section>

      <div className="family-model-settings-review-groups">
        <section className="family-model-settings-review-group family-model-settings-review-provider-summary" aria-labelledby="family-model-settings-review-providers">
          <div className="family-model-settings-group-head">
            <div className="family-model-settings-group-head-title">
              <span className="family-model-settings-review-group-icon is-provider" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="4" width="18" height="6" rx="2" />
                  <rect x="3" y="14" width="18" height="6" rx="2" />
                  <circle cx="7" cy="7" r="1" fill="currentColor" />
                  <circle cx="7" cy="17" r="1" fill="currentColor" />
                </svg>
              </span>
              <h3 id="family-model-settings-review-providers">Provider 服务</h3>
            </div>
            <span>{availableProfiles.length} 个可用服务</span>
          </div>
          <p>{availableProfiles.length > 0
            ? '服务凭据已配置，可以为下方启用的模型提供连接。'
            : '尚无已配置凭据的服务，启用的能力需要继续完善。'}</p>
        </section>

        <section className="family-model-settings-review-group" aria-labelledby="family-model-settings-review-capabilities">
          <div className="family-model-settings-group-head">
            <div className="family-model-settings-group-head-title">
              <span className="family-model-settings-review-group-icon is-capability" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 3l1.8 4.6L18.5 9.5l-4.7 1.9L12 16l-1.8-4.6L5.5 9.5l4.7-1.9L12 3Z" />
                </svg>
              </span>
              <h3 id="family-model-settings-review-capabilities">能力与价格</h3>
            </div>
            <span>{enabledBindings.length} 项启用</span>
          </div>
          <div className="family-model-settings-review-list">
            {props.draft.bindings.map((binding) => {
              const profile = props.settings.provider_profiles.find((candidate) => candidate.id === binding.provider_profile_id);
              const bindingReady = binding.enabled
                && binding.requested_model.trim().length > 0
                && Boolean(
                  profile
                  && profile.credential.configured
                  && profileSupportsCapability(profile, binding.capability),
                );
              const priceStatus = priceStatusForBinding(binding, props.draft.price_rates);
              const capabilityLabel = FAMILY_MODEL_CAPABILITY_OPTIONS[binding.capability].label;
              return (
                <article
                  className={binding.enabled ? 'is-enabled' : 'is-disabled'}
                  key={`${binding.capability}:${binding.variant_key}`}
                  aria-label={`${capabilityLabel} ${binding.variant_key}`}
                >
                  <div className="family-model-settings-review-model-name">
                    <span className={`family-model-settings-review-model-indicator ${bindingReady ? 'is-ready' : binding.enabled ? 'is-warning' : 'is-muted'}`} aria-hidden="true">
                      {bindingReady ? <CheckIcon /> : binding.enabled ? <AlertIcon /> : <ClockIcon />}
                    </span>
                    <div>
                      <strong>{capabilityLabel}</strong>
                      <span>{binding.variant_key}</span>
                    </div>
                  </div>
                  <p className="family-model-settings-review-model-service">{binding.enabled
                    ? `${profile?.display_name ?? '未选择 Provider'} · ${binding.requested_model || '未填写模型'}`
                    : '启用后可配置服务与模型'}</p>
                  <span className={`family-model-settings-review-model-state ${bindingReady ? 'is-ready' : binding.enabled ? 'is-warning' : 'is-muted'}`}>
                    {bindingReady ? '已就绪' : binding.enabled ? '待完善' : '未启用'}
                  </span>
                  <div className={`family-model-settings-review-price-state is-${priceStatus.tone}`}>
                    <span>价格</span>
                    <strong>{priceStatus.label}</strong>
                    <small>{priceStatus.detail}</small>
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        <section className="family-model-settings-review-group family-model-settings-review-search-summary" aria-labelledby="family-model-settings-review-search">
          <div className="family-model-settings-group-head">
            <div className="family-model-settings-group-head-title">
              <span className="family-model-settings-review-group-icon is-search" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              </span>
              <h3 id="family-model-settings-review-search">搜索索引</h3>
            </div>
            <span>{props.settings.active_search_profile_id ? '已启用' : '未启用'}</span>
          </div>
          <p>{props.settings.active_search_profile_id
            ? '当前搜索索引会继续服务，普通配置修改不会替换向量身份。'
            : '当前没有生效的家庭搜索索引。'}</p>
        </section>
      </div>
      {props.errorMessage ? <p className="family-model-settings-field-error" role="alert">{props.errorMessage}</p> : null}
    </section>
  );
}
