import type { Ingredient } from '../api/types';

export function tracksIngredientQuantity(ingredient: Pick<Ingredient, 'quantity_tracking_mode'> | null | undefined) {
  return ingredient?.quantity_tracking_mode !== 'not_track_quantity';
}

export function quantityTrackingLabel(ingredient: Pick<Ingredient, 'quantity_tracking_mode'> | null | undefined) {
  return tracksIngredientQuantity(ingredient) ? '记录数量' : '只记录有无';
}
