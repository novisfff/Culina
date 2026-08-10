// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ModelUsageBreakdownItem, ModelUsageMeasurementHealth } from '../../api/types';
import { ModelUsageTrend } from './ModelUsageTrend';

function health(): ModelUsageMeasurementHealth {
  return {
    exact_event_count: 1,
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
  };
}

function dailyItem(date: string, cost: string): ModelUsageBreakdownItem {
  return {
    label: `${date} / llm`,
    capability: 'llm',
    provider: null,
    billing_model: null,
    meter: null,
    meter_total: null,
    local_day: date,
    known_priced_cost_cny: cost,
    pricing_complete: true,
    unpriced_event_count: 0,
    total_cost_cny: cost,
    measurement_health: health(),
  };
}

describe('ModelUsageTrend', () => {
  it('provides an accessible daily-cost chart and a text summary of the highest day', () => {
    render(
      <ModelUsageTrend
        items={[
          dailyItem('2026-07-17', '0.400000000000'),
          dailyItem('2026-07-18', '1.250000000000'),
          dailyItem('2026-07-18', '0.250000000000'),
        ]}
      />,
    );

    expect(screen.getByRole('img', { name: '本月每日模型费用趋势' }))
      .toHaveAccessibleDescription(/已记录费用/);
    expect(screen.getByText(/本月最高已记录费用出现在 7 月 18 日/, { selector: 'p' })).toBeVisible();
    expect(screen.getByText(/¥1.50/, { selector: 'p' })).toBeVisible();
  });
});
