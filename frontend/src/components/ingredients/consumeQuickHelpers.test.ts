import { describe, expect, it } from 'vitest';
import {
  buildConsumeQuickValues,
  clampConsumeQuantity,
  getConsumeRemainingQuantity,
  isConsumeAllSelected,
  resolveConsumeStep,
} from './consumeQuickHelpers';

describe('consumeQuickHelpers', () => {
  it('clamps consumption when switching to a unit with less remaining stock', () => {
    expect(clampConsumeQuantity(6, 3.5)).toBe(3.5);
    expect(clampConsumeQuantity(-1, 3.5)).toBe(0);
  });

  it('keeps consume step precision aligned with remaining quantity', () => {
    expect(resolveConsumeStep(2)).toBe(0.25);
    expect(resolveConsumeStep(0.8)).toBe(0.1);
    expect(resolveConsumeStep(0.3)).toBe(0.05);
    expect(resolveConsumeStep(0.12)).toBe(0.01);
  });

  it('builds quick presets with fraction labels and an all option for integer units', () => {
    expect(buildConsumeQuickValues('个', 2).map((item) => item.label)).toEqual(['1/4', '1/2', '1', '2', '全部']);
  });

  it('marks near-max values as all selected and computes remaining quantity', () => {
    expect(isConsumeAllSelected(1.75, 2)).toBe(true);
    expect(isConsumeAllSelected(1.5, 2)).toBe(false);
    expect(getConsumeRemainingQuantity(2, 1.75)).toBe(0.25);
  });
});
