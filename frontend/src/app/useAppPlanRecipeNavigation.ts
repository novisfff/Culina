import { useCallback } from 'react';

export function useAppPlanRecipeNavigation<T extends { foodPlanItemId?: string; planDate?: string; mealType?: string; planItemBaseUpdatedAt?: string | null }>(args: {
  foodPlanDetail: { id: string; plan_date: string; meal_type: string; updated_at?: string | null } | null | undefined;
  startPlanRecipe: (input: T) => void;
}) {
  return useCallback((input: T) => {
    const latest = args.foodPlanDetail && args.foodPlanDetail.id === input.foodPlanItemId ? args.foodPlanDetail : null;
    args.startPlanRecipe({
      ...input,
      planDate: latest?.plan_date ?? input.planDate,
      mealType: latest?.meal_type ?? input.mealType,
      planItemBaseUpdatedAt: latest?.updated_at ?? input.planItemBaseUpdatedAt,
    });
  }, [args.foodPlanDetail, args.startPlanRecipe]);
}
