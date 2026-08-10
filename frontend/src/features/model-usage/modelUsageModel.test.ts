import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/request';
import type {
  ModelUsageMeasurementHealth,
  ModelUsagePersonalOverview,
  ModelUsagePolicy,
} from '../../api/types';
import {
  buildModelUsagePolicyPayload,
  buildModelUsageWorkspaceViewModel,
  capabilityMeterFallback,
  costDisplay,
  createModelUsagePolicyDraft,
  formatModelUsageCny,
  isModelUsageMissingPriceConfirmationRequired,
  modelUsageHealthNotices,
  normalizeModelUsageDecimalDraft,
  policyConflictFromApiError,
  validateModelUsagePolicyDraft,
} from './modelUsageModel';
import {
  MODEL_USAGE_CAPABILITY_OPTIONS,
  MODEL_USAGE_CAPABILITY_METERS,
  MODEL_USAGE_ERROR_OPTIONS,
  MODEL_USAGE_HEALTH_OPTIONS,
  MODEL_USAGE_METER_OPTIONS,
} from './modelUsageOptions';

function health(overrides: Partial<ModelUsageMeasurementHealth> = {}): ModelUsageMeasurementHealth {
  return {
    exact_event_count: 0,
    estimated_event_count: 0,
    unpriced_event_count: 0,
    uncertain_attempt_count: 0,
    pending_attempt_count: 0,
    unresolved_unknown_execution_attempt_count: 0,
    conservative_estimated_cost_cny: null,
    known_unmeasured_attempt_count: 0,
    measurement_gap: false,
    measurement_gap_scope: [],
    gap_intervals: [],
    ...overrides,
  };
}

function personalOverview(overrides: Partial<ModelUsagePersonalOverview> = {}): ModelUsagePersonalOverview {
  return {
    family_id: 'family-1',
    scope: 'me',
    period: '2026-07',
    source: 'raw',
    is_partial_period: false,
    known_priced_cost_cny: '0.000000000000',
    pricing_complete: true,
    unpriced_event_count: 0,
    total_cost_cny: '0.000000000000',
    meter_totals: [],
    measurement_health: health(),
    family_budget_state: 'sufficient',
    ...overrides,
  };
}

function policy(overrides: Partial<ModelUsagePolicy> = {}): ModelUsagePolicy {
  return {
    version_number: 3,
    monthly_budget_cny: '80.005000000000',
    alerts_enabled: true,
    hard_limit_enabled: false,
    budget_alert_revision: 2,
    capability_limits: [
      {
        capability: 'llm',
        limit_kind: 'cost',
        meter: null,
        limit_value: '12.345000000000',
        enabled: true,
      },
    ],
    effective_at: '2026-07-01T00:00:00Z',
    ...overrides,
  };
}

describe('model usage display model', () => {
  it.each([
    ['0.000000000000', '¥0.00'],
    ['0.001000000000', '小于 ¥0.01'],
    ['12.345000000000', '¥12.35'],
  ])('formats CNY for display without reusing rounded values for policy (%s)', (raw, expected) => {
    expect(formatModelUsageCny(raw)).toBe(expected);
  });

  it('distinguishes all-unpriced and partially priced cost summaries', () => {
    expect(costDisplay({
      known_priced_cost_cny: '0.000000000000',
      pricing_complete: false,
      unpriced_event_count: 3,
    })).toBe('未定价');
    expect(costDisplay({
      known_priced_cost_cny: '12.345000000000',
      pricing_complete: false,
      unpriced_event_count: 1,
    })).toBe('已记录 ¥12.35，另有未定价用量');
  });

  it('keeps independent health facts visible without inventing an unknown cost', () => {
    const notices = modelUsageHealthNotices(health({
      exact_event_count: 1,
      estimated_event_count: 2,
      unpriced_event_count: 3,
      uncertain_attempt_count: 4,
      pending_attempt_count: 5,
      unresolved_unknown_execution_attempt_count: 6,
      conservative_estimated_cost_cny: '0.123000000000',
      known_unmeasured_attempt_count: 7,
      measurement_gap: true,
      measurement_gap_scope: ['llm'],
      gap_intervals: [{
        started_at: '2026-07-12T01:00:00Z',
        ended_at: '2026-07-12T01:10:00Z',
        scope: ['llm'],
        coverage: 'unknown_scope',
      }],
    }));

    expect(notices.map((notice) => notice.kind)).toEqual([
      'exact',
      'estimated',
      'unpriced',
      'uncertain',
      'pending',
      'conservative_unknown_execution',
      'known_unmeasured',
      'measurement_gap',
    ]);
    expect(notices.find((notice) => notice.kind === 'conservative_unknown_execution')?.description).toContain('约 ¥0.12');
    expect(notices.find((notice) => notice.kind === 'measurement_gap')?.description)
      .toBe('该时间段的模型用量计量可能不完整。');

    const unknownCostNotice = modelUsageHealthNotices(health({
      unresolved_unknown_execution_attempt_count: 1,
      conservative_estimated_cost_cny: null,
    })).find((notice) => notice.kind === 'conservative_unknown_execution');
    expect(unknownCostNotice?.description).toContain('金额暂时无法确认');
    expect(unknownCostNotice?.description).not.toContain('¥');
  });

  it('maps central labels instead of exposing backend enum text at call sites', () => {
    expect(MODEL_USAGE_CAPABILITY_OPTIONS.llm.label).toBe('文本与视觉理解');
    expect(MODEL_USAGE_METER_OPTIONS.generated_images.label).toBe('生成图片');
    expect(MODEL_USAGE_ERROR_OPTIONS.model_usage_budget_exceeded.title).toBe('本月模型额度已用完');
    expect(MODEL_USAGE_HEALTH_OPTIONS.conservative_unknown_execution.title).toBe('执行情况待确认');
    expect(MODEL_USAGE_HEALTH_OPTIONS.known_unmeasured.title).toBe('用量明细待恢复');
    expect(MODEL_USAGE_HEALTH_OPTIONS.measurement_gap.title).toBe('部分时段记录不完整');
  });

  it('keeps policy meter choices aligned with production provider billing contracts', () => {
    expect(MODEL_USAGE_CAPABILITY_METERS.rerank).toEqual(['input_tokens']);
    expect(MODEL_USAGE_CAPABILITY_METERS.realtime_audio).toEqual([
      'audio_input_seconds',
      'tts_characters',
    ]);
  });

  it('uses overview meter totals only when the meter identifies one capability', () => {
    const totals = [
      { meter: 'input_tokens' as const, quantity: '120.000000000000' },
      { meter: 'generated_images' as const, quantity: '2.000000000000' },
    ];

    expect(capabilityMeterFallback(totals, 'llm')).toBeNull();
    expect(capabilityMeterFallback(totals, 'rerank')).toBeNull();
    expect(capabilityMeterFallback(totals, 'image_generation')).toEqual(totals[1]);
  });

  it('distinguishes first load, full error, empty data, ready data and stale refresh errors', () => {
    expect(buildModelUsageWorkspaceViewModel({
      overview: null,
      breakdown: null,
      dailyTrend: null,
      isInitialLoading: true,
      isRefreshing: false,
      isDailyTrendLoading: false,
      error: null,
    })).toMatchObject({ state: 'loading' });

    expect(buildModelUsageWorkspaceViewModel({
      overview: null,
      breakdown: null,
      dailyTrend: null,
      isInitialLoading: false,
      isRefreshing: false,
      isDailyTrendLoading: false,
      error: new Error('network down'),
    })).toMatchObject({ state: 'error', errorMessage: 'network down' });

    expect(buildModelUsageWorkspaceViewModel({
      overview: personalOverview(),
      breakdown: null,
      dailyTrend: null,
      isInitialLoading: false,
      isRefreshing: false,
      isDailyTrendLoading: false,
      error: null,
    })).toMatchObject({ state: 'empty', cost: '¥0.00' });

    const ready = buildModelUsageWorkspaceViewModel({
      overview: personalOverview({
        known_priced_cost_cny: '1.000000000000',
        total_cost_cny: '1.000000000000',
        meter_totals: [{ meter: 'input_tokens', quantity: '100.000000000000' }],
      }),
      breakdown: null,
      dailyTrend: null,
      isInitialLoading: false,
      isRefreshing: true,
      isDailyTrendLoading: false,
      error: new Error('offline'),
    });
    expect(ready).toMatchObject({
      state: 'ready',
      cost: '¥1.00',
      isRefreshing: true,
      refreshError: 'offline',
    });
  });

  it('creates a policy draft and payload without converting Decimal strings', () => {
    const draft = createModelUsagePolicyDraft(policy());
    const payload = buildModelUsagePolicyPayload(draft);

    expect(draft.monthly_budget_cny).toBe('80.005');
    expect(draft.capability_limits[0]?.limit_value).toBe('12.345');
    expect(payload).toEqual({
      base_version_number: 3,
      monthly_budget_cny: '80.005',
      alerts_enabled: true,
      hard_limit_enabled: false,
      capability_limits: [{
        capability: 'llm',
        limit_kind: 'cost',
        meter: null,
        limit_value: '12.345',
        enabled: true,
      }],
      confirm_missing_price_impact: false,
    });
  });

  it('keeps a controlled Decimal draft as text while serializing an empty budget as null', () => {
    const draft = createModelUsagePolicyDraft(policy());
    draft.monthly_budget_cny = normalizeModelUsageDecimalDraft(' 80.005000000000 ');
    expect(draft.monthly_budget_cny).toBe('80.005000000000');

    draft.monthly_budget_cny = normalizeModelUsageDecimalDraft('');
    expect(buildModelUsagePolicyPayload(draft).monthly_budget_cny).toBeNull();
  });

  it('requires a positive monthly budget before enabling a hard limit or capability guardrail', () => {
    const hardLimitDraft = createModelUsagePolicyDraft(policy({ monthly_budget_cny: null, hard_limit_enabled: true }));
    expect(validateModelUsagePolicyDraft(hardLimitDraft)).toEqual({
      valid: false,
      field: 'monthly_budget_cny',
      message: '开启限制前，请先填写大于 0 的家庭月预算。',
    });

    const guardrailDraft = createModelUsagePolicyDraft(policy({ monthly_budget_cny: null }));
    expect(validateModelUsagePolicyDraft(guardrailDraft)).toEqual({
      valid: false,
      field: 'monthly_budget_cny',
      message: '开启限制前，请先填写大于 0 的家庭月预算。',
    });
  });

  it('rejects duplicated capabilities and meters that do not belong to their capability', () => {
    const duplicateDraft = createModelUsagePolicyDraft(policy({
      capability_limits: [
        { capability: 'llm', limit_kind: 'cost', meter: null, limit_value: '1', enabled: true },
        { capability: 'llm', limit_kind: 'cost', meter: null, limit_value: '2', enabled: true },
      ],
    }));
    expect(validateModelUsagePolicyDraft(duplicateDraft)).toEqual({
      valid: false,
      field: 'capability_limits',
      message: '每项模型能力只能设置一个护栏。',
    });

    const invalidMeterDraft = createModelUsagePolicyDraft(policy({
      capability_limits: [
        { capability: 'llm', limit_kind: 'meter', meter: 'generated_images', limit_value: '1', enabled: true },
      ],
    }));
    expect(validateModelUsagePolicyDraft(invalidMeterDraft)).toEqual({
      valid: false,
      field: 'capability_limits',
      message: '所选计量项不适用于这项模型能力。',
    });
  });

  it('parses a policy conflict while leaving unrelated API failures alone', () => {
    const currentPolicy = policy({ version_number: 4 });
    const conflict = policyConflictFromApiError(new ApiError({
      status: 409,
      detail: '预算设置已更新',
      path: '/api/model-usage/family/policy',
      payload: {
        detail: {
          code: 'model_usage_policy_conflict',
          current_policy: currentPolicy,
          current_version_number: 4,
          recovery_hint: 'review_current_policy_and_reapply',
        },
      },
    }));

    expect(conflict).toEqual({
      current_policy: currentPolicy,
      current_version_number: 4,
      recovery_hint: 'review_current_policy_and_reapply',
    });
    expect(policyConflictFromApiError(new Error('offline'))).toBeNull();
  });

  it('recognizes only the structured missing-price confirmation response', () => {
    expect(isModelUsageMissingPriceConfirmationRequired(new ApiError({
      status: 422,
      detail: '请确认缺价影响',
      path: '/api/model-usage/family/policy',
      payload: { detail: { code: 'model_usage_missing_price_confirmation_required' } },
    }))).toBe(true);
    expect(isModelUsageMissingPriceConfirmationRequired(new ApiError({
      status: 422,
      detail: '其他校验错误',
      path: '/api/model-usage/family/policy',
      payload: { detail: { code: 'model_usage_policy_validation_error' } },
    }))).toBe(false);
    expect(isModelUsageMissingPriceConfirmationRequired(new Error('offline'))).toBe(false);
  });
});
