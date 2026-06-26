import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type {
  AiGeneratedRecipeDraft,
  CookRecipePreviewResponse,
  CookRecipeRequest,
  CookRecipeResponse,
  CreateRecipePayload,
  Difficulty,
  Food,
  GenerateRecipeDraftPayload,
  GenerateRecipeDraftResponse,
  ImageInputValue,
  Ingredient,
  InventoryItem,
  MealLog,
  MealType,
  Recipe,
  RecipeDiscovery,
  RecipeFavorite,
  RecipeIngredient,
  RecipePlanItem,
  RecipePayload,
  RecipeScene,
  RecipeStats,
  RecipeStep,
  ShoppingListItem,
} from '../../api/types';
import { resolveAssetUrl } from '../../lib/assets';
import { readJsonStorage, removeStorage, writeJsonStorage } from '../../lib/storage';
import { getPendingImageJobId, type AiRenderPayload } from '../../lib/aiImages';
import { emptyImages, formatDate, formatDateTime, getImagePreview, splitTags, todayKey } from '../../lib/ui';
import { IDLE_IMAGE_GENERATION_STATE, useImageComposer, type ImageGenerationUiState } from '../../hooks/useImageComposer';
import {
  ActionButton,
  Badge,
  EmptyState,
  WorkspaceSubpageHeader,
  WorkspaceSubpageShell,
} from '../ui-kit';
import {
  DIFFICULTY_LABELS,
  buildRecipeHomeViewModel,
  buildRecipeCards,
  filterRecipeCards,
  addDateKeyDays,
  getRecipeSceneFilters,
  getRecipeWeekRange,
  type RecipeCardViewModel,
  type RecipeQuickFilter,
  type RecipeSortMode,
  type RecipeWorkspaceView,
} from './workspaceModel';
import {
  DISCOVERY_SECTION_COPY,
  DUPLICATED_TYPE_LABELS,
  FALLBACK_SCENES,
  MAX_STEP_KEY_POINTS,
  OPTIONAL_INGREDIENT_NOTE_PATTERN,
  QUICK_FILTERS,
  RECIPE_STEP_ICON_OPTIONS,
  SHOPPING_UNIT_OPTIONS,
  SHOW_RECIPE_PLAN_MANAGEMENT,
  SORT_OPTIONS,
} from './RecipeWorkspaceOptions';
import {
  RecipeUiIcon,
  RecipeCard,
} from './RecipeWorkspaceCards';
import { RecipeDraftDialog } from './RecipeDraftDialog';
import { RecipeShoppingDialog } from './RecipeShoppingDialog';
import { RecipeCookFinishDialog } from './RecipeCookFinishDialog';
import { RecipeCookView } from './RecipeCookView';
import { RecipeDetailView } from './RecipeDetailView';
import { RecipeEditorView } from './RecipeEditorView';
import { RecipeLibraryView } from './RecipeLibraryView';
import { RecipePlanDetailDialog, RecipePlanDialog } from './RecipePlanDialogs';
import { RecipeSceneManagerDialog } from './RecipeSceneManagerDialog';
import { useRecipeCookState } from './useRecipeCookState';
import { useRecipeEditorState } from './useRecipeEditorState';
import { useRecipePlanState } from './useRecipePlanState';
import { useRecipeSceneState } from './useRecipeSceneState';
import { useRecipeShoppingState } from './useRecipeShoppingState';
import { useRecipeWorkspaceData } from './useRecipeWorkspaceData';
import {
  buildCustomShoppingDraft,
  buildCookPayload,
  buildFormFromRecipe,
  buildRecipeFormFromGeneratedDraft,
  buildRecipeImagePayload,
  buildRecipePayload,
  buildRecipeShortageShoppingPayloads,
  buildSceneImagePayload,
  buildShoppingDraftFromRecipeIngredient,
  buildShoppingDraftsFromShortages,
  buildShoppingPayloadsFromDrafts,
  clampStepIndex,
  createEmptyRecipeStepDraft,
  defaultIngredientRows,
  defaultRecipeDraftAiForm,
  defaultRecipeForm,
  defaultSceneDraft,
  formatCookPreviewRequestLabel,
  formatCookShortageDetail,
  formatCookShortageSummary,
  formatShoppingQuantity,
  getCookCompletionMessage,
  getCookPreviewActionLabel,
  getRecipeDraftGenerationActionLabel,
  getRecipeDraftGenerationButtonLabel,
  getRecipeDraftGenerationStatusCopy,
  getRecipeDraftGenerationStepState,
  getRecipeShoppingRequirement,
  getRecipeStepIconName,
  getRecipeStepSummary,
  getRecipeStepTitle,
  hasRecipeDraftMinimumInput,
  isAiGeneratedRecipeDraft,
  mapRecipeIdsToCards,
  mapRecipeScene,
  newDraftId,
  loadCookSession,
  recipeCookSessionKey,
  applyRecipeIngredientRequirement,
  resolveErrorMessage,
  resolveIngredientImageUrl,
  resolveRecipeDifficulty,
  sanitizeCookSession,
  stripRecipeIngredientRequirementNote,
  type ManagedRecipeScene,
  type RecipeDraftAiFormState,
  type RecipeDraftGenerationStage,
  type RecipeDraftIngredient,
  type RecipeFormState,
  type RecipeNotice,
  type RecipeSceneCard,
  type RecipeSceneFormMode,
  type RecipeShoppingCustomForm,
  type RecipeShoppingDraftItem,
  type RecipeShoppingIngredientOption,
  type RecipeShoppingRequirement,
  type RecipeStepDraft,
} from './RecipeWorkspaceModel';

export {
  buildCookPayload,
  buildRecipeFormFromGeneratedDraft,
  buildRecipePayload,
  buildRecipeShortageShoppingPayloads,
  buildCustomShoppingDraft,
  buildShoppingDraftsFromShortages,
  buildShoppingDraftFromRecipeIngredient,
  buildShoppingPayloadsFromDrafts,
  formatCookPreviewRequestLabel,
  formatCookShortageDetail,
  formatCookShortageSummary,
  getCookCompletionMessage,
  getCookPreviewActionLabel,
  getRecipeDraftGenerationButtonLabel,
  getRecipeDraftGenerationStepState,
  getRecipeShoppingRequirement,
  hasRecipeDraftMinimumInput,
  isAiGeneratedRecipeDraft,
  loadCookSession,
  recipeCookSessionKey,
  sanitizeCookSession,
  type RecipeDraftIngredient,
  type RecipeFormState,
};

type RecipeWorkspaceProps = {
  recipes: Recipe[];
  ingredients: Ingredient[];
  inventoryItems: InventoryItem[];
  mealLogs: MealLog[];
  foods: Food[];
  shoppingItems: ShoppingListItem[];
  recipeFavorites: RecipeFavorite[];
  recipeDiscovery: RecipeDiscovery | null;
  recipeStats: RecipeStats | null;
  recipePlanItems: RecipePlanItem[];
  recipeScenes: RecipeScene[];
  recipePlanWeekRange: { start: string; end: string };
  startRecipeId?: string | null;
  startFoodPlanItemId?: string | null;
  notificationCenter?: ReactNode;
  onStartRecipeHandled?: () => void;
  onRecipePlanPreviousWeek: () => void;
  onRecipePlanCurrentWeek: () => void;
  onRecipePlanNextWeek: () => void;
  createRecipe: (payload: CreateRecipePayload) => Promise<Recipe>;
  updateRecipe: (recipeId: string, payload: RecipePayload) => Promise<Recipe>;
  deleteRecipe: (recipeId: string) => Promise<void>;
  cookRecipe: (recipeId: string, payload: CookRecipeRequest) => Promise<CookRecipeResponse>;
  previewCookRecipe: (recipeId: string, payload: CookRecipeRequest) => Promise<CookRecipePreviewResponse>;
  generateRecipeDraft: (payload: GenerateRecipeDraftPayload) => Promise<GenerateRecipeDraftResponse>;
  createShoppingItem: (payload: {
    title: string;
    quantity?: number | null;
    unit?: string | null;
    ingredient_id?: string | null;
    quantity_mode?: ShoppingListItem['quantity_mode'];
    display_label?: string | null;
    reason: string;
  }) => Promise<ShoppingListItem>;
  addRecipeFavorite: (recipeId: string) => Promise<RecipeFavorite>;
  removeRecipeFavorite: (recipeId: string) => Promise<void>;
  createRecipePlanItem: (payload: { recipe_id: string; plan_date: string; meal_type: MealType; note: string }) => Promise<RecipePlanItem>;
  updateRecipePlanItem: (itemId: string, payload: { recipe_id?: string; plan_date?: string; meal_type?: MealType; note?: string }) => Promise<RecipePlanItem>;
  deleteRecipePlanItem: (itemId: string) => Promise<void>;
  createRecipeScene: (payload: {
    name: string;
    description: string;
    image_prompt: string;
    image_asset_id?: string;
    pending_image_job_id?: string | null;
    hidden: boolean;
    custom: boolean;
    sort_order: number;
  }) => Promise<RecipeScene>;
  updateRecipeScene: (
    sceneId: string,
    payload: {
      name?: string;
      description?: string;
      image_prompt?: string;
      image_asset_id?: string;
      pending_image_job_id?: string | null;
      hidden?: boolean;
      custom?: boolean;
      sort_order?: number;
    }
  ) => Promise<RecipeScene>;
  deleteRecipeScene: (sceneId: string) => Promise<void>;
  isCreatingRecipe?: boolean;
  isUpdatingRecipe?: boolean;
  isDeletingRecipe?: boolean;
  isCookingRecipe?: boolean;
  isCreatingShopping?: boolean;
  isUpdatingFavorite?: boolean;
  isUpdatingPlan?: boolean;
  isUpdatingScene?: boolean;
};

export function RecipeWorkspace(props: RecipeWorkspaceProps) {
  const categoryScrollRef = useRef<HTMLDivElement | null>(null);
  const discoveryScrollRef = useRef<HTMLDivElement | null>(null);
  const discoverySectionRef = useRef<HTMLElement | null>(null);
  const planSectionRef = useRef<HTMLElement | null>(null);
  const recipeNoticeTimerRef = useRef<number | null>(null);
  const recipeDraftStageTimerRef = useRef<number | null>(null);
  const recipeDraftDialogCloseTimerRef = useRef<number | null>(null);
  const recipeAiAppliedTimerRef = useRef<number | null>(null);
  const [categoryScrollState, setCategoryScrollState] = useState({ canLeft: false, canRight: false });
  const [discoveryScrollState, setDiscoveryScrollState] = useState({ canLeft: false, canRight: false });
  const [recipeNotice, setRecipeNotice] = useState<RecipeNotice | null>(null);
  const {
    view,
    setView,
    selectedRecipeId,
    setSelectedRecipeId,
    search,
    setSearch,
    quickFilter,
    setQuickFilter,
    sceneFilter,
    setSceneFilter,
    difficultyFilter,
    setDifficultyFilter,
    sortMode,
    setSortMode,
    recommendationPage,
    setRecommendationPage,
    form,
    setForm,
    ingredientRows,
    setIngredientRows,
    recipeDraftAiForm,
    setRecipeDraftAiForm,
    isRecipeDraftDialogOpen,
    setIsRecipeDraftDialogOpen,
    sceneTagDraft,
    setSceneTagDraft,
    visibleStepTips,
    setVisibleStepTips,
    stepKeyPointSlots,
    setStepKeyPointSlots,
    recipeDraftGenerationStage,
    setRecipeDraftGenerationStage,
    recipeDraftError,
    setRecipeDraftError,
    isRecipeAiApplied,
    setIsRecipeAiApplied,
    resetForm,
    openCreate,
    openDetail,
    openEdit,
    updateIngredientRow,
    updateIngredientNote,
    updateIngredientRequirement,
    updateStepDraft,
    getStepKeyPointValues,
    addStepTip,
    getStepKeyPointRowCount,
    addStepKeyPoint,
    updateStepKeyPoint,
    removeStepKeyPoint,
    addIngredientRow,
    removeIngredientRow,
    commitSceneTagDraft,
  } = useRecipeEditorState({
    ingredients: props.ingredients,
  });

  function showRecipeNotice(notice: RecipeNotice) {
    if (recipeNoticeTimerRef.current !== null) {
      window.clearTimeout(recipeNoticeTimerRef.current);
    }
    setRecipeNotice(notice);
    recipeNoticeTimerRef.current = window.setTimeout(() => {
      setRecipeNotice(null);
      recipeNoticeTimerRef.current = null;
    }, 3200);
  }

  const {
    shoppingDialogCard,
    shoppingDrafts,
    shoppingCustomForm,
    setShoppingCustomForm,
    isShoppingIngredientPickerOpen,
    setIsShoppingIngredientPickerOpen,
    shoppingIngredientOptions,
    visibleShoppingIngredientOptions,
    openShoppingDialog,
    closeShoppingDialog,
    updateShoppingDraft,
    adjustShoppingDraftQuantity,
    removeShoppingDraft,
    addRecipeIngredientToShoppingDraft,
    addCustomShoppingDraft,
    adjustCustomShoppingQuantity,
    selectShoppingIngredientOption,
    submitShoppingDrafts,
  } = useRecipeShoppingState({
    ingredients: props.ingredients,
    createShoppingItem: props.createShoppingItem,
    showRecipeNotice,
  });

  const {
    cards,
    homeViewModel,
    cardByRecipeId,
    managedScenes,
    managedSceneMap,
    categoryCards,
    sceneSelectOptions,
    visibleCards,
    cookableCards,
    recommendedWindow,
    shouldPageRecommendations,
    displayCards,
    shouldScrollDiscoveryCards,
    recentPreviewCards,
    quickPreviewCards,
    topPreviewItems,
    planDays,
    plannedDayCount,
    recentPreviewSlots,
    quickPreviewSlots,
    topPreviewSlots,
    recommendationSlots,
    mobileFeaturedCards,
    mobileLibraryCards,
    hasMobileRecipeAlerts,
    mobileSceneCards,
    favoriteSidebarCards,
    visiblePlanDays,
    hiddenPlanDayCount,
    currentWeekRange,
    isCurrentPlanWeek,
    planWeekLabel,
    selectedCard,
    selectedReadyCount,
  } = useRecipeWorkspaceData({
    recipes: props.recipes,
    ingredients: props.ingredients,
    inventoryItems: props.inventoryItems,
    mealLogs: props.mealLogs,
    foods: props.foods,
    recipeFavorites: props.recipeFavorites,
    recipeDiscovery: props.recipeDiscovery,
    recipeStats: props.recipeStats,
    recipePlanItems: props.recipePlanItems,
    recipeScenes: props.recipeScenes,
    recipePlanWeekRange: props.recipePlanWeekRange,
    quickFilter,
    sceneFilter,
    difficultyFilter,
    sortMode,
    search,
    recommendationPage,
    shoppingCustomForm,
    selectedRecipeId,
  });
  const {
    isSceneManagerOpen,
    setIsSceneManagerOpen,
    sceneFormMode,
    editingSceneName,
    sceneDraft,
    setSceneDraft,
    sceneImageState,
    generatingSceneName,
    openCreateSceneForm,
    openEditSceneForm,
    closeSceneForm,
    submitSceneDraft,
    deleteManagedScene,
    restoreManagedScene,
    generateSceneImage,
  } = useRecipeSceneState({
    managedScenes,
    sceneFilter,
    setSceneFilter,
    showRecipeNotice,
    createRecipeScene: props.createRecipeScene,
    updateRecipeScene: props.updateRecipeScene,
    deleteRecipeScene: props.deleteRecipeScene,
  });
  const selectedIngredientCount = selectedCard?.ingredientAvailability.length ?? 0;
  const selectedShortageCount = selectedCard?.shortages.length ?? 0;
  const selectedRecipePlanItems = selectedCard ? props.recipePlanItems.filter((item) => item.recipe_id === selectedCard.recipe.id) : [];
  const selectedRecentCookLog =
    selectedCard?.recipe.cook_logs
      .slice()
      .sort((left, right) => right.cook_date.localeCompare(left.cook_date))[0] ?? null;
  const isSelectedFavorite = selectedCard ? homeViewModel.favoriteRecipeIds.has(selectedCard.recipe.id) : false;
  const editorIngredientCount = ingredientRows.filter((item) => item.ingredient_id || item.ingredient_name.trim()).length;
  const editorStepCount = form.steps.filter((step) => step.text.trim()).length;
  const editorSceneTags = splitTags(form.sceneTags);
  const editorCoverAsset = getImagePreview(form.images);
  const editorCoverUrl = resolveAssetUrl(editorCoverAsset?.url);
  const editorReferenceUrl = resolveAssetUrl(form.images.referenceAsset?.url);
  const aiSourceIngredients = ingredientRows
    .filter((item) => item.ingredient_id || item.ingredient_name.trim())
    .map((item) => {
      const ingredient = props.ingredients.find((entry) => entry.id === item.ingredient_id);
      return ingredient?.name ?? item.ingredient_name.trim();
    })
    .filter(Boolean);
  const resolvedDifficulty = resolveRecipeDifficulty(form.difficulty);
  const aiSourceSummary = [
    { label: '菜名', value: form.title.trim() || '未填写' },
    { label: '份量', value: `${form.servings || '2'} 人份` },
    { label: '时长', value: form.prepMinutes ? `${form.prepMinutes} 分钟` : '未填写' },
    { label: '难度', value: form.difficulty ? DIFFICULTY_LABELS[resolvedDifficulty] : '未填写' },
    { label: '标签', value: editorSceneTags.join('、') || '未填写' },
    { label: '食材', value: aiSourceIngredients.join('、') || '未填写' },
  ];
  const editorCompletionItems = [
    { label: '已填写基础信息', done: Boolean(form.title.trim() && Number(form.servings) > 0) },
    { label: '已添加原料', done: editorIngredientCount > 0 },
    { label: '已添加步骤', done: editorStepCount > 0 },
    { label: '已设置封面', done: Boolean(editorCoverAsset) },
  ];
  const editorCompletionPercent = Math.round(
    (editorCompletionItems.filter((item) => item.done).length / editorCompletionItems.length) * 100
  );
  const isEditing = view === 'edit' && Boolean(selectedRecipeId);
  const isRecipeDraftBusy = recipeDraftGenerationStage === 'drafting' || recipeDraftGenerationStage === 'imaging';
  const recipeDraftButtonLabel = getRecipeDraftGenerationButtonLabel(recipeDraftGenerationStage);
  const recipeDraftActionLabel = getRecipeDraftGenerationActionLabel(recipeDraftGenerationStage);
  const recipeDraftStatusCopy = getRecipeDraftGenerationStatusCopy(recipeDraftGenerationStage);
  const recipeDraftStatusSteps = ['读取当前表单', '生成规范菜谱', '生成封面', '填入编辑表单'];
  const recipeImagePayload = buildRecipeImagePayload(form, ingredientRows, props.ingredients);
  const recipeImageComposer = useImageComposer({
    value: form.images,
    payload: recipeImagePayload,
    onChange: (images) => setForm((current) => ({ ...current, images })),
    uploadErrorMessage: '参考图上传或 AI 主图生成失败',
    generateErrorMessage: 'AI 主图生成失败',
  });
  const recipeImageState = recipeImageComposer.state;
  const submitDisabled = Boolean(props.isCreatingRecipe || props.isUpdatingRecipe);
  const activeDiscoveryCopy =
    sceneFilter === 'all'
      ? DISCOVERY_SECTION_COPY[quickFilter]
      : {
          title: sceneFilter,
          description:
            quickFilter === 'recommend' || quickFilter === 'all'
              ? '适合这个场景的菜谱'
              : `已叠加“${DISCOVERY_SECTION_COPY[quickFilter].title}”筛选`,
          emptyTitle: `暂无${sceneFilter}菜谱`,
          emptyDescription: '换个场景或清除筛选条件试试。',
        };
  const {
    planForm,
    setPlanForm,
    planDialogCard,
    isPlanDialogOpen,
    planRecipeSearch,
    setPlanRecipeSearch,
    isPlanRecipePickerOpen,
    setIsPlanRecipePickerOpen,
    expandedPlanDates,
    activePlanDetailItem,
    activePlanDetailCard,
    planDetailForm,
    setPlanDetailForm,
    openPlanDialog,
    closePlanDialog,
    openPlanDetail,
    closePlanDetail,
    togglePlanDay,
    startPlanDetailCook,
    selectPlanRecipe,
    submitPlanItem,
    updatePlanDate,
    updatePlanMealType,
    deletePlanItem,
    submitPlanDetail,
    deletePlanDetailItem,
  } = useRecipePlanState({
    recipePlanWeekRange: props.recipePlanWeekRange,
    recipePlanItems: props.recipePlanItems,
    cards,
    showRecipeNotice,
    createRecipePlanItem: props.createRecipePlanItem,
    updateRecipePlanItem: props.updateRecipePlanItem,
    deleteRecipePlanItem: props.deleteRecipePlanItem,
    onStartCookFromPlan: (item) => {
      const card = cards.find((entry) => entry.recipe.id === item.recipe_id);
      if (!card) return;
      openCook(card, item.id);
    },
  });
  const {
    cookTimerMinuteWheelRef,
    cookTimerSecondWheelRef,
    activeCookCard,
    cookPreview,
    cookPreviewError,
    isCookPreviewLoading,
    cookSession,
    wasCookSessionRestored,
    isCookFinishOpen,
    setIsCookFinishOpen,
    isCookTimerCustomOpen,
    setIsCookTimerCustomOpen,
    cookTimerPicker,
    setCookTimerPicker,
    cookTimerJustStarted,
    cookSteps,
    currentCookStep,
    currentStepSuggestedSeconds,
    cookTimerDisplaySeconds,
    cookTimerDurationSeconds,
    cookTimerProgress,
    cookProgressPercent,
    cookSubmitDisabled,
    openCook,
    closeCookDialog,
    updateCookSession,
    selectCookTimerDuration,
    openCustomCookTimer,
    confirmCustomCookTimer,
    toggleCookTimer,
    resetCookTimer,
    addCookTimerSeconds,
    jumpToCookStep,
    resetActiveCookSession,
    exitCookMode,
    toggleCookIngredient,
    completeCurrentCookStepAndContinue,
    moveCookStep,
    submitCookRecipe,
    timers,
    activeTimerId,
    addTimer,
    deleteTimer,
    selectTimer,
    toggleTimerById,
  } = useRecipeCookState({
    cards,
    selectedCard,
    view,
    setView,
    setSelectedRecipeId,
    startRecipeId: props.startRecipeId,
    startFoodPlanItemId: props.startFoodPlanItemId,
    onStartRecipeHandled: props.onStartRecipeHandled,
    previewCookRecipe: props.previewCookRecipe,
    cookRecipe: props.cookRecipe,
    isCookingRecipe: props.isCookingRecipe,
    showRecipeNotice,
  });
  const planRecipeQuery = planRecipeSearch.trim().toLowerCase();
  const planRecipeOptions = useMemo(() => {
    if (!planRecipeQuery) return cards;
    return cards.filter((card) => card.searchText.includes(planRecipeQuery) || card.recipe.title.toLowerCase().includes(planRecipeQuery));
  }, [cards, planRecipeQuery]);

  function updateCategoryScrollState() {
    const node = categoryScrollRef.current;
    if (!node) return;
    const canLeft = node.scrollLeft > 2;
    const canRight = node.scrollLeft + node.clientWidth < node.scrollWidth - 2;
    setCategoryScrollState((current) => (current.canLeft === canLeft && current.canRight === canRight ? current : { canLeft, canRight }));
  }

  function updateDiscoveryScrollState() {
    const node = discoveryScrollRef.current;
    if (!node) return;
    const canLeft = node.scrollLeft > 2;
    const canRight = node.scrollLeft + node.clientWidth < node.scrollWidth - 2;
    setDiscoveryScrollState((current) => (current.canLeft === canLeft && current.canRight === canRight ? current : { canLeft, canRight }));
  }

  useEffect(() => {
    updateCategoryScrollState();
  }, [categoryCards.length, sceneFilter, search]);

  useEffect(() => {
    updateDiscoveryScrollState();
  }, [displayCards.length, quickFilter, sceneFilter, search, difficultyFilter, sortMode]);

  useEffect(() => {
    setRecommendationPage(0);
  }, [quickFilter, sceneFilter, search, difficultyFilter, sortMode]);

  useEffect(() => {
    return () => {
      if (recipeNoticeTimerRef.current !== null) {
        window.clearTimeout(recipeNoticeTimerRef.current);
      }
      if (recipeDraftStageTimerRef.current !== null) {
        window.clearTimeout(recipeDraftStageTimerRef.current);
      }
      if (recipeDraftDialogCloseTimerRef.current !== null) {
        window.clearTimeout(recipeDraftDialogCloseTimerRef.current);
      }
      if (recipeAiAppliedTimerRef.current !== null) {
        window.clearTimeout(recipeAiAppliedTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const node = discoveryScrollRef.current;
    if (!node) return;
    node.scrollLeft = 0;
    window.requestAnimationFrame(updateDiscoveryScrollState);
  }, [quickFilter, sceneFilter, search, difficultyFilter, sortMode]);

  function handleOpenCreate() {
    recipeImageComposer.setState(IDLE_IMAGE_GENERATION_STATE);
    openCreate();
  }

  function handleOpenEdit(card: RecipeCardViewModel) {
    recipeImageComposer.setState(IDLE_IMAGE_GENERATION_STATE);
    openEdit(card);
  }

  function clearRecipeDraftStageTimer() {
    if (recipeDraftStageTimerRef.current !== null) {
      window.clearTimeout(recipeDraftStageTimerRef.current);
      recipeDraftStageTimerRef.current = null;
    }
  }

  function clearRecipeDraftDialogCloseTimer() {
    if (recipeDraftDialogCloseTimerRef.current !== null) {
      window.clearTimeout(recipeDraftDialogCloseTimerRef.current);
      recipeDraftDialogCloseTimerRef.current = null;
    }
  }

  function scheduleRecipeDraftStageReset() {
    clearRecipeDraftStageTimer();
    recipeDraftStageTimerRef.current = window.setTimeout(() => {
      setRecipeDraftGenerationStage('idle');
      recipeDraftStageTimerRef.current = null;
    }, 1800);
  }

  function pulseRecipeAiApplied() {
    if (recipeAiAppliedTimerRef.current !== null) {
      window.clearTimeout(recipeAiAppliedTimerRef.current);
    }
    setIsRecipeAiApplied(true);
    recipeAiAppliedTimerRef.current = window.setTimeout(() => {
      setIsRecipeAiApplied(false);
      recipeAiAppliedTimerRef.current = null;
    }, 1200);
  }

  function finishRecipeDraftGeneration() {
    setRecipeDraftGenerationStage('done');
    clearRecipeDraftDialogCloseTimer();
    recipeDraftDialogCloseTimerRef.current = window.setTimeout(() => {
      setIsRecipeDraftDialogOpen(false);
      recipeDraftDialogCloseTimerRef.current = null;
    }, 650);
    scheduleRecipeDraftStageReset();
  }

  function closeRecipeDraftDialog() {
    if (isRecipeDraftBusy) {
      setRecipeDraftError('AI 正在生成中，请稍等完成后再关闭。');
      return;
    }
    setIsRecipeDraftDialogOpen(false);
  }

  function buildAiRecipeDraftPayload(): GenerateRecipeDraftPayload {
    const selectedIngredientIds = ingredientRows
      .map((item) => item.ingredient_id)
      .filter((item): item is string => Boolean(item));
    const extraIngredients = ingredientRows
      .filter((item) => !item.ingredient_id && item.ingredient_name.trim())
      .map((item) => item.ingredient_name.trim());
    const servings = Number(form.servings);
    const prepMinutes = Number(form.prepMinutes);
    return {
      title: form.title.trim(),
      prompt: recipeDraftAiForm.prompt.trim() || form.tips.trim(),
      ingredient_ids: [...new Set(selectedIngredientIds)],
      extra_ingredients: extraIngredients,
      servings: Number.isFinite(servings) && servings > 0 ? servings : null,
      prep_minutes: Number.isFinite(prepMinutes) && prepMinutes > 0 ? prepMinutes : null,
      difficulty: form.difficulty || null,
      scene_tags: [],
      generate_image: true,
    };
  }

  async function generateRecipeDraftFromAi() {
    clearRecipeDraftStageTimer();
    clearRecipeDraftDialogCloseTimer();
    if (!hasRecipeDraftMinimumInput(form, ingredientRows, recipeDraftAiForm.prompt)) {
      setRecipeDraftGenerationStage('error');
      setRecipeDraftError('请先填写菜名、添加至少一个食材，或写一句补充说明。');
      return;
    }
    setRecipeDraftGenerationStage('drafting');
    setRecipeDraftError(null);
    try {
      const response = await props.generateRecipeDraft(buildAiRecipeDraftPayload());
      if (response.status === 'failed') {
        throw new Error(response.error || 'AI 菜谱生成失败，请稍后重试。');
      }
      const draft = response.draft;
      if (!isAiGeneratedRecipeDraft(draft)) {
        throw new Error('AI 没有返回可填入表单的结构化草稿。');
      }
      const next = buildRecipeFormFromGeneratedDraft(draft, form);
      setForm(next.form);
      setIngredientRows(next.ingredients);
      setVisibleStepTips({});
      setStepKeyPointSlots({});
      setSceneTagDraft('');
      pulseRecipeAiApplied();
      if (response.image_render_payload) {
        setRecipeDraftGenerationStage('imaging');
        try {
          const images = await recipeImageComposer.generateWithResult('text', response.image_render_payload);
          setForm((current) => ({
            ...current,
            images: {
              ...current.images,
              generatedAsset: images.generatedAsset,
              pendingJob: images.pendingJob,
            },
          }));
          showRecipeNotice({
            tone: 'success',
            title: 'AI 菜谱已填入',
            message: images.pendingJob
              ? '已补全文本内容，封面会在后台生成，可先保存。'
              : '已补全基础信息、原料、步骤、技巧和封面，可继续编辑后保存。',
          });
        } catch (reason) {
          showRecipeNotice({
            tone: 'warning',
            title: '菜谱已填入，封面生成失败',
            message: '已保留 AI 生成的文本内容，可稍后重试封面。',
          });
        }
      } else {
        showRecipeNotice({
          tone: 'success',
          title: 'AI 菜谱已填入',
          message: '已补全基础信息、原料、步骤和技巧，可继续编辑后保存。',
        });
      }
      finishRecipeDraftGeneration();
    } catch (reason) {
      setRecipeDraftGenerationStage('error');
      setRecipeDraftError(resolveErrorMessage(reason, 'AI 菜谱生成失败'));
    }
  }

  async function submitRecipe(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const payload = buildRecipePayload(form, ingredientRows, props.ingredients, getPendingImageJobId(form.images));
    if (!payload.title || payload.ingredient_items.length === 0) {
      showRecipeNotice({ tone: 'warning', title: '还不能保存菜谱', message: '菜谱至少要有标题和一个食材。' });
      return;
    }
    try {
      if (isEditing && selectedRecipeId) {
        await props.updateRecipe(selectedRecipeId, payload);
        setView('detail');
      } else {
        const created = await props.createRecipe(payload);
        setSelectedRecipeId(created.id);
        resetForm();
        recipeImageComposer.setState(IDLE_IMAGE_GENERATION_STATE);
        setView('detail');
      }
    } catch (reason) {
      showRecipeNotice({
        tone: 'danger',
        title: isEditing ? '更新菜谱失败' : '新增菜谱失败',
        message: resolveErrorMessage(reason, isEditing ? '更新菜谱失败' : '新增菜谱失败'),
      });
    }
  }

  async function deleteRecipeCard(card: RecipeCardViewModel) {
    if (!window.confirm(`确定删除「${card.recipe.title}」吗？`)) return;
    try {
      await props.deleteRecipe(card.recipe.id);
      if (selectedRecipeId === card.recipe.id) {
        setSelectedRecipeId(null);
      }
      setView('library');
    } catch (reason) {
      showRecipeNotice({ tone: 'danger', title: '删除菜谱失败', message: resolveErrorMessage(reason, '删除菜谱失败') });
    }
  }

  async function deleteSelectedRecipe() {
    if (!selectedCard) return;
    await deleteRecipeCard(selectedCard);
  }

  async function toggleRecipeFavorite(card: RecipeCardViewModel) {
    try {
      if (homeViewModel.favoriteRecipeIds.has(card.recipe.id)) {
        await props.removeRecipeFavorite(card.recipe.id);
      } else {
        await props.addRecipeFavorite(card.recipe.id);
      }
    } catch (reason) {
      showRecipeNotice({ tone: 'danger', title: '更新收藏失败', message: resolveErrorMessage(reason, '更新收藏失败') });
    }
  }

  async function handleRecipeImageUpload(files: FileList | null) {
    await recipeImageComposer.upload(files);
  }

  async function handleRecipeImageGenerate(mode: 'reference' | 'text') {
    await recipeImageComposer.generate(mode);
  }

  function resetRecipeImageInput() {
    recipeImageComposer.reset();
  }

  function renderFilters() {
    return (
      <section className="recipe-filter-shell">
        <div className="recipe-search-row">
          <label className="recipe-search-input-shell">
            <span className="recipe-search-input-icon" aria-hidden="true">
              <RecipeUiIcon name="search" />
            </span>
            <input
              className="text-input"
              placeholder="搜索菜谱、食材或技巧"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <select
            className="text-input recipe-filter-select"
            value={difficultyFilter}
            onChange={(event) => setDifficultyFilter(event.target.value as 'all' | Difficulty)}
          >
            <option value="all">全部难度</option>
            <option value="easy">简单</option>
            <option value="medium">中等</option>
            <option value="hard">复杂</option>
          </select>
          <select className="text-input recipe-filter-select" value={sortMode} onChange={(event) => setSortMode(event.target.value as RecipeSortMode)}>
            {SORT_OPTIONS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
          <button className="recipe-filter-action" type="button">
            <RecipeUiIcon name="filter" />
            筛选
          </button>
        </div>
        <div className="recipe-filter-row">
          {QUICK_FILTERS.map((item) => (
            <button
              key={item.value}
              className={quickFilter === item.value ? 'chip recipe-filter-chip active' : 'chip recipe-filter-chip'}
              type="button"
              onClick={() => {
                setQuickFilter(item.value);
                setSceneFilter('all');
                setRecommendationPage(0);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      </section>
    );
  }

  function renderCardGrid(items: RecipeCardViewModel[]) {
    return items.length > 0 ? (
      <div className="recipe-work-grid">
        {items.map((card) => (
          <RecipeCard
            key={card.recipe.id}
            card={card}
            onDetail={() => openDetail(card)}
            onEdit={() => handleOpenEdit(card)}
            onCook={() => openCook(card)}
            onShopping={() => openShoppingDialog(card, closeCookDialog)}
            onDelete={() => void deleteRecipeCard(card)}
            isDeleting={props.isDeletingRecipe}
          />
        ))}
      </div>
    ) : (
      <EmptyState
        title={props.recipes.length === 0 ? '还没有菜谱' : '没有匹配的菜谱'}
        description={props.recipes.length === 0 ? '先新增几份常做菜，后面就能按库存推荐。' : '换个筛选条件试试。'}
        action={
          <ActionButton tone="primary" type="button" onClick={handleOpenCreate}>
            新增菜谱
          </ActionButton>
        }
      />
    );
  }

  function scrollCategories(direction: 'left' | 'right') {
    categoryScrollRef.current?.scrollBy({
      left: direction === 'left' ? -260 : 260,
      behavior: 'smooth',
    });
    window.setTimeout(updateCategoryScrollState, 260);
  }

  function scrollDiscoveryCards(direction: 'left' | 'right') {
    discoveryScrollRef.current?.scrollBy({
      left: direction === 'left' ? -720 : 720,
      behavior: 'smooth',
    });
    window.setTimeout(updateDiscoveryScrollState, 260);
  }

  function showDiscoveryFilter(filter: RecipeQuickFilter, options: { sort?: RecipeSortMode } = {}) {
    setQuickFilter(filter);
    setSceneFilter('all');
    setSearch('');
    setDifficultyFilter('all');
    if (options.sort) {
      setSortMode(options.sort);
    }
    setRecommendationPage(0);
    window.requestAnimationFrame(() => {
      discoverySectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  function showPlanSection() {
    props.onRecipePlanCurrentWeek();
    window.requestAnimationFrame(() => {
      planSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  function showMobileRecipeFilter(filter: RecipeQuickFilter) {
    setQuickFilter(filter);
    setSceneFilter('all');
    setRecommendationPage(0);
  }

  function showMobileRecipeScene(sceneName: string) {
    if (quickFilter !== 'recommend' && quickFilter !== 'all') {
      setQuickFilter('recommend');
    }
    setSceneFilter(sceneName);
    setRecommendationPage(0);
    window.requestAnimationFrame(() => {
      document.getElementById('mobile-recipe-library')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  return (
    <div className={`recipe-workspace${view === 'cook' ? ' recipe-workspace-cook-mode' : ''}`}>
      {recipeNotice && (
        <div className={`recipe-notice-toast tone-${recipeNotice.tone}`} role={recipeNotice.tone === 'danger' ? 'alert' : 'status'} aria-live="polite">
          <span className="recipe-notice-icon">
            <RecipeUiIcon name={recipeNotice.tone === 'success' ? 'check' : 'warning'} />
          </span>
          <span className="recipe-notice-copy">
            <strong>{recipeNotice.title}</strong>
            <small>{recipeNotice.message}</small>
          </span>
          <button type="button" onClick={() => setRecipeNotice(null)} aria-label="关闭提示">
            ×
          </button>
        </div>
      )}
      {view === 'create' || view === 'edit' ? (
        <RecipeEditorView
          isEditing={isEditing}
          isRecipeAiApplied={isRecipeAiApplied}
          selectedRecipeId={selectedRecipeId}
          form={form}
          setForm={setForm}
          ingredientRows={ingredientRows}
          ingredients={props.ingredients}
          sceneTagDraft={sceneTagDraft}
          setSceneTagDraft={setSceneTagDraft}
          sceneSelectOptions={sceneSelectOptions}
          editorSceneTags={editorSceneTags}
          visibleStepTips={visibleStepTips}
          stepKeyPointSlots={stepKeyPointSlots}
          editorCoverUrl={editorCoverUrl}
          editorReferenceUrl={editorReferenceUrl}
          editorCoverAsset={editorCoverAsset}
          editorIngredientCount={editorIngredientCount}
          editorStepCount={editorStepCount}
          editorCompletionItems={editorCompletionItems}
          editorCompletionPercent={editorCompletionPercent}
          aiSourceSummary={aiSourceSummary}
          recipeDraftError={recipeDraftError}
          isRecipeDraftBusy={isRecipeDraftBusy}
          recipeImageState={recipeImageState}
          recipeDraftGenerationStage={recipeDraftGenerationStage}
          recipeDraftButtonLabel={recipeDraftButtonLabel}
          recipeImagePayload={recipeImagePayload}
          submitDisabled={submitDisabled}
          isCreatingRecipe={props.isCreatingRecipe}
          isUpdatingRecipe={props.isUpdatingRecipe}
          isDeletingRecipe={props.isDeletingRecipe}
          onBack={() => setView(isEditing ? 'detail' : 'library')}
          onSubmit={submitRecipe}
          onDelete={deleteSelectedRecipe}
          onOpenDraftDialog={() => setIsRecipeDraftDialogOpen(true)}
          updateIngredientRow={updateIngredientRow}
          updateIngredientNote={updateIngredientNote}
          updateIngredientRequirement={updateIngredientRequirement}
          addIngredientRow={addIngredientRow}
          removeIngredientRow={removeIngredientRow}
          updateStepDraft={updateStepDraft}
          getStepKeyPointValues={getStepKeyPointValues}
          getStepKeyPointRowCount={getStepKeyPointRowCount}
          addStepTip={addStepTip}
          addStepKeyPoint={addStepKeyPoint}
          updateStepKeyPoint={updateStepKeyPoint}
          removeStepKeyPoint={removeStepKeyPoint}
          commitSceneTagDraft={commitSceneTagDraft}
          handleRecipeImageUpload={handleRecipeImageUpload}
          handleRecipeImageGenerate={handleRecipeImageGenerate}
          resetRecipeImageInput={resetRecipeImageInput}
        />
      ) : view === 'cook' && activeCookCard && cookSession ? (
        <RecipeCookView
          activeCookCard={activeCookCard}
          cookSession={cookSession}
          cookSteps={cookSteps}
          currentCookStep={currentCookStep}
          currentStepSuggestedSeconds={currentStepSuggestedSeconds}
          cookTimerDisplaySeconds={cookTimerDisplaySeconds}
          cookTimerDurationSeconds={cookTimerDurationSeconds}
          cookTimerProgress={cookTimerProgress}
          cookProgressPercent={cookProgressPercent}
          wasCookSessionRestored={wasCookSessionRestored}
          cookPreview={cookPreview}
          isCreatingShopping={props.isCreatingShopping}
          isCookTimerCustomOpen={isCookTimerCustomOpen}
          cookTimerJustStarted={cookTimerJustStarted}
          cookTimerPicker={cookTimerPicker}
          cookTimerMinuteWheelRef={cookTimerMinuteWheelRef}
          cookTimerSecondWheelRef={cookTimerSecondWheelRef}
          setCookTimerPicker={setCookTimerPicker}
          setIsCookTimerCustomOpen={setIsCookTimerCustomOpen}
          exitCookMode={exitCookMode}
          jumpToCookStep={jumpToCookStep}
          moveCookStep={moveCookStep}
          completeCurrentCookStepAndContinue={completeCurrentCookStepAndContinue}
          resetActiveCookSession={resetActiveCookSession}
          openShoppingDialog={(card) => openShoppingDialog(card, closeCookDialog)}
          confirmCustomCookTimer={confirmCustomCookTimer}
          openCustomCookTimer={openCustomCookTimer}
          selectCookTimerDuration={selectCookTimerDuration}
          resetCookTimer={resetCookTimer}
          toggleCookTimer={toggleCookTimer}
          addCookTimerSeconds={addCookTimerSeconds}
          toggleCookIngredient={toggleCookIngredient}
          timers={timers}
          activeTimerId={activeTimerId}
          addTimer={addTimer}
          deleteTimer={deleteTimer}
          selectTimer={selectTimer}
          toggleTimerById={toggleTimerById}
        />
      ) : view === 'detail' && selectedCard ? (
        <RecipeDetailView
          selectedCard={selectedCard}
          selectedReadyCount={selectedReadyCount}
          selectedIngredientCount={selectedIngredientCount}
          selectedShortageCount={selectedShortageCount}
          isSelectedFavorite={isSelectedFavorite}
          selectedRecentCookLog={selectedRecentCookLog}
          selectedRecipePlanItems={selectedRecipePlanItems}
          isUpdatingFavorite={props.isUpdatingFavorite}
          isCreatingShopping={props.isCreatingShopping}
          isDeletingRecipe={props.isDeletingRecipe}
          onBack={() => setView('library')}
          onCook={openCook}
          onPlan={openPlanDialog}
          onShopping={(card) => openShoppingDialog(card, closeCookDialog)}
          onToggleFavorite={toggleRecipeFavorite}
          onEdit={handleOpenEdit}
          onDelete={deleteSelectedRecipe}
        />
      ) : (
        <RecipeLibraryView
          recipes={props.recipes}
          search={search}
          quickFilter={quickFilter}
          sceneFilter={sceneFilter}
          visibleCards={visibleCards}
          mobileFeaturedCards={mobileFeaturedCards}
          mobileSceneCards={mobileSceneCards}
          mobileLibraryCards={mobileLibraryCards}
          hasMobileRecipeAlerts={hasMobileRecipeAlerts}
          notificationCenter={props.notificationCenter}
          favoriteRecipeIds={homeViewModel.favoriteRecipeIds}
          isUpdatingFavorite={props.isUpdatingFavorite}
          activeDiscoveryCopy={activeDiscoveryCopy}
          renderFilters={renderFilters}
          displayCards={displayCards}
          shouldPageRecommendations={shouldPageRecommendations}
          shouldScrollDiscoveryCards={shouldScrollDiscoveryCards}
          discoveryScrollState={discoveryScrollState}
          recommendationSlots={recommendationSlots}
          discoverySectionRef={discoverySectionRef}
          discoveryScrollRef={discoveryScrollRef}
          recentPreviewSlots={recentPreviewSlots}
          topPreviewSlots={topPreviewSlots}
          quickPreviewSlots={quickPreviewSlots}
          favoriteSidebarCards={favoriteSidebarCards}
          planSectionRef={planSectionRef}
          visiblePlanDays={visiblePlanDays}
          expandedPlanDates={expandedPlanDates}
          hiddenPlanDayCount={hiddenPlanDayCount}
          planWeekLabel={planWeekLabel}
          recipePlanWeekRange={props.recipePlanWeekRange}
          plannedDayCount={plannedDayCount}
          isCurrentPlanWeek={isCurrentPlanWeek}
          isUpdatingPlan={props.isUpdatingPlan}
          isCookingRecipe={props.isCookingRecipe}
          cardsLength={cards.length}
          onOpenCreate={handleOpenCreate}
          onOpenDetail={openDetail}
          onOpenCook={openCook}
          onOpenShopping={(card) => openShoppingDialog(card, closeCookDialog)}
          onOpenPlanDialog={openPlanDialog}
          onToggleRecipeFavorite={toggleRecipeFavorite}
          onOpenSceneManager={() => setIsSceneManagerOpen(true)}
          onSearchChange={setSearch}
          onShowMobileRecipeFilter={showMobileRecipeFilter}
          onShowMobileRecipeScene={showMobileRecipeScene}
          onShowDiscoveryFilter={showDiscoveryFilter}
          onSetRecommendationPage={setRecommendationPage}
          onScrollDiscoveryCards={scrollDiscoveryCards}
          onUpdateDiscoveryScrollState={updateDiscoveryScrollState}
          onShowPlanSection={showPlanSection}
          onRecipePlanPreviousWeek={props.onRecipePlanPreviousWeek}
          onRecipePlanCurrentWeek={props.onRecipePlanCurrentWeek}
          onRecipePlanNextWeek={props.onRecipePlanNextWeek}
          onTogglePlanDay={togglePlanDay}
          onOpenPlanDetail={openPlanDetail}
          onStartPlanDetailCook={startPlanDetailCook}
        />
      )}

      {isRecipeDraftDialogOpen && (
        <RecipeDraftDialog
          aiSourceSummary={aiSourceSummary}
          form={recipeDraftAiForm}
          stage={recipeDraftGenerationStage}
          statusCopy={recipeDraftStatusCopy}
          statusSteps={recipeDraftStatusSteps}
          error={recipeDraftError}
          actionLabel={recipeDraftActionLabel}
          isBusy={isRecipeDraftBusy}
          isImageGenerating={recipeImageState.isGenerating}
          onChangeForm={setRecipeDraftAiForm}
          onGenerate={() => void generateRecipeDraftFromAi()}
          onClose={closeRecipeDraftDialog}
        />
      )}

      {SHOW_RECIPE_PLAN_MANAGEMENT && isPlanDialogOpen && (
        <RecipePlanDialog
          card={planDialogCard}
          form={planForm}
          recipeOptions={planRecipeOptions}
          recipeSearch={planRecipeSearch}
          isRecipePickerOpen={isPlanRecipePickerOpen}
          weekRange={props.recipePlanWeekRange}
          isUpdatingPlan={props.isUpdatingPlan}
          hasRecipes={cards.length > 0}
          onClose={closePlanDialog}
          onSubmit={submitPlanItem}
          onChangeForm={setPlanForm}
          onChangeRecipeSearch={setPlanRecipeSearch}
          onSetRecipePickerOpen={setIsPlanRecipePickerOpen}
          onSelectRecipe={selectPlanRecipe}
        />
      )}

      {SHOW_RECIPE_PLAN_MANAGEMENT && activePlanDetailItem && (
        <RecipePlanDetailDialog
          item={activePlanDetailItem}
          card={activePlanDetailCard}
          form={planDetailForm}
          weekRange={props.recipePlanWeekRange}
          isUpdatingPlan={props.isUpdatingPlan}
          isCookingRecipe={props.isCookingRecipe}
          onClose={closePlanDetail}
          onSubmit={submitPlanDetail}
          onChangeForm={setPlanDetailForm}
          onStartCook={startPlanDetailCook}
          onDelete={(item) => void deletePlanDetailItem(item)}
        />
      )}

      {shoppingDialogCard && (
        <RecipeShoppingDialog
          card={shoppingDialogCard}
          ingredients={props.ingredients}
          drafts={shoppingDrafts}
          customForm={shoppingCustomForm}
          ingredientOptions={shoppingIngredientOptions}
          visibleIngredientOptions={visibleShoppingIngredientOptions}
          isIngredientPickerOpen={isShoppingIngredientPickerOpen}
          isCreatingShopping={props.isCreatingShopping}
          unitOptions={SHOPPING_UNIT_OPTIONS}
          resolveIngredientImageUrl={resolveIngredientImageUrl}
          onClose={closeShoppingDialog}
          onUpdateDraft={updateShoppingDraft}
          onAdjustDraftQuantity={adjustShoppingDraftQuantity}
          onRemoveDraft={removeShoppingDraft}
          onAddRecipeIngredient={addRecipeIngredientToShoppingDraft}
          onChangeCustomForm={setShoppingCustomForm}
          onSetIngredientPickerOpen={setIsShoppingIngredientPickerOpen}
          onSelectIngredientOption={selectShoppingIngredientOption}
          onAdjustCustomQuantity={adjustCustomShoppingQuantity}
          onAddCustomDraft={addCustomShoppingDraft}
          onSubmit={() => void submitShoppingDrafts()}
        />
      )}

      {isCookFinishOpen && activeCookCard && cookSession && (
        <RecipeCookFinishDialog
          recipeTitle={activeCookCard.recipe.title}
          cookPreview={cookPreview}
          cookPreviewError={cookPreviewError}
          isCookPreviewLoading={isCookPreviewLoading}
          session={cookSession}
          isCooking={props.isCookingRecipe}
          submitDisabled={cookSubmitDisabled}
          onUpdateSession={updateCookSession}
          onClose={() => setIsCookFinishOpen(false)}
          onSubmit={submitCookRecipe}
        />
      )}

      {isSceneManagerOpen && (
        <RecipeSceneManagerDialog
          categoryCards={categoryCards}
          managedScenes={managedScenes}
          sceneFormMode={sceneFormMode}
          editingSceneName={editingSceneName}
          sceneDraft={sceneDraft}
          sceneImageState={sceneImageState}
          generatingSceneName={generatingSceneName}
          isUpdatingScene={props.isUpdatingScene}
          onClose={() => setIsSceneManagerOpen(false)}
          onOpenCreateForm={openCreateSceneForm}
          onCloseForm={closeSceneForm}
          onChangeDraft={setSceneDraft}
          onSubmitDraft={submitSceneDraft}
          onGenerateImage={(scene) => void generateSceneImage(scene, { draft: true })}
          onOpenEditForm={openEditSceneForm}
          onDeleteScene={(sceneName) => void deleteManagedScene(sceneName)}
          onRestoreScene={(sceneName) => void restoreManagedScene(sceneName)}
        />
      )}

    </div>
  );
}
