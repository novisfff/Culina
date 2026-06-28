import type { Food, FoodPlanItem, Ingredient, Recipe, SearchEntityType, SearchResultItem } from '../../api/types';
import { FOOD_TYPE_LABELS, MEAL_TYPE_LABELS } from '../../lib/ui';

export type GlobalSearchResultTone = 'ingredient' | 'food' | 'recipe' | 'meal_plan';

export type GlobalSearchResultView = {
  id: string;
  entityType: SearchEntityType;
  entityId: string;
  title: string;
  description: string;
  meta: string;
  typeLabel: string;
  tone: GlobalSearchResultTone;
  icon: 'leaf' | 'pot' | 'list' | 'calendar';
  imageUrl?: string;
  matchReasons: string[];
  item: SearchResultItem;
};

const TYPE_LABELS: Record<SearchEntityType, string> = {
  ingredient: '食材',
  food: '食物',
  recipe: '菜谱',
  meal_plan: '餐食计划',
};

const FOOD_PLAN_STATUS_LABELS: Record<string, string> = {
  planned: '待安排',
  cooked: '已完成',
  skipped: '已跳过',
};

function compactParts(parts: Array<string | number | null | undefined>) {
  return parts
    .map((part) => (typeof part === 'number' ? String(part) : part?.trim()))
    .filter(Boolean)
    .join(' · ');
}

function buildIngredientView(item: SearchResultItem): GlobalSearchResultView {
  const ingredient = item.entity as Ingredient;
  return {
    id: `${item.entity_type}:${item.entity_id}`,
    entityType: item.entity_type,
    entityId: item.entity_id,
    title: ingredient.name,
    description: compactParts([ingredient.category, ingredient.default_storage, ingredient.notes]) || '食材资料',
    meta: compactParts([ingredient.default_unit, ingredient.default_expiry_days ? `${ingredient.default_expiry_days} 天保质` : null]),
    typeLabel: TYPE_LABELS.ingredient,
    tone: 'ingredient',
    icon: 'leaf',
    imageUrl: ingredient.image?.url,
    matchReasons: item.match_reason.slice(0, 2),
    item,
  };
}

function buildFoodView(item: SearchResultItem): GlobalSearchResultView {
  const food = item.entity as Food;
  return {
    id: `${item.entity_type}:${item.entity_id}`,
    entityType: item.entity_type,
    entityId: item.entity_id,
    title: food.name,
    description:
      compactParts([
        FOOD_TYPE_LABELS[food.type],
        food.category,
        food.scene_tags?.[0],
        food.routine_note || food.notes,
      ]) || '食物资料',
    meta: compactParts(food.suitable_meal_types.slice(0, 2).map((mealType) => MEAL_TYPE_LABELS[mealType])),
    typeLabel: TYPE_LABELS.food,
    tone: 'food',
    icon: 'pot',
    imageUrl: food.images[0]?.url,
    matchReasons: item.match_reason.slice(0, 2),
    item,
  };
}

function buildRecipeView(item: SearchResultItem): GlobalSearchResultView {
  const recipe = item.entity as Recipe;
  return {
    id: `${item.entity_type}:${item.entity_id}`,
    entityType: item.entity_type,
    entityId: item.entity_id,
    title: recipe.title,
    description:
      compactParts([
        `${recipe.servings} 人份`,
        recipe.prep_minutes ? `${recipe.prep_minutes} 分钟` : null,
        recipe.scene_tags?.[0],
        recipe.tips,
      ]) || '菜谱资料',
    meta: compactParts(recipe.ingredient_items.slice(0, 3).map((entry) => entry.ingredient_name)),
    typeLabel: TYPE_LABELS.recipe,
    tone: 'recipe',
    icon: 'list',
    imageUrl: recipe.images[0]?.url,
    matchReasons: item.match_reason.slice(0, 2),
    item,
  };
}

function buildMealPlanView(item: SearchResultItem): GlobalSearchResultView {
  const plan = item.entity as FoodPlanItem;
  const mealLabel = MEAL_TYPE_LABELS[plan.meal_type] ?? plan.meal_type;
  const statusLabel = FOOD_PLAN_STATUS_LABELS[plan.status] ?? plan.status;
  return {
    id: `${item.entity_type}:${item.entity_id}`,
    entityType: item.entity_type,
    entityId: item.entity_id,
    title: plan.food_name || plan.recipe_title || plan.note || '餐食计划',
    description: compactParts([plan.plan_date, mealLabel, statusLabel, plan.note]) || '菜单计划',
    meta: compactParts([plan.recipe_title, FOOD_TYPE_LABELS[plan.food_type as keyof typeof FOOD_TYPE_LABELS]]),
    typeLabel: TYPE_LABELS.meal_plan,
    tone: 'meal_plan',
    icon: 'calendar',
    matchReasons: item.match_reason.slice(0, 2),
    item,
  };
}

export function buildGlobalSearchResultView(item: SearchResultItem): GlobalSearchResultView {
  if (item.entity_type === 'ingredient') return buildIngredientView(item);
  if (item.entity_type === 'food') return buildFoodView(item);
  if (item.entity_type === 'meal_plan') return buildMealPlanView(item);
  return buildRecipeView(item);
}
