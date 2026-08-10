import { useId, useState, type FormEvent } from 'react';
import type {
  ModelUsageCapability,
  ModelUsageCapabilityLimit,
  ModelUsageLimitKind,
  ModelUsageMeter,
  ModelUsagePolicy,
} from '../../api/types';
import { ActionButton, FormActions, StateBlock } from '../../components/ui-kit';
import {
  formatModelUsageCny,
  isModelUsageMissingPriceConfirmationRequired,
  normalizeModelUsageDecimalDraft,
  validateModelUsagePolicyDraft,
  type ModelUsagePolicyConflict,
  type ModelUsagePolicyDraft,
} from './modelUsageModel';
import {
  MODEL_USAGE_CAPABILITY_METERS,
  MODEL_USAGE_CAPABILITY_OPTIONS,
  MODEL_USAGE_METER_OPTIONS,
} from './modelUsageOptions';

export interface ModelUsagePolicySettingsProps {
  draft: ModelUsagePolicyDraft | null;
  policy: ModelUsagePolicy | null;
  isLoading: boolean;
  isError: boolean;
  isSaving: boolean;
  saveError: unknown;
  conflict: ModelUsagePolicyConflict | null;
  onRetry: () => void;
  onPatchDraft: (patch: Partial<ModelUsagePolicyDraft>) => void;
  onSave: () => Promise<ModelUsagePolicy | null>;
  onReviewConflict: () => void;
  onReapplyRetainedDraft: () => void;
  onSaved: () => void;
  formId?: string;
}

type CapabilityOptionEntry = [ModelUsageCapability, typeof MODEL_USAGE_CAPABILITY_OPTIONS.llm];

function ChevronIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m8 10 4 4 4-4" />
    </svg>
  );
}

function defaultCapabilityLimit(capability: ModelUsageCapability): ModelUsageCapabilityLimit {
  return {
    capability,
    limit_kind: 'cost',
    meter: null,
    limit_value: '1',
    enabled: true,
  };
}

function CapabilityGuardrail(props: {
  capability: ModelUsageCapability;
  option: typeof MODEL_USAGE_CAPABILITY_OPTIONS.llm;
  limit: ModelUsageCapabilityLimit | undefined;
  isSaving: boolean;
  onEnabledChange: (enabled: boolean) => void;
  onPatch: (patch: Partial<ModelUsageCapabilityLimit>) => void;
}) {
  const panelId = useId();
  const isEnabled = Boolean(props.limit?.enabled);
  const [isExpanded, setIsExpanded] = useState(isEnabled);
  const meters = MODEL_USAGE_CAPABILITY_METERS[props.capability];
  const activeKind = props.limit?.limit_kind ?? 'cost';
  const activeMeter = props.limit?.meter ?? meters[0] ?? null;
  const activeSummary = isEnabled
    ? activeKind === 'cost'
      ? `费用上限 ¥${props.limit?.limit_value ?? '1'}`
      : `${activeMeter ? MODEL_USAGE_METER_OPTIONS[activeMeter].label : '使用量'} ${props.limit?.limit_value ?? '1'}`
    : '未设置';

  function handleEnabledChange(enabled: boolean) {
    setIsExpanded(enabled);
    props.onEnabledChange(enabled);
  }

  return (
    <article className={['model-usage-policy-guardrail', isEnabled ? 'is-enabled' : '', isExpanded ? 'is-expanded' : ''].filter(Boolean).join(' ')}>
      <div className="model-usage-policy-guardrail-head">
        <button
          type="button"
          className="model-usage-policy-guardrail-expand"
          aria-expanded={isExpanded}
          aria-controls={panelId}
          aria-label={`${isExpanded ? '收起' : '展开'}${props.option.label}护栏设置`}
          disabled={!isEnabled || props.isSaving}
          onClick={() => setIsExpanded((current) => !current)}
        >
          <span className="model-usage-policy-guardrail-copy">
            <strong>{props.option.label}</strong>
            <small>{props.option.description}</small>
          </span>
          <span className={isEnabled ? 'is-enabled' : ''}>{activeSummary}</span>
          <ChevronIcon />
        </button>
        <label className="model-usage-policy-switch model-usage-policy-guardrail-switch">
          <input
            type="checkbox"
            aria-label={`${props.option.label}护栏`}
            checked={isEnabled}
            onChange={(event) => handleEnabledChange(event.target.checked)}
            disabled={props.isSaving}
          />
          <span aria-hidden="true" />
        </label>
      </div>
      {isExpanded && isEnabled ? (
        <div id={panelId} className="model-usage-policy-guardrail-fields">
          <label className="model-usage-policy-field">
            <span>护栏类型</span>
            <select
              aria-label={`${props.option.label}护栏类型`}
              value={activeKind}
              onChange={(event) => {
                const limitKind = event.target.value as ModelUsageLimitKind;
                props.onPatch({
                  limit_kind: limitKind,
                  meter: limitKind === 'meter' ? activeMeter : null,
                });
              }}
              disabled={props.isSaving}
            >
              <option value="cost">费用（元）</option>
              <option value="meter">使用量</option>
            </select>
          </label>
          {activeKind === 'meter' ? (
            <label className="model-usage-policy-field">
              <span>计量项</span>
              <select
                aria-label={`${props.option.label}计量项`}
                value={activeMeter ?? ''}
                onChange={(event) => props.onPatch({ meter: event.target.value as ModelUsageMeter })}
                disabled={props.isSaving}
              >
                {meters.map((meter) => <option key={meter} value={meter}>{MODEL_USAGE_METER_OPTIONS[meter].label}</option>)}
              </select>
            </label>
          ) : null}
          <label className="model-usage-policy-field">
            <span>{activeKind === 'cost' ? '费用上限（元）' : '使用量上限'}</span>
            <input
              aria-label={`${props.option.label}护栏上限`}
              inputMode="decimal"
              value={props.limit?.limit_value ?? ''}
              onChange={(event) => props.onPatch({
                limit_value: normalizeModelUsageDecimalDraft(event.target.value) ?? '',
              })}
              disabled={props.isSaving}
            />
          </label>
        </div>
      ) : null}
    </article>
  );
}

export function ModelUsagePolicySettings(props: ModelUsagePolicySettingsProps) {
  const generatedFormId = useId();
  const formId = props.formId ?? generatedFormId;
  const budgetInputId = `${formId}-monthly-budget`;
  const [hasAttemptedSave, setHasAttemptedSave] = useState(false);

  if (props.isLoading && !props.draft) {
    return <StateBlock status="loading" title="正在加载模型预算设置" description="正在读取当前家庭的提醒和限制。" />;
  }
  if (!props.draft) {
    return <StateBlock status="error" title="模型预算设置暂时不可用" description="请稍后重新加载当前设置。" actionLabel="重新加载" onAction={props.onRetry} />;
  }
  const draft = props.draft;
  const validation = validateModelUsagePolicyDraft(draft);
  const validationIssue = hasAttemptedSave && !validation.valid ? validation : null;
  const validationMessage = validationIssue?.message ?? null;
  const validationField = validationIssue?.field ?? null;
  const requiresMissingPriceConfirmation = draft.hard_limit_enabled
    && isModelUsageMissingPriceConfirmationRequired(props.saveError);
  const showSaveError = Boolean(props.saveError) && !requiresMissingPriceConfirmation && !props.conflict;

  function updateCapabilityLimit(capability: ModelUsageCapability, patch: Partial<ModelUsageCapabilityLimit>) {
    const current = draft.capability_limits;
    const existing = current.find((item) => item.capability === capability);
    const next = { ...(existing ?? defaultCapabilityLimit(capability)), ...patch };
    props.onPatchDraft({
      capability_limits: existing
        ? current.map((item) => item.capability === capability ? next : item)
        : [...current, next],
    });
  }

  function setCapabilityLimitEnabled(capability: ModelUsageCapability, enabled: boolean) {
    if (!enabled) {
      props.onPatchDraft({
        capability_limits: draft.capability_limits.filter((item) => item.capability !== capability),
      });
      return;
    }
    updateCapabilityLimit(capability, { enabled: true });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (props.isSaving) return;
    setHasAttemptedSave(true);
    if (!validation.valid) return;
    if (requiresMissingPriceConfirmation && !draft.confirm_missing_price_impact) return;
    try {
      const saved = await props.onSave();
      if (saved) props.onSaved();
    } catch {
      // The draft is intentionally retained by the policy hook after a failed save.
    }
  }

  return (
    <form id={formId} className="model-usage-policy-settings" onSubmit={handleSubmit} aria-busy={props.isSaving || undefined}>
      {props.conflict ? (
        <section className="model-usage-policy-conflict" role="status" aria-label="预算设置冲突">
          <div>
            <h2>预算设置已被更新</h2>
            <p>你的修改仍然保留。先查看最新设置，再决定是否重新应用。</p>
          </div>
          <ul className="model-usage-policy-conflict-summary">
            <li>当前版本：{props.conflict.current_version_number}</li>
            <li>家庭月预算：{formatModelUsageCny(props.conflict.current_policy.monthly_budget_cny)}</li>
            <li>{props.conflict.current_policy.hard_limit_enabled ? '已开启家庭硬限制' : '未开启家庭硬限制'}</li>
            <li>{props.conflict.current_policy.capability_limits.length} 项能力护栏</li>
          </ul>
          <div className="model-usage-policy-conflict-actions">
            <ActionButton tone="secondary" type="button" onClick={props.onReviewConflict} disabled={props.isSaving}>查看最新设置</ActionButton>
            <ActionButton tone="primary" type="button" onClick={props.onReapplyRetainedDraft} disabled={props.isSaving}>重新应用保留的修改</ActionButton>
          </div>
        </section>
      ) : null}
      {showSaveError ? (
        <StateBlock
          status="error"
          title="保存未完成"
          description="当前修改已保留，请检查设置后重试。"
          className="model-usage-policy-save-error"
        />
      ) : null}
      <section className="model-usage-policy-summary" role="region" aria-label="当前预算策略">
        <div className="model-usage-policy-summary-head">
          <p>当前设置</p>
          <strong>{draft.monthly_budget_cny ? formatModelUsageCny(draft.monthly_budget_cny) : '未设置预算'}</strong>
        </div>
        <div className="model-usage-policy-summary-facts">
          <span className={draft.alerts_enabled ? 'is-on' : ''}>预算提醒{draft.alerts_enabled ? '已开启' : '未开启'}</span>
          <span className={draft.hard_limit_enabled ? 'is-warning' : ''}>硬限制{draft.hard_limit_enabled ? '已开启' : '未开启'}</span>
          <span>{draft.capability_limits.length} 项护栏</span>
        </div>
      </section>

      <section className="model-usage-policy-section model-usage-policy-budget-section" aria-labelledby="model-usage-policy-budget-heading">
        <div className="model-usage-policy-section-head">
          <h2 id="model-usage-policy-budget-heading">家庭月预算</h2>
          <p>用于预算提醒和硬限制；不设置也会继续记录用量。</p>
        </div>
        <div className="model-usage-policy-field">
          <label htmlFor={budgetInputId}>家庭月预算（元）</label>
          <span className="model-usage-policy-money-input">
            <span aria-hidden="true">¥</span>
            <input
              id={budgetInputId}
              aria-label="家庭月预算（元）"
              inputMode="decimal"
              placeholder="不设置"
              value={draft.monthly_budget_cny ?? ''}
              onChange={(event) => props.onPatchDraft({
                monthly_budget_cny: normalizeModelUsageDecimalDraft(event.target.value),
              })}
              disabled={props.isSaving}
              aria-describedby="model-usage-budget-help"
              aria-invalid={validationField === 'monthly_budget_cny' ? true : undefined}
            />
            {draft.monthly_budget_cny ? (
              <button type="button" onClick={() => props.onPatchDraft({ monthly_budget_cny: null })} disabled={props.isSaving}>不设置</button>
            ) : null}
          </span>
        </div>
        <p id="model-usage-budget-help" className="model-usage-policy-help">按人民币填写，可输入小数。</p>
        {validationField === 'monthly_budget_cny' ? <p className="model-usage-policy-field-error" role="alert">{validationMessage}</p> : null}
      </section>

      <section className="model-usage-policy-section" aria-labelledby="model-usage-policy-limits-heading">
        <div className="model-usage-policy-section-head">
          <h2 id="model-usage-policy-limits-heading">提醒和限制</h2>
          <p>先提醒，再按需限制新请求。</p>
        </div>
        <label className="model-usage-policy-setting-row">
          <span className="model-usage-policy-setting-copy">
            <strong>预算提醒</strong>
            <small>用量接近预算时提醒家庭创建者</small>
          </span>
          <span className="model-usage-policy-switch">
            <input
              type="checkbox"
              aria-label="开启预算提醒"
              checked={draft.alerts_enabled}
              onChange={(event) => props.onPatchDraft({ alerts_enabled: event.target.checked })}
              disabled={props.isSaving}
            />
            <span aria-hidden="true" />
          </span>
        </label>
        <label className="model-usage-policy-setting-row">
          <span className="model-usage-policy-setting-copy">
            <strong>家庭硬限制</strong>
            <small>预算或能力额度达到上限后阻止新请求</small>
          </span>
          <span className="model-usage-policy-switch">
            <input
              type="checkbox"
              aria-label="开启家庭硬限制"
              checked={draft.hard_limit_enabled}
              onChange={(event) => props.onPatchDraft({ hard_limit_enabled: event.target.checked })}
              disabled={props.isSaving}
              aria-describedby={draft.hard_limit_enabled ? 'model-usage-hard-limit-inflight-help' : undefined}
            />
            <span aria-hidden="true" />
          </span>
        </label>
        {draft.hard_limit_enabled ? (
          <p id="model-usage-hard-limit-inflight-help" className="model-usage-policy-impact-note">
            保存后，新发起的模型调用会按新额度检查；已经开始的调用，以及计量服务异常期间已经允许的调用，仍可能完成并计入本月用量。
          </p>
        ) : null}
        {requiresMissingPriceConfirmation ? (
          <label className="model-usage-price-confirmation">
            <input
              type="checkbox"
              checked={draft.confirm_missing_price_impact}
              onChange={(event) => props.onPatchDraft({ confirm_missing_price_impact: event.target.checked })}
              disabled={props.isSaving}
            />
            <span>我知道保存后，没有价格信息的新调用会被阻止。</span>
          </label>
        ) : null}
      </section>

      <section className="model-usage-policy-section" aria-labelledby="model-usage-policy-guardrails-heading">
        <div className="model-usage-policy-section-head">
          <div className="model-usage-policy-section-title-row">
            <h2 id="model-usage-policy-guardrails-heading">能力护栏</h2>
            <span>{draft.capability_limits.length} 项已启用</span>
          </div>
          <p>按能力设置费用或使用量上限，未启用的能力不受单项限制。</p>
        </div>
        <div className="model-usage-policy-guardrails">
          {(Object.entries(MODEL_USAGE_CAPABILITY_OPTIONS) as CapabilityOptionEntry[]).map(([capability, option]) => {
            const limit = draft.capability_limits.find((item) => item.capability === capability);
            return (
              <CapabilityGuardrail
                key={capability}
                capability={capability}
                option={option}
                limit={limit}
                isSaving={props.isSaving}
                onEnabledChange={(enabled) => setCapabilityLimitEnabled(capability, enabled)}
                onPatch={(patch) => updateCapabilityLimit(capability, patch)}
              />
            );
          })}
        </div>
        {validationField === 'capability_limits' ? <p className="model-usage-policy-field-error" role="alert">{validationMessage}</p> : null}
      </section>
    </form>
  );
}

export function ModelUsagePolicyFooter(props: {
  formId: string;
  isSaving: boolean;
  hasDraft: boolean;
  requiresMissingPriceConfirmation: boolean;
  hasMissingPriceConfirmation: boolean;
  onClose: () => void;
}) {
  const confirmationPending = props.requiresMissingPriceConfirmation && !props.hasMissingPriceConfirmation;
  return (
    <FormActions
      primaryLabel="保存设置"
      submittingLabel="正在保存设置…"
      primaryType="submit"
      primaryForm={props.formId}
      primaryDisabled={!props.hasDraft || confirmationPending}
      primaryDisabledReason={confirmationPending ? '请先确认缺价调用的影响。' : undefined}
      isSubmitting={props.isSaving}
      secondaryLabel="取消"
      onSecondary={props.onClose}
    />
  );
}
