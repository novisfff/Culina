// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ModelUsageMeasurementHealth } from '../../api/types';
import { ModelUsageHealth } from './ModelUsageHealth';

function health(overrides: Partial<ModelUsageMeasurementHealth> = {}): ModelUsageMeasurementHealth {
  return {
    exact_event_count: 2,
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

describe('ModelUsageHealth', () => {
  it('renders nothing when every recorded event is exact', () => {
    const { container } = render(<ModelUsageHealth health={health()} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('explains actionable pricing and estimation facts with their counts', () => {
    render(<ModelUsageHealth health={health({
      estimated_event_count: 2,
      unpriced_event_count: 3,
    })} />);

    expect(screen.getByRole('heading', { name: '需要核对的用量' })).toBeVisible();
    expect(screen.getByText('2 次调用采用估算用量，费用可能随后调整。')).toBeVisible();
    expect(screen.getByText('3 次调用尚未定价，暂未计入上方费用。')).toBeVisible();
    expect(screen.queryByText(/避免把未知情况伪装成精确数据/)).not.toBeInTheDocument();
  });
});
