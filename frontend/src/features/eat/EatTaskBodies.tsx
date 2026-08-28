import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type {
  CompleteFoodPlanItemPayload,
  CookRecipeRequest,
  CookRecipePreviewRequest,
  CookRecipePreviewResponse,
  CookRecipeResponse,
  Food,
  FoodPlanItem,
  Ingredient,
  InventoryItem,
  MealLog,
  MealType,
  Member,
  RecordMealPayload,
  RecordMealResponse,
  RecordMealTarget,
  Recipe,
  RecipePayload,
  ShoppingListItem,
  UpdateFoodPayload,
  UpdateMealLogPayload,
} from '../../api/types/food';
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
export function EatMealTaskBody(props: {
  mealLog: MealLog;
  foodPlanItems: FoodPlanItem[];
  members: Member[];
  isUpdatingMeal?: boolean;
  updateMealLog: (mealLogId: string, payload: UpdateMealLogPayload) => Promise<unknown>;
  onClose: () => void;
}) {
  const [isEnrichOpen, setIsEnrichOpen] = useState(false);

  return (
    <>
      <WorkspaceOverlayFrame rootClassName="eat-task-body-overlay-root" onClose={props.onClose}>
        <WorkspaceModal
          title="这餐详情"
          description="查看这次餐食的评价、备注和照片。"
          eyebrow="记录"
          className="meal-log-modal meal-log-enrich-modal meal-log-preview-modal"
          onClose={props.onClose}
          footerActions={
            <FormActions
              className="meal-log-preview-modal-actions"
              primaryLabel="编辑这顿"
              onPrimary={() => setIsEnrichOpen(true)}
              secondaryLabel="关闭"
              onSecondary={props.onClose}
            />
          }
        >
          <MealHistorySurface
            mode="detail"
            meal={props.mealLog}
            detailContent={
              <div className="meal-log-preview-detail" data-testid="eat-meal-task-body">
                <div className="meal-enrichment-summary">
                  <span className={`meal-enrichment-meal-pill ${getMealTone(props.mealLog.meal_type)}`}>
                    <span className="meal-log-icon-slot">
                      <MealLogIcon name="done" />
                    </span>
                    {MEAL_TYPE_LABELS[props.mealLog.meal_type]}
                  </span>
                  <strong>{buildMealTitle(props.mealLog)}</strong>
                  <span className="meal-enrichment-summary-divider" />
                  <small>{formatDateTime(props.mealLog.created_at)}</small>
                </div>
            <p className="eat-meal-task-notes">{props.mealLog.notes || '这条记录没有备注。'}</p>
                <ul className="eat-meal-task-foods">
                  {props.mealLog.food_entries.map((entry) => (
                    <li key={entry.id}>
                      <strong>{entry.food_name || '未命名食物'}</strong>
                      <span>
                        {entry.rating == null
                          ? '—'
                          : `★ ${entry.rating.toFixed(1).replace(/\.0$/, '')} 分`}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            }
          />
        </WorkspaceModal>
      </WorkspaceOverlayFrame>

      <MealEnrichmentModal
        open={isEnrichOpen}
        meal={props.mealLog}
        members={props.members}
        isUpdating={Boolean(props.isUpdatingMeal)}
        updateMealLog={props.updateMealLog}
        onClose={() => setIsEnrichOpen(false)}
        overlayRootClassName="eat-task-body-overlay-root"
      />
    </>
  );
}

/**
 * History free multi-Food recording via production MealComposer + shared hooks.
 * Used when meal-create has no prefilled Food (history “记一餐”).
 *
 * Accidental close keeps draft + request identity in composer state; only success
 * (or explicit discard) should leave the meal-create task shell.
 */
function EatFreeMealComposerBody(props: {
  date?: string;
  mealType?: MealType;
  foods: Food[];
  foodPlanItems: FoodPlanItem[];
  isSubmitting?: boolean;
  recordMeal: (payload: RecordMealPayload) => Promise<RecordMealResponse>;
  onRecordSuccess?: (response: RecordMealResponse) => void;
  onClose: () => void;
}) {
  const businessToday = createMealBusinessDate();
  const [searchQuery, setSearchQuery] = useState('');
  const state = useMealComposerState({
    mode: 'full',
    initialMealType: props.mealType,
  });
  const data = useMealComposerData({
    open: state.open,
    date: state.date,
    mealType: state.mealType,
    searchQuery,
  });
  const plannedFoodSeeds = useMemo(
    () =>
      props.foodPlanItems
        .filter(
          (item) =>
            item.status === 'planned' &&
            item.plan_date === state.date &&
            item.meal_type === state.mealType,
        )
        .map((item) => {
          const food = props.foods.find((candidate) => candidate.id === item.food_id);
          return {
            id: item.id,
            foodId: item.food_id,
            foodName: item.food_name || food?.name || '未命名食物',
            baseUpdatedAt: item.updated_at,
            cover: food?.images[0] ?? null,
          };
        }),
    [props.foodPlanItems, props.foods, state.date, state.mealType],
  );
  const plannedFoodSeedsKey = plannedFoodSeeds
    .map((item) => `${item.id}:${item.baseUpdatedAt}:${item.foodId}`)
    .join(',');
  const plannedFoodRefsByFoodId = useMemo(() => {
    const result: Record<string, Array<{ id: string; baseUpdatedAt: string }>> = {};
    for (const item of plannedFoodSeeds) {
      (result[item.foodId] ??= []).push({ id: item.id, baseUpdatedAt: item.baseUpdatedAt });
    }
    return result;
  }, [plannedFoodSeeds]);

  const candidateResolution = useMemo((): MealCandidateResolution => {
    if (!state.open) return { status: 'idle' };
    if (data.candidateError) {
      return {
        status: 'error',
        message:
          data.candidateError instanceof Error && data.candidateError.message.trim()
            ? data.candidateError.message
            : '暂时无法加载可选餐食，请重试',
      };
    }
    if (data.isLoadingCandidates || data.isFetchingCandidates) {
      return { status: 'loading' };
    }
    // Query settled (success or disabled with empty) — treat as ready for this slot.
    return { status: 'ready' };
  }, [
    data.candidateError,
    data.isFetchingCandidates,
    data.isLoadingCandidates,
    state.open,
  ]);

  const actions = useMealComposerActions({
    state,
    candidates: data.candidates,
    candidateResolution,
    refetchCandidates: data.refetchCandidates,
    recordMeal: props.recordMeal,
    // App-level recordMeal mutation already invalidates caches on success.
    invalidateAfterRecord: async () => undefined,
    publishRecordResult: (response) => {
      props.onRecordSuccess?.(response);
      // Success leaves the meal-create shell.
      props.onClose();
    },
  });

  // Open once with nav-provided date / mealType (history CTA).
  const openedRef = useRef(false);
  useEffect(() => {
    if (openedRef.current) return;
    openedRef.current = true;
    state.openComposer({
      date: props.date ?? businessToday,
      mealType: props.mealType,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!state.open) return;
    state.setFoods((current) => reconcilePlannedMealFoods(current, plannedFoodSeeds));
    // Reconcile only when the authoritative plan set for the selected slot changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.open, state.date, state.mealType, plannedFoodSeedsKey]);

  const candidateIdsKey = data.candidates
    .map((candidate) => `${candidate.meal_log_id}:${candidate.row_version}`)
    .join(',');
  useEffect(() => {
    if (!state.open || state.requiresTargetReconfirm) return;
    if (candidateResolution.status !== 'ready') return;
    // applyCandidates preserves user-chosen target unless force.
    state.applyCandidates(data.candidates);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.open, state.date, state.mealType, candidateIdsKey, candidateResolution.status]);

  const dateOptions = useMemo(() => createMealRecordDateOptions(businessToday), [businessToday]);

  const candidatesBusy = candidateResolution.status === 'loading';
  const submitBlocked =
    candidatesBusy ||
    candidateResolution.status === 'error' ||
    state.requiresTargetReconfirm;

  return (
    <MealComposer
      open={state.open}
      date={state.date}
      mealType={state.mealType}
      dateOptions={dateOptions}
      foods={state.foods}
      candidates={data.candidates}
      selectedCandidateId={state.selectedCandidateId}
      candidateMode={state.candidateMode}
      target={state.target}
      searchQuery={searchQuery}
      searchResults={data.foods}
      isSearchingFoods={data.isSearchingFoods}
      busy={state.busy || Boolean(props.isSubmitting)}
      submitDisabled={submitBlocked}
      candidateSelectionDisabled={candidatesBusy || candidateResolution.status === 'error'}
      error={
        state.error ??
        (candidateResolution.status === 'error' ? candidateResolution.message : null) ??
        (candidatesBusy ? '正在查找可加入的餐食…' : null)
      }
      plannedFoodRefsByFoodId={plannedFoodRefsByFoodId}
      overlayRootClassName="eat-task-body-overlay-root"
      onClose={() => {
        if (state.busy) return;
        // Accidental close: keep draft + request id; stay on meal-create surface.
        state.close();
      }}
      onDateChange={state.setDate}
      onMealTypeChange={state.setMealType}
      onSearchQueryChange={setSearchQuery}
      onFoodsChange={state.setFoods}
      onTargetChange={state.setTarget}
      onSubmit={() => {
        void actions.submitRecord();
      }}
    />
  );
}

/** Compact prefilled single-Food record (Food / plan complete). */
function EatPrefixedMealCreateBody(props: {
  food: Food | null;
  planItem: FoodPlanItem | null;
  date?: string;
  mealType?: MealType;
  recipes: Recipe[];
  isSubmitting?: boolean;
  isCompletingPlan?: boolean;
  recordMeal: (payload: RecordMealPayload) => Promise<RecordMealResponse>;
  completeFoodPlanItem: (itemId: string, payload: CompleteFoodPlanItemPayload) => Promise<MealLog>;
  onRecordSuccess?: (response: RecordMealResponse) => void;
  onStartCook?: (recipeId: string, foodPlanItemId?: string) => void;
  onClose: () => void;
}) {
  const food = props.food;
  const planItem = props.planItem;
  // Plan-sourced complete always records on the plan slot (backend enforces plan_date/meal_type).
  const slotLocked = Boolean(planItem);
  const businessToday = createMealBusinessDate();
  const initialDate = planItem?.plan_date ?? props.date ?? businessToday;
  const initialMealType =
    planItem?.meal_type ?? props.mealType ?? (food ? getDefaultMealType(food) : 'dinner');

  const [date, setDate] = useState(initialDate);
  const [mealType, setMealType] = useState<MealType>(initialMealType);
  const [target, setTarget] = useState<RecordMealTarget>({ kind: 'new' });
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const [candidateMode, setCandidateMode] = useState<'none' | 'single' | 'multi'>('none');
  const [targetTouchedByUser, setTargetTouchedByUser] = useState(false);
  const [clientRequestId, setClientRequestId] = useState(
    () => `eat-record-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep local slot state pinned when planItem is present (or planItem identity changes).
  useEffect(() => {
    if (!planItem) return;
    setDate(planItem.plan_date);
    setMealType(planItem.meal_type);
    setTarget({ kind: 'new' });
    setSelectedCandidateId(null);
    setCandidateMode('none');
    setTargetTouchedByUser(false);
  }, [planItem?.id, planItem?.plan_date, planItem?.meal_type]);

  // Recipe + plan source opens cook owner instead of ordinary record.
  useEffect(() => {
    if (!food) return;
    if (planItem?.recipe_id && props.onStartCook) {
      props.onStartCook(planItem.recipe_id, planItem.id);
      props.onClose();
      return;
    }
    if (!planItem && food.recipe_id && normalizeFoodType(food) === 'selfMade' && props.onStartCook) {
      // Direct meal-create for a recipe food still records as ordinary food unless cook was requested.
      // Keep ordinary record path for explicit meal-create navigation.
    }
  }, [food, planItem, props]);

  // Candidates always follow the effective (locked-when-plan) slot — same pattern as EatPlanTaskBody.
  const effectiveDate = planItem?.plan_date ?? date;
  const effectiveMealType = planItem?.meal_type ?? mealType;
  const needsCandidates = Boolean(food) && !planItem?.recipe_id;
  const candidateQuery = useMealCandidateData({
    open: needsCandidates,
    date: effectiveDate,
    mealType: effectiveMealType,
  });
  const candidates = candidateQuery.candidates;
  const candidatesFetched = candidateQuery.query.isFetched;
  const candidateIdsKey = candidates
    .map((candidate) => `${candidate.meal_log_id}:${candidate.row_version}`)
    .join(',');

  const candidateResolution = useMemo((): MealCandidateResolution => {
    if (!needsCandidates) return { status: 'ready' };
    if (candidateQuery.error) {
      return {
        status: 'error',
        message:
          candidateQuery.error instanceof Error && candidateQuery.error.message.trim()
            ? candidateQuery.error.message
            : '暂时无法加载可选餐食，请重试',
      };
    }
    if (candidateQuery.isLoading || candidateQuery.isFetching || !candidatesFetched) {
      return { status: 'loading' };
    }
    return { status: 'ready' };
  }, [
    candidateQuery.error,
    candidateQuery.isFetching,
    candidateQuery.isLoading,
    candidatesFetched,
    needsCandidates,
  ]);

  useEffect(() => {
    if (!needsCandidates || candidateResolution.status !== 'ready') return;
    const presentation = deriveCandidatePresentation(candidates, effectiveMealType);
    setCandidateMode(presentation.mode);
    if (!targetTouchedByUser) {
      setTarget(presentation.target);
      setSelectedCandidateId(presentation.selectedCandidateId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    needsCandidates,
    effectiveDate,
    effectiveMealType,
    candidateIdsKey,
    candidateResolution.status,
    targetTouchedByUser,
  ]);

  // Plan without food is invalid after free-composer branch; show empty only as last resort.
  if (!food) {
    return (
      <WorkspaceOverlayFrame rootClassName="eat-task-body-overlay-root" onClose={props.onClose}>
        <WorkspaceModal title="记录一餐" onClose={props.onClose}>
          <StateBlock
            status="empty"
            title="还没有可记录的家常菜"
            description="请先从发现或餐食计划选择一份食物，再记录这一餐。"
          />
          <ActionButton tone="primary" type="button" onClick={props.onClose}>
            关闭
          </ActionButton>
        </WorkspaceModal>
      </WorkspaceOverlayFrame>
    );
  }

  // Plan-origin with recipe is handled by cook effect above; show nothing while redirecting.
  if (planItem?.recipe_id) {
    return null;
  }

  const dateOptions = slotLocked
    ? [effectiveDate]
    : createMealRecordDateOptions(businessToday);
  const cover = getFoodCoverAsset(food, props.recipes) ?? null;
  const candidatesPending = needsCandidates && !canSubmitWithCandidateResolution(candidateResolution);
  const mutationBusy =
    busy ||
    Boolean(props.isSubmitting) ||
    Boolean(props.isCompletingPlan);
  const isBusy = mutationBusy || candidatesPending;

  async function handleSubmit() {
    if (!food || isBusy) return;
    setError(null);

    if (needsCandidates && !canSubmitWithCandidateResolution(candidateResolution)) {
      if (candidateResolution.status === 'error') {
        setError(candidateResolution.message);
      } else {
        setError('正在查找可加入的餐食…');
      }
      return;
    }

    // Plan complete is a separate owner command (never ordinary record undo / never publish record result).
    if (planItem) {
      setBusy(true);
      try {
        const payload: CompleteFoodPlanItemPayload = {
          food_plan_item_base_updated_at: planItem.updated_at,
          ...(target.kind === 'existing'
            ? {
                target_meal_log_id: target.meal_log_id,
                expected_meal_log_row_version: target.expected_row_version,
              }
            : {}),
        };
        await props.completeFoodPlanItem(planItem.id, payload);
        props.onClose();
      } catch (reason) {
        setError(resolveErrorMessage(reason, '完成餐食计划失败，请稍后重试。'));
        setBusy(false);
      }
      return;
    }

    let payload: RecordMealPayload;
    try {
      payload = buildRecordMealPayload({
        clientRequestId,
        date: effectiveDate,
        mealType: effectiveMealType,
        target,
        foods: [
          {
            kind: 'existing',
            food_id: food.id,
            name: food.name,
            servings: 1,
            cover,
          },
        ],
      });
    } catch (reason) {
        setError(resolveErrorMessage(reason, '餐食记录失败，请重试'));
      return;
    }

    setBusy(true);
    try {
      const response = await props.recordMeal(payload);
      props.onRecordSuccess?.(response);
      props.onClose();
    } catch (reason) {
      const code = extractMealRecordErrorCode(reason);
      if (code === 'meal_log_stale') {
        try {
          const refreshed = await candidateQuery.refetch();
          const nextCandidates = Array.isArray(refreshed.data) ? refreshed.data : [];
          const presentation = deriveCandidatePresentation(nextCandidates, effectiveMealType);
          setTarget(presentation.target);
          setSelectedCandidateId(presentation.selectedCandidateId);
          setCandidateMode(presentation.mode);
          setTargetTouchedByUser(false);
          setError('这顿饭刚被家人更新，请重新确认');
        } catch {
          setError(messageFromMealRecordReason(reason, '这顿饭刚被家人更新，请重新确认'));
        }
        setBusy(false);
        return;
      }
      if (code === 'idempotency_key_reused' || code === 'record_operation_reverted') {
        setClientRequestId(`eat-record-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
        setError(
          code === 'record_operation_reverted'
            ? '上次记录已撤销，请再试一次'
            : '记录内容已变化，请再试一次',
        );
        setBusy(false);
        return;
      }
        setError(messageFromMealRecordReason(reason, '餐食记录失败，请重试'));
      setBusy(false);
    }
  }

  return (
    <MealQuickRecordView
      open
      prefilledFood={{
        food_id: food.id,
        name: food.name,
        cover,
        servings: 1,
      }}
      date={effectiveDate}
      mealType={effectiveMealType}
      dateOptions={dateOptions}
      candidates={candidates}
      selectedCandidateId={selectedCandidateId}
      candidateMode={candidateMode}
      target={target}
      busy={mutationBusy}
      submitDisabled={candidatesPending}
      error={error}
      slotLocked={slotLocked}
      overlayRootClassName="eat-task-body-overlay-root"
      onClose={props.onClose}
      onDateChange={(next) => {
        if (slotLocked) return;
        setDate(next);
        setTarget({ kind: 'new' });
        setSelectedCandidateId(null);
        setCandidateMode('none');
        setTargetTouchedByUser(false);
      }}
      onMealTypeChange={(next) => {
        if (slotLocked) return;
        setMealType(next);
        setTarget({ kind: 'new' });
        setSelectedCandidateId(null);
        setCandidateMode('none');
        setTargetTouchedByUser(false);
      }}
      onTargetChange={(nextTarget, nextSelectedId) => {
        setTarget(nextTarget);
        setSelectedCandidateId(nextSelectedId ?? null);
        setTargetTouchedByUser(true);
      }}
      onSubmit={() => {
        void handleSubmit();
      }}
    />
  );
}

/** Ordinary Food record via compact MealQuickRecordView + recordMeal (Task 16). */
export function EatMealCreateTaskBody(props: {
  food: Food | null;
  planItem: FoodPlanItem | null;
  date?: string;
  mealType?: MealType;
  recipes: Recipe[];
  foods?: Food[];
  foodPlanItems?: FoodPlanItem[];
  isSubmitting?: boolean;
  isCompletingPlan?: boolean;
  recordMeal: (payload: RecordMealPayload) => Promise<RecordMealResponse>;
  completeFoodPlanItem: (itemId: string, payload: CompleteFoodPlanItemPayload) => Promise<MealLog>;
  onRecordSuccess?: (response: RecordMealResponse) => void;
  onStartCook?: (recipeId: string, foodPlanItemId?: string) => void;
  onClose: () => void;
}) {
  // History free multi-Food recording (no prefilled Food, no plan).
  if (!props.food && !props.planItem) {
    return (
      <EatFreeMealComposerBody
        date={props.date}
        mealType={props.mealType}
        foods={props.foods ?? []}
        foodPlanItems={props.foodPlanItems ?? []}
        isSubmitting={props.isSubmitting}
        recordMeal={props.recordMeal}
        onRecordSuccess={props.onRecordSuccess}
        onClose={props.onClose}
      />
    );
  }

  return <EatPrefixedMealCreateBody {...props} />;
}

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
