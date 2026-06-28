import { describe, expect, it } from 'vitest';
import { queryKeys } from './queryKeys';

describe('queryKeys', () => {
  it('normalizes search-oriented keys', () => {
    expect(queryKeys.ingredientSearch('  番茄  ')).toEqual(['ingredients', 'search', '番茄']);
    expect(queryKeys.foodPlan('2026-06-01', '2026-06-07', ' 晚餐 ')).toEqual([
      'food-plan',
      '2026-06-01',
      '2026-06-07',
      '晚餐',
    ]);
  });

  it('sorts global search scopes without mutating the input', () => {
    const scopes = ['recipe', 'ingredient', 'food'] as const;

    expect(queryKeys.search(' 番茄 ', scopes, 10, 5)).toEqual([
      'search',
      '番茄',
      'food,ingredient,recipe',
      10,
      5,
    ]);
    expect(scopes).toEqual(['recipe', 'ingredient', 'food']);
  });
});
