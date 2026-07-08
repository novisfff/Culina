import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { Food, FoodPlanItem } from '../api/types';
import type { GlobalSearchSelection } from '../features/search/GlobalSearchOverlay';
import type { TabKey } from './AppShell';

export type IngredientNavigationRequest = {
  view: 'catalog' | 'detail';
  ingredientId?: string;
  requestId: number;
};

export type FoodNavigationRequest = {
  foodId: string;
  requestId: number;
  target?: 'detail' | 'edit' | 'quickMeal';
  quickMealAction?: 'eat' | 'cook';
};

export type RecipeNavigationRequest = {
  recipeId: string;
  requestId: number;
};

export type FoodPlanNavigationRequest = {
  itemId: string;
  planDate: string;
  requestId: number;
};

type UseAppGlobalSearchNavigationArgs = {
  foods: Food[];
  isPhoneViewport: boolean;
  setActiveTab: Dispatch<SetStateAction<TabKey>>;
  setSelectedRecipePlanDate: Dispatch<SetStateAction<string>>;
};

export function useAppGlobalSearchNavigation(args: UseAppGlobalSearchNavigationArgs) {
  const { foods, isPhoneViewport, setActiveTab, setSelectedRecipePlanDate } = args;
  const [ingredientNavigationRequest, setIngredientNavigationRequest] = useState<IngredientNavigationRequest | null>(null);
  const [foodNavigationRequest, setFoodNavigationRequest] = useState<FoodNavigationRequest | null>(null);
  const [foodPlanNavigationRequest, setFoodPlanNavigationRequest] = useState<FoodPlanNavigationRequest | null>(null);
  const [recipeNavigationRequest, setRecipeNavigationRequest] = useState<RecipeNavigationRequest | null>(null);
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const ingredientNavigationRequestIdRef = useRef(0);
  const foodNavigationRequestIdRef = useRef(0);
  const foodPlanNavigationRequestIdRef = useRef(0);
  const recipeNavigationRequestIdRef = useRef(0);

  const openRecipeTarget = useCallback((recipeId: string) => {
    if (isPhoneViewport) {
      const linkedFood = foods.find((food) => food.recipe_id === recipeId);
      if (linkedFood) {
        foodNavigationRequestIdRef.current += 1;
        setFoodNavigationRequest({
          foodId: linkedFood.id,
          requestId: foodNavigationRequestIdRef.current,
        });
      }
      setActiveTab('foods');
      return;
    }

    recipeNavigationRequestIdRef.current += 1;
    setRecipeNavigationRequest({
      recipeId,
      requestId: recipeNavigationRequestIdRef.current,
    });
    setActiveTab('recipes');
  }, [foods, isPhoneViewport, setActiveTab]);

  const handleGlobalSearchSelect = useCallback((selection: GlobalSearchSelection) => {
    setGlobalSearchOpen(false);
    if (selection.entityType === 'ingredient') {
      ingredientNavigationRequestIdRef.current += 1;
      setIngredientNavigationRequest({
        view: 'detail',
        ingredientId: selection.entityId,
        requestId: ingredientNavigationRequestIdRef.current,
      });
      setActiveTab('ingredients');
      return;
    }
    if (selection.entityType === 'food') {
      foodNavigationRequestIdRef.current += 1;
      setFoodNavigationRequest({
        foodId: selection.entityId,
        requestId: foodNavigationRequestIdRef.current,
      });
      setActiveTab('foods');
      return;
    }
    if (selection.entityType === 'meal_plan') {
      const planItem = selection.item.entity as FoodPlanItem;
      foodPlanNavigationRequestIdRef.current += 1;
      if (planItem.plan_date) {
        setSelectedRecipePlanDate(planItem.plan_date);
      }
      setFoodPlanNavigationRequest({
        itemId: selection.entityId,
        planDate: planItem.plan_date,
        requestId: foodPlanNavigationRequestIdRef.current,
      });
      setActiveTab('foods');
      return;
    }
    openRecipeTarget(selection.entityId);
  }, [openRecipeTarget, setActiveTab, setSelectedRecipePlanDate]);

  return {
    ingredientNavigationRequest,
    setIngredientNavigationRequest,
    ingredientNavigationRequestIdRef,
    foodNavigationRequest,
    setFoodNavigationRequest,
    foodNavigationRequestIdRef,
    foodPlanNavigationRequest,
    recipeNavigationRequest,
    globalSearchOpen,
    setGlobalSearchOpen,
    handleGlobalSearchSelect,
  };
}
