import { useCallback, useRef, useState } from 'react';
import type { GlobalSearchSelection } from '../features/search/GlobalSearchOverlay';
import type { AppNavigationService } from './useAppNavigationState';

export type IngredientNavigationRequest =
  | { target: 'catalog'; requestId: number }
  | { target: 'detail'; ingredientId: string; requestId: number }
  | { target: 'shopping'; ingredientId: string; requestId: number }
  | { target: 'priority'; requestId: number };

/** @deprecated Eating detail opens via AppNavigationTarget; retained for FoodWorkspace embedded requests. */
export type FoodNavigationRequest = {
  foodId: string;
  requestId: number;
  target?: 'detail' | 'edit' | 'quickMeal';
  quickMealAction?: 'eat' | 'cook';
};

/** Recipe targets open via AppNavigationTarget; retained for embedded navigation requests. */
export type RecipeNavigationRequest = {
  recipeId: string;
  requestId: number;
};

/** Food plan item/week requests still consumed by FoodWorkspace plan surface adapters. */
export type FoodPlanNavigationRequest =
  | {
      target: 'item';
      itemId: string;
      planDate: string;
      requestId: number;
    }
  | {
      target: 'week';
      planDate: string;
      requestId: number;
    };

type UseAppGlobalSearchNavigationArgs = {
  navigate: AppNavigationService['navigate'];
};

/**
 * Global search → semantic AppNavigationTarget for eating entities.
 * Ingredient detail still uses the discriminated IngredientWorkspace request boundary in PR A.
 */
export function useAppGlobalSearchNavigation(args: UseAppGlobalSearchNavigationArgs) {
  const [ingredientNavigationRequest, setIngredientNavigationRequest] =
    useState<IngredientNavigationRequest | null>(null);
  const [foodPlanNavigationRequest, setFoodPlanNavigationRequest] =
    useState<FoodPlanNavigationRequest | null>(null);
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const ingredientNavigationRequestIdRef = useRef(0);
  const foodPlanNavigationRequestIdRef = useRef(0);

  const openFoodPlanWeek = useCallback((planDate: string) => {
    foodPlanNavigationRequestIdRef.current += 1;
    setFoodPlanNavigationRequest({
      target: 'week',
      planDate,
      requestId: foodPlanNavigationRequestIdRef.current,
    });
    args.navigate({ workspace: 'eat', view: 'plan' });
  }, [args.navigate]);

  const handleGlobalSearchSelect = useCallback(
    (selection: GlobalSearchSelection) => {
      setGlobalSearchOpen(false);
      if (selection.entityType === 'ingredient') {
        ingredientNavigationRequestIdRef.current += 1;
        setIngredientNavigationRequest({
          target: 'detail',
          ingredientId: selection.entityId,
          requestId: ingredientNavigationRequestIdRef.current,
        });
        args.navigate({ workspace: 'ingredients' });
        return;
      }
      if (selection.entityType === 'food') {
        args.navigate({ workspace: 'eat', view: 'food', foodId: selection.entityId });
        return;
      }
      if (selection.entityType === 'recipe') {
        args.navigate({ workspace: 'eat', view: 'recipe', recipeId: selection.entityId });
        return;
      }
      if (selection.entityType === 'meal_plan') {
        args.navigate({
          workspace: 'eat',
          view: 'plan',
          foodPlanItemId: selection.entityId,
        });
      }
    },
    [args.navigate],
  );

  return {
    ingredientNavigationRequest,
    setIngredientNavigationRequest,
    ingredientNavigationRequestIdRef,
    foodPlanNavigationRequest,
    openFoodPlanWeek,
    globalSearchOpen,
    setGlobalSearchOpen,
    handleGlobalSearchSelect,
  };
}
