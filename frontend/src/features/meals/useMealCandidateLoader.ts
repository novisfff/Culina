import { useCallback } from 'react';
import { api } from '../../api/client';
import type { MealLogCandidate, MealType } from '../../api/types/meal';

export type MealCandidateLoader = (
  date: string,
  mealType: MealType,
) => Promise<MealLogCandidate[]>;

/**
 * Provides the imperative candidate loader required by legacy meal flows.
 * Keeping the transport call here prevents App from owning meal feature data access.
 */
export function useMealCandidateLoader(): MealCandidateLoader {
  return useCallback(
    (date: string, mealType: MealType) => api.getMealCandidates(date, mealType),
    [],
  );
}
