// @vitest-environment node
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

it('resolves same-name ingredients by the selected ID', () => {
  const result = resolveShoppingFormSubmission({
    form: { targetType: 'ingredient', ingredientId: 'chosen', foodId: '', title: '鸡', quantity: '2', unit: '克', reason: '' },
    ingredients: [chickenIngredient, { ...chickenIngredient, id: 'chosen' }],
    foods: [],
  });
  expect(result).toMatchObject({ ok: true, payload: { ingredient_id: 'chosen', food_id: null } });
});

it('does not silently bind a missing selected ID to a same-name ingredient', () => {
  const result = resolveShoppingFormSubmission({
    form: { targetType: 'ingredient', ingredientId: 'missing', foodId: '', title: '鸡', quantity: '2', unit: '克', reason: '' },
    ingredients: [chickenIngredient], foods: [],
  });
  expect(result).toMatchObject({ ok: false, title: '先选择采购内容' });
});
