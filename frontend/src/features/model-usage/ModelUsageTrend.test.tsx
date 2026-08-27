// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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

  it('renders every day including zero values in a horizontally scrollable 30-day track', () => {
    const { container } = render(
      <ModelUsageTrend
        window={{ startDate: '2026-07-25', endDate: '2026-08-23', periods: ['2026-07', '2026-08'] }}
        items={[dailyItem('2026-07-25', '1.000000000000'), dailyItem('2026-08-23', '0.000000000000')]}
      />,
    );

    expect(container.querySelectorAll('.model-usage-trend-val-badge')).toHaveLength(30);
    expect(container.querySelectorAll('.model-usage-trend-label')).toHaveLength(30);
    expect(container.querySelectorAll('.model-usage-trend-val-badge')[1]).toHaveTextContent('¥0.00');
    expect(screen.getByRole('region', { name: '最近 30 天每日费用，可横向滚动' })).toBeVisible();
    expect(screen.getByText('左右滑动查看全部 30 天')).toBeVisible();
  });

  it('positions the rolling chart at the latest dates after loading completes', () => {
    const scrollWidth = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(1200);
    const clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(320);
    const window = { startDate: '2026-07-25', endDate: '2026-08-23', periods: ['2026-07', '2026-08'] };
    const { rerender } = render(<ModelUsageTrend window={window} items={[]} isLoading />);

    rerender(<ModelUsageTrend window={window} items={[]} isLoading={false} />);

    expect(screen.getByRole('region', { name: '最近 30 天每日费用，可横向滚动' }).scrollLeft).toBe(880);
    scrollWidth.mockRestore();
    clientWidth.mockRestore();
  });
});
