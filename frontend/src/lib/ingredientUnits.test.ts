import { describe, expect, it } from 'vitest';
import {
  convertInventoryQuantityToDefault,
  convertInventoryRemainingToDefault,
  convertQuantityFromDefaultUnit,
  convertQuantityToDefaultUnit,
  getIngredientAvailableQuantityInDefault,
  getIngredientUnitConversions,
  getIngredientUnitOptions,
  getInventoryConsumedQuantity,
  getInventoryRemainingQuantity,
  normalizeIngredientUnit,
  resolveIngredientUnitRatio,
  resolvePreferredIngredientUnit,
} from './ingredientUnits';

const eggIngredient = {
  default_unit: '个',
  unit_conversions: [
    { unit: ' 打 ', ratio_to_default: 12 },
    { unit: '个', ratio_to_default: 1 },
    { unit: '', ratio_to_default: 2 },
    { unit: '盒', ratio_to_default: Number.NaN },
    { unit: '袋', ratio_to_default: 0 },
  ],
};

describe('ingredient unit helpers', () => {
  it('normalizes units and filters invalid or duplicate conversions', () => {
    expect(normalizeIngredientUnit('  个  ')).toBe('个');
    expect(normalizeIngredientUnit(null)).toBe('');
    expect(getIngredientUnitConversions(eggIngredient)).toEqual([{ unit: '打', ratio_to_default: 12 }]);
    expect(getIngredientUnitOptions(eggIngredient)).toEqual([
      { unit: '个', ratio_to_default: 1 },
      { unit: '打', ratio_to_default: 12 },
    ]);
  });

  it('resolves ratios and preferred units with safe fallbacks', () => {
    expect(resolveIngredientUnitRatio(eggIngredient, '个')).toBe(1);
    expect(resolveIngredientUnitRatio(eggIngredient, '打')).toBe(12);
    expect(resolveIngredientUnitRatio(eggIngredient, '盒')).toBeNull();
    expect(resolvePreferredIngredientUnit(eggIngredient, '打')).toBe('打');
    expect(resolvePreferredIngredientUnit(eggIngredient, '盒')).toBe('个');
    expect(resolvePreferredIngredientUnit(null, '盒')).toBe('盒');
  });

  it('converts quantities to and from default units with two-decimal rounding', () => {
    expect(convertQuantityToDefaultUnit(eggIngredient, 1.5, '打')).toBe(18);
    expect(convertQuantityFromDefaultUnit(eggIngredient, 5, '打')).toBe(0.42);
    expect(convertQuantityToDefaultUnit(eggIngredient, Number.NaN, '打')).toBeNull();
    expect(convertQuantityFromDefaultUnit(eggIngredient, 5, '盒')).toBeNull();
  });

  it('derives inventory remaining and consumed quantities defensively', () => {
    expect(getInventoryRemainingQuantity({ quantity: 5, remaining_quantity: 2 })).toBe(2);
    expect(getInventoryRemainingQuantity({ quantity: 5, remaining_quantity: -1 })).toBe(0);
    expect(getInventoryRemainingQuantity({ quantity: 5 })).toBe(5);
    expect(getInventoryConsumedQuantity({ quantity: 5, consumed_quantity: 3, remaining_quantity: 2 })).toBe(3);
    expect(getInventoryConsumedQuantity({ quantity: 5, remaining_quantity: 2 })).toBe(3);
    expect(getInventoryConsumedQuantity({ quantity: 5, remaining_quantity: 8 })).toBe(0);
  });

  it('converts inventory quantities and filters expired batches from availability', () => {
    expect(convertInventoryQuantityToDefault(eggIngredient, { quantity: 2, unit: '打' })).toBe(24);
    expect(convertInventoryRemainingToDefault(eggIngredient, { quantity: 2, remaining_quantity: 1.5, unit: '打' })).toBe(18);
    expect(
      getIngredientAvailableQuantityInDefault(
        eggIngredient,
        [
          { quantity: 1, remaining_quantity: 0.5, unit: '打', expiry_date: '2026-06-29' },
          { quantity: 6, remaining_quantity: 6, unit: '个', expiry_date: '2026-06-27' },
          { quantity: 2, remaining_quantity: 2, unit: '个', expiry_date: null },
        ],
        { excludeExpiredAt: '2026-06-28' }
      )
    ).toBe(8);
  });
});
