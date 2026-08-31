import { useMemo } from 'react';
import type { Food, FoodType, Ingredient, InventoryItem, MealType, Recipe } from '../../api/types/food';
import type { MealLog } from '../../api/types/meal';
import { buildRecipeCards } from '../recipes/workspaceModel';
import {
  getFoodGovernanceIssues,
  getFoodPriority,
  getFoodSceneTags,
  getMealUsage,
} from './FoodWorkspaceHelpers';
import { filterFoodWorkspaceItems } from './FoodWorkspaceViewModel';
import { buildFoodLibraryCardViewModel } from './FoodLibraryCard';
import type { FoodGovernanceIssue, FoodWorkspaceLens } from './FoodWorkspaceOptions';

export type FoodWorkspaceDataArgs = {
  foods: Food[];
  searchAwareFoods: Food[];
  recipes: Recipe[];
  ingredients: Ingredient[];
  inventoryItems: InventoryItem[];
  mealLogs: MealLog[];
  appliedFoodSearch: string;
  matchedFoodIds: readonly string[];
  typeFilter: 'all' | FoodType;
  mealFilter: 'all' | MealType;
  lensFilter: FoodWorkspaceLens;
  sceneFilter: string;
  governanceIssueFilter: FoodGovernanceIssue | 'all';
};

export function buildFoodWorkspaceData(args: FoodWorkspaceDataArgs) {
  const foodUsageCards = args.foods.map((food) => ({ food, usage: getMealUsage(food, args.mealLogs) }));
  const recipeCards = buildRecipeCards(args.recipes, args.ingredients, args.inventoryItems, args.mealLogs, args.foods);
  const repeatFoods = foodUsageCards
    .filter(({ food, usage }) => food.favorite || usage.count >= 2)
    .sort((left, right) => Number(right.food.favorite) - Number(left.food.favorite) || right.usage.count - left.usage.count)
    .slice(0, 3);
  const filteredFoods = filterFoodWorkspaceItems(
    args.searchAwareFoods,
    args.appliedFoodSearch,
    args.typeFilter,
    args.mealFilter,
    args.lensFilter,
    args.recipes,
    args.matchedFoodIds,
  )
    .filter((food) => args.sceneFilter === 'all' || getFoodSceneTags(food).includes(args.sceneFilter))
    .filter((food) => args.lensFilter !== 'needsInfo' || args.governanceIssueFilter === 'all' || getFoodGovernanceIssues(food, args.recipes).includes(args.governanceIssueFilter))
    .sort((left, right) => args.appliedFoodSearch
      ? 0
      : getFoodPriority(right, args.mealLogs, args.lensFilter, args.recipes) - getFoodPriority(left, args.mealLogs, args.lensFilter, args.recipes));
  return {
    foodUsageCards,
    recipeCards,
    repeatFoods,
    repeatFoodCount: foodUsageCards.filter(({ food, usage }) => food.favorite || usage.count >= 2).length,
    filteredFoods,
    foodCardViewModels: filteredFoods.map((food) => buildFoodLibraryCardViewModel(food, args.recipes, args.mealLogs)),
    foodCardResetKey: [args.appliedFoodSearch, args.typeFilter, args.mealFilter, args.lensFilter, args.sceneFilter, args.governanceIssueFilter].join('|'),
  };
}

export function useFoodWorkspaceData(args: FoodWorkspaceDataArgs) {
  return useMemo(() => buildFoodWorkspaceData(args), [
    args.appliedFoodSearch,
    args.foods,
    args.governanceIssueFilter,
    args.ingredients,
    args.inventoryItems,
    args.lensFilter,
    args.matchedFoodIds,
    args.mealFilter,
    args.mealLogs,
    args.recipes,
    args.sceneFilter,
    args.searchAwareFoods,
    args.typeFilter,
  ]);
}
