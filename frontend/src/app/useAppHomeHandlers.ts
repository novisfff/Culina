import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { MealType, ShoppingListItem } from '../api/types';
import {
  buildHomeRestockForm,
  type HomeRestockFormState,
} from '../features/home/homeDashboardModel';
import type {
  AppNavigationTarget,
  CookLaunchContext,
  MealCreateSource,
} from './appNavigationModel';
import type { IngredientNavigationRequest } from './useAppGlobalSearchNavigation';

export const homeTargets = {
  food: (foodId: string): AppNavigationTarget => ({ workspace: 'eat', view: 'food', foodId }),
  plan: (foodPlanItemId: string): AppNavigationTarget => ({ workspace: 'eat', view: 'plan', foodPlanItemId }),
  history: (mealLogId?: string): AppNavigationTarget => ({ workspace: 'eat', view: 'history', mealLogId }),
  mealCreate: (source: MealCreateSource, foodId?: string): AppNavigationTarget => ({
    workspace: 'eat',
    view: 'meal-create',
    source,
    foodId,
  }),
  ingredients: (): AppNavigationTarget => ({ workspace: 'ingredients' }),
};

export type HomeRecommendedCookArgs = {
  foodId: string;
  recipeId: string;
  date: string;
  mealType: MealType;
  servings: number;
};

export type HomePlanCookArgs = {
  foodId: string;
  recipeId: string;
  foodPlanItemId: string;
  planDate: string;
  mealType: MealType;
  servings?: number;
  planItemBaseUpdatedAt: string;
};

type UseAppHomeHandlersArgs = {
  ingredientNavigationRequestIdRef: MutableRefObject<number>;
  setIngredientNavigationRequest: Dispatch<SetStateAction<IngredientNavigationRequest | null>>;
  navigate: (target: AppNavigationTarget) => void;
  setHomeRestockShoppingItemId: Dispatch<SetStateAction<string | null>>;
  setHomeRestockForm: Dispatch<SetStateAction<HomeRestockFormState | null>>;
  setHomeMealDetailId: Dispatch<SetStateAction<string | null>>;
  ingredients: Parameters<typeof buildHomeRestockForm>[1];
  /** Shared atomic shopping intake. Preferred over the legacy restock form. */
  openShoppingIntake?: (args?: { selectedItemId?: string }) => void;
};

/** Pure helper for tests and callers that need the target without side effects. */
export function buildHomeHandlers(args: Pick<UseAppHomeHandlersArgs, 'navigate'> & Partial<UseAppHomeHandlersArgs>) {
  const navigate = args.navigate;

  function openFood(foodId: string) {
    navigate(homeTargets.food(foodId));
  }

  function openPlan(foodPlanItemId: string) {
    navigate(homeTargets.plan(foodPlanItemId));
  }

  function openHistory(mealLogId?: string) {
    navigate(homeTargets.history(mealLogId));
  }

  function openMealCreate(source: MealCreateSource, foodId?: string) {
    navigate(homeTargets.mealCreate(source, foodId));
  }

  function startRecommendedRecipe(input: HomeRecommendedCookArgs) {
    const launchContext: CookLaunchContext = {
      date: input.date,
      mealType: input.mealType,
      servings: input.servings,
      source: { kind: 'direct' },
    };
    navigate({
      workspace: 'eat',
      view: 'cook',
      foodId: input.foodId,
      recipeId: input.recipeId,
      launchContext,
    });
  }

  function startPlanRecipe(input: HomePlanCookArgs) {
    const launchContext: CookLaunchContext = {
      date: input.planDate,
      mealType: input.mealType,
      servings: input.servings ?? 1,
      source: {
        kind: 'plan',
        foodPlanItemId: input.foodPlanItemId,
        planItemBaseUpdatedAt: input.planItemBaseUpdatedAt,
      },
    };
    navigate({
      workspace: 'eat',
      view: 'cook',
      foodId: input.foodId,
      recipeId: input.recipeId,
      launchContext,
    });
  }

  return {
    openFood,
    openPlan,
    openHistory,
    openMealCreate,
    startRecommendedRecipe,
    startPlanRecipe,
  };
}

export function useAppHomeHandlers(args: UseAppHomeHandlersArgs) {
  const semantic = buildHomeHandlers({ navigate: args.navigate });

  function nextIngredientRequestId() {
    args.ingredientNavigationRequestIdRef.current += 1;
    return args.ingredientNavigationRequestIdRef.current;
  }

  function openIngredientsCatalog() {
    args.setIngredientNavigationRequest({
      target: 'catalog',
      requestId: nextIngredientRequestId(),
    });
    args.navigate(homeTargets.ingredients());
  }

  function openIngredientDetail(ingredientId: string) {
    args.setIngredientNavigationRequest({
      target: 'detail',
      ingredientId,
      requestId: nextIngredientRequestId(),
    });
    args.navigate(homeTargets.ingredients());
  }

  function openIngredientShopping(ingredientId: string) {
    args.setIngredientNavigationRequest({
      target: 'shopping',
      ingredientId,
      requestId: nextIngredientRequestId(),
    });
    args.navigate(homeTargets.ingredients());
  }

  function openIngredientPriority() {
    args.setIngredientNavigationRequest({
      target: 'priority',
      requestId: nextIngredientRequestId(),
    });
    args.navigate(homeTargets.ingredients());
  }

  function openHomeRestock(item: ShoppingListItem) {
    if (args.openShoppingIntake) {
      args.openShoppingIntake({ selectedItemId: item.id });
      return;
    }
    // Legacy fallback retained only when intake is not composed (tests).
    args.setHomeRestockShoppingItemId(item.id);
    args.setHomeRestockForm(buildHomeRestockForm(item, args.ingredients));
  }

  function closeHomeRestock() {
    args.setHomeRestockShoppingItemId(null);
    args.setHomeRestockForm(null);
  }

  function closeHomeMealDetail() {
    args.setHomeMealDetailId(null);
  }

  function updateHomeRestockForm(next: HomeRestockFormState) {
    args.setHomeRestockForm(next);
  }

  return {
    ...semantic,
    openIngredientsCatalog,
    openIngredientDetail,
    openIngredientShopping,
    openIngredientPriority,
    openHomeRestock,
    closeHomeRestock,
    closeHomeMealDetail,
    updateHomeRestockForm,
  };
}
