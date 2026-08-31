import type { Food, MealType } from '../../api/types/food';
import type { MealLogCandidate, RecordMealTarget } from '../../api/types/meal';
import type { MealCandidateResolution } from '../../features/meals/MealComposerModel';

export type FoodQuickRecordState = {
  food: Food;
  date: string;
  mealType: MealType;
  target: RecordMealTarget;
  selectedCandidateId: string | null;
  candidateMode: 'none' | 'single' | 'multi';
  candidates: MealLogCandidate[];
  candidateResolution: MealCandidateResolution;
  targetTouchedByUser: boolean;
  clientRequestId: string;
  busy: boolean;
  error: string | null;
};

export function createFoodRecordClientRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `meal-record-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
