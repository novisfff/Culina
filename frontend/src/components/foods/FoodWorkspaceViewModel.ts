import type { Food, FoodScene, Recipe, FoodType, MealType } from '../../api/types/food';
import type { MealLog } from '../../api/types/meal';
import type { FoodWorkspaceLens, FoodGovernanceIssue } from './FoodWorkspaceOptions';
import { getFoodGovernanceIssueLabels, getFoodSceneTags, isFoodExpiring, isFoodMissingDecisionInfo, isOutsideFood, isReadyLikeFood, normalizeFoodType } from './FoodWorkspaceHelpers';
import {
  buildMobileFilterResetKey,
  buildMobileSceneExploreCards,
  filterMobileLibraryFoods,
  paginateMobileSceneCards,
  type MobileCookingFilter,
} from './FoodMobileLibraryModel';
import type { FoodSceneCardView } from './useFoodSceneState';

export function buildFoodGovernanceSummary(args: {
  expiringFoods: Food[];
  needsInfoFoods: Food[];
  governanceQueue: Food[];
  recipes: Recipe[];
  hasFilters: boolean;
}) {
  const nextGovernanceFood = args.governanceQueue[0] ?? null;
  return {
    managementIssueCount: new Set([...args.expiringFoods, ...args.needsInfoFoods].map((food) => food.id)).size,
    nextGovernanceFood,
    nextGovernanceSummary: nextGovernanceFood
      ? `${nextGovernanceFood.name} · ${getFoodGovernanceIssueLabels(nextGovernanceFood, args.recipes).join('、')}`
      : '信息已补齐',
    hasFoodFilters: args.hasFilters,
  };
}

export function buildFoodMobileFilterTabs(args: {
  lensFilter: string;
  typeFilter: string;
  mealFilter: string;
  sceneFilter: string;
  governanceIssueFilter: string;
  cookingFilter: MobileCookingFilter;
  clearFilters: () => void;
  setCookingFilter: (value: MobileCookingFilter) => void;
  setLensFilter: (value: FoodWorkspaceLens) => void;
  setTypeFilter: (value: 'all' | import('../../api/types/food').FoodType) => void;
  setMealFilter: (value: 'all' | MealType) => void;
  setSceneFilter: (value: string) => void;
  setGovernanceIssueFilter: (value: 'all' | FoodGovernanceIssue) => void;
}) {
  const reset = () => {
    args.setLensFilter('all');
    args.setTypeFilter('all');
    args.setMealFilter('all');
    args.setSceneFilter('all');
    args.setGovernanceIssueFilter('all');
  };
  return [
    { label: '全部', active: args.lensFilter === 'all' && args.typeFilter === 'all' && args.mealFilter === 'all' && args.sceneFilter === 'all' && args.governanceIssueFilter === 'all' && args.cookingFilter === 'all', onClick: () => { args.clearFilters(); args.setCookingFilter('all'); } },
    { label: '家常', active: args.typeFilter === 'selfMade', onClick: () => { args.setCookingFilter('all'); reset(); args.setTypeFilter('selfMade'); } },
    { label: '外卖', active: args.typeFilter === 'takeout', onClick: () => { args.setCookingFilter('all'); reset(); args.setTypeFilter('takeout'); } },
    { label: '收藏', active: args.lensFilter === 'favorite', onClick: () => { args.setCookingFilter('all'); reset(); args.setLensFilter('favorite'); } },
    { label: '可做', active: args.cookingFilter === 'ready', onClick: () => { args.setCookingFilter('ready'); reset(); } },
    { label: '缺少食材', active: args.cookingFilter === 'shortage', onClick: () => { args.setCookingFilter('shortage'); reset(); } },
  ];
}

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

function sortedUniqueSceneTags(tags: Iterable<string>) {
  return Array.from(new Set(Array.from(tags).map((tag) => tag.trim()).filter(Boolean)))
    .sort((left, right) => left.localeCompare(right, 'zh-CN'));
}

export function buildFoodEditorSceneTagOptions(args: {
  foodScenes: FoodScene[];
  foods: Food[];
  editorSceneTags: readonly string[];
}) {
  return sortedUniqueSceneTags([
    ...args.foodScenes.filter((scene) => !scene.hidden).map((scene) => scene.name),
    ...args.foods.flatMap((food) => getFoodSceneTags(food)),
    ...args.editorSceneTags,
  ]);
}

export function buildRecipeEditorSceneTagOptions(args: {
  foodScenes: FoodScene[];
  recipes: Recipe[];
}) {
  return sortedUniqueSceneTags([
    ...args.foodScenes.filter((scene) => !scene.hidden).map((scene) => scene.name),
    ...args.recipes.flatMap((recipe) => recipe.scene_tags ?? []),
  ]);
}

export function buildFoodMobileWorkspaceViewModel(args: {
  foods: Food[];
  filteredFoods: Food[];
  sceneCards: FoodSceneCardView[];
  defaultScenes: Array<{ key: string; title: string; fallbackIndex: number }>;
  cookingFilter: MobileCookingFilter;
  appliedSearch: string;
  typeFilter: string;
  mealFilter: string;
  lensFilter: string;
  sceneFilter: string;
  governanceIssueFilter: string;
  getCookingSummary: (food: Food) => { isReady: boolean; shortagePreview: unknown[] } | null;
}) {
  const mobileSceneCards = buildMobileSceneExploreCards({
    foods: args.foods,
    sceneCards: args.sceneCards,
    defaultScenes: args.defaultScenes,
  });
  return {
    mobileSceneCards,
    mobileScenePages: paginateMobileSceneCards(mobileSceneCards),
    mobileLibraryFoods: filterMobileLibraryFoods(args.filteredFoods, args.cookingFilter, args.getCookingSummary),
    mobileLibraryResetKey: buildMobileFilterResetKey([
      args.appliedSearch,
      args.typeFilter,
      args.mealFilter,
      args.lensFilter,
      args.sceneFilter,
      args.governanceIssueFilter,
      args.cookingFilter,
    ]),
  };
}
