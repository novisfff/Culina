import type { Food, FoodPlanItem, MealLog, Recipe } from '../../api/types';
import type { CookLaunchContext, EatTask } from '../../app/appNavigationModel';
import { getWeekRange } from '../../lib/date';

export type QuerySettleStatus = 'idle' | 'pending' | 'success' | 'error';

export type ResolvedEatTask =
  | { kind: 'none' }
  | { kind: 'loading'; label: string }
  | { kind: 'food'; food: Food }
  | { kind: 'food-not-found'; foodId: string }
  | { kind: 'ready-recipe'; foodId: string; recipeId: string; mode: 'view' | 'edit' }
  | { kind: 'recipe-not-found'; recipeId: string }
  | { kind: 'recipe-food-missing'; recipe: Recipe }
  | { kind: 'recipe-food-ambiguous'; recipe: Recipe; foodIds: string[] }
  | { kind: 'plan'; item: FoodPlanItem; week: { start: string; end: string } }
  | { kind: 'plan-not-found'; foodPlanItemId: string }
  | { kind: 'cook'; food: Food; recipe: Recipe; launchContext: CookLaunchContext }
  | { kind: 'meal-create'; task: Extract<EatTask, { kind: 'meal-create' }>; planItem: FoodPlanItem | null }
  | { kind: 'meal'; mealLog: MealLog }
  | { kind: 'meal-not-found'; mealLogId: string };

export type ResolveEatTaskInput = {
  task: EatTask | null;
  recipes: Recipe[];
  foods: Food[];
  recipesStatus: QuerySettleStatus;
  foodsStatus: QuerySettleStatus;
  planDetail: FoodPlanItem | null;
  planDetailStatus: QuerySettleStatus;
  mealLogs: MealLog[];
  mealLogsStatus: QuerySettleStatus;
};

/** Monday–Sunday week range containing the given plan date (YYYY-MM-DD). */
export function weekContaining(date: string): { start: string; end: string } {
  return getWeekRange(date);
}

function isSettled(status: QuerySettleStatus): boolean {
  return status === 'success' || status === 'error' || status === 'idle';
}

function loading(label: string): ResolvedEatTask {
  return { kind: 'loading', label };
}

/** selfMade foods linked to a recipe; cook/view require exactly one match. */
export function relatedSelfMadeFoods(foods: Food[], recipeId: string): Food[] {
  return foods.filter((food) => food.type === 'selfMade' && food.recipe_id === recipeId);
}

function resolveRecipeRelation(
  recipeId: string,
  mode: 'view' | 'edit',
  recipes: Recipe[],
  foods: Food[],
): ResolvedEatTask {
  const recipe = recipes.find((item) => item.id === recipeId);
  if (!recipe) {
    return { kind: 'recipe-not-found', recipeId };
  }

  const related = relatedSelfMadeFoods(foods, recipeId);
  if (related.length === 0) {
    return { kind: 'recipe-food-missing', recipe };
  }
  if (related.length > 1) {
    return {
      kind: 'recipe-food-ambiguous',
      recipe,
      foodIds: related.map((food) => food.id),
    };
  }

  return {
    kind: 'ready-recipe',
    foodId: related[0].id,
    recipeId: recipe.id,
    mode,
  };
}

function resolveFoodDetail(task: Extract<EatTask, { kind: 'food-detail' }>, input: ResolveEatTaskInput): ResolvedEatTask {
  if (!isSettled(input.foodsStatus)) {
    return loading('正在加载食物');
  }
  const food = input.foods.find((item) => item.id === task.foodId);
  if (!food) {
    return { kind: 'food-not-found', foodId: task.foodId };
  }
  return { kind: 'food', food };
}

function resolveRecipeTarget(
  task: Extract<EatTask, { kind: 'recipe-target' }>,
  input: ResolveEatTaskInput,
): ResolvedEatTask {
  if (!isSettled(input.recipesStatus) || !isSettled(input.foodsStatus)) {
    return loading('正在解析做法');
  }
  return resolveRecipeRelation(task.recipeId, task.mode, input.recipes, input.foods);
}

function resolvePairedRecipe(
  task: Extract<EatTask, { kind: 'recipe' }>,
  input: ResolveEatTaskInput,
): ResolvedEatTask {
  if (!isSettled(input.recipesStatus) || !isSettled(input.foodsStatus)) {
    return loading('正在加载做法');
  }

  const recipe = input.recipes.find((item) => item.id === task.recipeId);
  if (!recipe) {
    return { kind: 'recipe-not-found', recipeId: task.recipeId };
  }

  const food = input.foods.find((item) => item.id === task.foodId);
  if (!food) {
    // Paired recipe IDs already claim a food; treat missing as relation gap.
    return { kind: 'recipe-food-missing', recipe };
  }

  return {
    kind: 'ready-recipe',
    foodId: food.id,
    recipeId: recipe.id,
    mode: task.mode,
  };
}

function resolvePlanDetail(
  task: Extract<EatTask, { kind: 'plan-detail' }>,
  input: ResolveEatTaskInput,
): ResolvedEatTask {
  if (!isSettled(input.planDetailStatus)) {
    return loading('正在加载菜单项');
  }
  if (!input.planDetail || input.planDetail.id !== task.foodPlanItemId) {
    return { kind: 'plan-not-found', foodPlanItemId: task.foodPlanItemId };
  }
  return {
    kind: 'plan',
    item: input.planDetail,
    week: weekContaining(input.planDetail.plan_date),
  };
}

function resolveCook(task: Extract<EatTask, { kind: 'cook' }>, input: ResolveEatTaskInput): ResolvedEatTask {
  if (!isSettled(input.recipesStatus) || !isSettled(input.foodsStatus)) {
    return loading('正在准备烹饪');
  }

  const recipe = input.recipes.find((item) => item.id === task.recipeId);
  if (!recipe) {
    return { kind: 'recipe-not-found', recipeId: task.recipeId };
  }

  const food = input.foods.find((item) => item.id === task.foodId);
  if (!food) {
    return { kind: 'recipe-food-missing', recipe };
  }

  return {
    kind: 'cook',
    food,
    recipe,
    launchContext: task.launchContext,
  };
}

function resolveMealCreate(
  task: Extract<EatTask, { kind: 'meal-create' }>,
  input: ResolveEatTaskInput,
): ResolvedEatTask {
  if (task.source.kind === 'direct') {
    return { kind: 'meal-create', task, planItem: null };
  }

  if (!isSettled(input.planDetailStatus)) {
    return loading('正在加载菜单项');
  }

  if (!input.planDetail || input.planDetail.id !== task.source.foodPlanItemId) {
    return { kind: 'plan-not-found', foodPlanItemId: task.source.foodPlanItemId };
  }

  return { kind: 'meal-create', task, planItem: input.planDetail };
}

function resolveMealDetail(
  task: Extract<EatTask, { kind: 'meal-detail' }>,
  input: ResolveEatTaskInput,
): ResolvedEatTask {
  if (!isSettled(input.mealLogsStatus)) {
    return loading('正在加载这餐记录');
  }
  const mealLog = input.mealLogs.find((item) => item.id === task.mealLogId);
  if (!mealLog) {
    return { kind: 'meal-not-found', mealLogId: task.mealLogId };
  }
  return { kind: 'meal', mealLog };
}

/**
 * Resolve an ID-only eat task against query state.
 *
 * Never mutates navigation state, never auto-creates foods for recipes, and
 * never picks the first related food when the relation count is not exactly one.
 */
export function resolveEatTask(input: ResolveEatTaskInput): ResolvedEatTask {
  const { task } = input;
  if (!task) {
    return { kind: 'none' };
  }

  switch (task.kind) {
    case 'food-detail':
      return resolveFoodDetail(task, input);
    case 'recipe-target':
      return resolveRecipeTarget(task, input);
    case 'recipe':
      return resolvePairedRecipe(task, input);
    case 'plan-detail':
      return resolvePlanDetail(task, input);
    case 'cook':
      return resolveCook(task, input);
    case 'meal-create':
      return resolveMealCreate(task, input);
    case 'meal-detail':
      return resolveMealDetail(task, input);
    default: {
      const _exhaustive: never = task;
      return _exhaustive;
    }
  }
}
