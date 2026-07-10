import { describe, expect, it } from 'vitest';

import { formatAiRate } from './AiQualityMetricsModel';

describe('formatAiRate', () => {
  it('formats a rate with exact counts', () => {
    expect(formatAiRate({ numerator: 4, denominator: 5, rate: 0.8 })).toBe('80%（4/5）');
  });

  it('labels an empty denominator as no samples', () => {
    expect(formatAiRate({ numerator: 0, denominator: 0, rate: null })).toBe('暂无样本');
  });
});
