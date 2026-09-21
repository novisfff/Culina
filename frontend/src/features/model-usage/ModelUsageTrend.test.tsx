// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
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
    const { container } = render(
      <ModelUsageTrend
        window={{ startDate: '2026-06-19', endDate: '2026-07-18', periods: ['2026-06', '2026-07'] }}
        items={[
          dailyItem('2026-07-17', '0.400000000000'),
          dailyItem('2026-07-18', '1.250000000000'),
          dailyItem('2026-07-18', '0.250000000000'),
        ]}
      />,
    );

    expect(screen.getByRole('img', { name: '最近 30 天每日模型费用趋势' }))
      .toHaveAccessibleDescription(/产生了费用/);
    expect(screen.getByText(/最高单日费用出现在 7 月 18 日/, { selector: 'p' })).toBeVisible();
    expect(screen.getByText(/¥1.50/, { selector: 'p' })).toBeVisible();
    expect(screen.queryByText('最高单日费用')).not.toBeInTheDocument();
    expect(screen.queryByText('有记录天数')).not.toBeInTheDocument();
    expect(container.querySelector('.model-usage-trend-line')).toBeInTheDocument();
    expect(container.querySelector('.model-usage-trend-area')).toBeInTheDocument();
  });

  it('keeps all 30 days available without a horizontal scroll track', () => {
    const { container } = render(
      <ModelUsageTrend
        window={{ startDate: '2026-07-25', endDate: '2026-08-23', periods: ['2026-07', '2026-08'] }}
        items={[dailyItem('2026-07-25', '1.000000000000')]}
      />,
    );
    expect(screen.queryByText('左右滑动查看全部 30 天')).not.toBeInTheDocument();
    expect(container.querySelectorAll('.model-usage-trend-val-badge')).toHaveLength(1);
    fireEvent.click(screen.getByText('查看每日费用'));
    const table = screen.getByRole('table', { name: '每日费用明细' });
    expect(table).toBeVisible();
    expect(table.querySelectorAll('tbody tr')).toHaveLength(30);
    expect(screen.getByText('7 月 25 日')).toBeVisible();
    expect(screen.getByText('8 月 23 日')).toBeVisible();
  });

  it.each([
    { items: [], message: '这 30 天还没有已计入费用的记录' },
    { items: [dailyItem('2026-08-23', '0')], message: '这 30 天已计入费用为 ¥0.00' },
  ])('distinguishes zero-priced records from no records: $message', ({ items, message }) => {
    render(<ModelUsageTrend window={{ startDate: '2026-07-25', endDate: '2026-08-23', periods: ['2026-07', '2026-08'] }} items={items} />);
    expect(screen.getByText(message)).toBeVisible();
    expect(screen.queryByText(/1 天产生了费用/)).not.toBeInTheDocument();
  });

  it('does not round a positive sub-cent peak down to a zero-cost label', () => {
    render(<ModelUsageTrend window={{ startDate: '2026-08-01', endDate: '2026-08-30', periods: ['2026-08'] }} items={[dailyItem('2026-08-23', '0.00001')]} />);
    expect(screen.getByRole('img', { name: '最近 30 天每日模型费用趋势' })).toHaveAccessibleDescription(/小于 ¥0.01/);
  });
});
