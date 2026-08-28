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

export function EatPlanTaskBody(props: {
  item: FoodPlanItem;
  food: Food | null;
  recipes: Recipe[];
  isUpdatingPlan?: boolean;
  isCompleting?: boolean;
  isUpdatingMeal?: boolean;
  members: Member[];
  onClose: () => void;
  onUpdate: (itemId: string, payload: { plan_date?: string; meal_type?: MealType; note?: string }) => Promise<unknown>;
  onDelete: (itemId: string) => Promise<unknown>;
  /** Non-recipe plan complete owner (Task 16). Never publishes ordinary record undo. */
  onComplete: (
    item: FoodPlanItem,
    target?: {
      target_meal_log_id?: string | null;
      expected_meal_log_row_version?: number | null;
    },
  ) => Promise<MealLog>;
  updateMealLog: (mealLogId: string, payload: UpdateMealLogPayload) => Promise<unknown>;
  onStartCook?: (recipeId: string, foodPlanItemId: string) => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [recordedMeal, setRecordedMeal] = useState<MealLog | null>(null);
  const [completionError, setCompletionError] = useState<string | null>(null);
  const activeItemIdRef = useRef(props.item.id);
  const completionRequestRef = useRef(0);
  activeItemIdRef.current = props.item.id;
  const [form, setForm] = useState<FoodPlanDetailFormState>({
    planDate: props.item.plan_date,
    mealType: props.item.meal_type,
    note: props.item.note ?? '',
  });

  const needsPlanCompleteCandidates = Boolean(
    props.item && !props.item.recipe_id && props.item.status !== 'cooked',
  );
  const planCandidateQuery = useMealCandidateData({
    open: needsPlanCompleteCandidates,
    date: props.item.plan_date,
    mealType: props.item.meal_type,
  });
  const planCandidates = planCandidateQuery.candidates;
  const planCandidatesFetched = planCandidateQuery.query.isFetched;
  const planCandidateIdsKey = planCandidates
    .map((candidate) => `${candidate.meal_log_id}:${candidate.row_version}`)
    .join(',');
  const [planCompleteTarget, setPlanCompleteTarget] = useState<RecordMealTarget>({ kind: 'new' });
  const [planCompleteSelectedCandidateId, setPlanCompleteSelectedCandidateId] = useState<string | null>(
    null,
  );
  const [planCompleteCandidateMode, setPlanCompleteCandidateMode] = useState<'none' | 'single' | 'multi'>(
    'none',
  );

  useEffect(() => {
    completionRequestRef.current += 1;
    setIsEditing(false);
    setRecordedMeal(null);
    setCompletionError(null);
    setForm({
      planDate: props.item.plan_date,
      mealType: props.item.meal_type,
      note: props.item.note ?? '',
    });
  }, [props.item.id, props.item.plan_date, props.item.meal_type, props.item.note]);

  useEffect(() => {
    if (!needsPlanCompleteCandidates) {
      setPlanCompleteTarget({ kind: 'new' });
      setPlanCompleteSelectedCandidateId(null);
      setPlanCompleteCandidateMode('none');
      return;
    }
    if (!planCandidatesFetched) return;
    const presentation = deriveCandidatePresentation(planCandidates, props.item.meal_type);
    setPlanCompleteTarget(presentation.target);
    setPlanCompleteSelectedCandidateId(presentation.selectedCandidateId);
    setPlanCompleteCandidateMode(presentation.mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    needsPlanCompleteCandidates,
    props.item.id,
    props.item.plan_date,
    props.item.meal_type,
    planCandidateIdsKey,
    planCandidatesFetched,
  ]);

  function resetEdit() {
    setForm({
      planDate: props.item.plan_date,
      mealType: props.item.meal_type,
      note: props.item.note ?? '',
    });
    setIsEditing(false);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await props.onUpdate(props.item.id, {
      plan_date: form.planDate,
      meal_type: form.mealType,
      note: form.note,
    });
    setIsEditing(false);
  }

  const planCompleteDraftFoods: MealComposerFood[] = [
    {
      kind: 'existing',
      food_id: props.item.food_id,
      name: props.item.food_name,
      servings: 1,
      cover: null,
    },
  ];

  const planCompleteExtras =
    needsPlanCompleteCandidates ? (
      <MealCandidateSelector
        mode={planCompleteCandidateMode}
        mealType={props.item.meal_type}
        candidates={planCandidates}
        selectedCandidateId={planCompleteSelectedCandidateId}
        target={planCompleteTarget}
        draftFoods={planCompleteDraftFoods}
        disabled={props.isCompleting}
        className="eat-plan-detail-candidates"
        onTargetChange={(target, selectedCandidateId) => {
          setPlanCompleteTarget(target);
          setPlanCompleteSelectedCandidateId(selectedCandidateId ?? null);
        }}
      />
    ) : null;

  if (recordedMeal) {
    return (
      <MealEnrichmentModal
        open
        meal={recordedMeal}
        members={props.members}
        isUpdating={Boolean(props.isUpdatingMeal)}
        updateMealLog={props.updateMealLog}
        onClose={props.onClose}
        overlayRootClassName="eat-task-body-overlay-root"
        formId="eat-plan-meal-enrichment-form"
      />
    );
  }

  return (
    <FoodPlanDetailModal
      item={props.item}
      food={props.food}
      recipes={props.recipes}
      form={form}
      isEditing={isEditing}
      isUpdatingPlan={props.isUpdatingPlan}
      isCompleting={props.isCompleting}
      actionError={completionError}
      completeExtras={planCompleteExtras}
      onClose={props.onClose}
      onChangeForm={setForm}
      onEditingChange={setIsEditing}
      onResetEdit={resetEdit}
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
      onComplete={() => {
        if (props.item.recipe_id && props.onStartCook) {
          props.onStartCook(props.item.recipe_id, props.item.id);
          return;
        }
        setCompletionError(null);
        const completingItemId = props.item.id;
        const requestId = ++completionRequestRef.current;
        const target =
          planCompleteTarget.kind === 'existing'
            ? {
                target_meal_log_id: planCompleteTarget.meal_log_id,
                expected_meal_log_row_version: planCompleteTarget.expected_row_version,
              }
            : undefined;
        void props
          .onComplete(props.item, target)
          .then((meal) => {
            if (activeItemIdRef.current === completingItemId && completionRequestRef.current === requestId) {
              setRecordedMeal(meal);
            }
          })
          .catch((reason) => {
            if (activeItemIdRef.current === completingItemId && completionRequestRef.current === requestId) {
              setCompletionError(resolveErrorMessage(reason, '记录这餐失败，请稍后重试。'));
            }
          });
      }}
      onDelete={() => {
        void props.onDelete(props.item.id).then(() => props.onClose());
      }}
      resolveAssetUrl={resolveUrl}
      overlayRootClassName="eat-task-body-overlay-root"
    />
  );
}
