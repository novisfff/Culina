import { describe, expect, it } from 'vitest';
import type { ModelUsageBreakdownItem, ModelUsageMeterTotal } from '../../api/types';
import {
  buildCapabilityCostDistribution,
  buildModelUsageMeterGroups,
  buildModelUsageTrendPoints,
  buildModelUsageTrendWindow,
} from './modelUsageChartModel';

function capabilityItem(
  capability: NonNullable<ModelUsageBreakdownItem['capability']>,
  cost: string,
  overrides: Partial<ModelUsageBreakdownItem> = {},
): ModelUsageBreakdownItem {
  return {
    label: capability,
    capability,
    meter: null,
    meter_total: null,
    local_day: null,
    known_priced_cost_cny: cost,
    pricing_complete: true,
    unpriced_event_count: 0,
    measurement_health: {
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
    },
    ...overrides,
  };
}

describe('buildCapabilityCostDistribution', () => {
  it('aggregates duplicate capabilities, sorts by cost and calculates stable shares', () => {
    const result = buildCapabilityCostDistribution([
      capabilityItem('embedding', '3.000000000000'),
      capabilityItem('llm', '5.500000000000'),
      capabilityItem('llm', '1.500000000000'),
    ]);

    expect(result.totalCostCny).toBe('10.000000000000');
    expect(result.entries.map((entry) => entry.capability)).toEqual(['llm', 'embedding']);
    expect(result.entries.map((entry) => entry.sharePercent)).toEqual([70, 30]);
  });

  it('keeps an unpriced capability visible without inventing a priced share', () => {
    const result = buildCapabilityCostDistribution([
      capabilityItem('llm', 'invalid'),
      capabilityItem('image_generation', '0.000000000000', {
        pricing_complete: false,
        unpriced_event_count: 2,
      }),
      capabilityItem('embedding', '2.000000000000'),
    ]);

    expect(result.totalCostCny).toBe('2.000000000000');
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]).toMatchObject({ capability: 'embedding', sharePercent: 100 });
    expect(result.entries[1]).toMatchObject({
      capability: 'image_generation',
      sharePercent: 0,
      pricingComplete: false,
      unpricedEventCount: 2,
    });
  });

  it('handles all-zero and single-capability periods without dividing by zero', () => {
    expect(buildCapabilityCostDistribution([
      capabilityItem('llm', '0.000000000000'),
    ])).toMatchObject({ totalCostCny: '0.000000000000', entries: [] });

    expect(buildCapabilityCostDistribution([
      capabilityItem('tts', '0.005000000000'),
    ]).entries[0]).toMatchObject({ capability: 'tts', sharePercent: 100 });
  });
});

describe('buildModelUsageMeterGroups', () => {
  it('groups comparable units without calculating a cross-unit percentage', () => {
    const totals: ModelUsageMeterTotal[] = [
      { meter: 'input_tokens', quantity: '3200.000000000000' },
      { meter: 'embedding_tokens', quantity: '1400.000000000000' },
      { meter: 'audio_input_seconds', quantity: '45.500000000000' },
      { meter: 'tts_characters', quantity: '128.000000000000' },
      { meter: 'generated_images', quantity: '2.000000000000' },
      { meter: 'request_units', quantity: 'not-a-number' },
    ];

    const groups = buildModelUsageMeterGroups(totals);

    expect(groups.map((group) => group.unit)).toEqual(['tokens', 'seconds', 'characters', 'counts']);
    expect(groups[0]?.items.map((item) => item.quantityText)).toEqual(['3,200', '1,400']);
    expect(groups[1]?.items[0]).toMatchObject({ meter: 'audio_input_seconds', quantityText: '45.5' });
    expect(groups.flatMap((group) => group.items).every((item) => !('sharePercent' in item))).toBe(true);
  });

  it('merges repeated meters and hides zero totals', () => {
    const groups = buildModelUsageMeterGroups([
      { meter: 'generated_images', quantity: '1.000000000000' },
      { meter: 'generated_images', quantity: '2.000000000000' },
      { meter: 'rerank_requests', quantity: '0.000000000000' },
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.items).toEqual([
      expect.objectContaining({ meter: 'generated_images', quantityText: '3' }),
    ]);
  });
});

describe('model usage rolling trend', () => {
  it('builds a real 30-day window across a month boundary for the current period', () => {
    expect(buildModelUsageTrendWindow('2026-08', '2026-08-23')).toEqual({
      startDate: '2026-07-25',
      endDate: '2026-08-23',
      periods: ['2026-07', '2026-08'],
    });
    expect(buildModelUsageTrendWindow('2026-07', '2026-08-23')).toEqual({
      startDate: '2026-07-02',
      endDate: '2026-07-31',
      periods: ['2026-07'],
    });
  });

  it('keeps all 30 dates and distinguishes explicit zero records from filled gaps', () => {
    const window = buildModelUsageTrendWindow('2026-08', '2026-08-23');
    const points = buildModelUsageTrendPoints([
      capabilityItem('llm', '1.250000000000', { local_day: '2026-07-25' }),
      capabilityItem('embedding', '0.750000000000', { local_day: '2026-07-25' }),
      capabilityItem('llm', '0.000000000000', { local_day: '2026-08-23' }),
      capabilityItem('llm', '9.000000000000', { local_day: '2026-07-24' }),
    ], window);

    expect(points).toHaveLength(30);
    expect(points[0]).toMatchObject({ date: '2026-07-25', hasRecord: true });
    expect(points[0]?.amount).toBe(2_000_000_000_000n);
    expect(points[1]).toMatchObject({ date: '2026-07-26', amount: 0n, hasRecord: false });
    expect(points.at(-1)).toMatchObject({ date: '2026-08-23', amount: 0n, hasRecord: true });
  });
});
