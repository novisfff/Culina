// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { useAiQueries } from './useAiQueries';
import { useAppShellQueries } from './useAppShellQueries';
import { useEatQueries } from './useEatQueries';
import { useFamilyQueries } from './useFamilyQueries';
import { useFoodPlanQueries } from './useFoodPlanQueries';
import { useHomeQueries } from './useHomeQueries';
import { useIngredientQueries } from './useIngredientQueries';

describe('domain query contracts', () => {
  it('exports one hook for each query owner boundary', () => {
    expect([
      useAppShellQueries,
      useHomeQueries,
      useFoodPlanQueries,
      useIngredientQueries,
      useEatQueries,
      useFamilyQueries,
      useAiQueries,
    ]).toHaveLength(7);
  });
});
