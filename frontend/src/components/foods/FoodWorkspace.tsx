import { useCallback, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { UpdateShoppingItemPayload } from '../../api/ingredientsApi';
import type { FoodWorkspaceProps } from './FoodWorkspaceTypes';
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
import { buildMediaSizes, resolveAssetUrl } from '../../lib/assets';
import { getPendingImageJobId } from '../../lib/aiImages';
import {
  FormActions,
  WorkspaceModal,
  WorkspaceOverlayFrame,
} from '../ui-kit';
import { FoodPlanDetailModal } from './FoodPlanDetailModal';
import { FoodPlanDetailWithCandidates } from './FoodPlanDetailWithCandidates';
import { FoodPlanDialog } from './FoodPlanDialog';
import { FoodWorkspaceQuickMealDialog } from './FoodWorkspaceQuickMealDialog';
import { FoodWorkspaceNotice } from './FoodWorkspaceNotice';
import { FoodWorkspaceShoppingOverlays } from './FoodWorkspaceShoppingOverlays';
import { FoodWorkspacePlanOverlays } from './FoodWorkspacePlanOverlays';
import { FoodWorkspaceQuickRecordOverlay } from './FoodWorkspaceQuickRecordOverlay';
import { FoodWorkspaceDialogController } from './FoodWorkspaceDialogController';
import { type FoodPlanSurfaceProps } from './FoodPlanSurface';
import { buildFoodWorkspacePlanSurfaceProps } from './FoodWorkspacePlanSurfaceModel';
import { FoodPlanWeekMobilePage } from './FoodPlanWeekMobilePage';
import {
  createMealBusinessDate,
  createMealRecordDateOptions,
} from '../../features/meals/MealComposerModel';
import { MealEnrichmentModal } from '../../features/meals/MealEnrichmentModal';
import { MealQuickRecordView } from '../../features/meals/MealQuickRecordView';
import type { MealRecordResult } from '../../features/meals/useMealRecordResultState';
import { FOOD_TYPE_LABELS, getFoodCover, getFoodCoverAsset, getImagePreview, splitTags, todayKey } from '../../lib/ui';
import {
  IDLE_IMAGE_GENERATION_STATE,
  useImageComposer,
} from '../../hooks/useImageComposer';
import { useNotice } from '../../hooks/useNotice';
import { useRecipeEditorState } from '../recipes/useRecipeEditorState';
import {
  buildRecipeImagePayload,
  getRecipeDraftGenerationButtonLabel,
} from '../recipes/RecipeWorkspaceModel';
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
  buildFoodEditorSceneTagOptions,
  buildFoodMobileWorkspaceViewModel,
  buildFoodMobileFilterTabs,
  buildFoodGovernanceSummary,
  buildRecipeEditorSceneTagOptions,
} from './FoodWorkspaceViewModel';
import { useFoodWorkspaceState } from './useFoodWorkspaceState';
import { useFoodWorkspaceSearch } from './useFoodWorkspaceSearch';
import { useFoodWorkspaceDialogState, type MobileCookingFilter } from './useFoodWorkspaceDialogState';
import { useFoodQuickMealActions } from './useFoodQuickMealActions';
import { FoodDetailDrawer } from './FoodDetailDrawer';
import { FoodEditorForm } from './FoodEditorForm';
import { buildFoodWorkspaceEditorViewModel } from './FoodWorkspaceEditorViewModel';
import { FoodWorkspaceDiscoverView } from './FoodWorkspaceDiscoverView';
import { FoodWorkspaceDiscoverDesktop, FoodWorkspaceDiscoverMobile } from './FoodWorkspaceDiscoverDesktop';
import { FoodWorkspaceMealOverlays } from './FoodWorkspaceMealOverlays';
import { FoodWorkspaceOperationalOverlays } from './FoodWorkspaceOperationalOverlays';
import { FoodWorkspaceEditorSurface } from './FoodWorkspaceEditorSurface';
import { FoodShoppingDialog } from './FoodShoppingDialog';
import { type FoodLibraryCardActions } from './FoodLibraryCard';
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

export function FoodWorkspace(props: FoodWorkspaceProps) {
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
  const governanceSummary = buildFoodGovernanceSummary({
    expiringFoods,
    needsInfoFoods,
    governanceQueue,
    recipes: props.recipes,
    hasFilters: Boolean(search.trim()) || typeFilter !== 'all' || mealFilter !== 'all' || lensFilter !== 'all' || sceneFilter !== 'all' || governanceIssueFilter !== 'all',
  });
  const { managementIssueCount, nextGovernanceFood, nextGovernanceSummary, hasFoodFilters } = governanceSummary;
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

  const mobileWorkspaceViewModel = buildFoodMobileWorkspaceViewModel({
    foods: props.foods,
    filteredFoods,
    sceneCards,
    defaultScenes: MOBILE_DEFAULT_FOOD_SCENES,
    cookingFilter: mobileCookingFilter,
    appliedSearch: appliedFoodSearch,
    typeFilter,
    mealFilter,
    lensFilter,
    sceneFilter,
    governanceIssueFilter,
    getCookingSummary: getFoodCookingSummary,
  });
  const mobileSceneExploreCards = mobileWorkspaceViewModel.mobileSceneCards.map((card) => ({
    ...card,
    onClick: () => selectMobileFoodScene(card.title),
  }));
  const mobileScenePages = mobileWorkspaceViewModel.mobileScenePages.map((page) =>
    page.map((card) => ({ ...card, onClick: () => selectMobileFoodScene(card.title) })),
  );
  const mobileLibraryFoods = mobileWorkspaceViewModel.mobileLibraryFoods;
  const mobileLibraryResetKey = mobileWorkspaceViewModel.mobileLibraryResetKey;
  const mobileFilterTabs = buildFoodMobileFilterTabs({
    lensFilter,
    typeFilter,
    mealFilter,
    sceneFilter,
    governanceIssueFilter,
    cookingFilter: mobileCookingFilter,
    clearFilters: clearFoodFilters,
    setCookingFilter: setMobileCookingFilter,
    setLensFilter,
    setTypeFilter,
    setMealFilter,
    setSceneFilter,
    setGovernanceIssueFilter,
  });

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
  const editorViewModel = buildFoodWorkspaceEditorViewModel({
    form,
    editingFood,
    recipes: props.recipes,
    foods: props.foods,
    foodScenes: props.foodScenes,
    editorSceneTags,
    recipeForm: recipeEditor.form,
    ingredientRows: recipeEditor.ingredientRows,
    ingredients: props.ingredients,
    view,
    isSavingFood: Boolean(props.isSavingFood),
    isCreatingRecipe: Boolean(props.isCreatingRecipe),
    isUpdatingRecipe: Boolean(props.isUpdatingRecipe),
  });
  const {
    currentRecipe: editorCurrentRecipe,
    isSelfMade,
    editorProfile,
    editorCompletionItems,
    editorCompletedCount,
    editorCompletionPercent,
    availableSceneTagOptions,
    editorRecipeCover,
    editorRecipeMeta,
    canSubmit,
    foodEditorSubmitLabel,
    recipeEditorSceneTags,
    recipeEditorCoverAsset,
    recipeEditorCoverUrl,
    recipeEditorCompletionItems,
    recipeEditorCompletionPercent,
    recipeEditorIngredientCount,
    recipeEditorStepCount,
    recipeEditorSceneSelectOptions,
    recipeEditorImagePayload,
    recipeEditorSubmitDisabled,
  } = editorViewModel;
  const currentRecipeForEditor = editorCurrentRecipe;
  const recipeEditorImageComposer = useImageComposer({
    value: recipeEditor.form.images,
    payload: recipeEditorImagePayload,
    onChange: (images) => recipeEditor.setForm((current) => ({ ...current, images })),
    uploadErrorMessage: '参考图上传或 AI 主图生成失败',
    generateErrorMessage: 'AI 主图生成失败',
  });

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

  const planSurfaceProps: FoodPlanSurfaceProps = buildFoodWorkspacePlanSurfaceProps({
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
    });

    const discoverDesktopContent = (
      <FoodWorkspaceDiscoverDesktop
        search={search}
        searchLoading={isFoodSearchFetching}
        typeFilter={typeFilter}
        mealFilter={mealFilter}
        lensFilter={lensFilter}
        governanceIssueFilter={governanceIssueFilter}
        hasFoodFilters={hasFoodFilters}
        filteredFoods={filteredFoods}
        totalFoods={props.foods.length}
        governanceQueueLength={governanceQueue.length}
        needsInfoCount={needsInfoFoods.length}
        nextGovernanceSummary={nextGovernanceSummary}
        governanceIssueSummaries={governanceIssueSummaries}
        feedback={feedback}
        currentLensCopy={currentLensCopy}
        foodCardViewModels={foodCardViewModels}
        foodCardResetKey={foodCardResetKey}
        foodLibraryCardActionsRef={foodLibraryCardActionsRef}
        repeatFoods={repeatFoods}
        repeatFoodCount={repeatFoodCount}
        managementIssueCount={managementIssueCount}
        foodScenes={props.foodScenes}
        sceneCards={sceneCards}
        sceneFilter={sceneFilter}
        nextGovernanceFood={nextGovernanceFood}
        planSurfaceProps={planSurfaceProps}
        onCreateFood={handleOpenCreate}
        onOpenLogs={props.onOpenLogs}
        onSearchChange={setSearch}
        onSearchClear={() => setSearch('')}
        onSearchCompositionStart={foodSearchComposition.onCompositionStart}
        onSearchCompositionEnd={foodSearchComposition.onCompositionEnd}
        onTypeFilterChange={setTypeFilter}
        onMealFilterChange={setMealFilter}
        onClearFilters={clearFoodFilters}
        onOpenNextGovernanceFood={openNextGovernanceFood}
        onGovernanceIssueChange={openGovernanceIssue}
        onSetLensFavorite={() => setLensFilter('favorite')}
        onSetLensExpiring={() => (expiringFoods.length > 0 ? setLensFilter('expiring') : openGovernanceIssue('all'))}
        onOpenGovernanceIssue={() => openGovernanceIssue('all')}
        onOpenSceneManager={() => setIsSceneManagerOpen(true)}
        onToggleScene={(sceneName) => setSceneFilter(sceneFilter === sceneName ? 'all' : sceneName)}
        isUpdatingFavorite={Boolean(props.isUpdatingFavorite)}
        isQuickAdding={Boolean(props.isQuickAdding)}
      />
    );

    const discoverMobileContent = (
      <FoodWorkspaceDiscoverMobile
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

    const surfaceContent = <FoodWorkspaceDiscoverView {...discoverSurfaceProps} />;

    const editorView = { availableSceneTagOptions, canSubmit, completionItems: editorCompletionItems, completionPercent: editorCompletionPercent, currentRecipe, editorProfile, editorRecipeCover, editorRecipeMeta, showActions: false, onAddSceneTag: addSceneTag, onBack: closeFoodEditorIfAllowed, onCreateAndAddSceneTag: () => void createAndAddSceneTag(), onEditRecipe: handleOpenRecipeEditor, onRemoveSceneTag: removeSceneTag, onSubmit: (event: FormEvent<HTMLFormElement>) => void handleSubmitFood(event), onToggleMealType: toggleMealType, onUploadImage: (files: FileList) => void imageComposer.upload(files), setNewSceneTagName };
    const recipeView = { isEditing: Boolean(recipeEditor.selectedRecipeId || form.recipeId), entityLabel: '菜谱', submitLabel: '保存菜谱', previewLabel: '回到食物', summaryCreateHint: '保存后回到食物库', backLabel: '回到食物', isRecipeAiApplied: false, selectedRecipeId: recipeEditor.selectedRecipeId, isRecipeDraftBusy: false, recipeDraftButtonLabel: getRecipeDraftGenerationButtonLabel(recipeEditor.recipeDraftGenerationStage), showAiDraftAction: false, showDeleteAction: false, compactHeader: true, onDelete: () => undefined, onOpenDraftDialog: () => undefined };

    return (
    <main className="food-workspace">
      <FoodWorkspaceNotice notice={notice} onClose={clearNotice} />
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

      {/* FoodWorkspaceEditorSurface owns <FoodWorkspaceEditorOverlay and recipe editor composition. */}
      <FoodWorkspaceEditorSurface context={{ props, view, isFoodRecipeEditorOpen, isSelfMade, editorCompletedCount, closeFoodEditorIfAllowed, handleSubmitFood, editorView, recipeView, availableSceneTagOptions, canSubmit, editorCompletionItems, editorCompletionPercent, currentRecipe, editorProfile, editorRecipeCover, editorRecipeMeta, FOOD_EDITOR_FORM_ID, form, imageComposer, isSceneTagPickerOpen, newSceneTagName, editorSceneTags, foodEditorSubmitLabel, addSceneTag, createAndAddSceneTag, setForm, handleOpenRecipeEditor, removeSceneTag, setIsSceneTagPickerOpen, toggleMealType, resolveFoodAssetUrl, recipeEditor, closeFoodRecipeEditor, recipeEditorSceneSelectOptions, recipeEditorSceneTags, recipeEditorCoverUrl, recipeEditorCoverAsset, recipeEditorIngredientCount, recipeEditorStepCount, recipeEditorCompletionItems, recipeEditorCompletionPercent, recipeEditorImageComposer, getRecipeDraftGenerationButtonLabel, recipeEditorSubmitDisabled, closeFoodRecipeEditorIfAllowed, submitFoodRecipeEditor }} />

      {/* FoodWorkspaceOperationalOverlays owns <FoodWorkspaceMealOverlays and <FoodWorkspacePlanOverlays. */}
      <FoodWorkspaceOperationalOverlays c={{ props, quickRecord, quickMealDateOptions, setQuickRecord, submitCompactRecord, quickMealDialog, updateQuickMealDialog, submitCookConfirmDialog, detailFood, recipeCards, todayDate, closeDetail, handleOpenEdit, handleOpenRecipeEditorDirectly, openPlanDialog, openQuickMealDialog, getDefaultMealType, isPlanDialogOpen, selectedPlanFood, planFoodSearch, planForm, setPlanForm, setPlanFoodSearch, closePlanDialog, submitPlanItem, clearPlanFoodSelection, activePlanDetailItem, activePlanDetailFood, planDetailForm, isPlanDetailEditing, closePlanDetail, setPlanDetailForm, setIsPlanDetailEditing, resetPlanDetailForm, submitPlanDetail, completePlanItem, deletePlanDetail, planMealEnrichment, setPlanMealEnrichment, isSceneManagerOpen, sceneFormMode, sceneCards, sceneDraft, sceneImageState, setIsSceneManagerOpen, openCreateScene, openEditScene, deleteScene, closeSceneForm, submitScene, generateFoodSceneImage, setSceneDraft, resolveFoodAssetUrl, getFoodCover, getFoodCoverAsset, getFoodPlanDateParts, normalizeFoodType }} />
    </main>
  );
}
