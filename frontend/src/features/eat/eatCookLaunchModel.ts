import type { Food, FoodPlanItem, MealType, Recipe } from '../../api/types/food';
import type { CookLaunchContext } from '../../app/appNavigationModel';
import { todayKey } from '../../lib/ui';

/** selfMade foods linked to a recipe; cook/view require exactly one match. */
export function relatedSelfMadeFoods(foods: Food[], recipeId: string): Food[] {
  return foods.filter((food) => food.type === 'selfMade' && food.recipe_id === recipeId);
}

/** Build a direct or plan-backed cook launch context with an explicit OCC base. */
export function buildCookLaunchContext(args: {
  foodPlanItemId?: string;
  planItem?: Pick<FoodPlanItem, 'plan_date' | 'meal_type' | 'updated_at'> | null;
  fallbackDate?: string;
  fallbackMealType?: MealType;
  servings?: number;
}): CookLaunchContext {
  const fallbackDate = args.fallbackDate ?? todayKey();
  const fallbackMealType = args.fallbackMealType ?? 'dinner';
  const servings = args.servings != null && args.servings > 0 ? args.servings : 1;
  if (args.foodPlanItemId) {
    return {
      date: args.planItem?.plan_date ?? fallbackDate,
      mealType: args.planItem?.meal_type ?? fallbackMealType,
      servings,
      source: {
        kind: 'plan',
        foodPlanItemId: args.foodPlanItemId,
        planItemBaseUpdatedAt: args.planItem?.updated_at ?? '',
      },
    };
  }
  return { date: fallbackDate, mealType: fallbackMealType, servings, source: { kind: 'direct' } };
}

export function isCompletableCookLaunch(launch: CookLaunchContext): boolean {
  if (launch.source.kind === 'direct') return true;
  return Boolean(launch.source.planItemBaseUpdatedAt?.trim());
}

export function buildPlanCookLaunchContext(
  item: Pick<FoodPlanItem, 'id' | 'plan_date' | 'meal_type' | 'updated_at'>,
  recipe: Pick<Recipe, 'servings'>,
): CookLaunchContext {
  return buildCookLaunchContext({ foodPlanItemId: item.id, planItem: item, servings: recipe.servings });
}
