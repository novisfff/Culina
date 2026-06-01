import { useMemo } from 'react';
import type {
  Difficulty,
  Food,
  Ingredient,
  InventoryItem,
  MealLog,
  Recipe,
  RecipeDiscovery,
  RecipeFavorite,
  RecipePlanItem,
  RecipeScene,
  RecipeStats,
} from '../../api/types';
import { resolveAssetUrl } from '../../lib/assets';
import { formatDate } from '../../lib/ui';
import {
  addDateKeyDays,
  buildRecipeCards,
  buildRecipeHomeViewModel,
  filterRecipeCards,
  getRecipeSceneFilters,
  getRecipeWeekRange,
  type RecipeCardViewModel,
  type RecipeQuickFilter,
  type RecipeSortMode,
} from './workspaceModel';
import {
  DUPLICATED_TYPE_LABELS,
  FALLBACK_SCENES,
} from './RecipeWorkspaceOptions';
import {
  mapRecipeIdsToCards,
  mapRecipeScene,
  type RecipeSceneCard,
  type RecipeShoppingCustomForm,
} from './RecipeWorkspaceModel';

type UseRecipeWorkspaceDataArgs = {
  recipes: Recipe[];
  ingredients: Ingredient[];
  inventoryItems: InventoryItem[];
  mealLogs: MealLog[];
  foods: Food[];
  recipeFavorites: RecipeFavorite[];
  recipeDiscovery: RecipeDiscovery | null;
  recipeStats: RecipeStats | null;
  recipePlanItems: RecipePlanItem[];
  recipeScenes: RecipeScene[];
  recipePlanWeekRange: { start: string; end: string };
  quickFilter: RecipeQuickFilter;
  sceneFilter: string;
  difficultyFilter: 'all' | Difficulty;
  sortMode: RecipeSortMode;
  search: string;
  recommendationPage: number;
  shoppingCustomForm: RecipeShoppingCustomForm;
  selectedRecipeId: string | null;
};

export function useRecipeWorkspaceData(args: UseRecipeWorkspaceDataArgs) {
  const cards = useMemo(
    () => buildRecipeCards(args.recipes, args.ingredients, args.inventoryItems, args.mealLogs, args.foods),
    [args.recipes, args.ingredients, args.inventoryItems, args.mealLogs, args.foods]
  );
  const homeViewModel = useMemo(
    () => buildRecipeHomeViewModel(cards, args.recipeFavorites, args.recipePlanItems, args.mealLogs, args.foods),
    [cards, args.recipeFavorites, args.recipePlanItems, args.mealLogs, args.foods]
  );
  const cardByRecipeId = useMemo(() => new Map(cards.map((card) => [card.recipe.id, card])), [cards]);
  const serverRecommendedCards = useMemo(
    () => mapRecipeIdsToCards(args.recipeDiscovery?.recommended.recipe_ids, cardByRecipeId),
    [args.recipeDiscovery, cardByRecipeId]
  );
  const serverQuickCards = useMemo(
    () => mapRecipeIdsToCards(args.recipeDiscovery?.quick.recipe_ids, cardByRecipeId),
    [args.recipeDiscovery, cardByRecipeId]
  );
  const serverReadyCards = useMemo(
    () => mapRecipeIdsToCards(args.recipeDiscovery?.ready.recipe_ids, cardByRecipeId),
    [args.recipeDiscovery, cardByRecipeId]
  );
  const serverMissingCards = useMemo(
    () => mapRecipeIdsToCards(args.recipeDiscovery?.missing.recipe_ids, cardByRecipeId),
    [args.recipeDiscovery, cardByRecipeId]
  );
  const serverRecentCards = useMemo(
    () => mapRecipeIdsToCards(args.recipeStats?.recently_cooked.map((item) => item.recipe_id), cardByRecipeId),
    [args.recipeStats, cardByRecipeId]
  );
  const serverTopItems = useMemo(
    () =>
      (args.recipeStats?.frequent ?? [])
        .map((item) => {
          const card = cardByRecipeId.get(item.recipe_id);
          return card ? { card, count: item.count } : null;
        })
        .filter((item): item is { card: RecipeCardViewModel; count: number } => Boolean(item)),
    [args.recipeStats, cardByRecipeId]
  );
  const sceneFilters = useMemo(() => getRecipeSceneFilters(cards), [cards]);
  const managedScenes = useMemo(() => args.recipeScenes.map(mapRecipeScene), [args.recipeScenes]);
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
    if (args.quickFilter === 'ready' && serverReadyCards.length > 0) return serverReadyCards;
    if (args.quickFilter === 'missing' && serverMissingCards.length > 0) return serverMissingCards;
    if (args.quickFilter === 'quick' && serverQuickCards.length > 0) return serverQuickCards;
    if (args.quickFilter === 'recommend' && serverRecommendedCards.length > 0) return serverRecommendedCards;
    return homeViewModel.recommendedCards;
  }, [args.quickFilter, serverReadyCards, serverMissingCards, serverQuickCards, serverRecommendedCards, homeViewModel.recommendedCards]);
  const visibleCards = useMemo(
    () =>
      filterRecipeCards(discoveryBaseCards, {
        search: args.search,
        quickFilter: args.quickFilter,
        sceneFilter: args.sceneFilter,
        difficultyFilter: args.difficultyFilter,
        sortMode: args.quickFilter === 'recommend' ? 'recommend' : args.sortMode,
        favoriteRecipeIds: homeViewModel.favoriteRecipeIds,
      }),
    [discoveryBaseCards, args.search, args.quickFilter, args.sceneFilter, args.difficultyFilter, args.sortMode, homeViewModel.favoriteRecipeIds]
  );
  const cookableCards = useMemo(
    () =>
      filterRecipeCards(serverReadyCards.length > 0 ? serverReadyCards : cards, {
        search: args.search,
        quickFilter: 'ready',
        sceneFilter: args.sceneFilter,
        difficultyFilter: args.difficultyFilter,
        sortMode: 'availability',
      }),
    [serverReadyCards, cards, args.search, args.sceneFilter, args.difficultyFilter]
  );
  const recommendedWindow = useMemo(() => {
    if (visibleCards.length === 0) return [];
    const windowSize = 3;
    if (visibleCards.length <= windowSize) return visibleCards;
    const start = (args.recommendationPage * windowSize) % visibleCards.length;
    return [
      ...visibleCards.slice(start, start + windowSize),
      ...visibleCards.slice(0, Math.max(start + windowSize - visibleCards.length, 0)),
    ];
  }, [visibleCards, args.recommendationPage]);
  const shouldPageRecommendations = args.quickFilter === 'recommend' && args.sceneFilter === 'all';
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
    const date = addDateKeyDays(args.recipePlanWeekRange.start, index);
    const fallbackDay = homeViewModel.planDays[index];
    return {
      date,
      label: fallbackDay?.label ?? formatDate(date).slice(0, 2),
      items: args.recipePlanItems.filter((item) => item.plan_date === date),
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
  const favoriteSidebarCards =
    homeViewModel.favoriteCards.length > 0 ? homeViewModel.favoriteCards.slice(0, 2) : homeViewModel.recommendedCards.slice(0, 2);
  const visiblePlanDays = planDays;
  const hiddenPlanDayCount = 0;
  const currentWeekRange = getRecipeWeekRange();
  const isCurrentPlanWeek =
    args.recipePlanWeekRange.start === currentWeekRange.start && args.recipePlanWeekRange.end === currentWeekRange.end;
  const planWeekLabel = isCurrentPlanWeek ? '本周菜单' : '当前周菜单';
  const selectedCard = args.selectedRecipeId ? cards.find((card) => card.recipe.id === args.selectedRecipeId) ?? null : null;
  const selectedReadyCount = selectedCard?.ingredientAvailability.filter((item) => item.ready).length ?? 0;

  return {
    cards,
    homeViewModel,
    cardByRecipeId,
    sceneFilters,
    managedScenes,
    managedSceneMap,
    categoryCards,
    sceneSelectOptions,
    discoveryBaseCards,
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
  };
}
