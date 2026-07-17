import { describe, expect, it } from 'vitest';
import { createFoodPlanDateOptions, resolveFoodPlanDate } from './foodPlanDateOptions';

describe('food plan dialog date window', () => {
  it('starts yesterday and exposes exactly seven dates', () => {
    expect(createFoodPlanDateOptions('2026-07-17')).toEqual([
      '2026-07-16',
      '2026-07-17',
      '2026-07-18',
      '2026-07-19',
      '2026-07-20',
      '2026-07-21',
      '2026-07-22',
    ]);
  });

  it('keeps an in-range explicit date and falls back to today outside the window', () => {
    expect(resolveFoodPlanDate('2026-07-18', '2026-07-17')).toBe('2026-07-18');
    expect(resolveFoodPlanDate('2026-07-13', '2026-07-17')).toBe('2026-07-17');
    expect(resolveFoodPlanDate(undefined, '2026-07-17')).toBe('2026-07-17');
  });
});
