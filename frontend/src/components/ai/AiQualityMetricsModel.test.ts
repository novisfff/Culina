import { describe, expect, it } from 'vitest';

import { formatAiRate, formatAiTokenCost, formatAiTokenCount } from './AiQualityMetricsModel';

describe('formatAiRate', () => {
  it('formats a rate with exact counts', () => {
    expect(formatAiRate({ numerator: 4, denominator: 5, rate: 0.8 })).toBe('80%（4/5）');
  });

  it('labels an empty denominator as no samples', () => {
    expect(formatAiRate({ numerator: 0, denominator: 0, rate: null })).toBe('暂无样本');
  });
});

describe('token usage formatters', () => {
  it('formats compact token counts', () => {
    expect(formatAiTokenCount(0)).toBe('0');
    expect(formatAiTokenCount(980)).toBe('980');
    expect(formatAiTokenCount(15200)).toBe('15.2K');
    expect(formatAiTokenCount(152000)).toBe('152K');
  });

  it('formats optional estimated cost', () => {
    expect(formatAiTokenCost(0)).toBe('—');
    expect(formatAiTokenCost(0.0042)).toBe('$0.0042');
    expect(formatAiTokenCost(0.21)).toBe('$0.21');
  });
});
