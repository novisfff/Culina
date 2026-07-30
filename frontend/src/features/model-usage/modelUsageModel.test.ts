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
  costDisplay,
  createModelUsagePolicyDraft,
  formatModelUsageCny,
  modelUsageHealthNotices,
  policyConflictFromApiError,
} from './modelUsageModel';
import {
  MODEL_USAGE_CAPABILITY_OPTIONS,
  MODEL_USAGE_ERROR_OPTIONS,
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
  });

  it('distinguishes first load, full error, empty data, ready data and stale refresh errors', () => {
    expect(buildModelUsageWorkspaceViewModel({
      overview: null,
      breakdown: null,
      isInitialLoading: true,
      isRefreshing: false,
      error: null,
    })).toMatchObject({ state: 'loading' });

    expect(buildModelUsageWorkspaceViewModel({
      overview: null,
      breakdown: null,
      isInitialLoading: false,
      isRefreshing: false,
      error: new Error('network down'),
    })).toMatchObject({ state: 'error', errorMessage: 'network down' });

    expect(buildModelUsageWorkspaceViewModel({
      overview: personalOverview(),
      breakdown: null,
      isInitialLoading: false,
      isRefreshing: false,
      error: null,
    })).toMatchObject({ state: 'empty', cost: '¥0.00' });

    const ready = buildModelUsageWorkspaceViewModel({
      overview: personalOverview({
        known_priced_cost_cny: '1.000000000000',
        total_cost_cny: '1.000000000000',
        meter_totals: [{ meter: 'input_tokens', quantity: '100.000000000000' }],
      }),
      breakdown: null,
      isInitialLoading: false,
      isRefreshing: true,
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

    expect(draft.monthly_budget_cny).toBe('80.005000000000');
    expect(draft.capability_limits[0]?.limit_value).toBe('12.345000000000');
    expect(payload).toEqual({
      base_version_number: 3,
      monthly_budget_cny: '80.005000000000',
      alerts_enabled: true,
      hard_limit_enabled: false,
      capability_limits: [{
        capability: 'llm',
        limit_kind: 'cost',
        meter: null,
        limit_value: '12.345000000000',
        enabled: true,
      }],
      confirm_missing_price_impact: false,
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
});
