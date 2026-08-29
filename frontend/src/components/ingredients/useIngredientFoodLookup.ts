import { api } from '../../api/client';
import type { Food } from '../../api/types';

export function useIngredientFoodLookup() {
  return async (title: string, foodId: string): Promise<Food | null> => {
    const candidates = await api.getFoods({ q: title, limit: 20 });
    return candidates.find((candidate) => candidate.id === foodId) ?? null;
  };
}
