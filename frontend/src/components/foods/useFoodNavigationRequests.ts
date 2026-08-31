import { useEffect, useRef } from 'react';
import type { Food, MealType } from '../../api/types/food';
import type { FoodWorkspaceNavigationRequest } from './FoodNavigationModel';
import { getDefaultMealType } from './FoodWorkspaceHelpers';
import { resolveFoodNavigationRequestAction } from './FoodNavigationModel';

export function useFoodNavigationRequests(args: {
  foods: Food[];
  navigationRequest?: FoodWorkspaceNavigationRequest | null;
  onEdit: (food: Food) => void;
  onQuickMeal: (food: Food, mealType: MealType, action: 'eat' | 'cook') => void;
}) {
  const handledRequestIdRef = useRef<number | null>(null);

  useEffect(() => {
    const action = resolveFoodNavigationRequestAction({
      foods: args.foods,
      navigationRequest: args.navigationRequest,
      handledRequestId: handledRequestIdRef.current,
    });
    if (action.kind === 'edit') {
      handledRequestIdRef.current = action.requestId;
      args.onEdit(action.food);
      return;
    }
    if (action.kind === 'quickMeal') {
      handledRequestIdRef.current = action.requestId;
      args.onQuickMeal(action.food, getDefaultMealType(action.food), action.quickMealAction);
    }
  }, [args.foods, args.navigationRequest, args.onEdit, args.onQuickMeal]);
}
