import { useCallback, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { UpdateShoppingItemPayload } from '../../api/ingredientsApi';
import type {
  Food,
  FoodPlanItem,
  FoodPayload,
  FoodScene,
  FoodType,
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
  CompleteFoodPlanItemPayload,
  MealLog,
  MealLogCandidate,
  RecordMealPayload,
  RecordMealResponse,
  RecordMealTarget,
  UpdateMealLogPayload,
} from '../../api/types/meal';
import type { AppNavigationTarget } from '../../app/appNavigationModel';
import type { FoodPlanNavigationRequest } from '../../app/useAppGlobalSearchNavigation';
import { buildMediaSizes, buildMediaSrcSet, resolveAssetUrl, resolveMediaUrl } from '../../lib/assets';
import { getPendingImageJobId } from '../../lib/aiImages';
import {
  ActionButton,
  EmptyState,
  FormActions,
  WorkspaceModal,
  WorkspaceOverlayFrame,
} from '../ui-kit';
import { FoodPlanDetailModal } from './FoodPlanDetailModal';
import { FoodPlanDetailWithCandidates } from './FoodPlanDetailWithCandidates';
import { FoodPlanDialog } from './FoodPlanDialog';
import { FoodQuickMealDialog } from './FoodQuickMealDialog';
import { FoodRecipeEditorDialog } from './FoodRecipeEditorDialog';
import { FoodSceneDialogs } from './FoodSceneDialogs';
import { FoodWorkspaceShoppingOverlays } from './FoodWorkspaceShoppingOverlays';
import { FoodWorkspaceEditorOverlay } from './FoodWorkspaceEditorOverlay';
import { FoodWorkspaceDetailOverlay } from './FoodWorkspaceDetailOverlay';
import { FoodWorkspacePlanOverlays } from './FoodWorkspacePlanOverlays';
import { FoodWorkspaceQuickRecordOverlay } from './FoodWorkspaceQuickRecordOverlay';
import { FoodDiscoverSurface } from './FoodDiscoverSurface';
import { FoodHubView } from './FoodHubView';
import { type FoodPlanSurfaceProps } from './FoodPlanSurface';
import { FoodPlanWeekMobilePage } from './FoodPlanWeekMobilePage';
import {
  createMealBusinessDate,
  createMealRecordDateOptions,
} from '../../features/meals/MealComposerModel';
import { FoodTabletSupportSurface } from './FoodTabletSupportSurface';
import { MealEnrichmentModal } from '../../features/meals/MealEnrichmentModal';
import { MealQuickRecordView } from '../../features/meals/MealQuickRecordView';
import { MealRecordResultBar } from '../../features/meals/MealRecordResultBar';
import type { MealRecordResult } from '../../features/meals/useMealRecordResultState';
import { FOOD_TYPE_LABELS, getFoodCover, getFoodCoverAsset, getImagePreview, splitTags, todayKey } from '../../lib/ui';
import {
  IDLE_IMAGE_GENERATION_STATE,
  useImageComposer,
} from '../../hooks/useImageComposer';
import { useNotice } from '../../hooks/useNotice';
import { RecipeEditorView } from '../recipes/RecipeEditorView';
import { useRecipeEditorState } from '../recipes/useRecipeEditorState';
import {
  buildRecipeImagePayload,
  getRecipeDraftGenerationButtonLabel,
} from '../recipes/RecipeWorkspaceModel';
import { FoodUiIcon } from './FoodWorkspacePrimitives';
import { getFoodEditorProfile } from './FoodWorkspaceHelpers';
import {
  FOOD_CREATE_TYPE_OPTIONS,
  FOOD_GOVERNANCE_ISSUE_OPTIONS,
  FOOD_QUICK_VIEW_OPTIONS,
  MOBILE_DEFAULT_FOOD_SCENES,
  FOOD_LENS_COPY,
  type FoodWorkspaceLens,
} from './FoodWorkspaceOptions';
import {
  getFoodPlanDateParts,
  getSuggestedMealTypeForHour,
  isReadyLikeType,
  isOutsideType,
  resolveFoodAssetUrl,
  getFoodCardPrimaryActionLabel,
  isFoodShoppingEligible,
  formatFoodStock,
  getFoodFormCompletionItems,
  getFoodImagePayload,
  buildFoodPayloadFromForm,
  type FoodFormState,
} from './FoodWorkspaceModel';
import { useFoodPlanState } from './useFoodPlanState';
import { useFoodSceneState } from './useFoodSceneState';
import { getMobileFoodSceneFilterState } from './FoodMobileSceneModel';
import {
  buildMobileFilterResetKey,
  buildMobileSceneExploreCards,
  filterMobileLibraryFoods,
  paginateMobileSceneCards,
} from './FoodMobileLibraryModel';
import { buildFoodEditorSceneTagOptions, buildRecipeEditorSceneTagOptions } from './FoodWorkspaceViewModel';
import { useFoodWorkspaceState } from './useFoodWorkspaceState';
import { useFoodWorkspaceSearch } from './useFoodWorkspaceSearch';
import { useFoodWorkspaceDialogState, type MobileCookingFilter } from './useFoodWorkspaceDialogState';
import { useFoodQuickMealActions } from './useFoodQuickMealActions';
import { FoodDetailDrawer } from './FoodDetailDrawer';
import { FoodEditorForm } from './FoodEditorForm';
import { buildFoodEditorCompletionState, buildRecipeEditorCompletionState } from './FoodEditorProjectionModel';
import { FoodMobileView } from './FoodMobileView';
import { FoodShoppingDialog } from './FoodShoppingDialog';
import { FoodLibraryFilters } from './FoodLibraryFilters';
import { FoodDesktopSidebar } from './FoodDesktopSidebar';
import {
  FoodCardLibrary,
  type FoodLibraryCardActions,
} from './FoodLibraryCard';
import {
  buildFoodShoppingDialogState,
  buildFoodShoppingWrite,
  type FoodShoppingDialogState,
} from './FoodShoppingModel';
import { RecipeShoppingDialog } from '../recipes/RecipeShoppingDialog';
import { useRecipeShoppingState } from '../recipes/useRecipeShoppingState';
import { SHOPPING_UNIT_OPTIONS } from '../recipes/RecipeWorkspaceOptions';
import { resolveIngredientImageUrl } from '../recipes/RecipeWorkspaceModel';
import {
  normalizeFoodType,
  isReadyLikeFood,
  isOutsideFood,
  getFoodSceneTags,
  describeExpiry,
  getFoodStatus,
  getFoodInventoryConfirmation,
  getDefaultMealType,
  getPrimaryFoodActionLabel,
  getSecondaryFoodActionLabel,
  getRepurchaseLabel,
  getFoodFactRows,
  getFoodMealHistory,
  getFoodAudienceText,
  getFoodGovernanceIssues,
  getFoodGovernanceIssueLabels,
  buildFoodRelationViewModelFromRecipeCards,
  buildFoodCookingSummaryFromRecipeCards,
  type FoodCookingSummary,
} from './FoodWorkspaceHelpers';
import { useFoodWorkspaceData } from './useFoodWorkspaceData';
import { useFoodGovernanceData } from './useFoodGovernanceData';
import { useFoodQuickRecordCandidates } from './useFoodQuickRecordCandidates';
import { useFoodQuickRecordSubmit } from './useFoodQuickRecordSubmit';
import { createFoodShoppingSubmit } from './useFoodShoppingActions';
import { submitFoodRecipeEditorAction } from './useFoodRecipeEditorActions';
import { submitFoodFormAction } from './useFoodFormActions';
import { submitFoodCookConfirmAction } from './useFoodCookActions';
import { useFoodNavigationRequests } from './useFoodNavigationRequests';
import { useFoodEditorNavigation } from './useFoodEditorNavigation';

const FOOD_EDITOR_FORM_ID = 'food-editor-form';

export { FOOD_CREATE_TYPE_OPTIONS, type FoodGovernanceIssue } from './FoodWorkspaceOptions';
export { buildFoodPayloadFromForm, type FoodFormState } from './FoodWorkspaceModel';
export { getSuggestedMealTypeForHour } from './FoodWorkspaceModel';

export type { TodayFoodRecommendation } from './FoodRecommendationsModel';
export { buildTodayFoodRecommendations } from './FoodRecommendationsModel';

export { resolveFoodNavigationRequestAction } from './FoodNavigationModel';
export type { FoodWorkspaceNavigationRequest } from './FoodNavigationModel';

type Props = {
  foods: Food[];
  recipes: Recipe[];
  ingredients: Ingredient[];
  inventoryItems: InventoryItem[];
  mealLogs: MealLog[];
  members: Member[];
  foodScenes: FoodScene[];
  foodPlanItems: FoodPlanItem[];
  foodPlanWeekRange: { start: string; end: string };
  isPhoneViewport?: boolean;
  notificationCenter?: ReactNode;
  navigationRequest?: {
    foodId: string;
    requestId: number;
    target?: 'detail' | 'edit' | 'quickMeal';
    quickMealAction?: 'eat' | 'cook';
  } | null;
  foodPlanNavigationRequest?: FoodPlanNavigationRequest | null;
  createFood: (payload: FoodPayload) => Promise<Food>;
  updateFood: (foodId: string, payload: UpdateFoodPayload) => Promise<Food>;
  updateFoodFavorite: (foodId: string, favorite: boolean, expectedRowVersion: number) => Promise<Food>;
  createRecipe: (payload: RecipePayload) => Promise<Recipe>;
  updateRecipe: (recipeId: string, payload: RecipePayload) => Promise<Recipe>;
  /** Ordinary Food card / takeout / dining-out record owner (Task 15). */
  recordMeal: (payload: RecordMealPayload) => Promise<RecordMealResponse>;
  /** Injectable candidate loader for compact record. */
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
  /** Non-Recipe Food workspace plan completion owner. */
  completeFoodPlanItem: (itemId: string, payload: CompleteFoodPlanItemPayload) => Promise<MealLog>;
  updateMealLog: (mealLogId: string, payload: UpdateMealLogPayload) => Promise<unknown>;
  shoppingItems: ShoppingListItem[];
  createShoppingItem: (payload: {
    title: string;
    quantity?: number | null;
    unit?: string | null;
    ingredient_id?: string | null;
    food_id?: string | null;
    quantity_mode?: ShoppingListItem['quantity_mode'];
    display_label?: string | null;
    reason: string;
  }) => Promise<unknown>;
  updateShoppingItem: (itemId: string, payload: UpdateShoppingItemPayload) => Promise<unknown>;
  createFoodPlanItem: (payload: { food_id: string; plan_date: string; meal_type: MealType; note: string }) => Promise<FoodPlanItem>;
  updateFoodPlanItem: (itemId: string, payload: { food_id?: string; plan_date?: string; meal_type?: MealType; note?: string; status?: 'planned' | 'cooked' | 'skipped' }) => Promise<FoodPlanItem>;
  deleteFoodPlanItem: (itemId: string) => Promise<void>;
  createFoodScene: (payload: {
    name: string;
    description: string;
    image_prompt: string;
    image_asset_id?: string;
    hidden: boolean;
    custom: boolean;
    sort_order: number;
  }) => Promise<FoodScene>;
  updateFoodScene: (
    sceneId: string,
    payload: {
      name?: string;
      description?: string;
      image_prompt?: string;
      image_asset_id?: string;
      hidden?: boolean;
      custom?: boolean;
      sort_order?: number;
    }
  ) => Promise<FoodScene>;
  deleteFoodScene: (sceneId: string) => Promise<void>;
  onStartRecipe: (recipeId: string, foodPlanItemId?: string) => void;
  /** Semantic navigation for direct Cook (no implicit plan creation). */
  navigate?: (target: AppNavigationTarget) => void;
  onOpenLogs: () => void;
  onFoodPlanPreviousWeek: () => void;
  onFoodPlanCurrentWeek: () => void;
  onFoodPlanNextWeek: () => void;
  isSavingFood?: boolean;
  isCreatingRecipe?: boolean;
  isUpdatingRecipe?: boolean;
  isUpdatingFavorite?: boolean;
  isQuickAdding?: boolean;
  isCompletingPlan?: boolean;
  isUpdatingPlan?: boolean;
  isUpdatingScene?: boolean;
  isUpdatingMeal?: boolean;
  isCreatingShopping?: boolean;
};

export function FoodWorkspace(props: Props) {
  const {
    view,
    setView,
    editingFood,
    detailFoodId,
    closeDetail,
    form,
    setForm,
    search,
    setSearch,
    lensFilter,
    setLensFilter,
    governanceIssueFilter,
    setGovernanceIssueFilter,
    typeFilter,
    setTypeFilter,
    mealFilter,
    setMealFilter,
    sceneFilter,
    setSceneFilter,
    isSceneTagPickerOpen,
    setIsSceneTagPickerOpen,
    newSceneTagName,
    setNewSceneTagName,
    feedback,
    setFeedback,
    editorSceneTags,
    openCreate,
    openEdit,
    openDetail,
    submitFood,
    toggleMealType,
    removeSceneTag,
    addSceneTag,
    createAndAddSceneTag,
    clearFoodFilters,
    openGovernanceIssue,
  } = useFoodWorkspaceState({
    foods: props.foods,
    foodScenes: props.foodScenes,
    recipes: props.recipes,
    navigationRequest: props.navigationRequest,
    createFood: props.createFood,
    updateFood: props.updateFood,
    createFoodScene: props.createFoodScene,
  });
  const { notice, showNotice, clearNotice } = useNotice();
  const recipeShopping = useRecipeShoppingState({
    ingredients: props.ingredients,
    createShoppingItem: props.createShoppingItem,
    showRecipeNotice: showNotice,
  });
  const foodPlanWeekRef = useRef<HTMLDivElement | null>(null);
  const [mobileWeekPlanDate, setMobileWeekPlanDate] = useState<string | null>(null);
  const [planMealEnrichment, setPlanMealEnrichment] = useState<{
    meal: MealLog;
    planItem: FoodPlanItem;
  } | null>(null);
  const [foodShoppingDialog, setFoodShoppingDialog] = useState<FoodShoppingDialogState | null>(null);
  const [foodShoppingError, setFoodShoppingError] = useState<string | null>(null);
  const [isFoodShoppingSubmitting, setIsFoodShoppingSubmitting] = useState(false);

  const handleNavigateToWeek = useCallback((planDate: string) => {
    if (props.isPhoneViewport) {
      setMobileWeekPlanDate(planDate);
      return;
    }
    requestAnimationFrame(() => {
      foodPlanWeekRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
      foodPlanWeekRef.current?.focus({ preventScroll: true });
    });
  }, [props.isPhoneViewport]);

  const {
    closeSceneForm,
    deleteScene,
    generateFoodSceneImage,
    isSceneManagerOpen,
    openCreateScene,
    openEditScene,
    sceneCards,
    sceneDraft,
    sceneFormMode,
    sceneImageState,
    setIsSceneManagerOpen,
    setSceneDraft,
    submitScene,
  } = useFoodSceneState({
    foods: props.foods,
    foodScenes: props.foodScenes,
    createFoodScene: props.createFoodScene,
    updateFoodScene: props.updateFoodScene,
    deleteFoodScene: props.deleteFoodScene,
  });
  const {
    activePlanDetailFood,
    activePlanDetailItem,
    clearPlanFoodSelection,
    closePlanDetail,
    closePlanDialog,
    completePlanItem,
    deletePlanDetail,
    foodPlanDays,
    isPlanDetailEditing,
    isPlanDialogOpen,
    openPlanDetail,
    openPlanDialog,
    planDetailForm,
    planFoodSearch,
    planForm,
    resetPlanDetailForm,
    selectedPlanFood,
    setIsPlanDetailEditing,
    setPlanDetailForm,
    setPlanFoodSearch,
    setPlanForm,
    submitPlanDetail,
    submitPlanItem,
  } = useFoodPlanState({
    foods: props.foods,
    foodPlanItems: props.foodPlanItems,
    foodPlanWeekRange: props.foodPlanWeekRange,
    navigationRequest: props.foodPlanNavigationRequest,
    onNavigateToWeek: handleNavigateToWeek,
    showNotice,
    setFeedback,
    getDefaultMealType,
    createFoodPlanItem: props.createFoodPlanItem,
    updateFoodPlanItem: props.updateFoodPlanItem,
    deleteFoodPlanItem: props.deleteFoodPlanItem,
    completeFoodPlanItem: props.completeFoodPlanItem,
    // Plan complete must never publish ordinary record undo.
    publishRecordResult: undefined,
    onMealRecorded: (meal, planItem) => setPlanMealEnrichment({ meal, planItem }),
    onStartRecipe: props.onStartRecipe,
  });
  const recipeEditor = useRecipeEditorState({ ingredients: props.ingredients });
  const {
    appliedSearch: appliedFoodSearch,
    matchedFoodIds,
    searchAwareFoods: remoteSearchFoods,
    isFetching: isFoodSearchFetching,
    composition: foodSearchComposition,
  } = useFoodWorkspaceSearch(search);
  const searchAwareFoods = remoteSearchFoods ?? props.foods;

  const {
    foodUsageCards,
    recipeCards,
    repeatFoods,
    repeatFoodCount,
    filteredFoods,
    foodCardViewModels,
    foodCardResetKey,
  } = useFoodWorkspaceData({
    foods: props.foods,
    searchAwareFoods,
    recipes: props.recipes,
    ingredients: props.ingredients,
    inventoryItems: props.inventoryItems,
    mealLogs: props.mealLogs,
    appliedFoodSearch,
    matchedFoodIds,
    typeFilter,
    mealFilter,
    lensFilter,
    sceneFilter,
    governanceIssueFilter,
  });
  const getFoodCookingSummary = (food: Food): FoodCookingSummary | null => buildFoodCookingSummaryFromRecipeCards(food, recipeCards);
  const { expiringFoods, needsInfoFoods, governanceIssueSummaries, governanceQueue } = useFoodGovernanceData({
    foods: props.foods,
    recipes: props.recipes,
    issueFilter: governanceIssueFilter,
    issueOptions: FOOD_GOVERNANCE_ISSUE_OPTIONS,
  });
  const suggestedMealType = useMemo(() => getSuggestedMealTypeForHour(), []);
  const currentLensCopy = FOOD_LENS_COPY[lensFilter];
  const detailFood = detailFoodId ? props.foods.find((food) => food.id === detailFoodId) ?? null : null;
  const managementIssueCount = new Set([...expiringFoods, ...needsInfoFoods].map((food) => food.id)).size;
  const nextGovernanceFood = governanceQueue[0] ?? null;
  const nextGovernanceSummary = nextGovernanceFood ? `${nextGovernanceFood.name} · ${getFoodGovernanceIssueLabels(nextGovernanceFood, props.recipes).join('、')}` : '信息已补齐';
  const hasFoodFilters = Boolean(search.trim()) || typeFilter !== 'all' || mealFilter !== 'all' || lensFilter !== 'all' || sceneFilter !== 'all' || governanceIssueFilter !== 'all';
  const todayDate = todayKey();
  const mealBusinessDate = createMealBusinessDate();
  // Recipe cook confirmation still uses FoodQuickMealDialog (no stock fields).
  const {
    quickMealDialog,
    setQuickMealDialog,
    quickRecord,
    setQuickRecord,
    isFoodRecipeEditorOpen,
    setIsFoodRecipeEditorOpen,
    mobileCookingFilter,
    setMobileCookingFilter,
  } = useFoodWorkspaceDialogState();
  const quickMealDateOptions = useMemo(
    () => createMealRecordDateOptions(mealBusinessDate),
    [mealBusinessDate]
  );
  const {
    openQuickMealDialog,
    updateQuickMealDialog,
    handleFoodCardPrimaryAction,
  } = useFoodQuickMealActions({
    recipes: props.recipes,
    mealBusinessDate,
    suggestedMealType,
    setQuickMealDialog,
    setQuickRecord,
  });
  function selectMobileFoodScene(sceneName: string) {
    const nextFilters = getMobileFoodSceneFilterState(sceneName);
    setSearch(nextFilters.search);
    setLensFilter(nextFilters.lensFilter);
    setTypeFilter(nextFilters.typeFilter);
    setMealFilter(nextFilters.mealFilter);
    setSceneFilter(nextFilters.sceneFilter);
    setGovernanceIssueFilter(nextFilters.governanceIssueFilter);
  }

  const mobileSceneExploreCards = buildMobileSceneExploreCards({
    foods: props.foods,
    sceneCards,
    defaultScenes: MOBILE_DEFAULT_FOOD_SCENES,
  }).map((card) => ({ ...card, onClick: () => selectMobileFoodScene(card.title) }));
  const mobileScenePages = paginateMobileSceneCards(mobileSceneExploreCards);
  const mobileLibraryFoods = filterMobileLibraryFoods(filteredFoods, mobileCookingFilter, getFoodCookingSummary);
  const mobileLibraryResetKey = buildMobileFilterResetKey([appliedFoodSearch, typeFilter, mealFilter, lensFilter, sceneFilter, governanceIssueFilter, mobileCookingFilter]);
  const mobileFilterTabs = [
    {
      label: '全部',
      active: lensFilter === 'all' && typeFilter === 'all' && mealFilter === 'all' && sceneFilter === 'all' && governanceIssueFilter === 'all' && mobileCookingFilter === 'all',
      onClick: () => {
        clearFoodFilters();
        setMobileCookingFilter('all');
      },
    },
    {
      label: '家常',
      active: typeFilter === 'selfMade',
      onClick: () => {
        setMobileCookingFilter('all');
        setLensFilter('all');
        setTypeFilter('selfMade');
        setMealFilter('all');
        setSceneFilter('all');
        setGovernanceIssueFilter('all');
      },
    },
    {
      label: '外卖',
      active: typeFilter === 'takeout',
      onClick: () => {
        setMobileCookingFilter('all');
        setLensFilter('all');
        setTypeFilter('takeout');
        setMealFilter('all');
        setSceneFilter('all');
        setGovernanceIssueFilter('all');
      },
    },
    {
      label: '收藏',
      active: lensFilter === 'favorite',
      onClick: () => {
        setMobileCookingFilter('all');
        setLensFilter('favorite');
        setTypeFilter('all');
        setMealFilter('all');
        setSceneFilter('all');
        setGovernanceIssueFilter('all');
      },
    },
    {
      label: '可做',
      active: mobileCookingFilter === 'ready',
      onClick: () => {
        setMobileCookingFilter('ready');
        setLensFilter('all');
        setTypeFilter('all');
        setMealFilter('all');
        setSceneFilter('all');
        setGovernanceIssueFilter('all');
      },
    },
    {
      label: '缺少食材',
      active: mobileCookingFilter === 'shortage',
      onClick: () => {
        setMobileCookingFilter('shortage');
        setLensFilter('all');
        setTypeFilter('all');
        setMealFilter('all');
        setSceneFilter('all');
        setGovernanceIssueFilter('all');
      },
    },
  ];

  const imagePayload = getFoodImagePayload(form, props.recipes);
  const imageComposer = useImageComposer({
    value: form.images,
    payload: imagePayload,
    onChange: (next) => setForm((current) => ({ ...current, images: next })),
    uploadErrorMessage: '图片上传成功，但生成主图失败。',
    generateErrorMessage: '生成主图失败，请稍后再试。',
  });
  const currentRecipe = props.recipes.find((recipe) => recipe.id === form.recipeId);
  const currentRecipeCard = currentRecipe ? recipeCards.find((card) => card.recipe.id === currentRecipe.id) ?? null : null;
  const isSelfMade = form.type === 'selfMade';
  const editorProfile = getFoodEditorProfile(form.type);
  const editorCompletion = buildFoodEditorCompletionState({ form, editingFood, recipes: props.recipes });
  const editorCompletionItems = editorCompletion.items;
  const editorCompletedCount = editorCompletion.completedCount;
  const editorCompletionPercent = editorCompletion.percent;
  const sceneTagOptions = buildFoodEditorSceneTagOptions({
    foodScenes: props.foodScenes,
    foods: props.foods,
    editorSceneTags,
  });
  const availableSceneTagOptions = sceneTagOptions.filter((tag) => !editorSceneTags.includes(tag));
  const editorRecipeCover = currentRecipe?.images[0]?.url ?? (editingFood ? getFoodCover(editingFood, props.recipes) : undefined);
  const editorRecipeMeta = currentRecipe ? `${currentRecipe.ingredient_items.length} 种食材 · ${currentRecipe.steps.length} 步` : '还没有菜谱';
  const recipeEditorCompletion = buildRecipeEditorCompletionState({
    title: recipeEditor.form.title,
    servings: recipeEditor.form.servings,
    ingredientRows: recipeEditor.ingredientRows,
    steps: recipeEditor.form.steps,
    hasCover: Boolean(getImagePreview(recipeEditor.form.images)),
  });
  const recipeEditorIngredientCount = recipeEditorCompletion.ingredientCount;
  const recipeEditorStepCount = recipeEditorCompletion.stepCount;
  const canSaveRecipeEditorDraft = Boolean(recipeEditor.form.title.trim() && recipeEditorIngredientCount > 0);
  const canSubmit = !props.isSavingFood && !props.isCreatingRecipe && !props.isUpdatingRecipe && (!isSelfMade || Boolean(form.recipeId) || canSaveRecipeEditorDraft);
  const foodEditorSubmitLabel = isSelfMade
    ? view === 'create'
      ? '保存家常菜谱'
      : '保存菜谱及食物信息'
    : view === 'create'
      ? '保存食物'
      : '保存修改';
  const recipeEditorSceneTags = splitTags(recipeEditor.form.sceneTags);
  const recipeEditorCoverAsset = getImagePreview(recipeEditor.form.images);
  const recipeEditorCoverUrl = resolveAssetUrl(recipeEditorCoverAsset?.url);
  const recipeEditorCompletionItems = recipeEditorCompletion.items;
  const recipeEditorCompletionPercent = recipeEditorCompletion.percent;
  const recipeEditorSceneSelectOptions = buildRecipeEditorSceneTagOptions({
    foodScenes: props.foodScenes,
    recipes: props.recipes,
  });
  const recipeEditorImagePayload = buildRecipeImagePayload(recipeEditor.form, recipeEditor.ingredientRows, props.ingredients);
  const recipeEditorImageComposer = useImageComposer({
    value: recipeEditor.form.images,
    payload: recipeEditorImagePayload,
    onChange: (images) => recipeEditor.setForm((current) => ({ ...current, images })),
    uploadErrorMessage: '参考图上传或 AI 主图生成失败',
    generateErrorMessage: 'AI 主图生成失败',
  });
  const recipeEditorSubmitDisabled = Boolean(props.isCreatingRecipe || props.isUpdatingRecipe);

  const {
    handleOpenCreate,
    handleOpenEdit,
    handleOpenRecipeEditorDirectly: openRecipeEditorDirectly,
    closeFoodRecipeEditor,
  } = useFoodEditorNavigation({
    resetFoodImage: () => imageComposer.setState(IDLE_IMAGE_GENERATION_STATE),
    resetRecipeImage: () => recipeEditorImageComposer.setState(IDLE_IMAGE_GENERATION_STATE),
    openCreate,
    openEdit,
    recipeCards,
    recipeEditorOpenCreate: recipeEditor.openCreate,
    recipeEditorOpenEdit: recipeEditor.openEdit,
    setRecipeEditorOpen: setIsFoodRecipeEditorOpen,
    closeDetail,
  });

  function handleOpenRecipeEditor() {
    if (!currentRecipeCard) {
      if (view === 'create' && isSelfMade) {
        recipeEditor.openCreate();
        setIsFoodRecipeEditorOpen(true);
        return;
      }
      showNotice({ tone: 'warning', title: '还没有菜谱', message: '请先补充菜谱和用料。' });
      return;
    }
    recipeEditorImageComposer.setState(IDLE_IMAGE_GENERATION_STATE);
    recipeEditor.openEdit(currentRecipeCard);
    setIsFoodRecipeEditorOpen(true);
  }

  function handleOpenRecipeEditorDirectly(food: Food) {
    if (openRecipeEditorDirectly(food)) return;
    showNotice({
      tone: 'warning',
      title: food.recipe_id ? '没有找到对应菜谱' : '没有相关菜谱',
      message: food.recipe_id ? '请确认该菜谱是否存在。' : '这份食物还没有对应的菜谱。',
    });
  }

  function closeFoodRecipeEditorIfAllowed() {
    if (!props.isCreatingRecipe && !props.isUpdatingRecipe) {
      closeFoodRecipeEditor();
    }
  }

  function closeFoodEditorIfAllowed() {
    if (!props.isSavingFood) {
      setView('list');
    }
  }

  function handleSubmitFood(event: Parameters<typeof submitFood>[0]) {
    void submitFoodFormAction({
      event,
      canSubmit,
      form,
      isReadyLike: isReadyLikeType(form.type),
      isSelfMade,
      recipeForm: recipeEditor.form,
      ingredientRows: recipeEditor.ingredientRows,
      ingredients: props.ingredients,
      recipes: props.recipes,
      selectedRecipeId: recipeEditor.selectedRecipeId,
      submitFood,
      updateRecipe: props.updateRecipe,
      createRecipe: props.createRecipe,
      setView,
      resetFoodImage: () => imageComposer.setState(IDLE_IMAGE_GENERATION_STATE),
      resetRecipeImage: () => recipeEditorImageComposer.setState(IDLE_IMAGE_GENERATION_STATE),
      showNotice,
    });
  }

  function submitFoodRecipeEditor(event: FormEvent<HTMLFormElement>) {
    void submitFoodRecipeEditorAction(event, {
      form,
      recipeForm: recipeEditor.form,
      ingredientRows: recipeEditor.ingredientRows,
      ingredients: props.ingredients,
      selectedRecipeId: recipeEditor.selectedRecipeId,
      updateRecipe: props.updateRecipe,
      createRecipe: props.createRecipe,
      showNotice,
      setForm,
      setView,
      view: view === 'list' ? 'create' : view,
      isSelfMade,
      closeEditor: () => {
        setIsFoodRecipeEditorOpen(false);
        recipeEditorImageComposer.setState(IDLE_IMAGE_GENERATION_STATE);
      },
      resetImageState: () => imageComposer.setState(IDLE_IMAGE_GENERATION_STATE),
    });
  }

  function openFoodShoppingDialog(food: Food) {
    if (!isReadyLikeFood(food)) return;
    setFoodShoppingError(null);
    setFoodShoppingDialog(buildFoodShoppingDialogState(food, props.shoppingItems));
  }

  function openFoodShopping(food: Food) {
    if (normalizeFoodType(food) === 'selfMade' && food.recipe_id) {
      const card = recipeCards.find((entry) => entry.recipe.id === food.recipe_id);
      if (!card) {
        showNotice({ tone: 'warning', title: '暂时无法打开菜谱', message: '没有找到这道家常菜需要的食材，请刷新后再试。' });
        return;
      }
      recipeShopping.openShoppingDialog(card, () => undefined, 'all');
      return;
    }
    openFoodShoppingDialog(food);
  }

  const submitFoodShopping = createFoodShoppingSubmit({
    dialog: foodShoppingDialog,
    isSubmitting: isFoodShoppingSubmitting,
    setDialog: setFoodShoppingDialog,
    setSubmitting: setIsFoodShoppingSubmitting,
    setError: setFoodShoppingError,
    createShoppingItem: props.createShoppingItem,
    updateShoppingItem: props.updateShoppingItem,
    showNotice,
  });
  function submitCookConfirmDialog(event: FormEvent<HTMLFormElement>) {
    void submitFoodCookConfirmAction({
      event,
      dialog: quickMealDialog,
      recipes: props.recipes,
      setDialog: setQuickMealDialog,
      navigate: props.navigate,
      onStartRecipe: props.onStartRecipe,
    });
  }

  useFoodQuickRecordCandidates({
    quickRecord,
    setQuickRecord,
    loadMealCandidates: props.loadMealCandidates,
  });

  const { submitCompactRecord } = useFoodQuickRecordSubmit({
    quickRecord,
    setQuickRecord,
    recordMeal: props.recordMeal,
    recipes: props.recipes,
    setFeedback,
    mealBusinessDate,
    loadMealCandidates: props.loadMealCandidates,
    onRecordSuccess: props.onRecordSuccess,
  });

  const foodLibraryCardActionsRef = useRef<FoodLibraryCardActions>({
    onOpenDetail: openDetail,
    onToggleFavorite: (food) => {
      void props.updateFoodFavorite(food.id, !food.favorite, food.row_version);
    },
    onPrimaryAction: handleFoodCardPrimaryAction,
    onAddShopping: openFoodShopping,
    onAddPlan: (food) => openPlanDialog(food),
  });
  foodLibraryCardActionsRef.current = {
    onOpenDetail: openDetail,
    onToggleFavorite: (food) => {
      void props.updateFoodFavorite(food.id, !food.favorite, food.row_version);
    },
    onPrimaryAction: handleFoodCardPrimaryAction,
    onAddShopping: openFoodShopping,
    onAddPlan: (food) => openPlanDialog(food),
  };

  function openNextGovernanceFood() {
    const nextFood = governanceQueue[0];
    if (!nextFood) return;
    handleOpenEdit(nextFood);
  }

  useFoodNavigationRequests({
    foods: props.foods,
    navigationRequest: props.navigationRequest,
    onEdit: handleOpenEdit,
    onQuickMeal: openQuickMealDialog,
  });

  const planSurfaceProps: FoodPlanSurfaceProps = {
      weekRange: props.foodPlanWeekRange,
      days: foodPlanDays,
      getPlanItemCoverAsset: (item) => {
        const food = props.foods.find((candidate) => candidate.id === item.food_id);
        return food ? getFoodCoverAsset(food, props.recipes) : null;
      },
      weekSectionRef: foodPlanWeekRef,
      isUpdatingPlan: props.isUpdatingPlan,
      isStartingPlanItem: Boolean(props.isCompletingPlan || props.isQuickAdding),
      canCreatePlan: props.foods.length > 0,
      mobileWeekPage:
        mobileWeekPlanDate ? (
          <FoodPlanWeekMobilePage
            weekRange={props.foodPlanWeekRange}
            days={foodPlanDays}
            selectedDate={mobileWeekPlanDate}
            onSelectDate={setMobileWeekPlanDate}
            onOpenItem={(item) => {
              setMobileWeekPlanDate(null);
              openPlanDetail(item);
            }}
            onBack={() => setMobileWeekPlanDate(null)}
          />
        ) : null,
      onPreviousWeek: props.onFoodPlanPreviousWeek,
      onCurrentWeek: props.onFoodPlanCurrentWeek,
      onNextWeek: props.onFoodPlanNextWeek,
      onCreatePlan: (defaults) => openPlanDialog(undefined, defaults),
      onOpenPlanItem: openPlanDetail,
      onStartPlanItem: (item: FoodPlanItem) => {
        void completePlanItem(item);
      },
    };

    const discoverDesktopContent = (
      <FoodHubView
        heroActions={
          <div className="hero-actions">
            <ActionButton tone="primary" type="button" onClick={() => handleOpenCreate('takeout')}>
              <FoodUiIcon name="plus" />
              <span>新增食物</span>
            </ActionButton>
            <ActionButton tone="secondary" type="button" onClick={props.onOpenLogs}>
              <FoodUiIcon name="receipt" />
              <span>用餐记录</span>
            </ActionButton>
          </div>
        }
        filtersSection={<FoodLibraryFilters
          search={search}
          searchLoading={isFoodSearchFetching}
          typeFilter={typeFilter}
          mealFilter={mealFilter}
          lensFilter={lensFilter}
          governanceIssueFilter={governanceIssueFilter}
          hasFoodFilters={hasFoodFilters}
          filteredCount={filteredFoods.length}
          totalCount={props.foods.length}
          governanceQueueLength={governanceQueue.length}
          needsInfoCount={needsInfoFoods.length}
          nextGovernanceSummary={nextGovernanceSummary}
          governanceIssueSummaries={governanceIssueSummaries}
          onSearchChange={setSearch}
          onSearchClear={() => setSearch('')}
          onSearchCompositionStart={foodSearchComposition.onCompositionStart}
          onSearchCompositionEnd={foodSearchComposition.onCompositionEnd}
          onTypeFilterChange={setTypeFilter}
          onMealFilterChange={setMealFilter}
          onClearFilters={clearFoodFilters}
          onOpenNextGovernanceFood={openNextGovernanceFood}
          onGovernanceIssueChange={(issue) => openGovernanceIssue(issue)}
        />}
        feedbackSection={feedback ? (
          <div className="food-feedback">
            <span>{feedback}</span>
            <button type="button" onClick={props.onOpenLogs}>查看记录</button>
          </div>
        ) : null}
        gridSection={filteredFoods.length > 0 ? (
          <FoodCardLibrary
            models={foodCardViewModels}
            resetKey={foodCardResetKey}
            actionsRef={foodLibraryCardActionsRef}
            isUpdatingFavorite={Boolean(props.isUpdatingFavorite)}
            isQuickAdding={Boolean(props.isQuickAdding)}
          />
        ) : (
          <EmptyState
            title={currentLensCopy.emptyTitle}
            description={search || typeFilter !== 'all' || mealFilter !== 'all' || sceneFilter !== 'all' ? '没有符合条件的食物，可以清空筛选后再试。' : currentLensCopy.emptyDescription}
            action={
              search || typeFilter !== 'all' || mealFilter !== 'all' || sceneFilter !== 'all' ? (
                <ActionButton tone="secondary" type="button" onClick={clearFoodFilters}>清空筛选</ActionButton>
              ) : lensFilter === 'selfMade' ? (
                <ActionButton tone="primary" type="button" onClick={() => handleOpenCreate('selfMade')}>添加家常菜谱</ActionButton>
              ) : (
                <ActionButton tone="primary" type="button" onClick={() => handleOpenCreate('takeout')}>新增食物</ActionButton>
              )
            }
          />
        )}
        sidebar={<>
        <FoodDesktopSidebar
          repeatFoods={repeatFoods}
          repeatFoodCount={repeatFoodCount}
          managementIssueCount={managementIssueCount}
          needsInfoCount={needsInfoFoods.length}
          foodScenes={props.foodScenes}
          sceneCards={sceneCards}
          sceneFilter={sceneFilter}
          nextGovernanceFood={nextGovernanceFood}
          nextGovernanceSummary={nextGovernanceSummary}
          plan={planSurfaceProps}
          onSetLensFavorite={() => setLensFilter('favorite')}
          onSetLensExpiring={() => (expiringFoods.length > 0 ? setLensFilter('expiring') : openGovernanceIssue('all'))}
          onOpenGovernanceIssue={() => openGovernanceIssue('all')}
          onOpenSceneManager={() => setIsSceneManagerOpen(true)}
          onOpenNextGovernanceFood={openNextGovernanceFood}
          onToggleScene={(sceneName) => setSceneFilter(sceneFilter === sceneName ? 'all' : sceneName)}
        />
        <FoodTabletSupportSurface
          metrics={[
            {
              label: '常吃清单',
              value: repeatFoodCount,
              title: repeatFoods.map(({ food }) => food.name).join('、') || '常吃清单',
              onClick: () => setLensFilter('favorite'),
            },
            {
              label: '临期或需要完善信息',
              value: managementIssueCount,
              onClick: () => (expiringFoods.length > 0 ? setLensFilter('expiring') : openGovernanceIssue('all')),
            },
            {
              label: '需要完善',
              value: needsInfoFoods.length,
              onClick: () => openGovernanceIssue('all'),
            },
            {
              label: '场景管理',
              value: props.foodScenes.filter((scene) => !scene.hidden).length,
              onClick: () => setIsSceneManagerOpen(true),
            },
          ]}
          nextTaskLabel={nextGovernanceFood ? '下一项需要完善' : '需要完善'}
          nextTaskSummary={nextGovernanceSummary}
          canOpenNextTask={Boolean(nextGovernanceFood)}
          onOpenNextTask={openNextGovernanceFood}
          plan={planSurfaceProps}
          scenes={sceneCards.map((scene) => ({
            name: scene.name,
            description: scene.description || (scene.count > 0 ? `${scene.count} 种食物` : '浏览这个场景'),
            imageUrl: resolveMediaUrl(scene.imageAsset, 'thumb') ?? (scene.imageUrl ? resolveFoodAssetUrl(scene.imageUrl) : undefined),
            imageSrcSet: buildMediaSrcSet(scene.imageAsset),
            active: sceneFilter === scene.name,
            onSelect: () => setSceneFilter(sceneFilter === scene.name ? 'all' : scene.name),
          }))}
        />
        </>}
      />
    );

    const discoverMobileContent = (
      <FoodMobileView
        recipes={props.recipes}
        mealLogs={props.mealLogs}
        managementIssueCount={managementIssueCount}
        mobileScenePages={mobileScenePages}
        mobileLibraryFoods={mobileLibraryFoods}
        mobileLibraryResetKey={mobileLibraryResetKey}
        hasFoodFilters={hasFoodFilters}
        search={search}
        isSearchFetching={isFoodSearchFetching}
        emptyTitle={currentLensCopy.emptyTitle}
        isQuickAdding={props.isQuickAdding}
        isUpdatingFavorite={props.isUpdatingFavorite}
        notificationCenter={props.notificationCenter}
        weekPage={
          mobileWeekPlanDate ? (
            <FoodPlanWeekMobilePage
              weekRange={props.foodPlanWeekRange}
              days={foodPlanDays}
              selectedDate={mobileWeekPlanDate}
              onSelectDate={setMobileWeekPlanDate}
              onOpenItem={(item) => {
                setMobileWeekPlanDate(null);
                openPlanDetail(item);
              }}
              onBack={() => setMobileWeekPlanDate(null)}
            />
          ) : null
        }
        resolveFoodAssetUrl={resolveFoodAssetUrl}
        getFoodCardPrimaryActionLabel={getFoodCardPrimaryActionLabel}
        getDefaultMealType={getDefaultMealType}
        getFoodSceneTags={getFoodSceneTags}
        getFoodCookingSummary={getFoodCookingSummary}
        onSearchChange={setSearch}
        onSearchCompositionStart={foodSearchComposition.onCompositionStart}
        onSearchCompositionEnd={foodSearchComposition.onCompositionEnd}
        onOpenGovernanceIssue={() => openGovernanceIssue('all')}
        onOpenSceneManager={() => setIsSceneManagerOpen(true)}
        onOpenDetail={openDetail}
        onOpenPlanDialog={openPlanDialog}
        onHandleFoodCardPrimaryAction={handleFoodCardPrimaryAction}
        onToggleFavorite={(food) => void props.updateFoodFavorite(food.id, !food.favorite, food.row_version)}
        onOpenShopping={openFoodShopping}
        onOpenCreate={() => handleOpenCreate('takeout')}
        onOpenLogs={props.onOpenLogs}
        onClearFoodFilters={() => {
          clearFoodFilters();
          setMobileCookingFilter('all');
        }}
        filterTabs={mobileFilterTabs}
      />
    );

    const discoverSurfaceProps = {
      desktopContent: discoverDesktopContent,
      mobileContent: discoverMobileContent,
      loading: false,
      errorMessage: null as string | null,
      isEmpty: false,
      onCreateFood: () => handleOpenCreate('takeout'),
    };

    const surfaceContent = <FoodDiscoverSurface {...discoverSurfaceProps} />;

    return (
    <main className="food-workspace">
      {notice && (
        <div className={`recipe-notice-toast tone-${notice.tone}`} role={notice.tone === 'danger' ? 'alert' : 'status'} aria-live="polite">
          <span className="recipe-notice-icon">
            <FoodUiIcon name={notice.tone === 'success' ? 'check' : 'bell'} />
          </span>
          <span className="recipe-notice-copy">
            <strong>{notice.title}</strong>
            <small>{notice.message}</small>
          </span>
          <button type="button" onClick={clearNotice} aria-label="关闭提示">
            ×
          </button>
        </div>
      )}
      {surfaceContent}
      <FoodWorkspaceShoppingOverlays
        food={props.foods.find((item) => item.id === foodShoppingDialog?.draft.foodId) ?? props.foods[0]}
        foodShopping={foodShoppingDialog ? {
          open: true,
          draft: foodShoppingDialog.draft,
          existingItem: foodShoppingDialog.existingItem,
          busy: isFoodShoppingSubmitting,
          errorMessage: foodShoppingError,
          onDraftChange: (draft) => setFoodShoppingDialog((current) => current ? { ...current, draft } : current),
          onSubmit: () => void submitFoodShopping(),
          onClose: () => {
            if (!isFoodShoppingSubmitting) {
              setFoodShoppingDialog(null);
              setFoodShoppingError(null);
            }
          },
        } : null}
        recipeShopping={recipeShopping.shoppingDialogCard ? {
          open: true,
          card: recipeShopping.shoppingDialogCard,
          ingredients: props.ingredients,
          drafts: recipeShopping.shoppingDrafts,
          customForm: recipeShopping.shoppingCustomForm,
          isIngredientPickerOpen: recipeShopping.isShoppingIngredientPickerOpen,
          isCreatingShopping: props.isCreatingShopping,
          unitOptions: SHOPPING_UNIT_OPTIONS,
          resolveIngredientImageUrl,
          onClose: recipeShopping.closeShoppingDialog,
          onUpdateDraft: recipeShopping.updateShoppingDraft,
          onAdjustDraftQuantity: recipeShopping.adjustShoppingDraftQuantity,
          onRemoveDraft: recipeShopping.removeShoppingDraft,
          onAddRecipeIngredient: recipeShopping.addRecipeIngredientToShoppingDraft,
          onChangeCustomForm: recipeShopping.setShoppingCustomForm,
          onSetIngredientPickerOpen: recipeShopping.setIsShoppingIngredientPickerOpen,
          onSelectIngredientOption: recipeShopping.selectShoppingIngredientOption,
          onAdjustCustomQuantity: recipeShopping.adjustCustomShoppingQuantity,
          onAddCustomDraft: recipeShopping.addCustomShoppingDraft,
          onSubmit: () => void recipeShopping.submitShoppingDrafts(),
        } : null}
      />

      <FoodWorkspaceEditorOverlay
        open={view !== 'list' && !isFoodRecipeEditorOpen}
        title={view === 'create' ? '新增食物' : '编辑食物'}
        description={isSelfMade ? '家常菜的菜谱、用料和日常记录都可以在这里补充。' : '补充来源、价格、评分和到期信息，方便下次继续安排。'}
        isSavingFood={Boolean(props.isSavingFood)}
        isPhoneViewport={Boolean(props.isPhoneViewport)}
        completedCount={editorCompletedCount}
        onClose={closeFoodEditorIfAllowed}
        onSubmit={(event) => void handleSubmitFood(event)}
        editor={{
          availableSceneTagOptions,
          canSubmit,
          completionItems: editorCompletionItems,
          completionPercent: editorCompletionPercent,
          currentRecipe,
          editorProfile,
          editorRecipeCover,
          editorRecipeMeta,
          formId: FOOD_EDITOR_FORM_ID,
          form,
          imageState: imageComposer.state,
          isSavingFood: props.isSavingFood,
          isSceneTagPickerOpen,
          isSelfMade,
          isUpdatingScene: props.isUpdatingScene,
          newSceneTagName,
          sceneTags: editorSceneTags,
          showActions: false,
          submitLabel: foodEditorSubmitLabel,
          view: view as 'create' | 'edit',
          onAddSceneTag: addSceneTag,
          onBack: closeFoodEditorIfAllowed,
          onCreateAndAddSceneTag: () => void createAndAddSceneTag(),
          onFormChange: setForm,
          onGenerateImage: (mode) => void imageComposer.generate(mode),
          onEditRecipe: handleOpenRecipeEditor,
          onRemoveSceneTag: removeSceneTag,
          onResetImage: imageComposer.reset,
          onSceneTagPickerToggle: () => setIsSceneTagPickerOpen((current) => !current),
          onSubmit: (event) => void handleSubmitFood(event),
          onToggleMealType: toggleMealType,
          onUploadImage: (files) => void imageComposer.upload(files),
          resolveAssetUrl: resolveFoodAssetUrl,
          setNewSceneTagName,
        }}
      />

      {isFoodRecipeEditorOpen && (
        <FoodRecipeEditorDialog
          currentRecipeTitle={currentRecipe?.title}
          isEditing={Boolean(recipeEditor.selectedRecipeId || form.recipeId)}
          isSaving={Boolean(props.isCreatingRecipe || props.isUpdatingRecipe)}
          onClose={closeFoodRecipeEditor}
        >
          <RecipeEditorView
            isEditing={Boolean(recipeEditor.selectedRecipeId || form.recipeId)}
            entityLabel="菜谱"
            submitLabel="保存菜谱"
            previewLabel="回到食物"
            summaryCreateHint="保存后回到食物库"
            backLabel="回到食物"
            isRecipeAiApplied={false}
            selectedRecipeId={recipeEditor.selectedRecipeId}
            form={recipeEditor.form}
            setForm={recipeEditor.setForm}
            ingredientRows={recipeEditor.ingredientRows}
            ingredients={props.ingredients}
            sceneTagDraft={recipeEditor.sceneTagDraft}
            setSceneTagDraft={recipeEditor.setSceneTagDraft}
            sceneSelectOptions={recipeEditorSceneSelectOptions}
            editorSceneTags={recipeEditorSceneTags}
            visibleStepTips={recipeEditor.visibleStepTips}
            editorCoverUrl={recipeEditorCoverUrl}
            editorCoverAsset={recipeEditorCoverAsset}
            editorIngredientCount={recipeEditorIngredientCount}
            editorStepCount={recipeEditorStepCount}
            editorCompletionItems={recipeEditorCompletionItems}
            editorCompletionPercent={recipeEditorCompletionPercent}
            recipeDraftError={recipeEditor.recipeDraftError}
            isRecipeDraftBusy={false}
            recipeImageState={recipeEditorImageComposer.state}
            recipeDraftButtonLabel={getRecipeDraftGenerationButtonLabel(recipeEditor.recipeDraftGenerationStage)}
            submitDisabled={recipeEditorSubmitDisabled}
            isCreatingRecipe={props.isCreatingRecipe}
            isUpdatingRecipe={props.isUpdatingRecipe}
            showAiDraftAction={false}
            showDeleteAction={false}
            compactHeader
            onBack={closeFoodRecipeEditorIfAllowed}
            onSubmit={(event) => void submitFoodRecipeEditor(event)}
            onDelete={() => undefined}
            onOpenDraftDialog={() => undefined}
            updateIngredientRow={recipeEditor.updateIngredientRow}
            selectIngredientRow={recipeEditor.selectIngredientRow}
            updateIngredientNote={recipeEditor.updateIngredientNote}
            updateIngredientRequirement={recipeEditor.updateIngredientRequirement}
            addIngredientRow={recipeEditor.addIngredientRow}
            removeIngredientRow={recipeEditor.removeIngredientRow}
            updateStepDraft={recipeEditor.updateStepDraft}
            getStepKeyPointValues={recipeEditor.getStepKeyPointValues}
            getStepKeyPointRowCount={recipeEditor.getStepKeyPointRowCount}
            addStepTip={recipeEditor.addStepTip}
            addStepKeyPoint={recipeEditor.addStepKeyPoint}
            updateStepKeyPoint={recipeEditor.updateStepKeyPoint}
            removeStepKeyPoint={recipeEditor.removeStepKeyPoint}
            commitSceneTagDraft={recipeEditor.commitSceneTagDraft}
            handleRecipeImageUpload={(files) => recipeEditorImageComposer.upload(files)}
            handleRecipeImageGenerate={(mode) => recipeEditorImageComposer.generate(mode)}
            resetRecipeImageInput={recipeEditorImageComposer.reset}
          />
        </FoodRecipeEditorDialog>
      )}

      {/* Shared ordinary-record result bar from App props (no local mutation state). */}
      <MealRecordResultBar
        result={props.recordResult ?? null}
        isReverting={props.isRevertingRecord}
        revertError={props.recordRevertError}
        rateError={props.recordRateError}
        onRevert={props.onRevertRecord}
        onView={props.onViewRecord}
        onRate={props.onRateRecord}
        onDismiss={props.onDismissRecord}
      />

      <FoodWorkspaceQuickRecordOverlay
        record={quickRecord}
        recipes={props.recipes}
        dateOptions={quickMealDateOptions}
        isRecording={props.isQuickAdding}
        setRecord={setQuickRecord}
        onSubmit={() => void submitCompactRecord()}
      />

      {quickMealDialog && (() => {
        const isCookAction = quickMealDialog.action === 'cook' && quickMealDialog.recipeId;
        const isSubmitting = Boolean(props.isQuickAdding || (isCookAction && props.isUpdatingPlan));

        return (
          <FoodQuickMealDialog
            dialog={quickMealDialog}
            dateOptions={quickMealDateOptions}
            isSubmitting={isSubmitting}
            recipes={props.recipes}
            onChange={updateQuickMealDialog}
            onClose={() => setQuickMealDialog(null)}
            onSubmit={submitCookConfirmDialog}
          />
        );
      })()}

      <FoodWorkspaceDetailOverlay
        food={detailFood}
        recipes={props.recipes}
        mealLogs={props.mealLogs}
        recipeCards={recipeCards}
        todayDate={todayDate}
        isQuickAdding={props.isQuickAdding}
        onClose={closeDetail}
        onEdit={handleOpenEdit}
        onEditRecipe={handleOpenRecipeEditorDirectly}
        onOpenPlanDialog={openPlanDialog}
        onStartCook={() => {
          if (detailFood) openQuickMealDialog(detailFood, getDefaultMealType(detailFood), 'cook');
        }}
        onQuickAdd={(food, mealType) => openQuickMealDialog(food, mealType, 'eat')}
        resolveAssetUrl={resolveFoodAssetUrl}
      />

      <FoodWorkspacePlanOverlays
        planDialog={{
          isOpen: isPlanDialogOpen,
          selectedPlanFood,
          foods: props.foods,
          recipes: props.recipes,
          planFoodSearch,
          planForm,
          todayDate,
          isUpdatingPlan: props.isUpdatingPlan,
          onClose: closePlanDialog,
          onSubmit: submitPlanItem,
          onClearPlanFoodSelection: clearPlanFoodSelection,
          onPlanFoodSearchChange: setPlanFoodSearch,
          onSelectPlanFood: (food) => {
            setPlanForm((current) => ({ ...current, foodId: food.id, mealType: getDefaultMealType(food) }));
            setPlanFoodSearch(food.name);
          },
          onPlanDateChange: (value) => setPlanForm({ ...planForm, planDate: value }),
          onMealTypeChange: (value) => setPlanForm({ ...planForm, mealType: value }),
          onPlanNoteChange: (value) => setPlanForm({ ...planForm, note: value }),
          resolveFoodAssetUrl,
          getFoodCover,
          getFoodCoverAsset,
          getDefaultMealType,
          getPlanDateParts: getFoodPlanDateParts,
          normalizeFoodType,
        }}
        planDetail={activePlanDetailItem ? {
          item: activePlanDetailItem,
          food: activePlanDetailFood,
          recipes: props.recipes,
          form: planDetailForm,
          isEditing: isPlanDetailEditing,
          isUpdatingPlan: props.isUpdatingPlan,
          isCompleting: Boolean(props.isCompletingPlan || props.isQuickAdding),
          onClose: closePlanDetail,
          onChangeForm: setPlanDetailForm,
          onEditingChange: setIsPlanDetailEditing,
          onResetEdit: resetPlanDetailForm,
          onSubmit: submitPlanDetail,
          completePlanItem: (target) => void completePlanItem(activePlanDetailItem, target),
          deletePlanItem: () => void deletePlanDetail(activePlanDetailItem),
          resolveAssetUrl: resolveFoodAssetUrl,
        } : null}
      />

      <MealEnrichmentModal
        open={Boolean(planMealEnrichment)}
        meal={planMealEnrichment?.meal ?? null}
        members={props.members}
        isUpdating={Boolean(props.isUpdatingMeal)}
        updateMealLog={props.updateMealLog}
        onClose={() => setPlanMealEnrichment(null)}
        overlayRootClassName="food-workspace-overlay-root"
        formId="food-plan-meal-enrichment-form"
      />

      <FoodSceneDialogs
        isSceneManagerOpen={isSceneManagerOpen}
        sceneFormMode={sceneFormMode}
        sceneCards={sceneCards}
        sceneDraft={sceneDraft}
        sceneImageState={sceneImageState}
        isUpdatingScene={props.isUpdatingScene}
        onCloseManager={() => setIsSceneManagerOpen(false)}
        onOpenCreateScene={() => openCreateScene()}
        onOpenEditScene={openEditScene}
        onDeleteScene={(sceneId) => void deleteScene(sceneId)}
        onCloseSceneForm={closeSceneForm}
        onSubmitScene={submitScene}
        onGenerateSceneImage={() => void generateFoodSceneImage()}
        onSceneDraftChange={setSceneDraft}
        resolveFoodAssetUrl={resolveFoodAssetUrl}
      />
    </main>
  );
}
