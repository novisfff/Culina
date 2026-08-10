import { isApiError } from '../../api/request';
import { businessDateKey } from '../../lib/date';
import type {
  ModelUsageBreakdown,
  ModelUsageCapability,
  ModelUsageCapabilityLimit,
  ModelUsageCostSummary,
  ModelUsageFamilyOverview,
  ModelUsageMeasurementHealth,
  ModelUsageMeterTotal,
  ModelUsagePersonalOverview,
  ModelUsagePolicy,
  UpdateModelUsagePolicyPayload,
} from '../../api/types';
import { MODEL_USAGE_CAPABILITY_METERS, MODEL_USAGE_HEALTH_OPTIONS } from './modelUsageOptions';

type ModelUsageOverview = ModelUsagePersonalOverview | ModelUsageFamilyOverview;

type ParsedDecimal = {
  integer: string;
  fraction: string;
  isZero: boolean;
};

function parseNonNegativeDecimal(value: string | null | undefined): ParsedDecimal | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return null;
  const integer = match[1] ?? '0';
  const fraction = match[2] ?? '';
  return {
    integer,
    fraction,
    isZero: /^0*$/.test(integer) && /^0*$/.test(fraction),
  };
}

function hasNonZeroDecimal(value: string | null | undefined) {
  return parseNonNegativeDecimal(value)?.isZero === false;
}

function roundedCents(decimal: ParsedDecimal): bigint {
  const hundredths = `${decimal.fraction}00`.slice(0, 2);
  const thirdDecimal = decimal.fraction[2] ?? '0';
  let cents = BigInt(decimal.integer) * 100n + BigInt(hundredths || '0');
  if (thirdDecimal >= '5') cents += 1n;
  return cents;
}

/** Formats a server Decimal only for display; policy payloads retain their original strings. */
export function formatModelUsageCny(value: string | null | undefined): string {
  const decimal = parseNonNegativeDecimal(value);
  if (!decimal) return '—';
  const cents = roundedCents(decimal);
  if (!decimal.isZero && cents === 0n) return '小于 ¥0.01';
  const yuan = cents / 100n;
  const centPart = String(cents % 100n).padStart(2, '0');
  return `¥${yuan}.${centPart}`;
}

export function costDisplay(summary: ModelUsageCostSummary): string {
  if (!summary.pricing_complete && !hasNonZeroDecimal(summary.known_priced_cost_cny)) return '未定价';
  const known = formatModelUsageCny(summary.known_priced_cost_cny);
  return summary.pricing_complete ? known : `已记录 ${known}，另有未定价用量`;
}

export function formatModelUsageQuantity(value: string): string {
  return value.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

export function capabilityMeterFallback(
  meterTotals: ModelUsageMeterTotal[],
  capability: ModelUsageCapability,
): ModelUsageMeterTotal | null {
  for (const total of meterTotals) {
    if (!MODEL_USAGE_CAPABILITY_METERS[capability].includes(total.meter)) continue;
    const matchingCapabilities = (Object.keys(MODEL_USAGE_CAPABILITY_METERS) as ModelUsageCapability[])
      .filter((candidate) => MODEL_USAGE_CAPABILITY_METERS[candidate].includes(total.meter));
    if (matchingCapabilities.length === 1) return total;
  }
  return null;
}

export function formatModelUsageTrackingStartedAt(value: string | null | undefined): string | null {
  if (!value) return null;
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return null;
  const [year, month, day] = businessDateKey(instant, 'Asia/Shanghai').split('-');
  if (!year || !month || !day) return null;
  return `${year} 年 ${Number(month)} 月 ${Number(day)} 日`;
}

export type ModelUsageHealthNoticeKind =
  | 'exact'
  | 'estimated'
  | 'unpriced'
  | 'uncertain'
  | 'pending'
  | 'conservative_unknown_execution'
  | 'known_unmeasured'
  | 'measurement_gap';

export interface ModelUsageHealthNotice {
  kind: ModelUsageHealthNoticeKind;
  title: string;
  description: string;
}

export function modelUsageHealthNotices(health: ModelUsageMeasurementHealth): ModelUsageHealthNotice[] {
  const notices: ModelUsageHealthNotice[] = [];
  if (health.exact_event_count > 0) {
    notices.push({
      kind: 'exact',
      title: MODEL_USAGE_HEALTH_OPTIONS.exact.title,
      description: `${health.exact_event_count} 次调用已精确计量。`,
    });
  }
  if (health.estimated_event_count > 0) {
    notices.push({
      kind: 'estimated',
      title: MODEL_USAGE_HEALTH_OPTIONS.estimated.title,
      description: `${health.estimated_event_count} 次调用采用估算用量，费用可能随后调整。`,
    });
  }
  if (health.unpriced_event_count > 0) {
    notices.push({
      kind: 'unpriced',
      title: MODEL_USAGE_HEALTH_OPTIONS.unpriced.title,
      description: `${health.unpriced_event_count} 次调用尚未定价，暂未计入上方费用。`,
    });
  }
  if (health.uncertain_attempt_count > 0) {
    notices.push({
      kind: 'uncertain',
      title: MODEL_USAGE_HEALTH_OPTIONS.uncertain.title,
      description: `${health.uncertain_attempt_count} 次调用仍在核对执行和结算情况。`,
    });
  }
  if (health.pending_attempt_count > 0) {
    notices.push({
      kind: 'pending',
      title: MODEL_USAGE_HEALTH_OPTIONS.pending.title,
      description: `${health.pending_attempt_count} 次调用正在等待结算。`,
    });
  }
  if (health.unresolved_unknown_execution_attempt_count > 0) {
    const cost = health.conservative_estimated_cost_cny;
    notices.push({
      kind: 'conservative_unknown_execution',
      title: MODEL_USAGE_HEALTH_OPTIONS.conservative_unknown_execution.title,
      description: cost === null
        ? `${health.unresolved_unknown_execution_attempt_count} 次调用的执行情况未知，金额暂时无法确认。`
        : `${health.unresolved_unknown_execution_attempt_count} 次调用的执行情况未知，已按约 ${formatModelUsageCny(cost)} 计入额度。`,
    });
  }
  if (health.known_unmeasured_attempt_count > 0) {
    notices.push({
      kind: 'known_unmeasured',
      title: MODEL_USAGE_HEALTH_OPTIONS.known_unmeasured.title,
      description: `${health.known_unmeasured_attempt_count} 次调用可定位，但尚未恢复具体用量。`,
    });
  }
  if (health.measurement_gap) {
    notices.push({
      kind: 'measurement_gap',
      title: MODEL_USAGE_HEALTH_OPTIONS.measurement_gap.title,
      description: '该时间段的模型用量计量可能不完整。',
    });
  }
  return notices;
}

export function actionableModelUsageHealthNotices(
  health: ModelUsageMeasurementHealth,
): ModelUsageHealthNotice[] {
  return modelUsageHealthNotices(health).filter((notice) => notice.kind !== 'exact');
}

function hasMeasuredUsage(
  overview: ModelUsageOverview,
  breakdown: ModelUsageBreakdown | null,
  dailyTrend: ModelUsageBreakdown | null,
): boolean {
  const health = overview.measurement_health;
  return Boolean(
    hasNonZeroDecimal(overview.known_priced_cost_cny) ||
      overview.unpriced_event_count > 0 ||
      overview.meter_totals.some((item) => hasNonZeroDecimal(item.quantity)) ||
      breakdown?.items.length ||
      dailyTrend?.items.length ||
      health.exact_event_count > 0 ||
      health.estimated_event_count > 0 ||
      health.unpriced_event_count > 0 ||
      health.uncertain_attempt_count > 0 ||
      health.pending_attempt_count > 0 ||
      health.unresolved_unknown_execution_attempt_count > 0 ||
      health.known_unmeasured_attempt_count > 0 ||
      health.measurement_gap,
  );
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error && reason.message ? reason.message : '暂时无法加载模型用量';
}

type WorkspaceDataState = {
  overview: ModelUsageOverview;
  breakdown: ModelUsageBreakdown | null;
  dailyTrend: ModelUsageBreakdown | null;
  cost: string;
  healthNotices: ModelUsageHealthNotice[];
  isRefreshing: boolean;
  isDailyTrendLoading: boolean;
  refreshError: string | null;
};

export type ModelUsageWorkspaceViewModel =
  | { state: 'loading' }
  | { state: 'error'; errorMessage: string }
  | ({ state: 'empty' | 'ready' } & WorkspaceDataState);

export function buildModelUsageWorkspaceViewModel(args: {
  overview: ModelUsageOverview | null;
  breakdown: ModelUsageBreakdown | null;
  dailyTrend: ModelUsageBreakdown | null;
  isInitialLoading: boolean;
  isRefreshing: boolean;
  isDailyTrendLoading: boolean;
  error: unknown;
}): ModelUsageWorkspaceViewModel {
  if (!args.overview) {
    if (args.isInitialLoading) return { state: 'loading' };
    return { state: 'error', errorMessage: errorMessage(args.error) };
  }

  const data: WorkspaceDataState = {
    overview: args.overview,
    breakdown: args.breakdown,
    dailyTrend: args.dailyTrend,
    cost: costDisplay(args.overview),
    healthNotices: modelUsageHealthNotices(args.overview.measurement_health),
    isRefreshing: args.isRefreshing,
    isDailyTrendLoading: args.isDailyTrendLoading,
    refreshError: args.error ? errorMessage(args.error) : null,
  };
  return {
    state: hasMeasuredUsage(args.overview, args.breakdown, args.dailyTrend) ? 'ready' : 'empty',
    ...data,
  };
}

export interface ModelUsagePolicyDraft extends UpdateModelUsagePolicyPayload {}

export type ModelUsagePolicyValidation =
  | { valid: true }
  | {
    valid: false;
    field: 'monthly_budget_cny' | 'capability_limits';
    message: string;
  };

/**
 * Keeps Decimal values as strings so policy payloads never pass through a
 * JavaScript number. An empty controlled field intentionally means no budget.
 */
export function normalizeModelUsageDecimalDraft(value: string): string | null {
  const normalized = value.trim();
  return normalized || null;
}

/**
 * Removes database-only trailing precision before a Decimal value enters an
 * editable form. The value stays a string, so no precision is lost through a
 * JavaScript number conversion.
 */
export function conciseModelUsageDecimalDraft(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.trim();
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(normalized) || !normalized.includes('.')) return normalized;
  const concise = normalized.replace(/0+$/, '').replace(/\.$/, '');
  return concise || '0';
}

export function validateModelUsagePolicyDraft(draft: ModelUsagePolicyDraft): ModelUsagePolicyValidation {
  const hasBudget = hasNonZeroDecimal(draft.monthly_budget_cny);
  if (draft.monthly_budget_cny !== null && !hasBudget) {
    return {
      valid: false,
      field: 'monthly_budget_cny',
      message: '家庭月预算需为大于 0 的金额，或留空不设置预算。',
    };
  }
  if ((draft.hard_limit_enabled || draft.capability_limits.length > 0) && !hasBudget) {
    return {
      valid: false,
      field: 'monthly_budget_cny',
      message: '开启限制前，请先填写大于 0 的家庭月预算。',
    };
  }
  if (new Set(draft.capability_limits.map((item) => item.capability)).size !== draft.capability_limits.length) {
    return {
      valid: false,
      field: 'capability_limits',
      message: '每项模型能力只能设置一个护栏。',
    };
  }
  for (const limit of draft.capability_limits) {
    if (!hasNonZeroDecimal(limit.limit_value)) {
      return {
        valid: false,
        field: 'capability_limits',
        message: '每项能力护栏都需要填写大于 0 的限制值。',
      };
    }
    if (limit.limit_kind === 'cost' && limit.meter !== null) {
      return {
        valid: false,
        field: 'capability_limits',
        message: '费用护栏不能同时选择计量项。',
      };
    }
    if (limit.limit_kind === 'meter' && (!limit.meter || !MODEL_USAGE_CAPABILITY_METERS[limit.capability].includes(limit.meter))) {
      return {
        valid: false,
        field: 'capability_limits',
        message: '所选计量项不适用于这项模型能力。',
      };
    }
  }
  return { valid: true };
}

function copyCapabilityLimits(limits: ModelUsageCapabilityLimit[]): ModelUsageCapabilityLimit[] {
  return limits.map((limit) => ({
    ...limit,
    limit_value: conciseModelUsageDecimalDraft(limit.limit_value) ?? '',
  }));
}

export function createModelUsagePolicyDraft(policy: ModelUsagePolicy): ModelUsagePolicyDraft {
  return {
    base_version_number: policy.version_number,
    monthly_budget_cny: conciseModelUsageDecimalDraft(policy.monthly_budget_cny),
    alerts_enabled: policy.alerts_enabled,
    hard_limit_enabled: policy.hard_limit_enabled,
    capability_limits: copyCapabilityLimits(policy.capability_limits),
    confirm_missing_price_impact: false,
  };
}

export function buildModelUsagePolicyPayload(draft: ModelUsagePolicyDraft): UpdateModelUsagePolicyPayload {
  return {
    base_version_number: draft.base_version_number,
    monthly_budget_cny: draft.monthly_budget_cny,
    alerts_enabled: draft.alerts_enabled,
    hard_limit_enabled: draft.hard_limit_enabled,
    capability_limits: copyCapabilityLimits(draft.capability_limits),
    confirm_missing_price_impact: draft.confirm_missing_price_impact,
  };
}

export interface ModelUsagePolicyConflict {
  current_policy: ModelUsagePolicy;
  current_version_number: number;
  recovery_hint: 'review_current_policy_and_reapply';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isModelUsagePolicy(value: unknown): value is ModelUsagePolicy {
  if (!isRecord(value)) return false;
  return (
    typeof value.version_number === 'number' &&
    (typeof value.monthly_budget_cny === 'string' || value.monthly_budget_cny === null) &&
    typeof value.alerts_enabled === 'boolean' &&
    typeof value.hard_limit_enabled === 'boolean' &&
    typeof value.budget_alert_revision === 'number' &&
    Array.isArray(value.capability_limits) &&
    typeof value.effective_at === 'string'
  );
}

export function policyConflictFromApiError(reason: unknown): ModelUsagePolicyConflict | null {
  if (!isApiError(reason) || reason.status !== 409 || !isRecord(reason.payload)) return null;
  const detail = reason.payload.detail;
  if (!isRecord(detail)) return null;
  if (
    detail.code !== 'model_usage_policy_conflict' ||
    !isModelUsagePolicy(detail.current_policy) ||
    typeof detail.current_version_number !== 'number' ||
    detail.recovery_hint !== 'review_current_policy_and_reapply'
  ) {
    return null;
  }
  return {
    current_policy: detail.current_policy,
    current_version_number: detail.current_version_number,
    recovery_hint: detail.recovery_hint,
  };
}

export function isModelUsageMissingPriceConfirmationRequired(reason: unknown): boolean {
  if (!isApiError(reason) || reason.status !== 422 || !isRecord(reason.payload)) return false;
  const detail = reason.payload.detail;
  return isRecord(detail) && detail.code === 'model_usage_missing_price_confirmation_required';
}
