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
  } from '../../../api/types/food';
import type {
  CookRecipeRequest,
  CookRecipePreviewRequest,
  CookRecipePreviewResponse,
  CookRecipeResponse,
} from '../../../api/types/recipe';
import type {
  Food,
  FoodPlanItem,
} from '../../../api/types/food';
import type {
  CompleteFoodPlanItemPayload,
  MealLog,
  RecordMealPayload,
  RecordMealResponse,
  RecordMealTarget,
  UpdateMealLogPayload,
} from '../../../api/types/meal';
import type { CookLaunchContext } from '../../../app/appNavigationModel';
import { FoodDetailDrawer } from '../../../components/foods/FoodDetailDrawer';
import { FoodEditorForm } from '../../../components/foods/FoodEditorForm';
import { FoodPlanDetailModal, type FoodPlanDetailFormState } from '../../../components/foods/FoodPlanDetailModal';
import { FoodPlanDialog } from '../../../components/foods/FoodPlanDialog';
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
} from '../../../components/foods/FoodWorkspaceHelpers';
import {
  buildFoodPayloadFromForm,
  foodToForm,
  getFoodFormCompletionItems,
  getFoodImagePayload,
  type FoodFormState,
} from '../../../components/foods/FoodWorkspaceModel';
import { MEAL_OPTIONS } from '../../../components/foods/FoodWorkspaceOptions';
import { RecipeCookFinishDialog } from '../../../components/recipes/RecipeCookFinishDialog';
import { RecipeDetailView } from '../../../components/recipes/RecipeDetailView';
import { RecipeEditorView } from '../../../components/recipes/RecipeEditorView';
import { RecipeShoppingDialog } from '../../../components/recipes/RecipeShoppingDialog';
import { RecipeTaskSurface } from '../../../components/recipes/RecipeTaskSurface';
import {
  buildRecipeImagePayload,
  buildRecipePayload,
  getRecipeDraftGenerationButtonLabel,
  resolveIngredientImageUrl,
} from '../../../components/recipes/RecipeWorkspaceModel';
import { SHOPPING_UNIT_OPTIONS } from '../../../components/recipes/RecipeWorkspaceOptions';
import { useRecipeCookState } from '../../../components/recipes/useRecipeCookState';
import { useRecipeEditorState } from '../../../components/recipes/useRecipeEditorState';
import { useRecipeShoppingState } from '../../../components/recipes/useRecipeShoppingState';
import { buildRecipeCards, type RecipeWorkspaceView } from '../../../components/recipes/workspaceModel';
import {
  ActionButton,
  ConfirmDialog,
  FormActions,
  StateBlock,
  WorkspaceModal,
  WorkspaceOverlayFrame,
} from '../../../components/ui-kit';
import { useImageComposer } from '../../../hooks/useImageComposer';
import { getMediaIds, getPendingImageJobId } from '../../../lib/aiImages';
import { resolveAssetUrl } from '../../../lib/assets';
import { getFoodCover, getFoodCoverAsset, getImagePreview, splitTags, todayKey, formatDateTime, MEAL_TYPE_LABELS } from '../../../lib/ui';
import { MealCandidateSelector } from '../../meals/MealCandidateSelector';
import { MealComposer } from '../../meals/MealComposer';
import {
  buildRecordMealPayload,
  canSubmitWithCandidateResolution,
  createMealBusinessDate,
  createMealRecordDateOptions,
  reconcilePlannedMealFoods,
  type MealCandidateResolution,
  deriveCandidatePresentation,
  type MealComposerFood,
} from '../../meals/MealComposerModel';
import { MealEnrichmentModal } from '../../meals/MealEnrichmentModal';
import { MealQuickRecordView } from '../../meals/MealQuickRecordView';
import { useMealCandidateData } from '../../meals/useMealCandidateData';
import { useMealComposerActions } from '../../meals/useMealComposerActions';
import { useMealComposerData } from '../../meals/useMealComposerData';
import { useMealComposerState } from '../../meals/useMealComposerState';
import {
  extractMealRecordErrorCode,
  messageFromMealRecordReason,
} from '../../meals/mealRecordErrors';
import { buildMealTitle, getMealTone } from '../../meals/MealLogWorkspaceModel';
import { MealLogIcon } from '../../meals/MealLogIcons';
import { MealHistorySurface } from '../../meals/MealHistorySurface';
import type { ResolvedEatTask } from '../EatWorkspaceViewModel';

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

export function EatCookTaskBody(props: {
  food: Food;
  recipe: Recipe;
  launchContext: CookLaunchContext;
  recipes: Recipe[];
  foods: Food[];
  ingredients: Ingredient[];
  inventoryItems: InventoryItem[];
  mealLogs: MealLog[];
  isCookingRecipe?: boolean;
  isCreatingShopping?: boolean;
  cookRecipe: (recipeId: string, payload: CookRecipeRequest) => Promise<CookRecipeResponse>;
  previewCookRecipe: (recipeId: string, payload: CookRecipePreviewRequest) => Promise<CookRecipePreviewResponse>;
  createShoppingItem: (payload: {
    title: string;
    quantity?: number | null;
    unit?: string | null;
    ingredient_id: string;
    quantity_mode?: ShoppingListItem['quantity_mode'];
    display_label?: string | null;
    reason: string;
  }) => Promise<ShoppingListItem>;
  onClose: () => void;
  onCompleted: () => void;
  onViewMealLog?: (mealLogId: string) => void;
  onResumePromptChange?: (open: boolean) => void;
  /** Authenticated user+family scope for v3 cook session persistence. */
  sessionScope?: { userId: string; familyId: string } | null;
}) {
  const cards = useMemo(
    () => buildRecipeCards(props.recipes, props.ingredients, props.inventoryItems, props.mealLogs, props.foods),
    [props.foods, props.ingredients, props.inventoryItems, props.mealLogs, props.recipes],
  );
  const selectedCard = cards.find((card) => card.recipe.id === props.recipe.id) ?? null;
  const planItemId =
    props.launchContext.source.kind === 'plan' ? props.launchContext.source.foodPlanItemId : null;

  const [view, setView] = useState<RecipeWorkspaceView>('cook');
  const [, setSelectedRecipeId] = useState<string | null>(props.recipe.id);
  const [launchSeeded, setLaunchSeeded] = useState(false);
  // Only auto-start cook once; cards refresh must not re-open the session.
  const [startRecipeId, setStartRecipeId] = useState<string | null>(props.recipe.id);

  const shopping = useRecipeShoppingState({
    ingredients: props.ingredients,
    createShoppingItem: props.createShoppingItem,
    showRecipeNotice: () => undefined,
  });

  const cookState = useRecipeCookState({
    cards,
    selectedCard,
    view,
    setView,
    setSelectedRecipeId,
    startRecipeId,
    startFoodPlanItemId: planItemId,
    startRecipeReturnTarget: null,
    onStartRecipeHandled: () => {
      setStartRecipeId(null);
    },
    previewCookRecipe: props.previewCookRecipe,
    cookRecipe: props.cookRecipe,
    isCookingRecipe: props.isCookingRecipe,
    showRecipeNotice: () => undefined,
    sessionScope: props.sessionScope ?? null,
    launchContext: props.launchContext,
    foodId: props.food.id,
    ownershipVerified: true,
    onViewMealLog: props.onViewMealLog,
    onCookFinished: props.onCompleted,
  });

  useEffect(() => {
    if (!cookState.cookSession || launchSeeded) return;
    // Restored v3 sessions keep their date/meal/servings/request ID.
    if (props.sessionScope && cookState.wasCookSessionRestored) {
      setLaunchSeeded(true);
      return;
    }
    cookState.updateCookSession({
      date: props.launchContext.date,
      mealType: props.launchContext.mealType,
      servings: String(props.launchContext.servings),
      planItemId,
    });
    setLaunchSeeded(true);
  }, [cookState, cookState.cookSession, cookState.wasCookSessionRestored, launchSeeded, planItemId, props.launchContext, props.sessionScope]);

  useEffect(() => {
    props.onResumePromptChange?.(Boolean(cookState.cookResumePrompt));
    return () => props.onResumePromptChange?.(false);
  }, [cookState.cookResumePrompt, props.onResumePromptChange]);

  if (cookState.cookResumePrompt) {
    return (
      <div className="eat-cook-task-body" data-testid="eat-cook-task-body">
        <ConfirmDialog
          open
          title="继续上次的做菜进度？"
          description="这道菜在当前餐次有最近保存的进度。你可以接着做，也可以重新开始。"
          confirmLabel="继续上次进度"
          cancelLabel="重新开始"
          closeLabel="关闭"
          rootClassName="eat-task-body-overlay-root eat-cook-confirm-root"
          modalClassName="eat-cook-confirm-modal"
          onClose={() => {
            cookState.dismissCookResumePrompt();
            props.onClose();
          }}
          onConfirm={cookState.continueSavedCook}
          onCancel={cookState.restartSavedCook}
        />
      </div>
    );
  }

  if (!cookState.activeCookCard || !cookState.cookSession) {
    return (
      <div className="eat-cook-task-body" data-testid="eat-cook-task-body">
        <WorkspaceOverlayFrame rootClassName="eat-task-body-overlay-root" onClose={props.onClose}>
          <WorkspaceModal title={props.recipe.title || '做菜'} description="烹饪流程准备中" onClose={props.onClose}>
            <StateBlock status="loading" title="正在打开烹饪" description="请稍候。" />
          </WorkspaceModal>
        </WorkspaceOverlayFrame>
      </div>
    );
  }

  return (
    <div className="eat-cook-task-body recipe-task-surface-cook" data-testid="eat-cook-task-body">
      <RecipeTaskSurface
        mode="cook"
        recipe={cookState.activeCookCard.recipe}
        food={props.food}
        launchContext={props.launchContext}
        onCompleted={() => props.onCompleted()}
        onClose={props.onClose}
        cook={{
          activeCookCard: cookState.activeCookCard,
          cookSession: cookState.cookSession,
          cookSteps: cookState.cookSteps,
          currentCookStep: cookState.currentCookStep,
          currentStepSuggestedSeconds: cookState.currentStepSuggestedSeconds,
          cookTimerDisplaySeconds: cookState.cookTimerDisplaySeconds,
          cookTimerDurationSeconds: cookState.cookTimerDurationSeconds,
          cookTimerProgress: cookState.cookTimerProgress,
          cookProgressPercent: cookState.cookProgressPercent,
          wasCookSessionRestored: cookState.wasCookSessionRestored,
          cookPreview: cookState.cookPreview,
          isCookTimerCustomOpen: cookState.isCookTimerCustomOpen,
          cookTimerJustStarted: cookState.cookTimerJustStarted,
          cookTimerPicker: cookState.cookTimerPicker,
          cookTimerMinuteWheelRef: cookState.cookTimerMinuteWheelRef,
          cookTimerSecondWheelRef: cookState.cookTimerSecondWheelRef,
          setCookTimerPicker: cookState.setCookTimerPicker,
          setIsCookTimerCustomOpen: cookState.setIsCookTimerCustomOpen,
          exitCookMode: () => {
            cookState.exitCookMode('source');
            props.onClose();
          },
          cookBackLabel: '关闭',
          cookBackTarget: 'source',
          cookExitTarget: 'source',
          jumpToCookStep: cookState.jumpToCookStep,
          moveCookStep: cookState.moveCookStep,
          completeCurrentCookStepAndContinue: cookState.completeCurrentCookStepAndContinue,
          resetActiveCookSession: cookState.resetActiveCookSession,
          openCookFinishDialog: () => cookState.setIsCookFinishOpen(true),
          openShoppingDialog: () => {
            if (cookState.activeCookCard) {
              shopping.openShoppingDialog(cookState.activeCookCard, () => undefined);
            }
          },
          confirmCustomCookTimer: cookState.confirmCustomCookTimer,
          openCustomCookTimer: cookState.openCustomCookTimer,
          selectCookTimerDuration: cookState.selectCookTimerDuration,
          resetCookTimer: cookState.resetCookTimer,
          toggleCookTimer: cookState.toggleCookTimer,
          addCookTimerSeconds: cookState.addCookTimerSeconds,
          toggleCookIngredient: cookState.toggleCookIngredient,
          timers: cookState.timers,
          activeTimerId: cookState.activeTimerId,
          addTimer: cookState.addTimer,
          deleteTimer: cookState.deleteTimer,
          selectTimer: cookState.selectTimer,
          toggleTimerById: cookState.toggleTimerById,
          startTimerById: cookState.startTimerById,
          pauseTimerById: cookState.pauseTimerById,
          resetTimerById: cookState.resetTimerById,
          addTimerSecondsById: cookState.addTimerSecondsById,
          setTimerById: cookState.setTimerById,
          setCookAssistantMessages: cookState.setCookAssistantMessages,
        }}
      />

      {cookState.isCookFinishOpen && cookState.activeCookCard && cookState.cookSession ? (
        <RecipeCookFinishDialog
          recipeTitle={cookState.activeCookCard.recipe.title}
          recipeCover={cookState.activeCookCard.recipe.images[0] ?? props.food.images?.[0] ?? null}
          cookPreview={cookState.cookPreview}
          cookPreviewError={cookState.cookPreviewError}
          isCookPreviewLoading={cookState.isCookPreviewLoading}
          session={cookState.cookSession}
          isCooking={props.isCookingRecipe}
          submitDisabled={cookState.cookSubmitDisabled}
          statusMessage={cookState.cookFinishStatusMessage}
          success={
            cookState.cookCompletionResult
              ? {
                  message: cookState.cookCompletionResult.message,
                  mealLogId: cookState.cookCompletionResult.mealLogId,
                }
              : null
          }
          candidates={cookState.cookCandidates}
          candidateMode={cookState.cookCandidateMode}
          selectedCandidateId={cookState.cookSelectedCandidateId}
          target={cookState.cookTarget}
          targetNeedsReconfirm={cookState.cookTargetNeedsReconfirm}
          onTargetChange={cookState.setCookMealTarget}
          onUpdateSession={cookState.updateCookSession}
          onClose={() => cookState.setIsCookFinishOpen(false)}
          onSubmit={cookState.submitCookRecipe}
          onFinishAndReturn={() => cookState.dismissCookCompletion()}
          onViewMeal={() => cookState.dismissCookCompletion({ viewMeal: true })}
        />
      ) : null}

      {shopping.shoppingDialogCard ? (
        <RecipeShoppingDialog
          card={shopping.shoppingDialogCard}
          ingredients={props.ingredients}
          drafts={shopping.shoppingDrafts}
          customForm={shopping.shoppingCustomForm}
          isIngredientPickerOpen={shopping.isShoppingIngredientPickerOpen}
          isCreatingShopping={props.isCreatingShopping}
          unitOptions={SHOPPING_UNIT_OPTIONS}
          resolveIngredientImageUrl={resolveIngredientImageUrl}
          onClose={shopping.closeShoppingDialog}
          onUpdateDraft={shopping.updateShoppingDraft}
          onAdjustDraftQuantity={shopping.adjustShoppingDraftQuantity}
          onRemoveDraft={shopping.removeShoppingDraft}
          onAddRecipeIngredient={shopping.addRecipeIngredientToShoppingDraft}
          onChangeCustomForm={shopping.setShoppingCustomForm}
          onSetIngredientPickerOpen={shopping.setIsShoppingIngredientPickerOpen}
          onSelectIngredientOption={shopping.selectShoppingIngredientOption}
          onAdjustCustomQuantity={shopping.adjustCustomShoppingQuantity}
          onAddCustomDraft={shopping.addCustomShoppingDraft}
          onSubmit={() => {
            void shopping.submitShoppingDrafts();
          }}
        />
      ) : null}
    </div>
  );
}
