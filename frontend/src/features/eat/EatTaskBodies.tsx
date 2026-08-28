import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type {
  Ingredient,
  InventoryItem,
  MealType,
  Member,
  Recipe,
  RecipePayload,
  ShoppingListItem,
  UpdateFoodPayload,
  } from '../../api/types/food';
import type {
  CookRecipeRequest,
  CookRecipePreviewRequest,
  CookRecipePreviewResponse,
  CookRecipeResponse,
} from '../../api/types/recipe';
import type {
  Food,
  FoodPlanItem,
} from '../../api/types/food';
import type {
  CompleteFoodPlanItemPayload,
  MealLog,
  RecordMealPayload,
  RecordMealResponse,
  RecordMealTarget,
  UpdateMealLogPayload,
} from '../../api/types/meal';
import type { CookLaunchContext } from '../../app/appNavigationModel';
import { FoodDetailDrawer } from '../../components/foods/FoodDetailDrawer';
import { FoodEditorForm } from '../../components/foods/FoodEditorForm';
import { FoodPlanDetailModal, type FoodPlanDetailFormState } from '../../components/foods/FoodPlanDetailModal';
import { FoodPlanDialog } from '../../components/foods/FoodPlanDialog';
import {
  buildFoodRelationViewModel,
  describeExpiry,
  getDefaultMealType,
  getFoodAudienceText,
  getFoodFactRows,
  getFoodInventoryConfirmation,
  getFoodMealHistory,
  getFoodSceneTags,
  getFoodStatus,
  getMealUsage,
  getPrimaryFoodActionLabel,
  getRepurchaseLabel,
  getSecondaryFoodActionLabel,
  isOutsideFood,
  isReadyLikeFood,
  normalizeFoodType,
} from '../../components/foods/FoodWorkspaceHelpers';
import {
  buildFoodPayloadFromForm,
  foodToForm,
  getFoodFormCompletionItems,
  getFoodImagePayload,
  type FoodFormState,
} from '../../components/foods/FoodWorkspaceModel';
import { MEAL_OPTIONS } from '../../components/foods/FoodWorkspaceOptions';
import { RecipeCookFinishDialog } from '../../components/recipes/RecipeCookFinishDialog';
import { RecipeDetailView } from '../../components/recipes/RecipeDetailView';
import { RecipeEditorView } from '../../components/recipes/RecipeEditorView';
import { RecipeShoppingDialog } from '../../components/recipes/RecipeShoppingDialog';
import { RecipeTaskSurface } from '../../components/recipes/RecipeTaskSurface';
import {
  buildRecipeImagePayload,
  buildRecipePayload,
  getRecipeDraftGenerationButtonLabel,
  resolveIngredientImageUrl,
} from '../../components/recipes/RecipeWorkspaceModel';
import { SHOPPING_UNIT_OPTIONS } from '../../components/recipes/RecipeWorkspaceOptions';
import { useRecipeCookState } from '../../components/recipes/useRecipeCookState';
import { useRecipeEditorState } from '../../components/recipes/useRecipeEditorState';
import { useRecipeShoppingState } from '../../components/recipes/useRecipeShoppingState';
import { buildRecipeCards, type RecipeWorkspaceView } from '../../components/recipes/workspaceModel';
import {
  ActionButton,
  ConfirmDialog,
  FormActions,
  StateBlock,
  WorkspaceModal,
  WorkspaceOverlayFrame,
} from '../../components/ui-kit';
import { useImageComposer } from '../../hooks/useImageComposer';
import { getMediaIds, getPendingImageJobId } from '../../lib/aiImages';
import { resolveAssetUrl } from '../../lib/assets';
import { getFoodCover, getFoodCoverAsset, getImagePreview, splitTags, todayKey, formatDateTime, MEAL_TYPE_LABELS } from '../../lib/ui';
import { MealCandidateSelector } from '../meals/MealCandidateSelector';
import { MealComposer } from '../meals/MealComposer';
import {
  buildRecordMealPayload,
  canSubmitWithCandidateResolution,
  createMealBusinessDate,
  createMealRecordDateOptions,
  reconcilePlannedMealFoods,
  type MealCandidateResolution,
  deriveCandidatePresentation,
  type MealComposerFood,
} from '../meals/MealComposerModel';
import { MealEnrichmentModal } from '../meals/MealEnrichmentModal';
import { MealQuickRecordView } from '../meals/MealQuickRecordView';
import { useMealCandidateData } from '../meals/useMealCandidateData';
import { useMealComposerActions } from '../meals/useMealComposerActions';
import { useMealComposerData } from '../meals/useMealComposerData';
import { useMealComposerState } from '../meals/useMealComposerState';
import {
  extractMealRecordErrorCode,
  messageFromMealRecordReason,
} from '../meals/mealRecordErrors';
import { buildMealTitle, getMealTone } from '../meals/MealLogWorkspaceModel';
import { MealLogIcon } from '../meals/MealLogIcons';
import { MealHistorySurface } from '../meals/MealHistorySurface';
import type { ResolvedEatTask } from './EatWorkspaceViewModel';

const EAT_FOOD_EDITOR_FORM_ID = 'eat-food-editor-form';

function resolveUrl(url: string) {
  return resolveAssetUrl(url) ?? url;
}

function getFoodPlanDateParts(dateKey: string) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(year, (month || 1) - 1, day || 1);
  return {
    day: String(day || 1),
    month: String(month || 1),
    weekday: new Intl.DateTimeFormat('zh-CN', { weekday: 'short' }).format(date),
  };
}

function resolveErrorMessage(reason: unknown, fallback: string) {
  if (reason instanceof Error && reason.message.trim()) {
    return reason.message;
  }
  return fallback;
}

import { EatFoodTaskBody } from './taskBodies/EatFoodTaskBody';
export { EatFoodTaskBody } from './taskBodies/EatFoodTaskBody';
import { EatPlanTaskBody } from './taskBodies/EatPlanTaskBody';
export { EatPlanTaskBody } from './taskBodies/EatPlanTaskBody';
import { EatRecipeTaskBody } from './taskBodies/EatRecipeTaskBody';
export { EatRecipeTaskBody } from './taskBodies/EatRecipeTaskBody';
import { EatCookTaskBody } from './taskBodies/EatCookTaskBody';
export { EatCookTaskBody } from './taskBodies/EatCookTaskBody';
import { EatMealTaskBody, EatMealCreateTaskBody } from './taskBodies/EatMealTaskBodies';
export { EatMealTaskBody, EatMealCreateTaskBody } from './taskBodies/EatMealTaskBodies';
export function buildEatTaskBodies(args: {
  resolvedTask: ResolvedEatTask;
  recipes: Recipe[];
  foods: Food[];
  ingredients: Ingredient[];
  inventoryItems: InventoryItem[];
  mealLogs: MealLog[];
  foodPlanItems: FoodPlanItem[];
  members: Member[];
  isRecordingMeal?: boolean;
  isCompletingPlan?: boolean;
  isUpdatingPlan?: boolean;
  isCookingRecipe?: boolean;
  isCreatingShopping?: boolean;
  isSavingFood?: boolean;
  isUpdatingRecipe?: boolean;
  isUpdatingMeal?: boolean;
  cookRecipe: (recipeId: string, payload: CookRecipeRequest) => Promise<CookRecipeResponse>;
  previewCookRecipe: (recipeId: string, payload: CookRecipePreviewRequest) => Promise<CookRecipePreviewResponse>;
  updateFoodPlanItem: (
    itemId: string,
    payload: { plan_date?: string; meal_type?: MealType; note?: string },
  ) => Promise<unknown>;
  deleteFoodPlanItem: (itemId: string) => Promise<unknown>;
  createFoodPlanItem: (payload: {
    food_id: string;
    plan_date: string;
    meal_type: MealType;
    note: string;
  }) => Promise<unknown>;
  updateFood: (foodId: string, payload: UpdateFoodPayload) => Promise<unknown>;
  updateRecipe: (recipeId: string, payload: RecipePayload) => Promise<unknown>;
  updateMealLog: (mealLogId: string, payload: UpdateMealLogPayload) => Promise<unknown>;
  createShoppingItem: (payload: {
    title: string;
    quantity?: number | null;
    unit?: string | null;
    ingredient_id: string;
    quantity_mode?: ShoppingListItem['quantity_mode'];
    display_label?: string | null;
    reason: string;
  }) => Promise<ShoppingListItem>;
  recordMeal: (payload: RecordMealPayload) => Promise<RecordMealResponse>;
  completeFoodPlanItem: (itemId: string, payload: CompleteFoodPlanItemPayload) => Promise<MealLog>;
  onRecordSuccess?: (response: RecordMealResponse) => void;
  onClose: () => void;
  onOpenLogs: () => void;
  onNavigateRecipe: (recipeId: string, mode?: 'view' | 'edit') => void;
  onStartCook: (recipeId: string, foodPlanItemId?: string) => void;
  onStartCookWithFood: (foodId: string, recipeId: string) => void;
  onQuickAdd: (food: Food, mealType: MealType) => void;
  onCookCompleted: () => void;
  onViewMealLog?: (mealLogId: string) => void;
  onCookResumePromptChange?: (open: boolean) => void;
  sessionScope?: { userId: string; familyId: string } | null;
}): {
  foodTaskContent?: ReactNode;
  recipeTaskContent?: ReactNode;
  cookTaskContent?: ReactNode;
  planTaskContent?: ReactNode;
  mealTaskContent?: ReactNode;
  mealCreateContent?: ReactNode;
} {
  const resolved = args.resolvedTask;

  if (resolved.kind === 'food') {
    return {
      foodTaskContent: (
        <EatFoodTaskBody
          food={resolved.food}
          recipes={args.recipes}
          ingredients={args.ingredients}
          inventoryItems={args.inventoryItems}
          mealLogs={args.mealLogs}
          foods={args.foods}
          isQuickAdding={args.isRecordingMeal}
          isSavingFood={args.isSavingFood}
          isUpdatingPlan={args.isUpdatingPlan}
          updateFood={args.updateFood}
          createFoodPlanItem={args.createFoodPlanItem}
          onClose={args.onClose}
          onEditRecipe={(food) => {
            if (food.recipe_id) args.onNavigateRecipe(food.recipe_id, 'edit');
          }}
          onOpenLogs={args.onOpenLogs}
          onStartCook={(recipeId) => args.onStartCook(recipeId)}
          onQuickAdd={args.onQuickAdd}
        />
      ),
    };
  }

  if (resolved.kind === 'ready-recipe') {
    return {
      recipeTaskContent: (
        <EatRecipeTaskBody
          foodId={resolved.foodId}
          recipeId={resolved.recipeId}
          mode={resolved.mode}
          recipes={args.recipes}
          foods={args.foods}
          ingredients={args.ingredients}
          inventoryItems={args.inventoryItems}
          mealLogs={args.mealLogs}
          isUpdatingRecipe={args.isUpdatingRecipe}
          updateRecipe={args.updateRecipe}
          onClose={args.onClose}
          onCook={(foodId, recipeId) => args.onStartCookWithFood(foodId, recipeId)}
          onEdit={(recipeId) => args.onNavigateRecipe(recipeId, 'edit')}
        />
      ),
    };
  }

  if (resolved.kind === 'plan') {
    const food = args.foods.find((item) => item.id === resolved.item.food_id) ?? null;
    return {
      planTaskContent: (
        <EatPlanTaskBody
          item={resolved.item}
          food={food}
          recipes={args.recipes}
          isUpdatingPlan={args.isUpdatingPlan}
          isCompleting={args.isCompletingPlan || args.isCookingRecipe}
          isUpdatingMeal={args.isUpdatingMeal}
          members={args.members}
          onClose={args.onClose}
          onUpdate={args.updateFoodPlanItem}
          onDelete={args.deleteFoodPlanItem}
          onComplete={async (item, target) => {
            // Recipe plan opens cook; non-recipe uses completeFoodPlanItem.
            // Never publishes ordinary record undo (caller may open enrichment).
            const payload: CompleteFoodPlanItemPayload = {
              food_plan_item_base_updated_at: item.updated_at,
              ...(target?.target_meal_log_id
                ? {
                    target_meal_log_id: target.target_meal_log_id,
                    expected_meal_log_row_version: target.expected_meal_log_row_version ?? null,
                  }
                : {}),
            };
            return args.completeFoodPlanItem(item.id, payload);
          }}
          updateMealLog={args.updateMealLog}
          onStartCook={args.onStartCook}
        />
      ),
    };
  }

  if (resolved.kind === 'cook') {
    return {
      cookTaskContent: (
        <EatCookTaskBody
          food={resolved.food}
          recipe={resolved.recipe}
          launchContext={resolved.launchContext}
          recipes={args.recipes}
          foods={args.foods}
          ingredients={args.ingredients}
          inventoryItems={args.inventoryItems}
          mealLogs={args.mealLogs}
          isCookingRecipe={args.isCookingRecipe}
          isCreatingShopping={args.isCreatingShopping}
          cookRecipe={args.cookRecipe}
          previewCookRecipe={args.previewCookRecipe}
          createShoppingItem={args.createShoppingItem}
          onClose={args.onClose}
          onCompleted={args.onCookCompleted}
          onViewMealLog={args.onViewMealLog}
          onResumePromptChange={args.onCookResumePromptChange}
          sessionScope={args.sessionScope ?? null}
        />
      ),
    };
  }

  if (resolved.kind === 'meal') {
    return {
      mealTaskContent: (
        <EatMealTaskBody
          mealLog={resolved.mealLog}
          foodPlanItems={args.foodPlanItems}
          members={args.members}
          isUpdatingMeal={args.isUpdatingMeal}
          updateMealLog={args.updateMealLog}
          onClose={args.onClose}
        />
      ),
    };
  }

  if (resolved.kind === 'meal-create') {
    const foodId = resolved.task.foodId ?? resolved.planItem?.food_id;
    const food = foodId ? args.foods.find((item) => item.id === foodId) ?? null : null;
    return {
      mealCreateContent: (
        <EatMealCreateTaskBody
          food={food}
          planItem={resolved.planItem}
          date={resolved.task.date}
          mealType={resolved.task.mealType}
          recipes={args.recipes}
          foods={args.foods}
          foodPlanItems={args.foodPlanItems}
          isSubmitting={args.isRecordingMeal}
          isCompletingPlan={args.isCompletingPlan}
          recordMeal={args.recordMeal}
          completeFoodPlanItem={args.completeFoodPlanItem}
          onRecordSuccess={args.onRecordSuccess}
          onStartCook={args.onStartCook}
          onClose={args.onClose}
        />
      ),
    };
  }

  return {};
}
