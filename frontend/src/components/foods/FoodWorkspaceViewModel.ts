import type { Food, Recipe, FoodType, MealType } from '../../api/types/food';
import type { MealLog } from '../../api/types/meal';
import type { FoodWorkspaceLens } from './FoodWorkspaceOptions';
import { getFoodSceneTags, isFoodExpiring, isFoodMissingDecisionInfo, isOutsideFood, isReadyLikeFood, normalizeFoodType } from './FoodWorkspaceHelpers';

export function buildFoodWorkspaceViewModel(args: { foods: Food[]; recipes: Recipe[]; mealLogs: MealLog[]; search: string; typeFilter?: 'all' | FoodType; mealFilter?: 'all' | MealType; lensFilter?: FoodWorkspaceLens; matchedFoodIds?: readonly string[] }) {
  const keyword = args.search.trim().toLowerCase();
  const ids = new Set(args.matchedFoodIds ?? []);
  const type = args.typeFilter ?? 'all'; const meal = args.mealFilter ?? 'all'; const lens = args.lensFilter ?? 'all';
  const items = args.foods.filter((food) => {
    const normalized = normalizeFoodType(food);
    const text = [food.name, food.category, food.source_name, food.purchase_source, food.scene, food.notes, food.routine_note, ...getFoodSceneTags(food)].join(' ').toLowerCase();
    const lensMatch = lens === 'all' || (lens === 'today' && food.suitable_meal_types.some((m) => m === 'lunch' || m === 'dinner')) || (lens === 'selfMade' && normalized === 'selfMade') || (lens === 'outside' && isOutsideFood(food)) || (lens === 'ready' && isReadyLikeFood(food)) || (lens === 'expiring' && isFoodExpiring(food)) || (lens === 'favorite' && food.favorite) || (lens === 'needsInfo' && isFoodMissingDecisionInfo(food, args.recipes));
    return (!keyword || ids.has(food.id) || text.includes(keyword)) && (type === 'all' || normalized === type) && (meal === 'all' || food.suitable_meal_types.includes(meal)) && lensMatch;
  });
  return { items, mealLogs: args.mealLogs, countLabel: `显示 ${items.length} / ${args.foods.length} 项食物` };
}

export function filterFoodWorkspaceItems(
  foods: Food[], search: string, typeFilter: 'all' | FoodType, mealFilter: 'all' | MealType,
  lensFilter: FoodWorkspaceLens = 'all', recipes: Recipe[] = [], matchedFoodIds: readonly string[] = [],
) {
  return buildFoodWorkspaceViewModel({ foods, recipes, mealLogs: [], search, typeFilter, mealFilter, lensFilter, matchedFoodIds }).items;
}
