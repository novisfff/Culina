import { describe, expect, it } from 'vitest';
import type { Ingredient } from '../../api/types';
import { resolveShoppingFormSubmission } from './shoppingFormSubmission';

const chickenIngredient = {
  id: 'ingredient-chicken',
  name: '鸡',
  category: '禽肉',
  default_unit: '克',
  default_storage: '冷藏',
  quantity_tracking_mode: 'track_quantity',
} as Ingredient;

describe('resolveShoppingFormSubmission', () => {
  it('keeps other purchases free text even when the title matches an ingredient name', () => {
    const result = resolveShoppingFormSubmission({
      form: {
        targetType: 'free_text',
        ingredientId: '',
        foodId: '',
        title: '鸡',
        quantity: '2',
        unit: '份',
        reason: '周末备用',
      },
      ingredients: [chickenIngredient],
      foods: [],
    });

    expect(result).toEqual({
      ok: true,
      payload: {
        title: '鸡',
        quantity: 2,
        unit: '份',
        ingredient_id: null,
        food_id: null,
        quantity_mode: 'track_quantity',
        display_label: null,
        reason: '周末备用',
      },
    });
  });
});
