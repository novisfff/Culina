import { describe, expect, it } from 'vitest';
import { modelUsageBudgetBalance } from './modelUsagePresentationModel';

describe('model usage budget presentation', () => {
  it('keeps the actual overrun while capping only the visual bar', () => {
    expect(modelUsageBudgetBalance('80', '100')).toEqual({
      percentage: '125.0', progress: 100, exceeded: true, amount: '20.000000000000',
    });
  });
  it('subtracts small decimal reserves without floating point loss', () => {
    expect(modelUsageBudgetBalance('0.3', '0.1')?.amount).toBe('0.200000000000');
  });
  it('does not invent a balance when budget or measurement is absent', () => {
    expect(modelUsageBudgetBalance(null, '1')).toBeNull();
    expect(modelUsageBudgetBalance('0', '1')).toBeNull();
    expect(modelUsageBudgetBalance('10', null)).toBeNull();
  });
});
