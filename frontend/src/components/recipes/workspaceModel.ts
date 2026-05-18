import type { Difficulty, Food, Ingredient, InventoryItem, MealLog, Recipe, RecipeFavorite, RecipeIngredient, RecipePlanItem } from '../../api/types';
import { getIngredientAvailableQuantityInDefault, convertQuantityToDefaultUnit } from '../../lib/ingredientUnits';
import { todayKey } from '../../lib/ui';

export type RecipeWorkspaceView = 'library' | 'cookable' | 'detail' | 'create' | 'edit' | 'cook';
export type RecipeAvailability = 'ready' | 'partial' | 'missing';
export type RecipeQuickFilter = 'all' | 'recommend' | 'ready' | 'missing' | 'common' | 'favorite' | 'quick';
export type RecipeSortMode = 'recommend' | 'updated' | 'time' | 'availability' | 'difficulty';

export type RecipeShortageViewModel = {
  ingredientId?: string | null;
  ingredientName: string;
  requiredQuantity: number;
  availableQuantity: number;
  missingQuantity: number;
  unit: string;
};

export type RecipeIngredientAvailability = {
  item: RecipeIngredient;
  ingredient: Ingredient | null;
  requiredQuantity: number;
  availableQuantity: number;
  missingQuantity: number;
  unit: string;
  ready: boolean;
};

export type RecipeCardViewModel = {
  recipe: Recipe;
  coverUrl?: string;
  availability: RecipeAvailability;
  availabilityLabel: string;
  availabilityDetail: string;
  availabilityScore: number;
  shortages: RecipeShortageViewModel[];
  ingredientAvailability: RecipeIngredientAvailability[];
  ingredientPreview: string[];
  hiddenIngredientCount: number;
  linkedFood: Food | null;
  mealUsageCount: number;
  lastUsedAt: string | null;
  searchText: string;
  updatedAt: string;
};

export type RecipeWorkspaceMetrics = {
  total: number;
  ready: number;
  partial: number;
  missing: number;
  quick: number;
};

export type RecipeDiscoverySection = {
  title: string;
  description: string;
  cards: RecipeCardViewModel[];
};

export type RecipePlanDayViewModel = {
  date: string;
  label: string;
  items: RecipePlanItem[];
};

export type RecipeHomeViewModel = {
  recentlyCooked: RecipeCardViewModel[];
  weeklyTop: Array<{ card: RecipeCardViewModel; count: number }>;
  quickRecipes: RecipeCardViewModel[];
  favoriteCards: RecipeCardViewModel[];
  recommendedCards: RecipeCardViewModel[];
  popularCategories: Array<{ name: string; count: number }>;
  planDays: RecipePlanDayViewModel[];
  favoriteRecipeIds: Set<string>;
};

export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  easy: '简单',
  medium: '中等',
  hard: '复杂',
};

const DIFFICULTY_WEIGHT: Record<Difficulty, number> = {
  easy: 1,
  medium: 2,
  hard: 3,
};

const DAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function parseDateKey(dateKey: string) {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(year, (month ?? 1) - 1, day ?? 1);
}

function toDateKey(date: Date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function addDateKeyDays(dateKey: string, days: number) {
  const date = parseDateKey(dateKey);
  date.setDate(date.getDate() + days);
  return toDateKey(date);
}

export function getRecipeWeekRange(dateKey = todayKey()) {
  const date = parseDateKey(dateKey);
  const day = date.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const start = addDateKeyDays(dateKey, mondayOffset);
  return { start, end: addDateKeyDays(start, 6) };
}

function isDateInRange(dateKey: string, start: string, end: string) {
  return dateKey >= start && dateKey <= end;
}

function getRecipeIdForFood(foodId: string, foods: Food[]) {
  return foods.find((food) => food.id === foodId)?.recipe_id ?? null;
}

function getMealLogRecipeIds(log: MealLog, foods: Food[]) {
  return log.food_entries
    .map((entry) => getRecipeIdForFood(entry.food_id, foods))
    .filter((recipeId): recipeId is string => Boolean(recipeId));
}

function roundQuantity(value: number) {
  return Number(value.toFixed(2));
}

function formatQuantity(value: number) {
  return String(roundQuantity(value));
}

function getRecipeMealUsage(recipe: Recipe, foods: Food[], mealLogs: MealLog[]) {
  const linkedFoodIds = new Set(foods.filter((food) => food.recipe_id === recipe.id).map((food) => food.id));
  if (linkedFoodIds.size === 0) {
    return { count: 0, lastUsedAt: null };
  }
  const usedLogs = mealLogs.filter((log) => log.food_entries.some((entry) => linkedFoodIds.has(entry.food_id)));
  const lastUsedAt = usedLogs
    .map((log) => log.date)
    .sort((left, right) => right.localeCompare(left))[0] ?? null;
  return { count: usedLogs.length, lastUsedAt };
}

function buildIngredientAvailability(
  recipe: Recipe,
  ingredients: Ingredient[],
  inventoryItems: InventoryItem[]
): RecipeIngredientAvailability[] {
  return recipe.ingredient_items.map((item) => {
    const ingredient = item.ingredient_id ? ingredients.find((entry) => entry.id === item.ingredient_id) ?? null : null;
    if (!ingredient) {
      return {
        item,
        ingredient: null,
        requiredQuantity: item.quantity,
        availableQuantity: 0,
        missingQuantity: item.quantity,
        unit: item.unit,
        ready: false,
      };
    }

    const requiredInDefault = convertQuantityToDefaultUnit(ingredient, item.quantity, item.unit);
    const availableInDefault = getIngredientAvailableQuantityInDefault(
      ingredient,
      inventoryItems.filter((inventory) => inventory.ingredient_id === ingredient.id),
      { excludeExpiredAt: todayKey() }
    );
    if (requiredInDefault === null) {
      return {
        item,
        ingredient,
        requiredQuantity: item.quantity,
        availableQuantity: 0,
        missingQuantity: item.quantity,
        unit: item.unit,
        ready: false,
      };
    }

    const missingInDefault = Math.max(requiredInDefault - availableInDefault, 0);
    return {
      item,
      ingredient,
      requiredQuantity: requiredInDefault,
      availableQuantity: roundQuantity(availableInDefault),
      missingQuantity: roundQuantity(missingInDefault),
      unit: ingredient.default_unit,
      ready: missingInDefault <= 0,
    };
  });
}

export function buildRecipeCards(
  recipes: Recipe[],
  ingredients: Ingredient[],
  inventoryItems: InventoryItem[],
  mealLogs: MealLog[],
  foods: Food[]
): RecipeCardViewModel[] {
  return recipes.map((recipe) => {
    const ingredientAvailability = buildIngredientAvailability(recipe, ingredients, inventoryItems);
    const shortages = ingredientAvailability
      .filter((item) => !item.ready)
      .map((item) => ({
        ingredientId: item.item.ingredient_id,
        ingredientName: item.item.ingredient_name,
        requiredQuantity: item.requiredQuantity,
        availableQuantity: item.availableQuantity,
        missingQuantity: item.missingQuantity,
        unit: item.unit,
      }));
    const readyCount = ingredientAvailability.filter((item) => item.ready).length;
    const availabilityScore =
      ingredientAvailability.length === 0 ? 0 : readyCount / ingredientAvailability.length;
    const availability: RecipeAvailability =
      shortages.length === 0 ? 'ready' : availabilityScore >= 0.5 ? 'partial' : 'missing';
    const { count, lastUsedAt } = getRecipeMealUsage(recipe, foods, mealLogs);
    const linkedFood = foods.find((food) => food.recipe_id === recipe.id) ?? null;
    const ingredientPreview = recipe.ingredient_items
      .slice(0, 4)
      .map((item) => `${item.ingredient_name}${formatQuantity(item.quantity)}${item.unit}`);

    return {
      recipe,
      coverUrl: recipe.images[0]?.url,
      availability,
      availabilityLabel:
        availability === 'ready' ? '可直接做' : availability === 'partial' ? `缺 ${shortages.length} 项` : '库存不足',
      availabilityDetail:
        availability === 'ready'
          ? '现有库存可以覆盖主要用料'
          : `${shortages.map((item) => item.ingredientName).slice(0, 2).join('、')} 需要补齐`,
      availabilityScore,
      shortages,
      ingredientAvailability,
      ingredientPreview,
      hiddenIngredientCount: Math.max(recipe.ingredient_items.length - 4, 0),
      linkedFood,
      mealUsageCount: count,
      lastUsedAt,
      searchText: [
        recipe.title,
        recipe.tips,
        recipe.scene_tags.join(' '),
        recipe.ingredient_items.map((item) => `${item.ingredient_name} ${item.note}`).join(' '),
      ]
        .join(' ')
        .toLowerCase(),
      updatedAt: recipe.updated_at,
    };
  });
}

export function buildRecipeMetrics(cards: RecipeCardViewModel[]): RecipeWorkspaceMetrics {
  return {
    total: cards.length,
    ready: cards.filter((card) => card.availability === 'ready').length,
    partial: cards.filter((card) => card.availability === 'partial').length,
    missing: cards.filter((card) => card.availability === 'missing').length,
    quick: cards.filter((card) => card.recipe.prep_minutes <= 20).length,
  };
}

export function getRecipeSceneFilters(cards: RecipeCardViewModel[]) {
  return [...new Set(cards.flatMap((card) => card.recipe.scene_tags).filter(Boolean))].sort((left, right) =>
    left.localeCompare(right, 'zh-CN')
  );
}

export function filterRecipeCards(
  cards: RecipeCardViewModel[],
  options: {
    search: string;
    quickFilter: RecipeQuickFilter;
    sceneFilter: string;
    difficultyFilter: 'all' | Difficulty;
    sortMode: RecipeSortMode;
    favoriteRecipeIds?: Set<string>;
  }
) {
  const search = options.search.trim().toLowerCase();
  const filtered = cards.filter((card) => {
    const searchMatch = !search || card.searchText.includes(search);
    const quickMatch =
      options.quickFilter === 'all' ||
      options.quickFilter === 'recommend' ||
      (options.quickFilter === 'ready' && card.availability === 'ready') ||
      (options.quickFilter === 'missing' && card.availability !== 'ready') ||
      (options.quickFilter === 'common' &&
        (card.mealUsageCount > 0 || card.linkedFood?.favorite || Boolean(options.favoriteRecipeIds?.has(card.recipe.id)))) ||
      (options.quickFilter === 'favorite' && Boolean(options.favoriteRecipeIds?.has(card.recipe.id))) ||
      (options.quickFilter === 'quick' && card.recipe.prep_minutes <= 20);
    const sceneMatch = options.sceneFilter === 'all' || card.recipe.scene_tags.includes(options.sceneFilter);
    const difficultyMatch = options.difficultyFilter === 'all' || card.recipe.difficulty === options.difficultyFilter;
    return searchMatch && quickMatch && sceneMatch && difficultyMatch;
  });

  return [...filtered].sort((left, right) => {
    if (options.sortMode === 'recommend') {
      return 0;
    }
    if (options.sortMode === 'time') {
      return left.recipe.prep_minutes - right.recipe.prep_minutes || right.updatedAt.localeCompare(left.updatedAt);
    }
    if (options.sortMode === 'availability') {
      return right.availabilityScore - left.availabilityScore || right.updatedAt.localeCompare(left.updatedAt);
    }
    if (options.sortMode === 'difficulty') {
      return DIFFICULTY_WEIGHT[left.recipe.difficulty] - DIFFICULTY_WEIGHT[right.recipe.difficulty];
    }
    return right.updatedAt.localeCompare(left.updatedAt);
  });
}

export function buildRecipeHomeViewModel(
  cards: RecipeCardViewModel[],
  favorites: RecipeFavorite[],
  planItems: RecipePlanItem[],
  mealLogs: MealLog[],
  foods: Food[],
  dateKey = todayKey()
): RecipeHomeViewModel {
  const favoriteRecipeIds = new Set(favorites.map((item) => item.recipe_id));
  const cardByRecipeId = new Map(cards.map((card) => [card.recipe.id, card]));
  const { start, end } = getRecipeWeekRange(dateKey);

  const recentlyCooked: RecipeCardViewModel[] = [];
  const seenRecent = new Set<string>();
  [...mealLogs]
    .sort((left, right) => right.date.localeCompare(left.date) || right.created_at.localeCompare(left.created_at))
    .forEach((log) => {
      getMealLogRecipeIds(log, foods).forEach((recipeId) => {
        const card = cardByRecipeId.get(recipeId);
        if (card && !seenRecent.has(recipeId)) {
          seenRecent.add(recipeId);
          recentlyCooked.push(card);
        }
      });
    });

  const weeklyCount = new Map<string, number>();
  mealLogs
    .filter((log) => isDateInRange(log.date, start, end))
    .forEach((log) => {
      getMealLogRecipeIds(log, foods).forEach((recipeId) => {
        weeklyCount.set(recipeId, (weeklyCount.get(recipeId) ?? 0) + 1);
      });
    });

  const weeklyTop = [...weeklyCount.entries()]
    .map(([recipeId, count]) => ({ card: cardByRecipeId.get(recipeId), count }))
    .filter((item): item is { card: RecipeCardViewModel; count: number } => Boolean(item.card))
    .sort((left, right) => right.count - left.count || right.card.updatedAt.localeCompare(left.card.updatedAt))
    .slice(0, 3);

  const favoriteCreatedAt = new Map(favorites.map((item) => [item.recipe_id, item.created_at]));
  const favoriteCards = [...favoriteRecipeIds]
    .map((recipeId) => cardByRecipeId.get(recipeId))
    .filter((card): card is RecipeCardViewModel => Boolean(card))
    .sort((left, right) => (favoriteCreatedAt.get(right.recipe.id) ?? '').localeCompare(favoriteCreatedAt.get(left.recipe.id) ?? ''));

  const quickRecipes = cards
    .filter((card) => card.recipe.prep_minutes <= 20)
    .sort((left, right) => left.recipe.prep_minutes - right.recipe.prep_minutes || right.updatedAt.localeCompare(left.updatedAt));

  const recommendedCards = [...cards].sort((left, right) => {
    const score = (card: RecipeCardViewModel) =>
      (favoriteRecipeIds.has(card.recipe.id) ? 1000 : 0) +
      card.mealUsageCount * 80 +
      card.availabilityScore * 60 +
      (card.recipe.prep_minutes <= 20 ? 20 : 0) +
      (card.recipe.difficulty === 'easy' ? 8 : card.recipe.difficulty === 'medium' ? 3 : 0);
    return score(right) - score(left) || right.updatedAt.localeCompare(left.updatedAt);
  });

  const categoryCounts = new Map<string, number>();
  cards.forEach((card) => {
    const tags = card.recipe.scene_tags.length > 0 ? card.recipe.scene_tags : ['家庭日常'];
    tags.forEach((tag) => categoryCounts.set(tag, (categoryCounts.get(tag) ?? 0) + 1));
  });
  const popularCategories = [...categoryCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name, 'zh-CN'))
    .slice(0, 8);

  const planDays = Array.from({ length: 7 }, (_, index) => {
    const date = addDateKeyDays(start, index);
    const day = parseDateKey(date).getDay();
    return {
      date,
      label: DAY_LABELS[day],
      items: planItems.filter((item) => item.plan_date === date),
    };
  });

  return {
    recentlyCooked: recentlyCooked.slice(0, 4),
    weeklyTop,
    quickRecipes: quickRecipes.slice(0, 6),
    favoriteCards,
    recommendedCards,
    popularCategories,
    planDays,
    favoriteRecipeIds,
  };
}
