import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
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
import {
  generateImageFromText,
  type AiRenderPayload,
} from '../../lib/aiImages';
import { buildIngredientPlaceholderSvg, emptyImages, formatDate, formatDateTime, getImagePreview, splitTags, todayKey } from '../../lib/ui';
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
import {
  buildCookPayload,
  buildCustomShoppingDraft,
  buildDefaultCookSession,
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
  clearCookSession,
  createEmptyRecipeStepDraft,
  defaultIngredientRows,
  defaultRecipeDraftAiForm,
  defaultRecipeForm,
  defaultSceneDraft,
  formatShoppingQuantity,
  getRecipeDraftGenerationActionLabel,
  getRecipeDraftGenerationButtonLabel,
  getRecipeDraftGenerationStatusCopy,
  getRecipeDraftGenerationStepState,
  getRecipeShoppingRequirement,
  getRecipeStepIconName,
  getRecipeStepSummary,
  getRecipeStepTitle,
  getStepSuggestedSeconds,
  hasRecipeDraftMinimumInput,
  isAiGeneratedRecipeDraft,
  loadCookSession,
  mapRecipeIdsToCards,
  mapRecipeScene,
  newDraftId,
  recipeCookSessionKey,
  applyRecipeIngredientRequirement,
  resolveErrorMessage,
  resolveIngredientImageUrl,
  resolveRecipeDifficulty,
  saveCookSession,
  sanitizeCookSession,
  stripRecipeIngredientRequirementNote,
  type ManagedRecipeScene,
  type RecipeCookSessionState,
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
  createShoppingItem: (payload: { title: string; quantity: number; unit: string; reason: string }) => Promise<ShoppingListItem>;
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
  const cookTimerMinuteWheelRef = useRef<HTMLDivElement | null>(null);
  const cookTimerSecondWheelRef = useRef<HTMLDivElement | null>(null);
  const discoverySectionRef = useRef<HTMLElement | null>(null);
  const planSectionRef = useRef<HTMLElement | null>(null);
  const recipeNoticeTimerRef = useRef<number | null>(null);
  const recipeDraftStageTimerRef = useRef<number | null>(null);
  const recipeDraftDialogCloseTimerRef = useRef<number | null>(null);
  const recipeAiAppliedTimerRef = useRef<number | null>(null);
  const previewCookRecipeRef = useRef(props.previewCookRecipe);
  const [categoryScrollState, setCategoryScrollState] = useState({ canLeft: false, canRight: false });
  const [discoveryScrollState, setDiscoveryScrollState] = useState({ canLeft: false, canRight: false });
  const [view, setView] = useState<RecipeWorkspaceView>('library');
  const [selectedRecipeId, setSelectedRecipeId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [quickFilter, setQuickFilter] = useState<RecipeQuickFilter>('recommend');
  const [sceneFilter, setSceneFilter] = useState('all');
  const [difficultyFilter, setDifficultyFilter] = useState<'all' | Difficulty>('all');
  const [sortMode, setSortMode] = useState<RecipeSortMode>('updated');
  const [recommendationPage, setRecommendationPage] = useState(0);
  const [form, setForm] = useState<RecipeFormState>(() => defaultRecipeForm());
  const [ingredientRows, setIngredientRows] = useState<RecipeDraftIngredient[]>(() => defaultIngredientRows());
  const [planForm, setPlanForm] = useState<{ recipeId: string; planDate: string; mealType: MealType; note: string }>(() => {
    return { recipeId: '', planDate: todayKey(), mealType: 'dinner', note: '' };
  });
  const [planDialogCard, setPlanDialogCard] = useState<RecipeCardViewModel | null>(null);
  const [isPlanDialogOpen, setIsPlanDialogOpen] = useState(false);
  const [planRecipeSearch, setPlanRecipeSearch] = useState('');
  const [isPlanRecipePickerOpen, setIsPlanRecipePickerOpen] = useState(false);
  const [expandedPlanDates, setExpandedPlanDates] = useState<Set<string>>(() => new Set([todayKey()]));
  const [planDetailItemId, setPlanDetailItemId] = useState<string | null>(null);
  const [planDetailForm, setPlanDetailForm] = useState<{ planDate: string; mealType: MealType; note: string }>(() => ({
    planDate: '',
    mealType: 'dinner',
    note: '',
  }));
  const [cookCard, setCookCard] = useState<RecipeCardViewModel | null>(null);
  const [cookPreview, setCookPreview] = useState<CookRecipePreviewResponse | null>(null);
  const [cookPreviewError, setCookPreviewError] = useState<string | null>(null);
  const [isCookPreviewLoading, setIsCookPreviewLoading] = useState(false);
  const [cookSession, setCookSession] = useState<RecipeCookSessionState | null>(null);
  const [wasCookSessionRestored, setWasCookSessionRestored] = useState(false);
  const [isCookFinishOpen, setIsCookFinishOpen] = useState(false);
  const [isCookTimerCustomOpen, setIsCookTimerCustomOpen] = useState(false);
  const [cookTimerPicker, setCookTimerPicker] = useState({ minutes: 2, seconds: 0 });
  const [cookTimerJustStarted, setCookTimerJustStarted] = useState(false);
  const [shoppingDialogCard, setShoppingDialogCard] = useState<RecipeCardViewModel | null>(null);
  const [shoppingDrafts, setShoppingDrafts] = useState<RecipeShoppingDraftItem[]>([]);
  const [shoppingCustomForm, setShoppingCustomForm] = useState<RecipeShoppingCustomForm>(() => ({ title: '', quantity: '1', unit: '个' }));
  const [isShoppingIngredientPickerOpen, setIsShoppingIngredientPickerOpen] = useState(false);
  const [recipeNotice, setRecipeNotice] = useState<RecipeNotice | null>(null);
  const [recipeDraftAiForm, setRecipeDraftAiForm] = useState<RecipeDraftAiFormState>(() => defaultRecipeDraftAiForm());
  const [isRecipeDraftDialogOpen, setIsRecipeDraftDialogOpen] = useState(false);
  const [sceneTagDraft, setSceneTagDraft] = useState('');
  const [visibleStepTips, setVisibleStepTips] = useState<Record<string, boolean>>({});
  const [stepKeyPointSlots, setStepKeyPointSlots] = useState<Record<string, number>>({});
  const [recipeDraftGenerationStage, setRecipeDraftGenerationStage] = useState<RecipeDraftGenerationStage>('idle');
  const [recipeDraftError, setRecipeDraftError] = useState<string | null>(null);
  const [isRecipeAiApplied, setIsRecipeAiApplied] = useState(false);
  const [isSceneManagerOpen, setIsSceneManagerOpen] = useState(false);
  const [sceneFormMode, setSceneFormMode] = useState<RecipeSceneFormMode>(null);
  const [editingSceneName, setEditingSceneName] = useState<string | null>(null);
  const [sceneDraft, setSceneDraft] = useState<ManagedRecipeScene>(() => defaultSceneDraft());
  const [sceneImageState, setSceneImageState] = useState<ImageGenerationUiState>(IDLE_IMAGE_GENERATION_STATE);
  const [generatingSceneName, setGeneratingSceneName] = useState<string | null>(null);

  const cards = useMemo(
    () => buildRecipeCards(props.recipes, props.ingredients, props.inventoryItems, props.mealLogs, props.foods),
    [props.recipes, props.ingredients, props.inventoryItems, props.mealLogs, props.foods]
  );
  const homeViewModel = useMemo(
    () => buildRecipeHomeViewModel(cards, props.recipeFavorites, props.recipePlanItems, props.mealLogs, props.foods),
    [cards, props.recipeFavorites, props.recipePlanItems, props.mealLogs, props.foods]
  );
  const cardByRecipeId = useMemo(() => new Map(cards.map((card) => [card.recipe.id, card])), [cards]);
  const serverRecommendedCards = useMemo(
    () => mapRecipeIdsToCards(props.recipeDiscovery?.recommended.recipe_ids, cardByRecipeId),
    [props.recipeDiscovery, cardByRecipeId]
  );
  const serverQuickCards = useMemo(
    () => mapRecipeIdsToCards(props.recipeDiscovery?.quick.recipe_ids, cardByRecipeId),
    [props.recipeDiscovery, cardByRecipeId]
  );
  const serverReadyCards = useMemo(
    () => mapRecipeIdsToCards(props.recipeDiscovery?.ready.recipe_ids, cardByRecipeId),
    [props.recipeDiscovery, cardByRecipeId]
  );
  const serverMissingCards = useMemo(
    () => mapRecipeIdsToCards(props.recipeDiscovery?.missing.recipe_ids, cardByRecipeId),
    [props.recipeDiscovery, cardByRecipeId]
  );
  const serverRecentCards = useMemo(
    () => mapRecipeIdsToCards(props.recipeStats?.recently_cooked.map((item) => item.recipe_id), cardByRecipeId),
    [props.recipeStats, cardByRecipeId]
  );
  const serverTopItems = useMemo(
    () =>
      (props.recipeStats?.frequent ?? [])
        .map((item) => {
          const card = cardByRecipeId.get(item.recipe_id);
          return card ? { card, count: item.count } : null;
        })
        .filter((item): item is { card: RecipeCardViewModel; count: number } => Boolean(item)),
    [props.recipeStats, cardByRecipeId]
  );
  const sceneFilters = useMemo(() => getRecipeSceneFilters(cards), [cards]);
  const managedScenes = useMemo(() => props.recipeScenes.map(mapRecipeScene), [props.recipeScenes]);
  const managedSceneMap = new Map(managedScenes.map((scene) => [scene.name, scene]));
  const categoryCards: RecipeSceneCard[] = [
    ...new Map(
      [
        ...homeViewModel.popularCategories.filter((category) => !DUPLICATED_TYPE_LABELS.has(category.name)),
        ...FALLBACK_SCENES.map((name) => ({
          name,
          count: 0,
        })),
        ...managedScenes
          .filter((scene) => !scene.hidden && !DUPLICATED_TYPE_LABELS.has(scene.name))
          .map((scene) => ({
            name: scene.name,
            count: 0,
            description: scene.description,
            imagePrompt: scene.imagePrompt,
            imageAssetId: scene.imageAssetId,
            imageAssetUrl: scene.imageAssetUrl,
            custom: scene.custom,
          })),
      ].map((category) => [category.name, category])
    ).values(),
  ].filter((category) => !managedSceneMap.get(category.name)?.hidden).slice(0, 10);
  const sceneSelectOptions = [...new Set([...sceneFilters, ...categoryCards.map((category) => category.name)])].sort((left, right) =>
    left.localeCompare(right, 'zh-CN')
  );
  const discoveryBaseCards = useMemo(() => {
    if (quickFilter === 'ready' && serverReadyCards.length > 0) return serverReadyCards;
    if (quickFilter === 'missing' && serverMissingCards.length > 0) return serverMissingCards;
    if (quickFilter === 'quick' && serverQuickCards.length > 0) return serverQuickCards;
    if (quickFilter === 'recommend' && serverRecommendedCards.length > 0) return serverRecommendedCards;
    return homeViewModel.recommendedCards;
  }, [quickFilter, serverReadyCards, serverMissingCards, serverQuickCards, serverRecommendedCards, homeViewModel.recommendedCards]);
  const visibleCards = useMemo(
    () =>
      filterRecipeCards(discoveryBaseCards, {
        search,
        quickFilter,
        sceneFilter,
        difficultyFilter,
        sortMode: quickFilter === 'recommend' ? 'recommend' : sortMode,
        favoriteRecipeIds: homeViewModel.favoriteRecipeIds,
      }),
    [discoveryBaseCards, search, quickFilter, sceneFilter, difficultyFilter, sortMode, homeViewModel.favoriteRecipeIds]
  );
  const cookableCards = useMemo(
    () => filterRecipeCards(serverReadyCards.length > 0 ? serverReadyCards : cards, { search, quickFilter: 'ready', sceneFilter, difficultyFilter, sortMode: 'availability' }),
    [serverReadyCards, cards, search, sceneFilter, difficultyFilter]
  );
  const recommendedWindow = useMemo(() => {
    if (visibleCards.length === 0) return [];
    const windowSize = 3;
    if (visibleCards.length <= windowSize) return visibleCards;
    const start = (recommendationPage * windowSize) % visibleCards.length;
    return [...visibleCards.slice(start, start + windowSize), ...visibleCards.slice(0, Math.max(start + windowSize - visibleCards.length, 0))];
  }, [visibleCards, recommendationPage]);
  const shouldPageRecommendations = quickFilter === 'recommend' && sceneFilter === 'all';
  const displayCards = shouldPageRecommendations ? recommendedWindow : visibleCards;
  const shouldScrollDiscoveryCards = false;
  const recentPreviewCards =
    serverRecentCards.length > 0
      ? serverRecentCards
      : homeViewModel.recentlyCooked.length > 0
        ? homeViewModel.recentlyCooked
        : homeViewModel.recommendedCards.slice(0, 4);
  const quickPreviewCards =
    serverQuickCards.length > 0
      ? serverQuickCards.slice(0, 5)
      : homeViewModel.quickRecipes.length > 0
        ? homeViewModel.quickRecipes.slice(0, 5)
        : homeViewModel.recommendedCards.slice(0, 5);
  const topPreviewItems =
    serverTopItems.length > 0
      ? serverTopItems.slice(0, 3)
      : homeViewModel.weeklyTop.length > 0
      ? homeViewModel.weeklyTop
      : homeViewModel.recommendedCards.slice(0, 3).map((card, index) => ({ card, count: Math.max(2 - index, 1) }));
  const planDays = Array.from({ length: 7 }, (_, index) => {
    const date = addDateKeyDays(props.recipePlanWeekRange.start, index);
    const fallbackDay = homeViewModel.planDays[index];
    return {
      date,
      label: fallbackDay?.label ?? formatDate(date).slice(0, 2),
      items: props.recipePlanItems.filter((item) => item.plan_date === date),
    };
  });
  const plannedDayCount = planDays.filter((day) => day.items.length > 0).length;
  const recentPreviewSlots = Array.from({ length: 4 }, (_, index) => recentPreviewCards[index] ?? null);
  const quickPreviewSlots = Array.from({ length: 5 }, (_, index) => quickPreviewCards[index] ?? null);
  const topPreviewSlots = Array.from({ length: 3 }, (_, index) => topPreviewItems[index] ?? null);
  const recommendationSlots = displayCards;
  const mobileFeaturedCards = (displayCards.length > 0 ? displayCards : homeViewModel.recommendedCards).slice(0, 3);
  const mobileLibraryCards = visibleCards;
  const hasMobileRecipeAlerts = cards.some((card) => card.shortages.length > 0);
  const mobileSceneCards = categoryCards.slice(0, 8).map((scene) => ({
    scene,
    coverUrl:
      scene.imageAssetUrl ??
      cards.find((card) => (card.recipe.scene_tags ?? []).includes(scene.name))?.coverUrl,
  }));
  const shoppingIngredientOptions = useMemo<RecipeShoppingIngredientOption[]>(
    () =>
      props.ingredients.map((ingredient) => ({
        id: ingredient.id,
        name: ingredient.name,
        unit: ingredient.default_unit || '个',
        imageUrl: resolveIngredientImageUrl(ingredient, ingredient.name),
        category: ingredient.category,
      })),
    [props.ingredients]
  );
  const visibleShoppingIngredientOptions = useMemo(() => {
    const keyword = shoppingCustomForm.title.trim().toLowerCase();
    if (!keyword) return shoppingIngredientOptions.slice(0, 8);
    return shoppingIngredientOptions
      .filter((item) => `${item.name} ${item.category}`.toLowerCase().includes(keyword))
      .slice(0, 8);
  }, [shoppingCustomForm.title, shoppingIngredientOptions]);
  const favoriteSidebarCards =
    homeViewModel.favoriteCards.length > 0 ? homeViewModel.favoriteCards.slice(0, 2) : homeViewModel.recommendedCards.slice(0, 2);
  const visiblePlanDays = planDays;
  const hiddenPlanDayCount = 0;
  const activePlanDetailItem = planDetailItemId ? props.recipePlanItems.find((item) => item.id === planDetailItemId) ?? null : null;
  const activePlanDetailCard = activePlanDetailItem ? cards.find((entry) => entry.recipe.id === activePlanDetailItem.recipe_id) ?? null : null;
  const currentWeekRange = getRecipeWeekRange();
  const isCurrentPlanWeek = props.recipePlanWeekRange.start === currentWeekRange.start && props.recipePlanWeekRange.end === currentWeekRange.end;
  const planWeekLabel = isCurrentPlanWeek ? '本周菜单' : '当前周菜单';
  const selectedCard = selectedRecipeId ? cards.find((card) => card.recipe.id === selectedRecipeId) ?? null : null;
  const selectedReadyCount = selectedCard?.ingredientAvailability.filter((item) => item.ready).length ?? 0;
  const selectedIngredientCount = selectedCard?.ingredientAvailability.length ?? 0;
  const selectedShortageCount = selectedCard?.shortages.length ?? 0;
  const selectedRecipePlanItems = selectedCard ? props.recipePlanItems.filter((item) => item.recipe_id === selectedCard.recipe.id) : [];
  const planRecipeQuery = planRecipeSearch.trim().toLowerCase();
  const planRecipeOptions = useMemo(() => {
    if (!planRecipeQuery) return cards;
    return cards.filter((card) => card.searchText.includes(planRecipeQuery) || card.recipe.title.toLowerCase().includes(planRecipeQuery));
  }, [cards, planRecipeQuery]);
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
  const editorGeneratedUrl = resolveAssetUrl(form.images.generatedAsset?.url);
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
  const activeCookCard = cookCard ?? (view === 'cook' ? selectedCard : null);
  const cookSteps = activeCookCard?.recipe.steps.length
    ? activeCookCard.recipe.steps
    : activeCookCard
      ? [{ id: 'fallback-step', title: '', text: '这份菜谱还没有录入步骤，可以先按你的习惯完成烹饪。', icon: 'tip', summary: '', estimated_minutes: null, tip: '', key_points: [] }]
      : [];
  const currentCookStep = cookSteps[clampStepIndex(cookSession?.currentStepIndex ?? 0, Math.max(cookSteps.length, 1))] ?? null;
  const currentStepSuggestedSeconds = getStepSuggestedSeconds(currentCookStep);
  const cookTimerDisplaySeconds =
    cookSession?.timerMode === 'countdown'
      ? Math.max((cookSession.timerDurationSeconds ?? currentStepSuggestedSeconds ?? 0) - cookSession.timerSeconds, 0)
      : cookSession?.timerSeconds ?? 0;
  const cookTimerDurationSeconds = cookSession?.timerDurationSeconds ?? currentStepSuggestedSeconds;
  const cookTimerProgress =
    cookSession?.timerMode === 'countdown' && cookTimerDurationSeconds
      ? Math.min(Math.max(cookSession.timerSeconds / cookTimerDurationSeconds, 0), 1)
      : 0;
  const cookProgressPercent = cookSteps.length > 0 ? Math.round((((cookSession?.currentStepIndex ?? 0) + 1) / cookSteps.length) * 100) : 0;
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
  const submitDisabled = props.isCreatingRecipe || props.isUpdatingRecipe || recipeImageState.isGenerating;
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
  const cookSubmitDisabled =
    props.isCookingRecipe || isCookPreviewLoading || Boolean(cookPreviewError) || Boolean(cookPreview?.shortages.length) || !cookPreview || !cookSession;

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
    const today = todayKey();
    setExpandedPlanDates(today >= props.recipePlanWeekRange.start && today <= props.recipePlanWeekRange.end ? new Set([today]) : new Set());
  }, [props.recipePlanWeekRange.start, props.recipePlanWeekRange.end]);

  useEffect(() => {
    if (!activePlanDetailItem) {
      if (planDetailItemId) setPlanDetailItemId(null);
      return;
    }
    setPlanDetailForm({
      planDate: activePlanDetailItem.plan_date,
      mealType: activePlanDetailItem.meal_type,
      note: activePlanDetailItem.note ?? '',
    });
  }, [activePlanDetailItem?.id, activePlanDetailItem?.plan_date, activePlanDetailItem?.meal_type, activePlanDetailItem?.note, planDetailItemId]);

  useEffect(() => {
    if (!isCookTimerCustomOpen) return;
    window.requestAnimationFrame(() => {
      cookTimerMinuteWheelRef.current?.scrollTo({ top: Math.max(cookTimerPicker.minutes * 38 - 52, 0), behavior: 'auto' });
      cookTimerSecondWheelRef.current?.scrollTo({ top: Math.max(cookTimerPicker.seconds * 38 - 52, 0), behavior: 'auto' });
    });
  }, [isCookTimerCustomOpen, cookTimerPicker.minutes, cookTimerPicker.seconds]);

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
    previewCookRecipeRef.current = props.previewCookRecipe;
  }, [props.previewCookRecipe]);

  useEffect(() => {
    if (!activeCookCard || !cookSession) {
      setCookPreview(null);
      setCookPreviewError(null);
      setIsCookPreviewLoading(false);
      return;
    }
    if (!Number.isFinite(Number(cookSession.servings)) || Number(cookSession.servings) <= 0) {
      setCookPreview(null);
      setCookPreviewError('份量必须大于 0。');
      setIsCookPreviewLoading(false);
      return;
    }

    let ignore = false;
    setIsCookPreviewLoading(true);
    setCookPreviewError(null);
    const payload = buildCookPayload({
      servings: cookSession.servings,
      date: cookSession.date,
      mealType: cookSession.mealType,
      createMealLog: cookSession.createMealLog,
      planItemId: cookSession.planItemId,
      resultNote: '',
      adjustments: cookSession.adjustments,
      rating: '',
    });
    const timer = window.setTimeout(() => {
      previewCookRecipeRef.current(activeCookCard.recipe.id, payload)
        .then((response) => {
          if (ignore) return;
          setCookPreview(response);
          setCookPreviewError(null);
        })
        .catch((reason) => {
          if (ignore) return;
          setCookPreview(null);
          setCookPreviewError(resolveErrorMessage(reason, '扣减预览失败'));
        })
        .finally(() => {
          if (!ignore) {
            setIsCookPreviewLoading(false);
          }
        });
    }, 250);

    return () => {
      ignore = true;
      window.clearTimeout(timer);
    };
  }, [
    activeCookCard?.recipe.id,
    cookSession?.servings,
    cookSession?.date,
    cookSession?.mealType,
    cookSession?.createMealLog,
    cookSession?.planItemId,
    cookSession?.adjustments,
  ]);

  useEffect(() => {
    const node = discoveryScrollRef.current;
    if (!node) return;
    node.scrollLeft = 0;
    window.requestAnimationFrame(updateDiscoveryScrollState);
  }, [quickFilter, sceneFilter, search, difficultyFilter, sortMode]);

  useEffect(() => {
    if (view !== 'cook' || !activeCookCard || !cookSession) return;
    saveCookSession(activeCookCard.recipe.id, cookSession);
  }, [view, activeCookCard, cookSession]);

  useEffect(() => {
    if (view !== 'cook' || !cookSession?.timerRunning) return;
    const timer = window.setInterval(() => {
      setCookSession((current) => {
        if (!current) return current;
        const duration = current.timerDurationSeconds;
        if (current.timerMode === 'countdown' && duration && current.timerSeconds >= duration) {
          return { ...current, timerRunning: false, timerSeconds: duration };
        }
        return { ...current, timerSeconds: current.timerSeconds + 1 };
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [view, cookSession?.timerRunning]);

  useEffect(() => {
    if (!cookTimerJustStarted) return;
    const timer = window.setTimeout(() => setCookTimerJustStarted(false), 700);
    return () => window.clearTimeout(timer);
  }, [cookTimerJustStarted]);

  function resetForm() {
    setForm(defaultRecipeForm());
    setIngredientRows(defaultIngredientRows());
    setRecipeDraftAiForm(defaultRecipeDraftAiForm());
    setRecipeDraftError(null);
    setSceneTagDraft('');
    setVisibleStepTips({});
    setStepKeyPointSlots({});
  }

  function openCreate() {
    resetForm();
    recipeImageComposer.setState(IDLE_IMAGE_GENERATION_STATE);
    setSelectedRecipeId(null);
    setView('create');
  }

  function openDetail(card: RecipeCardViewModel) {
    setSelectedRecipeId(card.recipe.id);
    setView('detail');
  }

  function openEdit(card: RecipeCardViewModel) {
    const next = buildFormFromRecipe(card.recipe);
    setSelectedRecipeId(card.recipe.id);
    setForm(next.form);
    setIngredientRows(next.ingredients);
    setRecipeDraftAiForm(defaultRecipeDraftAiForm());
    setRecipeDraftError(null);
    recipeImageComposer.setState(IDLE_IMAGE_GENERATION_STATE);
    setSceneTagDraft('');
    setVisibleStepTips({});
    setStepKeyPointSlots({});
    setView('edit');
  }

  function openCook(card: RecipeCardViewModel, planItemId?: string) {
    const loaded = loadCookSession(card.recipe, planItemId ?? null);
    setSelectedRecipeId(card.recipe.id);
    setCookCard(card);
    setCookSession(loaded.session);
    setWasCookSessionRestored(loaded.restored);
    setIsCookFinishOpen(false);
    setCookPreview(null);
    setCookPreviewError(null);
    setView('cook');
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    });
  }

  useEffect(() => {
    if (!props.startRecipeId) return;
    const targetCard = cards.find((card) => card.recipe.id === props.startRecipeId);
    if (!targetCard) return;
    openCook(targetCard, props.startFoodPlanItemId ?? undefined);
    props.onStartRecipeHandled?.();
  }, [cards, props.startFoodPlanItemId, props.startRecipeId]);

  function closeCookDialog() {
    setCookCard(null);
    setCookSession(null);
    setWasCookSessionRestored(false);
    setIsCookFinishOpen(false);
    setCookPreview(null);
    setCookPreviewError(null);
  }

  function updateCookSession(patch: Partial<RecipeCookSessionState>) {
    setCookSession((current) => (current ? { ...current, ...patch } : current));
  }

  function selectCookTimerDuration(seconds: number | null) {
    updateCookSession({
      timerMode: seconds ? 'countdown' : 'countup',
      timerDurationSeconds: seconds,
      timerSeconds: 0,
      timerRunning: false,
    });
  }

  function openCustomCookTimer() {
    const duration = cookSession?.timerDurationSeconds ?? currentStepSuggestedSeconds ?? 120;
    setCookTimerPicker({
      minutes: Math.min(Math.floor(duration / 60), 59),
      seconds: duration % 60,
    });
    setIsCookTimerCustomOpen((current) => !current);
  }

  function confirmCustomCookTimer() {
    const duration = cookTimerPicker.minutes * 60 + cookTimerPicker.seconds;
    if (duration <= 0) return;
    updateCookSession({
      timerMode: 'countdown',
      timerDurationSeconds: duration,
      timerSeconds: 0,
      timerRunning: true,
    });
    setIsCookTimerCustomOpen(false);
    setCookTimerJustStarted(true);
  }

  function startCookTimer() {
    const duration = cookSession?.timerDurationSeconds ?? currentStepSuggestedSeconds;
    updateCookSession({
      timerMode: duration ? 'countdown' : 'countup',
      timerDurationSeconds: duration,
      timerRunning: true,
    });
    setCookTimerJustStarted(true);
  }

  function toggleCookTimer() {
    if (cookSession?.timerRunning) {
      updateCookSession({ timerRunning: false });
    } else {
      startCookTimer();
    }
  }

  function resetCookTimer() {
    updateCookSession({
      timerSeconds: 0,
      timerRunning: false,
      timerMode: cookSession?.timerDurationSeconds ?? currentStepSuggestedSeconds ? 'countdown' : 'countup',
      timerDurationSeconds: cookSession?.timerDurationSeconds ?? currentStepSuggestedSeconds,
    });
  }

  function addCookTimerSeconds(seconds: number) {
    setCookSession((current) => {
      if (!current || current.timerMode !== 'countdown') return current;
      const duration = current.timerDurationSeconds ?? currentStepSuggestedSeconds ?? 0;
      return {
        ...current,
        timerDurationSeconds: Math.max(duration + seconds, seconds),
      };
    });
  }

  function jumpToCookStep(index: number) {
    const nextStepIndex = clampStepIndex(index, Math.max(cookSteps.length, 1));
    const nextSuggestedSeconds = getStepSuggestedSeconds(cookSteps[nextStepIndex]);
    updateCookSession({
      currentStepIndex: nextStepIndex,
      timerSeconds: 0,
      timerRunning: false,
      timerMode: nextSuggestedSeconds ? 'countdown' : 'countup',
      timerDurationSeconds: nextSuggestedSeconds,
    });
  }

  function resetActiveCookSession() {
    if (!activeCookCard) return;
    const nextSession = buildDefaultCookSession(activeCookCard.recipe, cookSession?.planItemId ?? null);
    setCookSession(nextSession);
    setWasCookSessionRestored(false);
    setIsCookFinishOpen(false);
    clearCookSession(activeCookCard.recipe.id, cookSession?.planItemId ?? null);
  }

  function exitCookMode(target: 'detail' | 'library' = 'detail') {
    setIsCookFinishOpen(false);
    setCookSession((current) => (current ? { ...current, timerRunning: false } : current));
    setCookCard(null);
    setView(target);
  }

  function toggleCookIngredient(itemId: string) {
    setCookSession((current) => {
      if (!current) return current;
      const checked = new Set(current.checkedIngredientIds);
      if (checked.has(itemId)) {
        checked.delete(itemId);
      } else {
        checked.add(itemId);
      }
      return { ...current, checkedIngredientIds: [...checked] };
    });
  }

  function completeCurrentCookStepAndContinue() {
    if (!currentCookStep || !cookSession) return;
    const isLastStep = cookSession.currentStepIndex >= cookSteps.length - 1;
    setCookSession((current) => {
      if (!current) return current;
      const completed = new Set(current.completedStepIds);
      completed.add(currentCookStep.id);
      const nextStepIndex = isLastStep ? current.currentStepIndex : clampStepIndex(current.currentStepIndex + 1, Math.max(cookSteps.length, 1));
      const nextSuggestedSeconds = isLastStep ? current.timerDurationSeconds : getStepSuggestedSeconds(cookSteps[nextStepIndex]);
      return {
        ...current,
        completedStepIds: [...completed],
        currentStepIndex: nextStepIndex,
        timerSeconds: isLastStep ? current.timerSeconds : 0,
        timerRunning: isLastStep ? current.timerRunning : false,
        timerMode: nextSuggestedSeconds ? 'countdown' : 'countup',
        timerDurationSeconds: nextSuggestedSeconds,
      };
    });
    if (isLastStep) {
      setIsCookFinishOpen(true);
    }
  }

  function moveCookStep(delta: number) {
    setCookSession((current) => {
      if (!current) return current;
      const nextStepIndex = clampStepIndex(current.currentStepIndex + delta, Math.max(cookSteps.length, 1));
      const nextSuggestedSeconds = getStepSuggestedSeconds(cookSteps[nextStepIndex]);
      return {
        ...current,
        currentStepIndex: nextStepIndex,
        timerSeconds: 0,
        timerRunning: false,
        timerMode: nextSuggestedSeconds ? 'countdown' : 'countup',
        timerDurationSeconds: nextSuggestedSeconds,
      };
    });
  }

  function updateIngredientRow(id: string, key: 'ingredient_id' | 'quantity' | 'unit' | 'note', value: string) {
    setIngredientRows((current) =>
      current.map((item) => {
        if (item.id !== id) return item;
        if (key === 'ingredient_id') {
          const ingredient = props.ingredients.find((entry) => entry.id === value);
          return {
            ...item,
            ingredient_id: value,
            ingredient_name: ingredient?.name ?? '',
            unit: ingredient?.default_unit ?? item.unit,
          };
        }
        return { ...item, [key]: value };
      })
    );
  }

  function updateIngredientNote(id: string, value: string) {
    setIngredientRows((current) =>
      current.map((item) =>
        item.id === id ? { ...item, note: applyRecipeIngredientRequirement(value, getRecipeShoppingRequirement(item)) } : item
      )
    );
  }

  function updateIngredientRequirement(id: string, requirement: RecipeShoppingRequirement) {
    setIngredientRows((current) =>
      current.map((item) => (item.id === id ? { ...item, note: applyRecipeIngredientRequirement(item.note, requirement) } : item))
    );
  }

  function updateStepDraft(stepId: string, patch: Partial<RecipeStepDraft>) {
    setForm((current) => ({
      ...current,
      steps: current.steps.map((item) => (item.id === stepId ? { ...item, ...patch } : item)),
    }));
  }

  function getStepKeyPointValues(step: RecipeStepDraft) {
    return step.keyPoints ? step.keyPoints.split('\n').slice(0, MAX_STEP_KEY_POINTS) : [];
  }

  function addStepTip(stepId: string) {
    setVisibleStepTips((current) => ({ ...current, [stepId]: true }));
  }

  function getStepKeyPointRowCount(step: RecipeStepDraft) {
    return Math.min(MAX_STEP_KEY_POINTS, Math.max(getStepKeyPointValues(step).length, stepKeyPointSlots[step.id] ?? 0));
  }

  function addStepKeyPoint(step: RecipeStepDraft) {
    const nextCount = Math.min(MAX_STEP_KEY_POINTS, getStepKeyPointRowCount(step) + 1);
    setStepKeyPointSlots((current) => ({ ...current, [step.id]: nextCount }));
  }

  function updateStepKeyPoint(step: RecipeStepDraft, index: number, value: string) {
    const rowCount = Math.max(getStepKeyPointRowCount(step), index + 1);
    const rows = Array.from({ length: Math.min(MAX_STEP_KEY_POINTS, rowCount) }, (_, rowIndex) => getStepKeyPointValues(step)[rowIndex] ?? '');
    rows[index] = value;
    updateStepDraft(step.id, { keyPoints: rows.join('\n') });
    setStepKeyPointSlots((current) => ({ ...current, [step.id]: rows.length }));
  }

  function removeStepKeyPoint(step: RecipeStepDraft, index: number) {
    const rowCount = getStepKeyPointRowCount(step);
    const rows = Array.from({ length: rowCount }, (_, rowIndex) => getStepKeyPointValues(step)[rowIndex] ?? '').filter((_, rowIndex) => rowIndex !== index);
    updateStepDraft(step.id, { keyPoints: rows.join('\n') });
    setStepKeyPointSlots((current) => ({ ...current, [step.id]: rows.length }));
  }

  function addIngredientRow() {
    setIngredientRows((current) => [
      ...current,
      { id: newDraftId('ingredient'), ingredient_name: '', ingredient_id: '', quantity: '', unit: '个', note: '' },
    ]);
  }

  function removeIngredientRow(id: string) {
    setIngredientRows((current) => (current.length > 1 ? current.filter((item) => item.id !== id) : current));
  }

  function commitSceneTagDraft() {
    const nextTags = splitTags(sceneTagDraft);
    if (nextTags.length === 0) return;
    setForm((current) => ({
      ...current,
      sceneTags: [...new Set([...splitTags(current.sceneTags), ...nextTags])].join('、'),
    }));
    setSceneTagDraft('');
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
        recipeImageComposer.setState({ isGenerating: true, errorMessage: null });
        try {
          const images = await generateImageFromText(response.image_render_payload);
          setForm((current) => ({ ...current, images: { ...current.images, generatedAsset: images.generatedAsset } }));
          recipeImageComposer.setState(IDLE_IMAGE_GENERATION_STATE);
          showRecipeNotice({
            tone: 'success',
            title: 'AI 菜谱已填入',
            message: '已补全基础信息、原料、步骤和技巧，可继续编辑后保存。',
          });
        } catch (reason) {
          const message = resolveErrorMessage(reason, 'AI 封面生成失败');
          recipeImageComposer.setState({ isGenerating: false, errorMessage: message });
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
    const payload = buildRecipePayload(form, ingredientRows, props.ingredients);
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

  function openShoppingDialog(card: RecipeCardViewModel) {
    setCookCard(null);
    setCookPreview(null);
    setCookPreviewError(null);
    setShoppingDialogCard(card);
    setShoppingDrafts(buildShoppingDraftsFromShortages(card));
    setShoppingCustomForm({ title: '', quantity: '1', unit: '个' });
  }

  function closeShoppingDialog() {
    setShoppingDialogCard(null);
    setShoppingDrafts([]);
    setShoppingCustomForm({ title: '', quantity: '1', unit: '个' });
  }

  function updateShoppingDraft(itemId: string, patch: Partial<Pick<RecipeShoppingDraftItem, 'title' | 'quantity' | 'unit' | 'reason'>>) {
    setShoppingDrafts((current) => current.map((item) => (item.id === itemId ? { ...item, ...patch } : item)));
  }

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

  function adjustShoppingDraftQuantity(itemId: string, delta: number) {
    setShoppingDrafts((current) =>
      current.map((item) => {
        if (item.id !== itemId) return item;
        const currentQuantity = Number(item.quantity);
        const nextQuantity = Math.max(0.01, (Number.isFinite(currentQuantity) ? currentQuantity : 1) + delta);
        return { ...item, quantity: formatShoppingQuantity(nextQuantity) };
      })
    );
  }

  function removeShoppingDraft(itemId: string) {
    setShoppingDrafts((current) => current.filter((item) => item.id !== itemId));
  }

  function addRecipeIngredientToShoppingDraft(item: RecipeIngredient) {
    if (!shoppingDialogCard) return;
    const draft = buildShoppingDraftFromRecipeIngredient(shoppingDialogCard.recipe.title, item);
    setShoppingDrafts((current) => {
      if (current.some((entry) => entry.recipeIngredientId === item.id)) return current;
      return [...current, draft];
    });
  }

  function addCustomShoppingDraft() {
    if (!shoppingDialogCard) return;
    const draft = buildCustomShoppingDraft(shoppingDialogCard.recipe.title, shoppingCustomForm);
    if (!draft) {
      showRecipeNotice({ tone: 'warning', title: '还差一点', message: '请填写采购名称和大于 0 的数量。' });
      return;
    }
    setShoppingDrafts((current) => [...current, draft]);
    setShoppingCustomForm({ title: '', quantity: '1', unit: shoppingCustomForm.unit.trim() || '个' });
    setIsShoppingIngredientPickerOpen(false);
  }

  function adjustCustomShoppingQuantity(delta: number) {
    const currentQuantity = Number(shoppingCustomForm.quantity);
    const nextQuantity = Math.max(0.01, (Number.isFinite(currentQuantity) ? currentQuantity : 1) + delta);
    setShoppingCustomForm({ ...shoppingCustomForm, quantity: formatShoppingQuantity(nextQuantity) });
  }

  function selectShoppingIngredientOption(option: RecipeShoppingIngredientOption) {
    setShoppingCustomForm((current) => ({
      ...current,
      title: option.name,
      unit: option.unit,
    }));
    setIsShoppingIngredientPickerOpen(false);
  }

  async function submitShoppingDrafts() {
    const payloads = buildShoppingPayloadsFromDrafts(shoppingDrafts);
    if (payloads.length === 0) {
      showRecipeNotice({ tone: 'warning', title: '没有可加入项', message: '请至少保留一个有效采购项。' });
      return;
    }
    try {
      await Promise.all(payloads.map((payload) => props.createShoppingItem(payload)));
      closeShoppingDialog();
      showRecipeNotice({ tone: 'success', title: '已加入采购清单', message: `${payloads.length} 项食材已放进采购清单。` });
    } catch (reason) {
      showRecipeNotice({ tone: 'danger', title: '加入采购失败', message: resolveErrorMessage(reason, '加入采购失败') });
    }
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

  function defaultPlanDateForSelectedWeek() {
    const today = todayKey();
    return today >= props.recipePlanWeekRange.start && today <= props.recipePlanWeekRange.end ? today : props.recipePlanWeekRange.start;
  }

  function openPlanDialog(card?: RecipeCardViewModel) {
    setPlanDialogCard(card ?? null);
    setPlanRecipeSearch('');
    setIsPlanRecipePickerOpen(false);
    setPlanForm({
      recipeId: card?.recipe.id ?? '',
      planDate: defaultPlanDateForSelectedWeek(),
      mealType: 'dinner',
      note: '',
    });
    setIsPlanDialogOpen(true);
  }

  function closePlanDialog() {
    setIsPlanDialogOpen(false);
    setPlanDialogCard(null);
    setPlanRecipeSearch('');
    setIsPlanRecipePickerOpen(false);
  }

  function openPlanDetail(item: RecipePlanItem) {
    setPlanDetailItemId(item.id);
    setPlanDetailForm({
      planDate: item.plan_date,
      mealType: item.meal_type,
      note: item.note ?? '',
    });
  }

  function closePlanDetail() {
    setPlanDetailItemId(null);
  }

  function togglePlanDay(date: string) {
    setExpandedPlanDates((current) => {
      const next = new Set(current);
      if (next.has(date)) {
        next.delete(date);
      } else {
        next.add(date);
      }
      return next;
    });
  }

  function startPlanDetailCook(item: RecipePlanItem) {
    const card = cards.find((entry) => entry.recipe.id === item.recipe_id);
    if (!card) {
      showRecipeNotice({ tone: 'warning', title: '找不到菜谱', message: '这条计划关联的菜谱不在当前列表里。' });
      return;
    }
    closePlanDetail();
    openCook(card, item.id);
  }

  function selectPlanRecipe(card: RecipeCardViewModel) {
    setPlanForm((current) => ({ ...current, recipeId: card.recipe.id }));
    setPlanDialogCard(card);
    setPlanRecipeSearch('');
    setIsPlanRecipePickerOpen(false);
  }

  function buildRecipeScenePayload(scene: ManagedRecipeScene) {
    const existingIndex = managedScenes.findIndex((item) => item.name === scene.name);
    return {
      name: scene.name.trim(),
      description: scene.description.trim(),
      image_prompt: scene.imagePrompt.trim(),
      image_asset_id: scene.imageAssetId,
      hidden: Boolean(scene.hidden),
      custom: scene.custom ?? true,
      sort_order: existingIndex >= 0 ? existingIndex : managedScenes.length,
    };
  }

  function openCreateSceneForm() {
    setSceneFormMode('create');
    setEditingSceneName(null);
    setSceneDraft(defaultSceneDraft());
    setSceneImageState(IDLE_IMAGE_GENERATION_STATE);
  }

  function openEditSceneForm(scene: RecipeSceneCard) {
    setSceneFormMode('edit');
    setEditingSceneName(scene.name);
    setSceneDraft({
      id: managedScenes.find((item) => item.name === scene.name)?.id,
      name: scene.name,
      description: scene.description || '',
      imagePrompt: scene.imagePrompt || `${scene.name} 的家庭厨房场景图`,
      imageAssetId: scene.imageAssetId,
      imageAssetUrl: scene.imageAssetUrl,
      custom: scene.custom ?? true,
    });
    setSceneImageState(IDLE_IMAGE_GENERATION_STATE);
  }

  function closeSceneForm() {
    setSceneFormMode(null);
    setEditingSceneName(null);
    setSceneDraft(defaultSceneDraft());
    setSceneImageState(IDLE_IMAGE_GENERATION_STATE);
  }

  async function submitSceneDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = sceneDraft.name.trim();
    if (!name) {
      showRecipeNotice({ tone: 'warning', title: '还不能保存场景', message: '请填写场景名称。' });
      return;
    }
    if (DUPLICATED_TYPE_LABELS.has(name)) {
      showRecipeNotice({ tone: 'warning', title: '场景名称重复', message: '这个名称会和上方筛选重复，请换一个场景名称。' });
      return;
    }
    const nextScene = {
      name,
      description: sceneDraft.description.trim(),
      imagePrompt: sceneDraft.imagePrompt.trim(),
      imageAssetId: sceneDraft.imageAssetId,
      imageAssetUrl: sceneDraft.imageAssetUrl,
      custom: true,
    };
    const existing = managedScenes.find((scene) => scene.name === (editingSceneName ?? name));
    try {
      if (existing?.id) {
        await props.updateRecipeScene(existing.id, buildRecipeScenePayload(nextScene));
      } else {
        await props.createRecipeScene(buildRecipeScenePayload(nextScene));
      }
      closeSceneForm();
    } catch (reason) {
      showRecipeNotice({ tone: 'danger', title: '保存场景失败', message: resolveErrorMessage(reason, '保存场景失败') });
    }
  }

  async function deleteManagedScene(sceneName: string) {
    const existing = managedScenes.find((scene) => scene.name === sceneName);
    try {
      if (existing?.id && existing.custom) {
        await props.deleteRecipeScene(existing.id);
      } else if (existing?.id) {
        await props.updateRecipeScene(existing.id, { hidden: true });
      } else {
        await props.createRecipeScene({
          name: sceneName,
          description: '',
          image_prompt: '',
          hidden: true,
          custom: false,
          sort_order: managedScenes.length,
        });
      }
      if (sceneFilter === sceneName) {
        setSceneFilter('all');
      }
    } catch (reason) {
      showRecipeNotice({ tone: 'danger', title: '删除场景失败', message: resolveErrorMessage(reason, '删除场景失败') });
    }
  }

  async function restoreManagedScene(sceneName: string) {
    const existing = managedScenes.find((scene) => scene.name === sceneName);
    if (!existing?.id) return;
    try {
      if (existing.custom) {
        await props.updateRecipeScene(existing.id, { hidden: false });
      } else {
        await props.deleteRecipeScene(existing.id);
      }
    } catch (reason) {
      showRecipeNotice({ tone: 'danger', title: '恢复场景失败', message: resolveErrorMessage(reason, '恢复场景失败') });
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

  async function generateSceneImage(scene: ManagedRecipeScene, options: { draft?: boolean } = {}) {
    const name = scene.name.trim();
    if (!name) {
      showRecipeNotice({ tone: 'warning', title: '还不能生成场景图', message: '请先填写场景名称。' });
      return;
    }
    setGeneratingSceneName(name);
    setSceneImageState({ isGenerating: true, errorMessage: null });
    try {
      const nextImages = await generateImageFromText(buildSceneImagePayload(scene));
      const generatedAsset = nextImages.generatedAsset;
      if (!generatedAsset) {
        throw new Error('AI 主图生成失败');
      }
      const nextScene: ManagedRecipeScene = {
        ...scene,
        name,
        description: scene.description.trim(),
        imagePrompt: scene.imagePrompt.trim(),
        imageAssetId: generatedAsset.id,
        imageAssetUrl: generatedAsset.url,
        custom: scene.custom ?? true,
      };
      if (options.draft) {
        setSceneDraft(nextScene);
      } else if (scene.id) {
        await props.updateRecipeScene(scene.id, {
          image_prompt: nextScene.imagePrompt,
          image_asset_id: generatedAsset.id,
          hidden: false,
        });
      } else {
        await props.createRecipeScene(buildRecipeScenePayload(nextScene));
      }
      setSceneImageState(IDLE_IMAGE_GENERATION_STATE);
    } catch (reason) {
      setSceneImageState({ isGenerating: false, errorMessage: resolveErrorMessage(reason, '场景图片生成失败') });
    } finally {
      setGeneratingSceneName(null);
    }
  }

  async function submitPlanItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!planForm.recipeId) {
      showRecipeNotice({
        tone: 'warning',
        title: '还不能加入菜单',
        message: cards.length === 0 ? '先新增一份菜谱，再安排菜单计划。' : '请选择要加入菜单的菜谱。',
      });
      return;
    }
    try {
      await props.createRecipePlanItem({
        recipe_id: planForm.recipeId,
        plan_date: planForm.planDate,
        meal_type: planForm.mealType,
        note: planForm.note.trim(),
      });
      closePlanDialog();
      setPlanForm((current) => ({ ...current, recipeId: '', planDate: defaultPlanDateForSelectedWeek(), note: '' }));
    } catch (reason) {
      showRecipeNotice({ tone: 'danger', title: '添加菜单计划失败', message: resolveErrorMessage(reason, '添加菜单计划失败') });
    }
  }

  async function updatePlanDate(item: RecipePlanItem, planDate: string) {
    try {
      await props.updateRecipePlanItem(item.id, { plan_date: planDate });
    } catch (reason) {
      showRecipeNotice({ tone: 'danger', title: '更新计划日期失败', message: resolveErrorMessage(reason, '更新计划日期失败') });
    }
  }

  async function updatePlanMealType(item: RecipePlanItem, mealType: MealType) {
    try {
      await props.updateRecipePlanItem(item.id, { meal_type: mealType });
    } catch (reason) {
      showRecipeNotice({ tone: 'danger', title: '更新计划餐次失败', message: resolveErrorMessage(reason, '更新计划餐次失败') });
    }
  }

  async function deletePlanItem(item: RecipePlanItem) {
    try {
      await props.deleteRecipePlanItem(item.id);
    } catch (reason) {
      showRecipeNotice({ tone: 'danger', title: '删除菜单计划失败', message: resolveErrorMessage(reason, '删除菜单计划失败') });
    }
  }

  async function submitPlanDetail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activePlanDetailItem) return;
    try {
      await props.updateRecipePlanItem(activePlanDetailItem.id, {
        plan_date: planDetailForm.planDate,
        meal_type: planDetailForm.mealType,
        note: planDetailForm.note.trim(),
      });
      closePlanDetail();
    } catch (reason) {
      showRecipeNotice({ tone: 'danger', title: '更新菜单计划失败', message: resolveErrorMessage(reason, '更新菜单计划失败') });
    }
  }

  async function deletePlanDetailItem(item: RecipePlanItem) {
    try {
      await props.deleteRecipePlanItem(item.id);
      closePlanDetail();
    } catch (reason) {
      showRecipeNotice({ tone: 'danger', title: '删除菜单计划失败', message: resolveErrorMessage(reason, '删除菜单计划失败') });
    }
  }

  async function submitCookRecipe(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeCookCard || !cookSession) return;
    try {
      const response = await props.cookRecipe(
        activeCookCard.recipe.id,
        buildCookPayload({
          servings: cookSession.servings,
          date: cookSession.date,
          mealType: cookSession.mealType,
          createMealLog: cookSession.createMealLog,
          planItemId: cookSession.planItemId,
          resultNote: cookSession.resultNote,
          adjustments: cookSession.adjustments,
          rating: cookSession.rating,
        })
      );
      if (response.shortages.length > 0) {
        showRecipeNotice({ tone: 'warning', title: '库存不足', message: response.shortages.map((item) => item.ingredient_name).join('、') });
        return;
      }
      clearCookSession(activeCookCard.recipe.id, cookSession.planItemId);
      setSelectedRecipeId(activeCookCard.recipe.id);
      closeCookDialog();
      setView('detail');
      showRecipeNotice({
        tone: 'success',
        title: '烹饪完成',
        message: cookSession.createMealLog ? '已扣减库存并生成餐食记录。' : '已扣减库存。',
      });
    } catch (reason) {
      showRecipeNotice({ tone: 'danger', title: '开始做失败', message: resolveErrorMessage(reason, '开始做失败') });
    }
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
            onEdit={() => openEdit(card)}
            onCook={() => openCook(card)}
            onShopping={() => openShoppingDialog(card)}
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
          <ActionButton tone="primary" type="button" onClick={openCreate}>
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
          editorGeneratedUrl={editorGeneratedUrl}
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
          openShoppingDialog={openShoppingDialog}
          confirmCustomCookTimer={confirmCustomCookTimer}
          openCustomCookTimer={openCustomCookTimer}
          selectCookTimerDuration={selectCookTimerDuration}
          resetCookTimer={resetCookTimer}
          toggleCookTimer={toggleCookTimer}
          addCookTimerSeconds={addCookTimerSeconds}
          toggleCookIngredient={toggleCookIngredient}
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
          onShopping={openShoppingDialog}
          onToggleFavorite={toggleRecipeFavorite}
          onEdit={openEdit}
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
          onOpenCreate={openCreate}
          onOpenDetail={openDetail}
          onOpenCook={openCook}
          onOpenShopping={openShoppingDialog}
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
