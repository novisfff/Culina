import type { Food } from '../../api/types/food';

export type FoodWorkspaceNavigationRequest = {
  requestId: number;
  foodId: string;
  target?: 'detail' | 'edit' | 'quickMeal';
  quickMealAction?: 'eat' | 'cook';
};

export type FoodNavigationRequestAction =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'edit'; food: Food; requestId: number }
  | { kind: 'quickMeal'; food: Food; requestId: number; quickMealAction: 'eat' | 'cook' };

export function resolveFoodNavigationRequestAction(args: {
  foods: Food[];
  navigationRequest?: FoodWorkspaceNavigationRequest | null;
  handledRequestId: number | null;
}): FoodNavigationRequestAction {
  const { foods, navigationRequest, handledRequestId } = args;
  if (!navigationRequest || navigationRequest.target === 'detail' || handledRequestId === navigationRequest.requestId) return { kind: 'idle' };
  const food = foods.find((item) => item.id === navigationRequest.foodId);
  if (!food) return { kind: 'pending' };
  if (navigationRequest.target === 'edit') return { kind: 'edit', food, requestId: navigationRequest.requestId };
  return { kind: 'quickMeal', food, requestId: navigationRequest.requestId, quickMealAction: navigationRequest.quickMealAction ?? 'eat' };
}
