import { describe, expect, it } from 'vitest';
import { resolveFoodNavigationRequestAction } from './FoodNavigationModel';

const foods = [{ id: 'food-1' }, { id: 'food-2' }] as never[];

describe('FoodNavigationModel', () => {
  it('distinguishes pending, idle, edit and quick meal requests', () => {
    expect(resolveFoodNavigationRequestAction({ foods, navigationRequest: null, handledRequestId: null })).toEqual({ kind: 'idle' });
    expect(resolveFoodNavigationRequestAction({ foods, navigationRequest: { requestId: 1, foodId: 'missing', target: 'edit' }, handledRequestId: null })).toEqual({ kind: 'pending' });
    expect(resolveFoodNavigationRequestAction({ foods, navigationRequest: { requestId: 2, foodId: 'food-1', target: 'edit' }, handledRequestId: null })).toMatchObject({ kind: 'edit', requestId: 2 });
    expect(resolveFoodNavigationRequestAction({ foods, navigationRequest: { requestId: 3, foodId: 'food-2', target: 'quickMeal', quickMealAction: 'cook' }, handledRequestId: null })).toMatchObject({ kind: 'quickMeal', quickMealAction: 'cook' });
  });

  it('does not replay a handled request or detail-only request', () => {
    expect(resolveFoodNavigationRequestAction({ foods, navigationRequest: { requestId: 4, foodId: 'food-1', target: 'edit' }, handledRequestId: 4 })).toEqual({ kind: 'idle' });
    expect(resolveFoodNavigationRequestAction({ foods, navigationRequest: { requestId: 5, foodId: 'food-1', target: 'detail' }, handledRequestId: null })).toEqual({ kind: 'idle' });
  });
});
