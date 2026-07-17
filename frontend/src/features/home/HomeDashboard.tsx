import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import type {
  Food,
  FoodPlanItem,
  FoodRecommendations,
  Ingredient,
  InventoryItem,
  MealLog,
  MealLogCandidate,
  MealType,
  Recipe,
  RecordMealPayload,
  RecordMealResponse,
  RecordMealTarget,
  ShoppingListItem,
} from '../../api/types';
import type { AppNavigationTarget } from '../../app/appNavigationModel';
import type { HomePlanCookArgs, HomeRecommendedCookArgs } from '../../app/useAppHomeHandlers';
import { DashboardIcon } from '../../app/shellIcons';
import { MediaWithPlaceholder } from '../../components/MediaPlaceholder';
import {
  Badge,
  EmptyState,
  PageHeader,
  WorkspaceModal,
  WorkspaceOverlayFrame,
} from '../../components/ui-kit';
import { FoodQuickMealDialog, type FoodQuickMealDialogState } from '../../components/foods/FoodQuickMealDialog';
import { MEAL_OPTIONS } from '../../components/foods/FoodWorkspaceOptions';
import { FoodDetailDrawer } from '../../components/foods/FoodDetailDrawer';
import {
  normalizeFoodType,
  isReadyLikeFood,
  isOutsideFood,
  getFoodSceneTags,
  describeExpiry,
  getFoodStatus,
  getFoodFactRows,
  getFoodInventoryConfirmation,
  getFoodMealHistory,
  getFoodAudienceText,
  getMealUsage,
  getDefaultMealType,
  getPrimaryFoodActionLabel,
  getRepurchaseLabel,
  getSecondaryFoodActionLabel,
  buildFoodRelationViewModel,
} from '../../components/foods/FoodWorkspaceHelpers';
import { FOOD_TYPE_LABELS, formatDate, getFoodCover, getFoodCoverAsset, MEAL_TYPE_LABELS, todayKey } from '../../lib/ui';
import type {
  InventoryActionGroup,
} from '../inventory/inventoryActionModel';
import {
  buildRecordMealPayload,
  canSubmitWithCandidateResolution,
  createMealBusinessDate,
  createMealRecordDateOptions,
  deriveCandidatePresentation,
  type MealCandidateResolution,
} from '../meals/MealComposerModel';
import {
  extractMealRecordErrorCode,
  messageFromMealRecordReason,
} from '../meals/mealRecordErrors';
import { MealQuickRecordView } from '../meals/MealQuickRecordView';
import { MealRecordResultBar } from '../meals/MealRecordResultBar';
import type { MealRecordResult } from '../meals/useMealRecordResultState';
import {
  type DashboardPlanDay,
  type DashboardPlanSummaryItem,
  type DashboardRecommendation,
  type DashboardStat,
  type HomeHighlightsViewModel,
  type HomeRequiredAction,
} from './homeDashboardModel';
import { HomeCompactCalendar } from './HomeCompactCalendar';
import { HomeHighlightTimeline } from './HomeHighlightTimeline';
import { HomeMobileDashboard } from './HomeMobileDashboard';
import { HomeRequiredActions } from './HomeRequiredActions';

export type HomeDashboardProps = {
  sidebarFamilyName: string;
  sidebarMotto: string;
  sidebarLocation: string;
  sidebarMemberLabel: string;
  sidebarActivityLabel: string;
  inventoryAlerts: unknown[];
  notificationCenter?: ReactNode;
  dashboardStats: DashboardStat[];
  desktopRecommendations: DashboardRecommendation[];
  mobileRecommendations: DashboardRecommendation[];
  recommendationCount: number;
  foodRecommendations?: FoodRecommendations | null;
  homeInventoryActionGroups: InventoryActionGroup[];
  hasLaterInventoryActionGroups: boolean;
  hasFullListInventoryActionGroups: boolean;
  requiredActions: HomeRequiredAction[];
  hasMoreHomeActions: boolean;
  activeFoodPlanItems: FoodPlanItem[];
  foodPlanItems: FoodPlanItem[];
  dashboardWeekMealCapacity: number;
  dashboardPlanDays: DashboardPlanDay[];
  compactPlanDays: DashboardPlanDay[];
  selectedDashboardPlanDay?: DashboardPlanDay;
  selectedDashboardPlanDateLabel: string;
  selectedPlanSummary: string;
  pendingShoppingCount: number;
  pendingShoppingPreview: ShoppingListItem[];
  dashboardPlanSummary: DashboardPlanSummaryItem[];
  foodPlanWeekRange: { start: string; end: string };
  homeHighlights: HomeHighlightsViewModel;
  foods: Food[];
  recipes: Recipe[];
  ingredients: Ingredient[];
  mealLogs: MealLog[];
  inventoryItems: InventoryItem[];
  isQuickAdding: boolean;
  isCreatingFoodPlanItem: boolean;
  resolveAssetUrl: (url?: string) => string | undefined;
  /** Asia/Shanghai business date for meal defaults (injected from App). */
  businessDateKey: string;
  /** Ordinary Home recommendation/direct Food record owner. */
  recordMeal: (payload: RecordMealPayload) => Promise<RecordMealResponse>;
  /** Injectable candidate loader (defaults unused; App/tests pass this). */
  loadMealCandidates?: (date: string, mealType: MealType) => Promise<MealLogCandidate[]>;
  /** Publish ordinary record result into App-level shared state. */
  onRecordSuccess?: (response: RecordMealResponse) => void;
  /** Shared ordinary-record result bar contract from App. */
  recordResult?: MealRecordResult | null;
  isRevertingRecord?: boolean;
  recordRevertError?: string | null;
  recordRateError?: string | null;
  onRevertRecord?: () => void | Promise<void>;
  onViewRecord?: () => void;
  onRateRecord?: (rating: number | null | undefined) => void | Promise<void>;
  onDismissRecord?: () => void;
  createFoodPlanItem: (payload: { food_id: string; plan_date: string; meal_type: MealType; note: string }) => Promise<FoodPlanItem>;
  onNavigate: (target: AppNavigationTarget) => void;
  onOpenGlobalSearch: () => void;
  onNextDesktopRecommendations: () => void;
  onNextMobileRecommendation: () => void;
  /** Direct cook from recommendation/detail — never creates a plan item. */
  onStartRecommendedRecipe: (input: HomeRecommendedCookArgs) => void;
  /** Plan cook after creating or opening a plan item. */
  onStartPlanRecipe: (input: HomePlanCookArgs) => void;
  onSelectedPlanDateChange: (date: string) => void;
  onHomePlanAddDialogOpen: (food: Food, fallbackMealType?: MealType) => void;
  onHomePlanAddEmptyDialogOpen: (planDate: string, mealType: MealType) => void;
  onHomePlanDetailOpen: (item: FoodPlanItem) => void;
  onHomeRestockOpen: (item: ShoppingListItem) => void;
  onOpenActionGroup: (group: InventoryActionGroup) => void;
  onOpenIngredientShopping: (ingredientId: string) => void;
  onOpenIngredientPriority: () => void;
  onOpenShoppingIntake: () => void;
  onOpenFamilyActivity: () => void;
  onOpenFullWeek: (planDate: string) => void;
  onRetryHighlights: () => void;
  /** Optional: open inventory reconciliation, typically with scope=suggested for long-unconfirmed. */
  onOpenReconciliation?: (args?: { scope?: 'suggested' | 'refrigerated' | 'frozen' | 'room_temperature' | 'all' }) => void;
  onFoodPlanPreviousWeek: () => void;
  onFoodPlanCurrentWeek: () => void;
  onFoodPlanNextWeek: () => void;
};

function getSuggestedHomeMealType(hour = new Date().getHours()): MealType {
  if (hour < 10) return 'breakfast';
  if (hour < 15) return 'lunch';
  if (hour < 22) return 'dinner';
  return 'snack';
}

function getHomeQuickDefaultMealType(food: Food, fallbackMealType?: MealType): MealType {
  const suggestedMealType = fallbackMealType ?? getSuggestedHomeMealType();
  if (food.suitable_meal_types.includes(suggestedMealType)) return suggestedMealType;
  if (food.suitable_meal_types.length === 0) return suggestedMealType;
  return food.suitable_meal_types[0] ?? suggestedMealType;
}

function createClientRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `meal-record-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

type HomeQuickRecordState = {
  food: Food;
  date: string;
  mealType: MealType;
  target: RecordMealTarget;
  selectedCandidateId: string | null;
  candidateMode: 'none' | 'single' | 'multi';
  candidates: MealLogCandidate[];
  candidateResolution: MealCandidateResolution;
  targetTouchedByUser: boolean;
  clientRequestId: string;
  busy: boolean;
  error: string | null;
};

export function HomeDashboard(props: HomeDashboardProps) {
  const {
    sidebarFamilyName,
    sidebarMotto,
    sidebarLocation,
    sidebarMemberLabel,
    sidebarActivityLabel,
    inventoryAlerts,
    dashboardStats,
    desktopRecommendations,
    mobileRecommendations,
    recommendationCount,
    foodRecommendations,
    requiredActions,
    hasMoreHomeActions,
    compactPlanDays,
    selectedDashboardPlanDay,
    selectedPlanSummary,
    foods,
    recipes,
    ingredients,
    mealLogs,
    inventoryItems,
    homeHighlights,
    isQuickAdding,
    isCreatingFoodPlanItem,
    resolveAssetUrl,
    businessDateKey,
    recordMeal,
    loadMealCandidates,
    onRecordSuccess,
    recordResult = null,
    isRevertingRecord = false,
    recordRevertError = null,
    recordRateError = null,
    onRevertRecord,
    onViewRecord,
    onRateRecord,
    onDismissRecord,
    createFoodPlanItem,
    onNavigate,
    onOpenGlobalSearch,
    onNextDesktopRecommendations,
    onNextMobileRecommendation,
    onStartRecommendedRecipe,
    onStartPlanRecipe,
    onSelectedPlanDateChange,
    onHomePlanAddDialogOpen: openHomePlanAddDialog,
    onHomePlanAddEmptyDialogOpen: openHomePlanAddEmptyDialog,
    onHomePlanDetailOpen: openHomePlanDetail,
    onOpenActionGroup,
    onOpenIngredientShopping,
    onOpenIngredientPriority,
    onOpenShoppingIntake,
    onOpenFamilyActivity,
    onOpenFullWeek,
    onRetryHighlights,
    onOpenReconciliation,
    onFoodPlanPreviousWeek,
    onFoodPlanCurrentWeek,
    onFoodPlanNextWeek,
  } = props;
  // Recipe cook confirmation still uses FoodQuickMealDialog.
  const [quickMealDialog, setQuickMealDialog] = useState<FoodQuickMealDialogState | null>(null);
  // Non-Recipe recommendation / direct Food uses compact prefilled MealQuickRecordView.
  const [quickRecord, setQuickRecord] = useState<HomeQuickRecordState | null>(null);
  const [detailFood, setDetailFood] = useState<Food | null>(null);
  const [morePlansPopover, setMorePlansPopover] = useState<{
    date: string;
    mealType: MealType;
    items: FoodPlanItem[];
  } | null>(null);
  const recommendationRowRef = useRef<HTMLDivElement | null>(null);
  const [recommendationScrollState, setRecommendationScrollState] = useState({
    canScrollLeft: false,
    canScrollRight: false,
  });

  function syncRecommendationScrollState() {
    const row = recommendationRowRef.current;
    if (!row) return;
    const canScrollLeft = row.scrollLeft > 4;
    const canScrollRight = row.scrollLeft + row.clientWidth < row.scrollWidth - 4;
    setRecommendationScrollState((current) =>
      current.canScrollLeft === canScrollLeft && current.canScrollRight === canScrollRight
        ? current
        : { canScrollLeft, canScrollRight },
    );
  }

  useEffect(() => {
    syncRecommendationScrollState();
    window.addEventListener('resize', syncRecommendationScrollState);
    return () => window.removeEventListener('resize', syncRecommendationScrollState);
  }, [desktopRecommendations]);

  function openDetail(food: Food) {
    setDetailFood(food);
  }

  function handleRecommendationCardKeyDown(event: KeyboardEvent<HTMLElement>, food: Food) {
    if (event.target !== event.currentTarget) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    openDetail(food);
  }

  const mealBusinessDate = businessDateKey || createMealBusinessDate();
  const quickMealDateOptions = useMemo(
    () => createMealRecordDateOptions(mealBusinessDate),
    [mealBusinessDate],
  );

  function openCookConfirmDialog(
    food: Food,
    fallbackMealType?: MealType,
    options?: { date?: string; preferFallbackMealType?: boolean },
  ) {
    const recipeId = food.recipe_id ?? undefined;
    const recipeServings =
      recipeId != null
        ? recipes.find((recipe) => recipe.id === recipeId)?.servings
        : undefined;
    const mealType =
      options?.preferFallbackMealType && fallbackMealType
        ? fallbackMealType
        : getHomeQuickDefaultMealType(food, fallbackMealType);
    setQuickMealDialog({
      action: 'cook',
      date: options?.date ?? mealBusinessDate,
      food,
      mealType,
      recipeId,
      servings: recipeServings && recipeServings > 0 ? recipeServings : 1,
    });
  }

  function openCompactRecord(
    food: Food,
    fallbackMealType?: MealType,
    options?: { date?: string },
  ) {
    const mealType = getHomeQuickDefaultMealType(food, fallbackMealType);
    setQuickRecord({
      food,
      date: options?.date ?? mealBusinessDate,
      mealType,
      target: { kind: 'new' },
      selectedCandidateId: null,
      candidateMode: 'none',
      candidates: [],
      candidateResolution: { status: 'loading' },
      targetTouchedByUser: false,
      clientRequestId: createClientRequestId(),
      busy: false,
      error: null,
    });
  }

  /** Recommendation / detail primary action: cook for recipe foods, compact record otherwise. */
  function openQuickMealDialog(
    food: Food,
    fallbackMealType?: MealType,
    options?: { date?: string; preferFallbackMealType?: boolean },
  ) {
    if (food.recipe_id) {
      openCookConfirmDialog(food, fallbackMealType, options);
      return;
    }
    openCompactRecord(food, fallbackMealType, options);
  }

  function updateQuickMealDialog(
    patch: Partial<Pick<FoodQuickMealDialogState, 'date' | 'mealType' | 'servings'>>,
  ) {
    setQuickMealDialog((current) => (current ? { ...current, ...patch } : current));
  }

  async function submitCookConfirmDialog(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!quickMealDialog) return;
    const current = quickMealDialog;
    if (!current.food.recipe_id) return;
    const servings =
      current.servings != null && current.servings > 0
        ? current.servings
        : recipes.find((recipe) => recipe.id === current.food.recipe_id)?.servings || 1;
    setQuickMealDialog(null);
    onStartRecommendedRecipe({
      foodId: current.food.id,
      recipeId: current.food.recipe_id,
      date: current.date,
      mealType: current.mealType,
      servings,
    });
  }

  // Load authoritative candidates when compact record date/mealType change.
  useEffect(() => {
    if (!quickRecord) return;
    let cancelled = false;
    const { date, mealType } = quickRecord;
    const loader = loadMealCandidates;
    if (!loader) {
      setQuickRecord((current) =>
        current && current.date === date && current.mealType === mealType
          ? {
              ...current,
              candidates: [],
              candidateMode: 'none',
              candidateResolution: { status: 'ready' },
            }
          : current,
      );
      return;
    }
    setQuickRecord((current) =>
      current && current.date === date && current.mealType === mealType
        ? { ...current, candidateResolution: { status: 'loading' }, error: null }
        : current,
    );
    void (async () => {
      try {
        const candidates = await loader(date, mealType);
        if (cancelled) return;
        const presentation = deriveCandidatePresentation(candidates, mealType);
        setQuickRecord((current) => {
          if (!current || current.date !== date || current.mealType !== mealType) return current;
          return {
            ...current,
            candidates,
            candidateMode: presentation.mode,
            candidateResolution: { status: 'ready' },
            ...(current.targetTouchedByUser
              ? {}
              : {
                  target: presentation.target,
                  selectedCandidateId: presentation.selectedCandidateId,
                }),
          };
        });
      } catch (reason) {
        if (cancelled) return;
        const message =
          reason instanceof Error && reason.message.trim()
            ? reason.message
            : '加载候选失败，请重试';
        setQuickRecord((current) =>
          current && current.date === date && current.mealType === mealType
            ? {
                ...current,
                candidateResolution: { status: 'error', message },
                error: message,
              }
            : current,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
    // Only re-run when open identity / date / mealType / loader change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quickRecord?.food.id, quickRecord?.date, quickRecord?.mealType, loadMealCandidates]);

  async function submitCompactRecord() {
    if (!quickRecord || quickRecord.busy) return;
    if (!canSubmitWithCandidateResolution(quickRecord.candidateResolution)) {
      setQuickRecord((current) =>
        current
          ? {
              ...current,
              error:
                current.candidateResolution.status === 'error'
                  ? current.candidateResolution.message || '加载候选失败，请重试'
                  : '正在确认是否有可加入的餐食…',
            }
          : current,
      );
      return;
    }
    const cover = getFoodCoverAsset(quickRecord.food, recipes) ?? null;
    let payload: RecordMealPayload;
    try {
      payload = buildRecordMealPayload({
        clientRequestId: quickRecord.clientRequestId,
        date: quickRecord.date,
        mealType: quickRecord.mealType,
        target: quickRecord.target,
        foods: [
          {
            kind: 'existing',
            food_id: quickRecord.food.id,
            name: quickRecord.food.name,
            servings: 1,
            cover,
          },
        ],
      });
    } catch (reason) {
      setQuickRecord((current) =>
        current
          ? {
              ...current,
              error: reason instanceof Error && reason.message.trim()
                ? reason.message
                : '记录失败，请重试',
            }
          : current,
      );
      return;
    }

    setQuickRecord((current) => (current ? { ...current, busy: true, error: null } : current));
    try {
      const response = await recordMeal(payload);
      setQuickRecord(null);
      onRecordSuccess?.(response);
    } catch (reason) {
      const code = extractMealRecordErrorCode(reason);
      if (code === 'meal_log_stale' && loadMealCandidates) {
        try {
          const refreshed = await loadMealCandidates(quickRecord.date, quickRecord.mealType);
          const presentation = deriveCandidatePresentation(refreshed, quickRecord.mealType);
          setQuickRecord((current) =>
            current
              ? {
                  ...current,
                  busy: false,
                  candidates: refreshed,
                  candidateMode: presentation.mode,
                  candidateResolution: { status: 'ready' },
                  target: presentation.target,
                  selectedCandidateId: presentation.selectedCandidateId,
                  targetTouchedByUser: false,
                  error: '这顿饭刚被家人更新，请重新确认',
                }
              : current,
          );
          return;
        } catch {
          // fall through to generic message
        }
      }
      if (code === 'idempotency_key_reused' || code === 'record_operation_reverted') {
        setQuickRecord((current) =>
          current
            ? {
                ...current,
                busy: false,
                clientRequestId: createClientRequestId(),
                error:
                  code === 'record_operation_reverted'
                    ? '上次记录已撤销，请再试一次'
                    : '记录内容已变化，请再试一次',
              }
            : current,
        );
        return;
      }
      setQuickRecord((current) =>
        current
          ? {
              ...current,
              busy: false,
              error: messageFromMealRecordReason(reason, '记录失败，请重试'),
            }
          : current,
      );
    }
  }

  function handleOpenInventoryAction(group: InventoryActionGroup) {
    if (group.kind === 'low_stock') {
      onOpenIngredientShopping(group.ingredientId);
      return;
    }
    onOpenActionGroup(group);
  }

  const selectedPlanDate = selectedDashboardPlanDay?.date ?? compactPlanDays[0]?.date ?? '';
  const resolvePlanItemCoverUrl = (item: FoodPlanItem) => {
    const planFood = foods.find((food) => food.id === item.food_id);
    return resolveAssetUrl(planFood ? getFoodCover(planFood, recipes) : undefined);
  };

  return (
    <>
      <HomeMobileDashboard
        sidebarFamilyName={sidebarFamilyName}
        sidebarMotto={sidebarMotto}
        sidebarLocation={sidebarLocation}
        sidebarMemberLabel={sidebarMemberLabel}
        sidebarActivityLabel={sidebarActivityLabel}
        inventoryAlerts={inventoryAlerts}
        notificationCenter={props.notificationCenter}
        dashboardStats={dashboardStats}
        mobileRecommendations={mobileRecommendations}
        recommendationCount={recommendationCount}
        foodRecommendations={foodRecommendations}
        requiredActions={requiredActions}
        hasMoreHomeActions={hasMoreHomeActions}
        compactPlanDays={compactPlanDays}
        selectedDashboardPlanDay={selectedDashboardPlanDay}
        selectedPlanSummary={selectedPlanSummary}
        homeHighlights={homeHighlights}
        isQuickAdding={isQuickAdding}
        isCreatingFoodPlanItem={isCreatingFoodPlanItem}
        resolveAssetUrl={resolveAssetUrl}
        resolvePlanItemCoverUrl={resolvePlanItemCoverUrl}
        onNavigate={onNavigate}
        onOpenGlobalSearch={onOpenGlobalSearch}
        onNextMobileRecommendation={onNextMobileRecommendation}
        onSelectedPlanDateChange={onSelectedPlanDateChange}
        onFoodPlanPreviousWeek={onFoodPlanPreviousWeek}
        onFoodPlanCurrentWeek={onFoodPlanCurrentWeek}
        onFoodPlanNextWeek={onFoodPlanNextWeek}
        onQuickStartFood={openQuickMealDialog}
        onHomePlanAddDialogOpen={openHomePlanAddDialog}
        onHomePlanAddEmptyDialogOpen={openHomePlanAddEmptyDialog}
        onHomePlanDetailOpen={openHomePlanDetail}
        onOpenMealPlans={(date, mealType, items) => setMorePlansPopover({ date, mealType, items })}
        onOpenActionGroup={onOpenActionGroup}
        onOpenIngredientShopping={onOpenIngredientShopping}
        onOpenIngredientPriority={onOpenIngredientPriority}
        onOpenShoppingIntake={onOpenShoppingIntake}
        onOpenFamilyActivity={onOpenFamilyActivity}
        onOpenFullWeek={onOpenFullWeek}
        onRetryHighlights={onRetryHighlights}
        onOpenDetail={openDetail}
        onOpenReconciliation={onOpenReconciliation}
      />

      <MealRecordResultBar
        result={recordResult ?? null}
        isReverting={isRevertingRecord}
        revertError={recordRevertError}
        rateError={recordRateError}
        onRevert={onRevertRecord}
        onView={onViewRecord}
        onRate={onRateRecord}
        onDismiss={onDismissRecord}
      />

      {quickRecord ? (
        <MealQuickRecordView
          open
          prefilledFood={{
            food_id: quickRecord.food.id,
            name: quickRecord.food.name,
            cover: getFoodCoverAsset(quickRecord.food, recipes) ?? null,
            servings: 1,
          }}
          date={quickRecord.date}
          mealType={quickRecord.mealType}
          dateOptions={quickMealDateOptions}
          candidates={quickRecord.candidates}
          selectedCandidateId={quickRecord.selectedCandidateId}
          candidateMode={quickRecord.candidateMode}
          target={quickRecord.target}
          busy={quickRecord.busy || isQuickAdding}
          submitDisabled={!canSubmitWithCandidateResolution(quickRecord.candidateResolution)}
          error={quickRecord.error}
          overlayRootClassName="home-dashboard-overlay-root"
          onClose={() => {
            if (!quickRecord.busy) setQuickRecord(null);
          }}
          onDateChange={(date) => {
            setQuickRecord((current) =>
              current
                ? {
                    ...current,
                    date,
                    target: { kind: 'new' },
                    selectedCandidateId: null,
                    candidateMode: 'none',
                    candidates: [],
                    candidateResolution: { status: 'loading' },
                    targetTouchedByUser: false,
                    error: null,
                  }
                : current,
            );
          }}
          onMealTypeChange={(mealType) => {
            setQuickRecord((current) =>
              current
                ? {
                    ...current,
                    mealType,
                    target: { kind: 'new' },
                    selectedCandidateId: null,
                    candidateMode: 'none',
                    candidates: [],
                    candidateResolution: { status: 'loading' },
                    targetTouchedByUser: false,
                    error: null,
                  }
                : current,
            );
          }}
          onTargetChange={(target, selectedCandidateId) => {
            setQuickRecord((current) =>
              current
                ? {
                    ...current,
                    target,
                    selectedCandidateId:
                      selectedCandidateId ??
                      (target.kind === 'existing' ? target.meal_log_id : null),
                    targetTouchedByUser: true,
                    error: null,
                  }
                : current,
            );
          }}
          onSubmit={() => {
            void submitCompactRecord();
          }}
        />
      ) : null}

      {quickMealDialog && (() => {
        const isCookAction = quickMealDialog.action === 'cook' && quickMealDialog.recipeId;
        const isSubmitting = Boolean(isQuickAdding || (isCookAction && isCreatingFoodPlanItem));

        return (
          <FoodQuickMealDialog
            dialog={quickMealDialog}
            dateOptions={quickMealDateOptions}
            recipes={recipes}
            isSubmitting={isSubmitting}
            overlayRootClassName="home-dashboard-overlay-root"
            onChange={updateQuickMealDialog}
            onClose={() => setQuickMealDialog(null)}
            onSubmit={submitCookConfirmDialog}
          />
        );
      })()}

      {detailFood && (() => {
        const usage = getMealUsage(detailFood, mealLogs);
        const expiry = describeExpiry(detailFood);
        const normalizedType = normalizeFoodType(detailFood);
        const status = getFoodStatus(detailFood, usage, expiry, recipes);
        const factRows = getFoodFactRows(detailFood, usage, expiry);
        const history = getFoodMealHistory(detailFood, mealLogs);
        const relation = buildFoodRelationViewModel(detailFood, recipes, ingredients, inventoryItems, mealLogs, foods);
        const linkedRecipeCard = relation.linkedRecipeCard;
        const recipe = linkedRecipeCard?.recipe ?? (detailFood.recipe_id ? recipes.find((item) => item.id === detailFood.recipe_id) ?? null : null);
        const coverAsset = getFoodCoverAsset(detailFood, recipes);
        const cover = coverAsset?.url;
        const detailMealOptions = detailFood.suitable_meal_types.length > 0
          ? MEAL_OPTIONS.filter((meal) => detailFood.suitable_meal_types.includes(meal.value))
          : MEAL_OPTIONS;

        return (
          <FoodDetailDrawer
            food={detailFood}
            audienceText={getFoodAudienceText(detailFood, mealLogs)}
            cover={cover}
            coverAsset={coverAsset}
            detailMealOptions={detailMealOptions}
            expiry={expiry}
            factRows={factRows}
            history={history}
            inventoryConfirmation={isReadyLikeFood(detailFood) ? getFoodInventoryConfirmation(detailFood, todayKey()) : null}
            isOutsideFood={isOutsideFood(detailFood)}
            isQuickAdding={isQuickAdding}
            isReadyLikeFood={isReadyLikeFood(detailFood)}
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
            onClose={() => setDetailFood(null)}
            onEdit={() => {
              onNavigate({ workspace: 'eat', view: 'food', foodId: detailFood.id });
              setDetailFood(null);
            }}
            onEditRecipe={() => {
              if (detailFood.recipe_id) {
                onNavigate({ workspace: 'eat', view: 'recipe', recipeId: detailFood.recipe_id });
              } else {
                onNavigate({ workspace: 'eat', view: 'food', foodId: detailFood.id });
              }
              setDetailFood(null);
            }}
            onOpenPlanDialog={(food) => {
              openHomePlanAddDialog(food, foodRecommendations?.target_meal_type ?? 'dinner');
              setDetailFood(null);
            }}
            onStartCook={() => {
              // Same confirmation dialog as Discover / primary recommendation cook.
              openQuickMealDialog(detailFood, foodRecommendations?.target_meal_type, {
                date: foodRecommendations?.target_date,
                preferFallbackMealType: true,
              });
              setDetailFood(null);
            }}
            onQuickAdd={(food, mealType) => {
              openQuickMealDialog(food, mealType);
              setDetailFood(null);
            }}
            resolveAssetUrl={(url) => resolveAssetUrl(url) ?? url}
            overlayRootClassName="home-dashboard-overlay-root"
          />
        );
      })()}

      {morePlansPopover && (
        <WorkspaceOverlayFrame
          rootClassName="home-dashboard-overlay-root"
          onClose={() => setMorePlansPopover(null)}
        >
          <WorkspaceModal
            title={`${formatDate(morePlansPopover.date)} · ${MEAL_TYPE_LABELS[morePlansPopover.mealType]}计划`}
            description={`共 ${morePlansPopover.items.length} 项计划`}
            eyebrow="餐食清单"
            className="home-more-plans-modal"
            onClose={() => setMorePlansPopover(null)}
          >
            <div className="home-more-plans-grid">
              {morePlansPopover.items.map((item) => {
                const planFood = foods.find((food) => food.id === item.food_id);
                const planCoverUrl = resolveAssetUrl(planFood ? getFoodCover(planFood, recipes) : undefined);
                const planTitle = item.recipe_title || item.food_name || planFood?.name || '未命名食物';
                return (
                  <button
                    key={item.id}
                    className={item.status === 'cooked' ? 'dashboard-plan-dish is-cooked' : 'dashboard-plan-dish'}
                    type="button"
                    onClick={() => {
                      openHomePlanDetail(item);
                      setMorePlansPopover(null);
                    }}
                    title={planTitle}
                  >
                    <MediaWithPlaceholder src={planCoverUrl} alt="" />
                    <span>{planTitle}</span>
                  </button>
                );
              })}
            </div>
          </WorkspaceModal>
        </WorkspaceOverlayFrame>
      )}

      <main className="dashboard-page">
        <PageHeader
          title="首页"
          description="把今天要做、要买、要处理的事放在一个清晰工作台里。"
          actions={
            <div className="dashboard-hero-actions">
              <button className="solid-button dashboard-action-primary" type="button" onClick={onOpenGlobalSearch}>
                <DashboardIcon name="search" />
                全局搜索
              </button>
            </div>
          }
        />

        <div className="dashboard-stat-grid">
          {dashboardStats.map((item) => (
            <article key={item.label} className={`dashboard-stat-card card-tone-${item.tone}`}>
              <span className={`dashboard-stat-icon tone-${item.tone}`}>
                <DashboardIcon name={item.icon} />
              </span>
              <div>
                <span>{item.label}</span>
                <strong>
                  {item.value}
                  <small>{item.unit}</small>
                </strong>
                <p>{item.detail}</p>
              </div>
            </article>
          ))}
        </div>

        <section className="home-question-one card dashboard-panel">
          <header className="home-question-head home-question-one-head">
            <div>
              <h2>今天吃什么</h2>
            </div>
            <button
              className="ghost-button button-compact"
              type="button"
              onClick={onNextDesktopRecommendations}
              disabled={recommendationCount <= 3}
            >
              <DashboardIcon name="refresh" />
              换一批
            </button>
          </header>

          {desktopRecommendations.length > 0 ? (
            <div
              className={[
                'dashboard-food-scroller',
                recommendationScrollState.canScrollLeft ? 'can-scroll-left' : '',
                recommendationScrollState.canScrollRight ? 'can-scroll-right' : '',
              ].filter(Boolean).join(' ')}
              data-testid="home-recommendation-scroller"
            >
              <div
                ref={recommendationRowRef}
                className="dashboard-food-row"
                data-testid="home-recommendation-row"
                onScroll={syncRecommendationScrollState}
              >
              {desktopRecommendations.map(({ recommendation, coverUrl }) => {
                const food = recommendation.food;
                const canStartRecipe = Boolean(food.recipe_id);
                const primaryActionLabel = canStartRecipe ? '开始做' : '加入计划';
                return (
                  <article
                    key={food.id}
                    className="dashboard-food-card"
                    data-testid="home-recommendation-card"
                    role="button"
                    tabIndex={0}
                    aria-label={`查看食物详情：${food.name}`}
                    onClick={() => openDetail(food)}
                    onKeyDown={(event) => handleRecommendationCardKeyDown(event, food)}
                  >
                    <div className="dashboard-food-cover">
                      <MediaWithPlaceholder src={resolveAssetUrl(coverUrl)} alt="" />
                    </div>
                    <div className="dashboard-food-body">
                      <h3>{food.name}</h3>
                      <div className="dashboard-badge-row">
                        <Badge>{FOOD_TYPE_LABELS[food.type]}</Badge>
                        <Badge>{food.routine_note || `${food.suitable_meal_types.length || 1} 餐适合`}</Badge>
                      </div>
                      <p>{recommendation.reasons[0] ?? food.notes ?? '适合今天安排'}</p>
                      <div className="dashboard-food-actions">
                        <button
                          className="solid-button button-compact"
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            if (canStartRecipe) {
                              openQuickMealDialog(food, foodRecommendations?.target_meal_type);
                              return;
                            }
                            openHomePlanAddDialog(food, foodRecommendations?.target_meal_type ?? 'dinner');
                          }}
                          disabled={isQuickAdding || isCreatingFoodPlanItem}
                        >
                          {primaryActionLabel}
                        </button>
                        <button
                          className="dashboard-icon-button"
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            openHomePlanAddDialog(food, foodRecommendations?.target_meal_type ?? 'dinner');
                          }}
                          disabled={isCreatingFoodPlanItem}
                          aria-label={`加入菜单：${food.name}`}
                          title="加入菜单"
                        >
                          <DashboardIcon name="calendar" />
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
              </div>
            </div>
          ) : (
            <EmptyState title="暂无推荐" description="补充食材或菜谱后，这里会出现今日建议。" />
          )}

          <HomeCompactCalendar
            days={compactPlanDays}
            selectedDate={selectedPlanDate}
            selectedSummary={selectedPlanSummary}
            onSelectDate={onSelectedPlanDateChange}
            onPreviousWeek={onFoodPlanPreviousWeek}
            onCurrentWeek={onFoodPlanCurrentWeek}
            onNextWeek={onFoodPlanNextWeek}
            onOpenFullWeek={onOpenFullWeek}
            onAddMeal={openHomePlanAddEmptyDialog}
            onOpenPlanDetail={openHomePlanDetail}
            onOpenMealPlans={(date, mealType, items) => setMorePlansPopover({ date, mealType, items })}
            resolvePlanItemCoverUrl={resolvePlanItemCoverUrl}
          />
        </section>

        <div className="home-dashboard-lower-grid" data-testid="home-lower-grid">
          <HomeRequiredActions
            actions={requiredActions}
            hasMore={hasMoreHomeActions}
            onOpenInventory={handleOpenInventoryAction}
            onOpenShoppingIntake={onOpenShoppingIntake}
            onOpenReconciliation={() => onOpenReconciliation?.({ scope: 'suggested' })}
            onViewAll={onOpenIngredientPriority}
          />
          <HomeHighlightTimeline
            viewModel={homeHighlights}
            limit={5}
            onRetry={onRetryHighlights}
            onViewAll={onOpenFamilyActivity}
          />
        </div>
      </main>
    </>
  );
}
