import type { ComponentProps } from 'react';
import type { Food, MealLog, Recipe } from '../../api/types';
import { FoodDetailDrawer } from './FoodDetailDrawer';
import { buildRecipeCards } from '../recipes/workspaceModel';
import {
  buildFoodRelationViewModelFromRecipeCards,
  describeExpiry,
  getDefaultMealType,
  getFoodAudienceText,
  getFoodFactRows,
  getFoodMealHistory,
  getFoodStatus,
  getFoodInventoryConfirmation,
  getFoodSceneTags,
  getPrimaryFoodActionLabel,
  getRepurchaseLabel,
  getSecondaryFoodActionLabel,
  getMealUsage,
  isOutsideFood,
  isReadyLikeFood,
  normalizeFoodType,
} from './FoodWorkspaceHelpers';
import { MEAL_OPTIONS } from './FoodWorkspaceOptions';
import { getFoodCoverAsset } from '../../lib/ui';

type DrawerProps = ComponentProps<typeof FoodDetailDrawer>;

export type FoodWorkspaceDetailOverlayProps = {
  food: Food | null;
  recipes: Recipe[];
  mealLogs: MealLog[];
  recipeCards: ReturnType<typeof buildRecipeCards>;
  todayDate: string;
  isQuickAdding?: boolean;
  onClose: DrawerProps['onClose'];
  onEdit: DrawerProps['onEdit'];
  onEditRecipe: DrawerProps['onEditRecipe'];
  onOpenPlanDialog: DrawerProps['onOpenPlanDialog'];
  onStartCook: DrawerProps['onStartCook'];
  onQuickAdd: DrawerProps['onQuickAdd'];
  resolveAssetUrl: DrawerProps['resolveAssetUrl'];
};

export function FoodWorkspaceDetailOverlay(props: FoodWorkspaceDetailOverlayProps) {
  if (!props.food) return null;
  const food = props.food;
  const usage = getMealUsage(food, props.mealLogs);
  const expiry = describeExpiry(food);
  const normalizedType = normalizeFoodType(food);
  const status = getFoodStatus(food, usage, expiry, props.recipes);
  const factRows = getFoodFactRows(food, usage, expiry);
  const history = getFoodMealHistory(food, props.mealLogs);
  const relation = buildFoodRelationViewModelFromRecipeCards(food, props.recipeCards, props.mealLogs);
  const recipe = relation.linkedRecipeCard?.recipe ?? (food.recipe_id ? props.recipes.find((item) => item.id === food.recipe_id) ?? null : null);
  const coverAsset = getFoodCoverAsset(food, props.recipes);
  const detailMealOptions = food.suitable_meal_types.length > 0 ? MEAL_OPTIONS.filter((meal) => food.suitable_meal_types.includes(meal.value)) : MEAL_OPTIONS;
  return <FoodDetailDrawer
    food={food}
    audienceText={getFoodAudienceText(food, props.mealLogs)}
    cover={coverAsset?.url}
    coverAsset={coverAsset}
    detailMealOptions={detailMealOptions}
    expiry={expiry}
    factRows={factRows}
    history={history}
    inventoryConfirmation={isReadyLikeFood(food) ? getFoodInventoryConfirmation(food, props.todayDate) : null}
    isOutsideFood={isOutsideFood(food)}
    isQuickAdding={props.isQuickAdding}
    isReadyLikeFood={isReadyLikeFood(food)}
    normalizedType={normalizedType}
    recipe={recipe}
    relation={relation}
    status={status}
    usage={usage}
    getDefaultMealType={getDefaultMealType}
    getPrimaryFoodActionLabel={getPrimaryFoodActionLabel}
    getRepurchaseLabel={getRepurchaseLabel}
    getSceneTags={getFoodSceneTags}
    getSecondaryFoodActionLabel={getSecondaryFoodActionLabel}
    onClose={props.onClose}
    onEdit={props.onEdit}
    onEditRecipe={props.onEditRecipe}
    onOpenPlanDialog={props.onOpenPlanDialog}
    onStartCook={props.onStartCook}
    onQuickAdd={props.onQuickAdd}
    resolveAssetUrl={props.resolveAssetUrl}
    overlayRootClassName="food-workspace-overlay-root"
  />;
}
