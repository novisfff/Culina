import type { Food, FoodPlanItem, Recipe } from '../api/types';
import type { AppNavigationTarget } from './appNavigationModel';
import { buildCookLaunchContext, relatedSelfMadeFoods } from '../features/eat/eatCookLaunchModel';
import { businessDateKey } from '../lib/date';

type Args = {
  foods: Food[];
  recipes: Recipe[];
  foodPlanItems: FoodPlanItem[];
  foodPlanDetail: FoodPlanItem | null;
  navigate: (target: AppNavigationTarget) => void;
};

export function useAppCookNavigation(args: Args) {
  function startRecipeCook(recipeId: string, foodPlanItemId?: string) {
    const related = relatedSelfMadeFoods(args.foods, recipeId);
    const recipe = args.recipes.find((item) => item.id === recipeId) ?? null;
    const planItem = foodPlanItemId
      ? ((args.foodPlanDetail?.id === foodPlanItemId ? args.foodPlanDetail : null)
        ?? args.foodPlanItems.find((item) => item.id === foodPlanItemId)
        ?? null)
      : null;
    if (foodPlanItemId && !planItem?.updated_at) {
      args.navigate({ workspace: 'eat', view: 'plan', foodPlanItemId });
      return;
    }
    if (related.length !== 1) {
      args.navigate({ workspace: 'eat', view: 'recipe', recipeId });
      return;
    }
    args.navigate({
      workspace: 'eat', view: 'cook', foodId: related[0].id, recipeId,
      launchContext: buildCookLaunchContext({ foodPlanItemId, planItem, servings: recipe?.servings }),
    });
  }

  function startCookWithFood(foodId: string, recipeId: string) {
    const recipe = args.recipes.find((item) => item.id === recipeId) ?? null;
    args.navigate({
      workspace: 'eat', view: 'cook', foodId, recipeId,
      launchContext: buildCookLaunchContext({
        fallbackDate: businessDateKey(new Date(), 'Asia/Shanghai'),
        fallbackMealType: 'dinner',
        servings: recipe?.servings,
      }),
    });
  }

  return { startRecipeCook, startCookWithFood };
}
