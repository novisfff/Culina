import { describe, expect, it } from 'vitest';
import { quantityTrackingLabel, tracksIngredientQuantity } from './ingredientTracking';

describe('ingredient tracking helpers', () => {
  it('tracks quantity by default when mode is missing', () => {
    expect(tracksIngredientQuantity(undefined)).toBe(true);
    expect(tracksIngredientQuantity(null)).toBe(true);
    expect(tracksIngredientQuantity({})).toBe(true);
    expect(quantityTrackingLabel({})).toBe('记录数量');
  });

  it('recognizes presence-only ingredients', () => {
    const ingredient = { quantity_tracking_mode: 'not_track_quantity' as const };

    expect(tracksIngredientQuantity(ingredient)).toBe(false);
    expect(quantityTrackingLabel(ingredient)).toBe('只记录有无');
  });
});
