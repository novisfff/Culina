import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from './api/client';
import { isApiError } from './api/request';
import { invalidateAfterInventoryChanged, invalidateAfterInventoryOperation } from './api/cacheInvalidation';
import { queryKeys } from './api/queryKeys';
import { AppNotificationCenter, AppShell } from './app/AppShell';
import type { AppNavigationTarget, PrimaryTabKey } from './app/appNavigationModel';
import { useAppGlobalSearchNavigation } from './app/useAppGlobalSearchNavigation';
import { useAppHomeHandlers } from './app/useAppHomeHandlers';
import { useAppFamilyViewModel } from './app/useAppFamilyViewModel';
import { useAppHomeViewModel } from './app/useAppHomeViewModel';
import { useAppMutations } from './app/useAppMutations';
import { useAppNavigationState } from './app/useAppNavigationState';
import { useAppWorkspaceQueries } from './app/useAppWorkspaceQueries';
import { buildEatTaskBodies } from './features/eat/EatTaskBodies';
import { EatWorkspace } from './features/eat/EatWorkspace';
import {
  relatedSelfMadeFoods,
  buildCookLaunchContext,
  resolveEatTask,
  type QuerySettleStatus,
} from './features/eat/EatWorkspaceViewModel';
import type {
  InventoryOperationDetail,
  InventoryOperationResult,
  MealLog,
  UpdateMealLogPayload,
} from './api/types';
import { useAuth } from './auth/AuthContext';
import { AuthStatusScreen, LoginScreen } from './components/LoginScreen';
import { addDateKeyDays, getRecipeWeekRange } from './components/recipes/workspaceModel';
import { businessDateKey } from './lib/date';
import { tracksIngredientQuantity } from './lib/ingredientTracking';
import {
  buildInventoryActionGroups,
  selectHomeEligibleInventoryActionGroups,
} from './features/inventory/inventoryActionModel';
import {
  EmptyState,
} from './components/ui-kit';
import {
  todayKey,
} from './lib/ui';
import { MealLogWorkspace } from './features/meals/MealLogWorkspace';
import { useFamilySettingsState } from './features/family/useFamilySettingsState';
import { useHomeDashboardState } from './features/home/useHomeDashboardState';
import { useHomeDashboardActions } from './features/home/useHomeDashboardActions';
import type { HomeMealEnrichmentOpenRequest } from './features/home/useHomeDashboardActions';
import { InventoryMaintenanceDialogs } from './features/inventory/InventoryMaintenanceDialogs';
import {
  InventoryOperationBanner,
  selectRecentBannerOperation,
} from './features/inventory/InventoryOperationBanner';
import { storageLocationForScope } from './features/inventory/inventoryReconciliationModel';
import { useInventoryReconciliationActions } from './features/inventory/useInventoryReconciliationActions';
import { useInventoryReconciliationState } from './features/inventory/useInventoryReconciliationState';
import { useShoppingIntakeState } from './features/inventory/useShoppingIntakeState';
import { useShoppingIntakeActions } from './features/inventory/useShoppingIntakeActions';
import {
  buildFreeTextLinkOptions,
  linkFreeTextDraft,
  suggestFreeTextLinkCandidates,
  type FreeTextLinkCandidate,
  type FreeTextLinkTarget,
} from './features/inventory/shoppingIntakeModel';
import { useNotice } from './hooks/useNotice';
import { useAiImageJobMonitor } from './hooks/useAiImageJobMonitor';
import { resolveAssetUrl } from './lib/assets';
import { readStringStorage, writeStringStorage } from './lib/storage';
import { HomeDashboard } from './features/home/HomeDashboard';
import { GlobalSearchOverlay } from './features/search/GlobalSearchOverlay';
import { IngredientShoppingDialog } from './components/ingredients/IngredientShoppingDialog';
import {
  buildShoppingForm,
  type ShoppingDialogFormState,
} from './components/ingredients/ingredientWorkspaceForms';
import { resolveShoppingFormSubmission } from './components/ingredients/shoppingFormSubmission';

const AiWorkspace = lazy(() =>
  import('./components/ai/AiWorkspace').then((module) => ({ default: module.AiWorkspace }))
);
const FoodWorkspace = lazy(() =>
  import('./components/foods/FoodWorkspace').then((module) => ({ default: module.FoodWorkspace }))
);
const IngredientWorkspace = lazy(() =>
  import('./components/ingredients/IngredientWorkspace').then((module) => ({ default: module.IngredientWorkspace }))
);
const HomeDashboardDialogs = lazy(() =>
  import('./features/home/HomeDashboardDialogs').then((module) => ({ default: module.HomeDashboardDialogs }))
);
const FamilySettings = lazy(() =>
  import('./features/family/FamilySettings').then((module) => ({ default: module.FamilySettings }))
);

const SIDEBAR_COLLAPSED_KEY = 'culina-large-shell-sidebar-collapsed-v3';
const PHONE_VIEWPORT_QUERY = '(max-width: 767px)';

function defaultSidebarCollapsed() {
  return readStringStorage(SIDEBAR_COLLAPSED_KEY, '') === '1';
}

function resetPageScroll() {
  window.requestAnimationFrame(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    document.scrollingElement?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  });
}

function getIsPhoneViewport() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia(PHONE_VIEWPORT_QUERY).matches;
}

/** Prefer structured 409/422 detail.message over ApiError.detail which may be "[object Object]". */
function messageFromApiError(reason: unknown, fallback: string): string {
  if (isApiError(reason)) {
    const payload = reason.payload;
    if (payload && typeof payload === 'object' && 'detail' in payload) {
      const detail = (payload as { detail?: unknown }).detail;
      if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
        const message = (detail as { message?: unknown }).message;
        if (typeof message === 'string' && message.trim()) {
          return message;
        }
      }
      if (typeof detail === 'string' && detail.trim()) {
        return detail;
      }
    }
    if (reason.detail && reason.detail !== '[object Object]') {
      return reason.detail;
    }
    return fallback;
  }
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  return fallback;
}

function queryErrorMessage(error: unknown, fallback: string): string | null {
  if (!error) return null;
  return messageFromApiError(error, fallback);
}

function useIsPhoneViewport() {
  const [isPhoneViewport, setIsPhoneViewport] = useState(getIsPhoneViewport);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return undefined;
    }
    const mediaQuery = window.matchMedia(PHONE_VIEWPORT_QUERY);
    const handleChange = () => setIsPhoneViewport(mediaQuery.matches);
    handleChange();
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  return isPhoneViewport;
}


function querySettleStatus(query: {
  isPending?: boolean;
  isLoading?: boolean;
  isError?: boolean;
  isSuccess?: boolean;
  fetchStatus?: string;
  data?: unknown;
}): QuerySettleStatus {
  if (query.isError) return 'error';
  if (query.isSuccess || query.data !== undefined) return 'success';
  if (query.isPending || query.isLoading) return 'pending';
  return 'idle';
}

function primaryTabToTarget(
  tab: PrimaryTabKey,
  currentEatBaseView: 'discover' | 'plan' | 'history',
  alreadyOnEat: boolean,
): AppNavigationTarget {
  switch (tab) {
    case 'home':
      return { workspace: 'home' };
    case 'eat':
      if (alreadyOnEat) {
        return { workspace: 'eat', view: currentEatBaseView };
      }
      return { workspace: 'eat', view: 'discover' };
    case 'ingredients':
      return { workspace: 'ingredients' };
    case 'ai':
      return { workspace: 'ai' };
    case 'family':
      return { workspace: 'family' };
  }
}

function WorkspaceLoadingFallback() {
  return (
    <main className="page-stack">
      <section className="card page-section">
        <EmptyState title="正在加载工作台" description="首次打开需要加载对应模块，请稍候。" />
      </section>
    </main>
  );
}

function App() {
  const { isAuthenticated, isLoading: authLoading, user, membership, logout } = useAuth();
  const isPhoneViewport = useIsPhoneViewport();
  const navigation = useAppNavigationState();
  const [selectedRecipePlanDate, setSelectedRecipePlanDate] = useState(todayKey());
  const foodPlanWeekRange = useMemo(() => getRecipeWeekRange(selectedRecipePlanDate), [selectedRecipePlanDate]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(defaultSidebarCollapsed);
  const [hasBooted, setHasBooted] = useState(false);
  const [homeMealEnrichmentRequest, setHomeMealEnrichmentRequest] = useState<HomeMealEnrichmentOpenRequest | null>(null);
  const [homeShoppingDialogOpen, setHomeShoppingDialogOpen] = useState(false);
  const [homeShoppingForm, setHomeShoppingForm] = useState<ShoppingDialogFormState>(() => buildShoppingForm());
  const [cookResumePromptOpen, setCookResumePromptOpen] = useState(false);
  const { notice, showNotice, clearNotice } = useNotice();
  const queryClient = useQueryClient();
  const aiImageJobMonitor = useAiImageJobMonitor(isAuthenticated, { onNotice: showNotice });

  useEffect(() => {
    resetPageScroll();
  }, [navigation.state.primaryTab, navigation.state.eat.baseView, navigation.state.eat.task?.kind]);

  useEffect(() => {
    writeStringStorage(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed ? '1' : '0');
  }, [sidebarCollapsed]);

  const {
    familyQuery,
    membersQuery,
    ingredientsQuery,
    inventoryQuery,
    inventoryStatesQuery,
    shoppingQuery,
    inventoryOperationsQuery,
    recipesQuery,
    foodPlanQuery,
    foodPlanDetailQuery,
    foodScenesQuery,
    foodsQuery,
    mealLogsQuery,
    activityLogsQuery,
    activityHighlightsQuery,
    aiConversationsQuery,
    isBootLoading: isWorkspaceBootLoading,
    members,
    ingredients,
    inventoryItems,
    inventoryStates,
    shoppingItems,
    inventoryOperations,
    recipes,
    foodPlanItems,
    foodPlanDetail,
    foodScenes,
    foods,
    foodRecommendations,
    mealLogs,
    aiConversations,
    family,
  } = useAppWorkspaceQueries({
    navigationState: navigation.state,
    isAuthenticated,
    foodPlanWeekRange,
  });

  // One business date for home action projection; same key is injected again by useAppHomeViewModel.
  const homeBusinessDateKey = businessDateKey(new Date(), 'Asia/Shanghai');
  const homePreparedActionGroups = useMemo(
    () =>
      buildInventoryActionGroups({
        inventoryItems,
        inventoryStates,
        ingredients,
        shoppingItems,
        referenceDate: homeBusinessDateKey,
      }),
    [homeBusinessDateKey, ingredients, inventoryItems, inventoryStates, shoppingItems],
  );
  const homeEligibleInventoryActionGroupsForState = useMemo(
    () => selectHomeEligibleInventoryActionGroups(homePreparedActionGroups),
    [homePreparedActionGroups],
  );

  const {
    desktopRecommendationCursor,
    mobileRecommendationCursor,
    showNextDesktopRecommendations,
    showNextMobileRecommendation,
    selectedDashboardPlanDate,
    setSelectedDashboardPlanDate,
    homePlanDetailItemId,
    isHomePlanAddDialogOpen,
    homePlanAddFoodId,
    setHomePlanAddFoodId,
    homePlanAddFoodSearch,
    setHomePlanAddFoodSearch,
    homePlanAddForm,
    setHomePlanAddForm,
    homePlanDetailForm,
    setHomePlanDetailForm,
    isHomePlanDetailEditing,
    setIsHomePlanDetailEditing,
    selectedActionGroupId,
    completionSummary,
    completedIngredientId,
    nextGroupId,
    actionDialogBusy,
    actionDialogError,
    actionDialogConflict,
    setActionDialogBusy,
    setActionDialogError,
    setActionDialogConflict,
    openActionGroup,
    closeActionGroup,
    completeActionGroup,
    openNextActionGroup,
    dismissCompletionSummary,
    homeRestockShoppingItemId,
    setHomeRestockShoppingItemId,
    homeRestockForm,
    setHomeRestockForm,
    homeMealDetailId,
    setHomeMealDetailId,
    openHomePlanDetail,
    closeHomePlanDetail,
    resetHomePlanDetailForm,
    openHomePlanAddDialog,
    openHomePlanAddEmptyDialog,
    selectHomePlanAddFood,
    closeHomePlanAddDialog,
  } = useHomeDashboardState({
    foodPlanWeekRange,
    homeEligibleInventoryActionGroups: homeEligibleInventoryActionGroupsForState,
    businessDateKey: homeBusinessDateKey,
    recommendationCount: foodRecommendations?.items.length ?? 0,
    recommendationIdSignature: (foodRecommendations?.items ?? [])
      .map((item) => item.food.id)
      .join('|'),
  });

  const {
    ingredientNavigationRequest,
    setIngredientNavigationRequest,
    ingredientNavigationRequestIdRef,
    foodPlanNavigationRequest,
    openFoodPlanWeek: requestFoodPlanWeek,
    globalSearchOpen,
    setGlobalSearchOpen,
    handleGlobalSearchSelect,
  } = useAppGlobalSearchNavigation({
    navigate: navigation.navigate,
  });

  const handlePrimaryTabChange = useCallback((tab: PrimaryTabKey) => {
    navigation.navigate(
      primaryTabToTarget(tab, navigation.state.eat.baseView, navigation.state.primaryTab === 'eat'),
    );
  }, [navigation]);

  const openFoodPlanWeek = useCallback((planDate: string) => {
    setSelectedRecipePlanDate(planDate);
    requestFoodPlanWeek(planDate);
  }, [requestFoodPlanWeek]);

  // FoodWorkspace / plan surface still use the legacy (recipeId, foodPlanItemId?) signature.
  // Exact-one selfMade relation: 0 or >1 matches → recipe-target (never arbitrary find()).
  const startRecipeCook = useCallback((recipeId: string, foodPlanItemId?: string) => {
    const related = relatedSelfMadeFoods(foods, recipeId);
    const recipe = recipes.find((item) => item.id === recipeId) ?? null;
    // Prefer latest plan detail query when the cook originates from a plan item.
    const planItem = foodPlanItemId
      ? (
          (foodPlanDetail && foodPlanDetail.id === foodPlanItemId ? foodPlanDetail : null)
          ?? foodPlanItems.find((item) => item.id === foodPlanItemId)
          ?? null
        )
      : null;
    // Plan cook requires OCC base. If week/detail cache miss, open plan-detail by id
    // so the detail query supplies updated_at before cook starts.
    if (foodPlanItemId && !planItem?.updated_at) {
      navigation.navigate({ workspace: 'eat', view: 'plan', foodPlanItemId });
      return;
    }
    if (related.length !== 1) {
      // Fall back to recipe-target so missing/ambiguous relation errors surface in EatWorkspace.
      navigation.navigate({ workspace: 'eat', view: 'recipe', recipeId });
      return;
    }
    const linkedFood = related[0];
    const launchContext = buildCookLaunchContext({
      foodPlanItemId,
      planItem,
      servings: recipe?.servings,
    });
    navigation.navigate({
      workspace: 'eat',
      view: 'cook',
      foodId: linkedFood.id,
      recipeId,
      launchContext,
    });
  }, [foodPlanDetail, foodPlanItems, foods, navigation, recipes]);

  const startCookWithFood = useCallback((foodId: string, recipeId: string) => {
    const recipe = recipes.find((item) => item.id === recipeId) ?? null;
    navigation.navigate({
      workspace: 'eat',
      view: 'cook',
      foodId,
      recipeId,
      launchContext: {
        date: todayKey(),
        mealType: 'dinner',
        servings: recipe?.servings && recipe.servings > 0 ? recipe.servings : 1,
        source: { kind: 'direct' },
      },
    });
  }, [navigation, recipes]);

  const resolvedEatTask = useMemo(
    () =>
      resolveEatTask({
        task: navigation.state.eat.task,
        recipes,
        foods,
        recipesStatus: querySettleStatus(recipesQuery),
        foodsStatus: querySettleStatus(foodsQuery),
        planDetail: foodPlanDetail,
        planDetailStatus: querySettleStatus(foodPlanDetailQuery),
        mealLogs,
        mealLogsStatus: querySettleStatus(mealLogsQuery),
        mealLogsFetching: mealLogsQuery.isFetching,
      }),
    [
      foodPlanDetail,
      foodPlanDetailQuery,
      foods,
      foodsQuery,
      mealLogs,
      mealLogsQuery,
      navigation.state.eat.task,
      recipes,
      recipesQuery,
    ],
  );

  useEffect(() => {
    if (!authLoading && !isWorkspaceBootLoading) {
      setHasBooted(true);
    }
  }, [authLoading, isWorkspaceBootLoading]);

  const {
    createIngredientMutation,
    updateIngredientMutation,
    transitionIngredientTrackingModeMutation,
    createInventoryMutation,
    upsertInventoryStateMutation,
    consumeInventoryMutation,
    disposeExpiredInventoryMutation,
    snoozeInventoryExpiryAlertsMutation,
    correctInventoryExpiryDateMutation,
    createShoppingMutation,
    updateShoppingMutation,
    deleteShoppingMutation,
    submitShoppingIntakeMutation,
    submitInventoryReconciliationMutation,
    revertInventoryOperationMutation,
    createRecipeMutation,
    updateRecipeMutation,
    deleteRecipeMutation,
    cookRecipeMutation,
    previewCookRecipeMutation,
    addRecipeFavoriteMutation,
    removeRecipeFavoriteMutation,
    createFoodPlanItemMutation,
    updateFoodPlanItemMutation,
    deleteFoodPlanItemMutation,
    createFoodSceneMutation,
    updateFoodSceneMutation,
    deleteFoodSceneMutation,
    createFoodMutation,
    updateFoodMutation,
    toggleFavoriteMutation,
    updateMealMutation,
    quickAddMealMutation,
  } = useAppMutations();

  const shoppingIntakeState = useShoppingIntakeState();
  const shoppingIntakeActions = useShoppingIntakeActions({
    state: shoppingIntakeState,
    submitShoppingIntake: (payload) => submitShoppingIntakeMutation.mutateAsync(payload),
    invalidateAfterInventoryOperation: async () => {
      await invalidateAfterInventoryOperation(queryClient);
    },
    showNotice,
    refreshSources: async () => {
      const latest = await Promise.all([
        queryClient.fetchQuery({ queryKey: queryKeys.shoppingList, queryFn: api.getShoppingList }),
        queryClient.fetchQuery({ queryKey: queryKeys.ingredients, queryFn: () => api.getIngredients() }),
        queryClient.fetchQuery({ queryKey: queryKeys.foods, queryFn: () => api.getFoods() }),
        queryClient.fetchQuery({ queryKey: queryKeys.inventoryStates, queryFn: () => api.listInventoryStates() }),
        queryClient.fetchQuery({ queryKey: queryKeys.inventory, queryFn: () => api.getInventory() }),
      ]);
      return {
        shoppingItems: latest[0],
        ingredients: latest[1],
        foods: latest[2],
        inventoryStates: latest[3],
      };
    },
  });

  const reconciliationState = useInventoryReconciliationState();
  const reconciliationActions = useInventoryReconciliationActions({
    familyId: family?.id ?? '',
    userId: user?.id ?? '',
    referenceDate: homeBusinessDateKey,
    state: reconciliationState,
    fetchReconciliation: async ({ scope, storageLocation }) =>
      api.getInventoryReconciliation({
        scope,
        storage_location: storageLocation,
      }),
    submitReconciliation: (payload) => submitInventoryReconciliationMutation.mutateAsync(payload),
    invalidateAfterInventoryOperation: async () => {
      await invalidateAfterInventoryOperation(queryClient);
    },
    showNotice,
  });

  const openHomeIngredientShoppingDialog = useCallback((ingredientId: string) => {
    const ingredient = ingredients.find((item) => item.id === ingredientId);
    if (!ingredient) {
      showNotice({
        tone: 'warning',
        title: '食材暂不可用',
        message: '没有找到对应食材，请刷新后再试。',
      });
      return;
    }
    setHomeShoppingForm(buildShoppingForm(ingredient, '库存不足'));
    setHomeShoppingDialogOpen(true);
  }, [ingredients, showNotice]);

  async function submitHomeShopping(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const resolution = resolveShoppingFormSubmission({
      form: homeShoppingForm,
      ingredients,
      foods,
    });
    if (!resolution.ok) {
      showNotice({
        tone: 'warning',
        title: resolution.title,
        message: resolution.message,
      });
      return;
    }
    try {
      await createShoppingMutation.mutateAsync(resolution.payload);
      setHomeShoppingForm(buildShoppingForm());
      setHomeShoppingDialogOpen(false);
    } catch (reason) {
      showNotice({
        tone: 'danger',
        title: '加入购物清单失败',
        message:
          reason instanceof Error && reason.message.trim()
            ? reason.message
            : '加入购物清单失败',
      });
    }
  }

  function openReconciliation(args?: { scope?: 'suggested' | 'refrigerated' | 'frozen' | 'room_temperature' | 'all' }) {
    const scope = args?.scope ?? 'suggested';
    void reconciliationActions.openReconciliation(scope, storageLocationForScope(scope));
  }

  const [operationHistoryOpen, setOperationHistoryOpen] = useState(false);
  const [selectedOperationId, setSelectedOperationId] = useState<string | null>(null);
  const [operationHistoryInitialId, setOperationHistoryInitialId] = useState<string | null>(null);
  const [operationDetail, setOperationDetail] = useState<InventoryOperationDetail | null>(null);
  const [operationDetailLoading, setOperationDetailLoading] = useState(false);
  const [operationDetailError, setOperationDetailError] = useState<string | null>(null);
  const [operationHistoryError, setOperationHistoryError] = useState<string | null>(null);
  const [operationHistoryConflict, setOperationHistoryConflict] = useState<string | null>(null);
  const [recentBannerOverride, setRecentBannerOverride] = useState<InventoryOperationResult | null>(null);

  const recentBannerOperation = useMemo(() => {
    const nowMs = Date.now();
    const fromList = selectRecentBannerOperation(inventoryOperations, nowMs);
    if (recentBannerOverride && selectRecentBannerOperation([recentBannerOverride], nowMs)) {
      if (!fromList || Date.parse(recentBannerOverride.applied_at) >= Date.parse(fromList.applied_at)) {
        return recentBannerOverride;
      }
    }
    return fromList;
  }, [inventoryOperations, recentBannerOverride]);

  function openOperationHistory(operationId?: string) {
    setOperationHistoryOpen(true);
    setOperationHistoryError(null);
    setOperationHistoryConflict(null);
    if (operationId) {
      setOperationHistoryInitialId(operationId);
      setSelectedOperationId(operationId);
    } else {
      setOperationHistoryInitialId(null);
    }
  }

  function closeOperationHistory() {
    if (revertInventoryOperationMutation.isPending) return;
    setOperationHistoryOpen(false);
    setOperationHistoryInitialId(null);
    setOperationHistoryConflict(null);
  }

  async function loadOperationDetail(operationId: string) {
    setOperationDetailLoading(true);
    setOperationDetailError(null);
    try {
      const detail = await api.getInventoryOperation(operationId);
      setOperationDetail(detail);
    } catch (reason) {
      setOperationDetail(null);
      setOperationDetailError(
        isApiError(reason)
          ? reason.detail || '读取操作详情失败'
          : reason instanceof Error
            ? reason.message
            : '读取操作详情失败',
      );
    } finally {
      setOperationDetailLoading(false);
    }
  }

  async function handleRevertInventoryOperation(operationId: string) {
    setOperationHistoryConflict(null);
    setOperationHistoryError(null);
    try {
      const result = await revertInventoryOperationMutation.mutateAsync(operationId);
      setRecentBannerOverride(result);
      if (shoppingIntakeState.result?.operation_id === operationId) {
        shoppingIntakeState.setResult({
          ...shoppingIntakeState.result,
          ...result,
          items: shoppingIntakeState.result.items,
        });
      }
      if (reconciliationState.result?.operation_id === operationId) {
        // reconciliation result is InventoryOperationResult
        reconciliationState.setResultAndClearDraft({
          result,
          familyId: family?.id ?? '',
          userId: user?.id ?? '',
        });
      }
      if (selectedOperationId === operationId) {
        try {
          const detail = await api.getInventoryOperation(operationId);
          setOperationDetail(detail);
        } catch {
          setOperationDetail((current) =>
            current && current.operation_id === operationId
              ? {
                  ...current,
                  ...result,
                  actor_display_name: current.actor_display_name,
                  lines: current.lines,
                }
              : current,
          );
        }
      }
      showNotice({
        tone: 'success',
        title: '已撤销本次操作',
        message: result.summary.description || '库存已回退到操作前状态。',
      });
    } catch (reason) {
      const message = messageFromApiError(reason, '撤销失败，请稍后重试');
      if (operationHistoryOpen) {
        setOperationHistoryConflict(message);
      } else {
        showNotice({ tone: 'danger', title: '无法撤销', message });
      }
      // Keep dialogs open on conflict/expired.
    }
  }

  function openShoppingIntake(args?: { selectedItemId?: string }) {
    shoppingIntakeState.openIntake({
      shoppingItems,
      ingredients,
      foods,
      inventoryStates,
      referenceDate: homeBusinessDateKey,
      selectedItemId: args?.selectedItemId,
    });
  }

  function resolveFreeTextLinkTarget(candidate: FreeTextLinkCandidate): FreeTextLinkTarget | null {
    if (candidate.kind === 'food') {
      const food = foods.find((item) => item.id === candidate.id);
      return food ? { kind: 'food', food } : null;
    }
    const ingredient = ingredients.find((item) => item.id === candidate.id);
    if (!ingredient) return null;
    const state = inventoryStates.find((item) => item.ingredient_id === ingredient.id) ?? null;
    return tracksIngredientQuantity(ingredient)
      ? { kind: 'exact_ingredient', ingredient, state }
      : { kind: 'presence_ingredient', ingredient, state };
  }

  const freeTextCandidatesByItemId = (() => {
    const draft = shoppingIntakeState.draft;
    if (!draft) return {} as Record<string, FreeTextLinkCandidate[]>;
    const map: Record<string, FreeTextLinkCandidate[]> = {};
    for (const item of draft.items) {
      if (item.kind !== 'free_text') continue;
      map[item.shoppingItemId] = suggestFreeTextLinkCandidates({
        title: item.title,
        ingredients,
        foods,
      });
    }
    return map;
  })();

  const freeTextLinkOptions = useMemo(
    () => buildFreeTextLinkOptions({ ingredients, foods }),
    [ingredients, foods],
  );

  const {
    overlayMode: familyOverlayMode,
    setOverlayMode: setFamilyOverlayMode,
    inviteForm,
    setInviteForm,
    profileForm,
    setProfileForm,
    memberEditForm,
    setMemberEditForm,
    passwordForm,
    setPasswordForm,
    familyForm,
    setFamilyForm,
    familyFormError,
    openMemberEdit,
    submitInvite,
    submitProfile,
    submitMemberEdit,
    submitPassword,
    submitFamily,
    isCreatingMember,
    isUpdatingProfile,
    isUpdatingMember,
    isUpdatingPassword,
    isUpdatingFamily,
    profileImageControls,
    familyImageControls,
  } = useFamilySettingsState({
    user,
    family,
    membershipRole: membership?.role,
    isOwner: membership?.role === 'Owner',
    showNotice,
  });

  const {
    openIngredientsCatalog,
    openIngredientDetail,
    openIngredientShopping,
    openIngredientPriority,
    openHomeRestock,
    closeHomeRestock,
    closeHomeMealDetail,
    updateHomeRestockForm,
    startRecommendedRecipe,
    startPlanRecipe: startPlanRecipeRaw,
  } = useAppHomeHandlers({
    ingredientNavigationRequestIdRef,
    setIngredientNavigationRequest,
    navigate: navigation.navigate,
    setHomeRestockShoppingItemId,
    setHomeRestockForm,
    setHomeMealDetailId,
    ingredients,
    openShoppingIntake,
    openIngredientShoppingDialog: openHomeIngredientShoppingDialog,
  });

  // Prefer latest foodPlanDetail.updated_at when cook originates from an open plan item.
  const startPlanRecipe = useCallback(
    (input: Parameters<typeof startPlanRecipeRaw>[0]) => {
      const latest =
        foodPlanDetail && foodPlanDetail.id === input.foodPlanItemId ? foodPlanDetail : null;
      startPlanRecipeRaw({
        ...input,
        planDate: latest?.plan_date ?? input.planDate,
        mealType: latest?.meal_type ?? input.mealType,
        planItemBaseUpdatedAt: latest?.updated_at ?? input.planItemBaseUpdatedAt,
      });
    },
    [foodPlanDetail, startPlanRecipeRaw],
  );

  // Plan-detail task (including global search) focuses the week after detail fetch.
  useEffect(() => {
    const task = navigation.state.eat.task;
    if (task?.kind !== 'plan-detail' || !foodPlanDetail) return;
    if (foodPlanDetail.id !== task.foodPlanItemId) return;
    setSelectedRecipePlanDate(foodPlanDetail.plan_date);
  }, [foodPlanDetail, navigation.state.eat.task]);

  if (!isAuthenticated) {
    return <LoginScreen />;
  }

  const isBootLoading = authLoading || (!hasBooted && isWorkspaceBootLoading);

  if (isBootLoading) {
    return (
      <AuthStatusScreen
        title="正在连接家庭厨房..."
        description="家庭数据加载中..."
      />
    );
  }

  const {
    homePlanDetailItem,
    homePlanDetailFood,
    homePlanAddFood,
    homePlanAddFoodOptions,
    currentUser,
    isOwner,
    inventoryAlerts,
    pendingShoppingCount,
    aiRecommendationCount,
    recentMeals,
    editingMember,
    headerName,
    sidebarRoleLabel,
    sidebarFamilyName,
    sidebarLocation,
    sidebarMotto,
    sidebarMemberLabel,
    sidebarActivityLabel,
    sidebarUserMeta,
    sidebarUserNote,
    today,
    homeEligibleInventoryActionGroups,
    homeInventoryActionGroups,
    homeInventoryActionCount,
    hasLaterInventoryActionGroups,
    hasFullListInventoryActionGroups,
    availableInventoryCount,
    activeFoodPlanItems,
    pendingShoppingPreview,
    todaysMeals,
    dashboardStats,
    dashboardRecommendationItems,
    desktopRecommendations,
    mobileRecommendations,
    dashboardWeekMealCapacity,
    dashboardPlanSummary,
    dashboardPlanDays,
    selectedDashboardPlanDay,
    selectedDashboardPlanDateLabel,
    homeRestockShoppingItem,
    homeMealDetail,
    homeMealDetailParticipants,
    homeRestockIngredient,
    homeRestockIngredientImageUrl,
    homeHighlightsViewModel,
    homeRequiredActions,
    hasMoreHomeActions,
  } = useAppHomeViewModel({
    user,
    membershipRole: membership?.role,
    family,
    members,
    memberEditMemberId: memberEditForm.memberId,
    ingredients,
    inventoryItems,
    inventoryStates,
    shoppingItems,
    recipes,
    foods,
    foodPlanItems,
    foodRecommendations,
    mealLogs,
    activityHighlights: {
      data: activityHighlightsQuery.data,
      isLoading: activityHighlightsQuery.isLoading,
      isError: activityHighlightsQuery.isError,
      isFetching: activityHighlightsQuery.isFetching,
    },
    desktopRecommendationCursor,
    mobileRecommendationCursor,
    selectedDashboardPlanDate,
    foodPlanWeekRange,
    homePlanDetailItemId,
    homePlanAddFoodId,
    homePlanAddFoodSearch,
    homeRestockShoppingItemId,
    homeMealDetailId,
    homeRestockForm,
    inventoryActionGroups: homePreparedActionGroups,
    resolveDashboardAssetUrl,
  });

  const familyActivityQuery = {
    data: activityLogsQuery.data,
    isLoading: activityLogsQuery.isLoading,
    isError: activityLogsQuery.isError,
    isFetching: activityLogsQuery.isFetching,
    refetch: () => {
      void activityLogsQuery.refetch();
    },
  };

  const {
    currentUserRecentLogs,
    familyOwnerMember,
    familyHeroImageUrl,
    familyStatCards,
    activityPhase: familyActivityPhase,
  } = useAppFamilyViewModel({
    activityQuery: familyActivityQuery,
    user,
    membership,
    family,
    members,
    shoppingItems,
    mealLogs,
    foods,
    recipes,
  });

  function retryHomeHighlights() {
    void activityHighlightsQuery.refetch();
  }

  function openFamilyActivity() {
    setFamilyOverlayMode('activity');
    navigation.navigate({ workspace: 'family' });
  }

  const selectedPlanSummary = selectedDashboardPlanDay
    ? `${selectedDashboardPlanDateLabel} · ${selectedDashboardPlanDay.totalCount} 项计划`
    : selectedDashboardPlanDateLabel;

  void homeInventoryActionCount;
  void availableInventoryCount;
  void completedIngredientId;

  const selectedActionGroup =
    homeEligibleInventoryActionGroups.find((group) => group.id === selectedActionGroupId) ?? null;
  const nextActionGroup =
    nextGroupId
      ? homeEligibleInventoryActionGroups.find((group) => group.id === nextGroupId) ?? null
      : null;
  const nextGroupLabel = nextActionGroup?.ingredientName ?? null;

  function handleOpenActionGroup(group: (typeof homeInventoryActionGroups)[number]) {
    openActionGroup(group.id);
  }

  function resolveDashboardAssetUrl(url?: string) {
    return resolveAssetUrl(url, { passthroughPrefixes: ['/images/'] });
  }

  void openIngredientsCatalog;
  void openIngredientDetail;
  void closeHomeRestock;
  void updateHomeRestockForm;
  void homeRestockShoppingItem;
  void homeRestockIngredient;
  void homeRestockIngredientImageUrl;

  function handleOpenNextActionGroup() {
    const group = openNextActionGroup();
    if (group?.kind === 'low_stock') {
      openIngredientShopping(group.ingredientId);
    }
  }

  async function refreshInventoryActions() {
    // Await canonical inventory (and shopping) refetch so completion/conflict branches
    // never compute next-item or surviving groups from stale React Query data.
    await invalidateAfterInventoryChanged(queryClient);
    await queryClient.invalidateQueries({ queryKey: queryKeys.shoppingList });
    const [freshInventory, freshStates, freshIngredients, freshShopping] = await Promise.all([
      queryClient.fetchQuery({
        queryKey: queryKeys.inventory,
        queryFn: () => api.getInventory(),
      }),
      queryClient.fetchQuery({
        queryKey: queryKeys.inventoryStates,
        queryFn: () => api.listInventoryStates(),
      }),
      queryClient.fetchQuery({
        queryKey: queryKeys.ingredients,
        queryFn: () => api.getIngredients(),
      }),
      queryClient.fetchQuery({
        queryKey: queryKeys.shoppingList,
        queryFn: () => api.getShoppingList(),
      }),
    ]);
    return selectHomeEligibleInventoryActionGroups(
      buildInventoryActionGroups({
        inventoryItems: freshInventory,
        inventoryStates: freshStates,
        ingredients: freshIngredients,
        shoppingItems: freshShopping,
        referenceDate: homeBusinessDateKey,
      }),
    );
  }

  const {
    startHomePlanDetailCook,
    disposeSelectedInventoryBatches,
    snoozeSelectedInventoryAlerts,
    correctSelectedInventoryExpiryDate,
    submitHomePlanDetail,
    deleteHomePlanDetail,
    submitHomePlanAdd,
  } = useHomeDashboardActions({
    showNotice,
    selectedActionGroup,
    homePlanDetailItem,
    homePlanDetailForm,
    homePlanAddFood,
    homePlanAddForm,
    disposeExpiredInventory: (payload) => disposeExpiredInventoryMutation.mutateAsync(payload),
    snoozeInventoryExpiryAlerts: (payload) => snoozeInventoryExpiryAlertsMutation.mutateAsync(payload),
    correctInventoryExpiryDate: (inventoryItemId, payload) =>
      correctInventoryExpiryDateMutation.mutateAsync({ inventoryItemId, payload }),
    snoozeStateExpiryAlert: (ingredientId, payload) => api.snoozeStateExpiryAlert(ingredientId, payload),
    correctStateExpiryDate: (ingredientId, payload) => api.correctStateExpiryDate(ingredientId, payload),
    setInventoryStateAbsent: (ingredientId, payload) => api.setInventoryStateAbsent(ingredientId, payload),
    refreshInventoryActions,
    completeActionGroup,
    closeActionGroup,
    setActionDialogBusy,
    setActionDialogError,
    setActionDialogConflict,
    updateFoodPlanItem: (itemId, payload) => updateFoodPlanItemMutation.mutateAsync({ itemId, payload }),
    deleteFoodPlanItem: (itemId) => deleteFoodPlanItemMutation.mutateAsync(itemId),
    createFoodPlanItem: (payload) => createFoodPlanItemMutation.mutateAsync(payload),
    quickAddMeal: (payload) => quickAddMealMutation.mutateAsync(payload),
    closeHomePlanDetail,
    closeHomePlanAddDialog,
    setIsHomePlanDetailEditing,
    startPlanRecipe,
    openMealLogEnrichment: setHomeMealEnrichmentRequest,
  });

  const homeMealEnrichmentMeal =
    homeMealEnrichmentRequest?.mealLog ??
    mealLogs.find((meal) => meal.id === homeMealEnrichmentRequest?.mealLogId) ??
    null;
  async function saveHomeMealEnrichment(meal: MealLog, payload: UpdateMealLogPayload) {
    const planItem = homeMealEnrichmentRequest?.planItem;
    if (!meal.id.startsWith('draft-') || !planItem) {
      await updateMealMutation.mutateAsync({ mealLogId: meal.id, payload });
      return;
    }

    const createdMeal = await quickAddMealMutation.mutateAsync({
      food_id: planItem.food_id,
      date: planItem.plan_date,
      meal_type: planItem.meal_type,
      servings: 1,
      note: planItem.note || '来自菜单计划',
      food_plan_item_id: planItem.id,
    });
    const foodEntryRatings = payload.food_entry_ratings?.map((rating, index) => {
      const draftEntry = meal.food_entries[index];
      const createdEntry =
        createdMeal.food_entries.find((entry) => draftEntry && entry.food_id === draftEntry.food_id && entry.note === draftEntry.note) ??
        createdMeal.food_entries[index];
      return createdEntry ? { id: createdEntry.id, rating: rating.rating } : null;
    }).filter((item): item is { id: string; rating: number | null } => item !== null);

    await updateMealMutation.mutateAsync({
      mealLogId: createdMeal.id,
      payload: {
        ...payload,
        ...(foodEntryRatings ? { food_entry_ratings: foodEntryRatings } : {}),
      },
    });
  }

  const noticeToast = notice ? (
    <div className={`recipe-notice-toast tone-${notice.tone}`} role={notice.tone === 'danger' ? 'alert' : 'status'} aria-live="polite">
      <span className="recipe-notice-icon" aria-hidden="true">
        {notice.tone === 'success' ? '✓' : '!'}
      </span>
      <span className="recipe-notice-copy">
        <strong>{notice.title}</strong>
        <small>{notice.message}</small>
      </span>
      <button type="button" onClick={clearNotice} aria-label="关闭提示">
        ×
      </button>
    </div>
  ) : null;
  const mobileNotificationCenter = (
    <AppNotificationCenter
      jobs={aiImageJobMonitor.jobs}
      isLoading={aiImageJobMonitor.isLoading}
      variant="mobileIcon"
      onDismissJob={aiImageJobMonitor.dismissJob}
      onRetryJob={aiImageJobMonitor.retryJob}
      retryingJobId={aiImageJobMonitor.retryingJobId}
    />
  );

  return (
    <AppShell
      activeTab={navigation.state.primaryTab}
      sidebarCollapsed={sidebarCollapsed}
      familyName={sidebarFamilyName}
      familyMotto={sidebarMotto}
      familyLocation={sidebarLocation}
      familyMemberLabel={sidebarMemberLabel}
      familyActivityLabel={sidebarActivityLabel}
      userName={headerName}
      userSeed={currentUser?.avatar_seed ?? headerName}
      userImageUrl={currentUser?.avatar_image?.url}
      userMeta={sidebarUserMeta}
      userNote={sidebarUserNote}
      notice={noticeToast}
      imageJobs={aiImageJobMonitor.jobs}
      imageJobsLoading={aiImageJobMonitor.isLoading}
      onDismissImageJob={aiImageJobMonitor.dismissJob}
      onRetryImageJob={aiImageJobMonitor.retryJob}
      retryingImageJobId={aiImageJobMonitor.retryingJobId}
      onTabChange={handlePrimaryTabChange}
      onToggleSidebar={() => setSidebarCollapsed((current) => !current)}
      onOpenProfile={() => setFamilyOverlayMode('profile')}
      onLogout={() => void logout()}
    >

          {navigation.state.primaryTab === 'home' && (
          <HomeDashboard
            sidebarFamilyName={sidebarFamilyName}
            sidebarMotto={sidebarMotto}
            sidebarLocation={sidebarLocation}
            sidebarMemberLabel={sidebarMemberLabel}
            sidebarActivityLabel={sidebarActivityLabel}
            inventoryAlerts={inventoryAlerts}
            notificationCenter={mobileNotificationCenter}
            dashboardStats={dashboardStats}
            desktopRecommendations={desktopRecommendations}
            mobileRecommendations={mobileRecommendations}
            recommendationCount={dashboardRecommendationItems.length}
            foodRecommendations={foodRecommendations}
            homeInventoryActionGroups={homeInventoryActionGroups}
            hasLaterInventoryActionGroups={hasLaterInventoryActionGroups}
            hasFullListInventoryActionGroups={hasFullListInventoryActionGroups}
            requiredActions={homeRequiredActions}
            hasMoreHomeActions={hasMoreHomeActions}
            activeFoodPlanItems={activeFoodPlanItems}
            foodPlanItems={foodPlanItems}
            dashboardWeekMealCapacity={dashboardWeekMealCapacity}
            dashboardPlanDays={dashboardPlanDays}
            compactPlanDays={dashboardPlanDays}
            selectedDashboardPlanDay={selectedDashboardPlanDay}
            selectedDashboardPlanDateLabel={selectedDashboardPlanDateLabel}
            selectedPlanSummary={selectedPlanSummary}
            pendingShoppingCount={pendingShoppingCount}
            pendingShoppingPreview={pendingShoppingPreview}
            dashboardPlanSummary={dashboardPlanSummary}
            foodPlanWeekRange={foodPlanWeekRange}
            homeHighlights={homeHighlightsViewModel}
            foods={foods}
            recipes={recipes}
            ingredients={ingredients}
            mealLogs={mealLogs}
            inventoryItems={inventoryItems}
            isQuickAdding={quickAddMealMutation.isPending}
            isCreatingFoodPlanItem={createFoodPlanItemMutation.isPending}
            resolveAssetUrl={resolveDashboardAssetUrl}
            quickAddMeal={(payload) => quickAddMealMutation.mutateAsync(payload)}
            createFoodPlanItem={(payload) => createFoodPlanItemMutation.mutateAsync(payload)}
            onNavigate={navigation.navigate}
            onOpenGlobalSearch={() => setGlobalSearchOpen(true)}
            onNextDesktopRecommendations={showNextDesktopRecommendations}
            onNextMobileRecommendation={showNextMobileRecommendation}
            onStartRecommendedRecipe={startRecommendedRecipe}
            onStartPlanRecipe={startPlanRecipe}
            onSelectedPlanDateChange={setSelectedDashboardPlanDate}
            onHomePlanAddDialogOpen={openHomePlanAddDialog}
            onHomePlanAddEmptyDialogOpen={openHomePlanAddEmptyDialog}
            onHomePlanDetailOpen={openHomePlanDetail}
            onHomeRestockOpen={openHomeRestock}
            onOpenActionGroup={handleOpenActionGroup}
            onOpenIngredientShopping={openIngredientShopping}
            onOpenIngredientPriority={openIngredientPriority}
            onOpenShoppingIntake={() => openShoppingIntake()}
            onOpenFamilyActivity={openFamilyActivity}
            onOpenFullWeek={openFoodPlanWeek}
            onRetryHighlights={retryHomeHighlights}
            onOpenReconciliation={openReconciliation}
            onFoodPlanPreviousWeek={() => setSelectedRecipePlanDate(addDateKeyDays(foodPlanWeekRange.start, -7))}
            onFoodPlanCurrentWeek={() => setSelectedRecipePlanDate(todayKey())}
            onFoodPlanNextWeek={() => setSelectedRecipePlanDate(addDateKeyDays(foodPlanWeekRange.end, 1))}
          />
        )}

        {navigation.state.primaryTab === 'eat' ? (
          <Suspense fallback={<WorkspaceLoadingFallback />}>
            <EatWorkspace
              navigation={navigation}
              resolvedTask={resolvedEatTask}
              completionPending={
                cookRecipeMutation.isPending
                || quickAddMealMutation.isPending
                || updateFoodPlanItemMutation.isPending
                || deleteFoodPlanItemMutation.isPending
              }
              cookResumePromptOpen={cookResumePromptOpen}
              {...buildEatTaskBodies({
                resolvedTask: resolvedEatTask,
                recipes,
                foods,
                ingredients,
                inventoryItems,
                mealLogs,
                foodPlanItems,
                members,
                sessionScope:
                  user?.id && membership?.family_id
                    ? { userId: user.id, familyId: membership.family_id }
                    : null,
                isQuickAdding: quickAddMealMutation.isPending,
                isUpdatingPlan:
                  createFoodPlanItemMutation.isPending
                  || updateFoodPlanItemMutation.isPending
                  || deleteFoodPlanItemMutation.isPending,
                isCookingRecipe: cookRecipeMutation.isPending,
                isCreatingShopping: createShoppingMutation.isPending,
                isSavingFood: updateFoodMutation.isPending,
                isUpdatingRecipe: updateRecipeMutation.isPending,
                isUpdatingMeal: updateMealMutation.isPending,
                cookRecipe: (recipeId, payload) =>
                  cookRecipeMutation.mutateAsync({ recipeId, payload }),
                previewCookRecipe: (recipeId, payload) =>
                  previewCookRecipeMutation.mutateAsync({ recipeId, payload }),
                updateFoodPlanItem: (itemId, payload) =>
                  updateFoodPlanItemMutation.mutateAsync({ itemId, payload }),
                deleteFoodPlanItem: (itemId) => deleteFoodPlanItemMutation.mutateAsync(itemId),
                createFoodPlanItem: (payload) => createFoodPlanItemMutation.mutateAsync(payload),
                updateFood: (foodId, payload) => updateFoodMutation.mutateAsync({ foodId, payload }),
                updateRecipe: (recipeId, payload) =>
                  updateRecipeMutation.mutateAsync({ recipeId, payload }),
                updateMealLog: (mealLogId, payload) =>
                  updateMealMutation.mutateAsync({ mealLogId, payload }),
                createShoppingItem: (payload) => createShoppingMutation.mutateAsync(payload),
                quickAddMeal: (payload) => quickAddMealMutation.mutateAsync(payload),
                onClose: navigation.closeTask,
                onOpenLogs: () => navigation.navigate({ workspace: 'eat', view: 'history' }),
                onNavigateRecipe: (recipeId, mode = 'view') =>
                  navigation.navigate({ workspace: 'eat', view: 'recipe', recipeId, mode }),
                onStartCook: startRecipeCook,
                onStartCookWithFood: startCookWithFood,
                onQuickAdd: (food, mealType) => {
                  navigation.navigate({
                    workspace: 'eat',
                    view: 'meal-create',
                    source: { kind: 'direct' },
                    foodId: food.id,
                    date: todayKey(),
                    mealType,
                  });
                },
                onCookCompleted: () => {
                  navigation.navigate({ workspace: 'eat', view: 'history' });
                },
                onViewMealLog: (mealLogId) => {
                  navigation.navigate({ workspace: 'eat', view: 'history', mealLogId });
                },
                onCookResumePromptChange: setCookResumePromptOpen,
              })}
              discoverContent={
                <FoodWorkspace
                  recipes={recipes}
                  ingredients={ingredients}
                  foods={foods}
                  inventoryItems={inventoryItems}
                  mealLogs={mealLogs}
                  members={members}
                  foodRecommendations={foodRecommendations}
                  foodScenes={foodScenes}
                  foodPlanItems={foodPlanItems}
                  foodPlanWeekRange={foodPlanWeekRange}
                  foodPlanNavigationRequest={foodPlanNavigationRequest}
                  isPhoneViewport={isPhoneViewport}
                  notificationCenter={mobileNotificationCenter}
                  createFood={(payload) => createFoodMutation.mutateAsync(payload)}
                  updateFood={(foodId, payload) => updateFoodMutation.mutateAsync({ foodId, payload })}
                  updateFoodFavorite={(foodId, favorite, expectedRowVersion) =>
                    toggleFavoriteMutation.mutateAsync({ foodId, favorite, expectedRowVersion })
                  }
                  createRecipe={(payload) => createRecipeMutation.mutateAsync(payload)}
                  updateRecipe={(recipeId, payload) => updateRecipeMutation.mutateAsync({ recipeId, payload })}
                  quickAddMeal={(payload) => quickAddMealMutation.mutateAsync(payload)}
                  updateMealLog={(mealLogId, payload) => updateMealMutation.mutateAsync({ mealLogId, payload })}
                  shoppingItems={shoppingItems}
                  createShoppingItem={(payload) => createShoppingMutation.mutateAsync(payload)}
                  updateShoppingItem={(itemId, payload) => updateShoppingMutation.mutateAsync({ itemId, payload })}
                  isCreatingShopping={createShoppingMutation.isPending}
                  createFoodPlanItem={(payload) => createFoodPlanItemMutation.mutateAsync(payload)}
                  updateFoodPlanItem={(itemId, payload) => updateFoodPlanItemMutation.mutateAsync({ itemId, payload })}
                  deleteFoodPlanItem={(itemId) => deleteFoodPlanItemMutation.mutateAsync(itemId)}
                  createFoodScene={(payload) => createFoodSceneMutation.mutateAsync(payload)}
                  updateFoodScene={(sceneId, payload) => updateFoodSceneMutation.mutateAsync({ sceneId, payload })}
                  deleteFoodScene={(sceneId) => deleteFoodSceneMutation.mutateAsync(sceneId)}
                  onStartRecipe={startRecipeCook}
                  navigate={navigation.navigate}
                  onOpenLogs={() => navigation.navigate({ workspace: 'eat', view: 'history' })}
                  onFoodPlanPreviousWeek={() => setSelectedRecipePlanDate(addDateKeyDays(foodPlanWeekRange.start, -7))}
                  onFoodPlanCurrentWeek={() => setSelectedRecipePlanDate(todayKey())}
                  onFoodPlanNextWeek={() => setSelectedRecipePlanDate(addDateKeyDays(foodPlanWeekRange.end, 1))}
                  isSavingFood={createFoodMutation.isPending || updateFoodMutation.isPending}
                  isCreatingRecipe={createRecipeMutation.isPending}
                  isUpdatingRecipe={updateRecipeMutation.isPending}
                  isUpdatingFavorite={toggleFavoriteMutation.isPending}
                  isQuickAdding={quickAddMealMutation.isPending}
                  isUpdatingPlan={createFoodPlanItemMutation.isPending || updateFoodPlanItemMutation.isPending || deleteFoodPlanItemMutation.isPending}
                  isUpdatingScene={createFoodSceneMutation.isPending || updateFoodSceneMutation.isPending || deleteFoodSceneMutation.isPending}
                  isUpdatingMeal={updateMealMutation.isPending}
                />
              }
              historyContent={
                <MealLogWorkspace
                  foodPlanItems={foodPlanItems}
                  members={members}
                  recentMeals={recentMeals}
                  foods={foods}
                  isUpdatingMeal={updateMealMutation.isPending}
                  notificationCenter={mobileNotificationCenter}
                  focusMealLogId={
                    resolvedEatTask.kind === 'meal' ? resolvedEatTask.mealLog.id : null
                  }
                  updateMealLog={(mealLogId, payload) => updateMealMutation.mutateAsync({ mealLogId, payload })}
                  onBackHome={() => navigation.navigate({ workspace: 'home' })}
                  onBackToEat={() => navigation.navigate({ workspace: 'eat', view: 'discover' })}
                />
              }
            />
          </Suspense>
        ) : null}

        {navigation.state.primaryTab === 'ingredients' && (
          <Suspense fallback={<WorkspaceLoadingFallback />}>
            <IngredientWorkspace
              ingredients={ingredients}
              foods={foods}
              inventoryItems={inventoryItems}
              inventoryStates={inventoryStates}
              shoppingItems={shoppingItems}
              recipes={recipes}
              openShoppingIntake={openShoppingIntake}
              openReconciliation={openReconciliation}
              openOperationHistory={openOperationHistory}
              operationBanner={
                recentBannerOperation ? (
                  <InventoryOperationBanner
                    operation={recentBannerOperation}
                    busy={revertInventoryOperationMutation.isPending}
                    onView={(operationId) => openOperationHistory(operationId)}
                    onRevert={(operationId) => {
                      void handleRevertInventoryOperation(operationId);
                    }}
                    onOpenHistory={() => openOperationHistory()}
                  />
                ) : null
              }
              notificationCenter={mobileNotificationCenter}
              navigationRequest={ingredientNavigationRequest}
              createIngredient={(payload) => createIngredientMutation.mutateAsync(payload)}
              updateIngredient={(ingredientId, payload) => updateIngredientMutation.mutateAsync({ ingredientId, payload })}
              transitionIngredientTrackingMode={(ingredientId, payload) => transitionIngredientTrackingModeMutation.mutateAsync({ ingredientId, payload })}
              createInventory={(payload) => createInventoryMutation.mutateAsync(payload)}
              upsertInventoryState={(ingredientId, payload) =>
                upsertInventoryStateMutation.mutateAsync({ ingredientId, payload })
              }
              consumeInventory={(payload) => consumeInventoryMutation.mutateAsync(payload)}
              disposeExpiredInventory={(payload) => disposeExpiredInventoryMutation.mutateAsync(payload)}
              snoozeInventoryExpiryAlerts={(payload) => snoozeInventoryExpiryAlertsMutation.mutateAsync(payload)}
              correctInventoryExpiryDate={(inventoryItemId, payload) =>
                correctInventoryExpiryDateMutation.mutateAsync({ inventoryItemId, payload })
              }
              createShoppingItem={(payload) => createShoppingMutation.mutateAsync(payload)}
              updateShoppingItem={(payload) => updateShoppingMutation.mutateAsync(payload)}
              deleteShoppingItem={(itemId, expectedRowVersion) =>
                deleteShoppingMutation.mutateAsync({ itemId, expectedRowVersion })
              }
              isCreatingIngredient={createIngredientMutation.isPending}
              isUpdatingIngredient={updateIngredientMutation.isPending}
              isCreatingInventory={createInventoryMutation.isPending || upsertInventoryStateMutation.isPending}
              isConsumingInventory={consumeInventoryMutation.isPending}
              isDisposingExpiredInventory={disposeExpiredInventoryMutation.isPending}
              isCreatingShopping={createShoppingMutation.isPending}
              isUpdatingShopping={updateShoppingMutation.isPending || deleteShoppingMutation.isPending}
            />
          </Suspense>
        )}

        {navigation.state.primaryTab === 'ai' && (
          <Suspense fallback={<WorkspaceLoadingFallback />}>
            <AiWorkspace
              conversations={aiConversations}
              isLoading={aiConversationsQuery.isLoading}
              currentUser={user}
              createFoodPlanItem={(payload) => createFoodPlanItemMutation.mutateAsync(payload)}
              isCreatingFoodPlanItem={createFoodPlanItemMutation.isPending}
              onBackHome={() => navigation.navigate({ workspace: 'home' })}
              onNavigate={navigation.navigate}
            />
          </Suspense>
        )}

        {navigation.state.primaryTab === 'family' && (
          <Suspense fallback={<WorkspaceLoadingFallback />}>
            <FamilySettings
              family={family}
              isLoading={familyQuery.isLoading}
              errorMessage={familyQuery.error instanceof Error ? familyQuery.error.message : null}
              members={members}
              currentUser={currentUser}
              membership={membership}
              isOwner={isOwner}
              familyHeroImageUrl={familyHeroImageUrl}
              familyStatCards={familyStatCards}
              currentUserRecentLogs={currentUserRecentLogs}
              familyOwnerMember={familyOwnerMember}
              activityQuery={familyActivityQuery}
              activityPhase={familyActivityPhase}
              isPhoneViewport={isPhoneViewport}
              notificationCenter={mobileNotificationCenter}
              overlayMode={familyOverlayMode}
              editingMember={editingMember}
              inviteForm={inviteForm}
              profileForm={profileForm}
              memberEditForm={memberEditForm}
              passwordForm={passwordForm}
              familyForm={familyForm}
              isCreatingMember={isCreatingMember}
              isUpdatingProfile={isUpdatingProfile}
              isUpdatingMember={isUpdatingMember}
              isUpdatingPassword={isUpdatingPassword}
              isUpdatingFamily={isUpdatingFamily}
              familyFormError={familyFormError}
              profileImageControls={profileImageControls}
              familyImageControls={familyImageControls}
              resolveAssetUrl={resolveDashboardAssetUrl}
              onOverlayChange={setFamilyOverlayMode}
              onNavigate={navigation.navigate}
              onMemberEdit={openMemberEdit}
              onInviteFormChange={setInviteForm}
              onProfileFormChange={setProfileForm}
              onMemberEditFormChange={setMemberEditForm}
              onPasswordFormChange={setPasswordForm}
              onFamilyFormChange={setFamilyForm}
              onInviteSubmit={submitInvite}
              onProfileSubmit={submitProfile}
              onMemberEditSubmit={submitMemberEdit}
              onPasswordSubmit={submitPassword}
              onFamilySubmit={submitFamily}
            />
          </Suspense>
        )}

        <GlobalSearchOverlay
          open={globalSearchOpen}
          onClose={() => setGlobalSearchOpen(false)}
          onSelect={handleGlobalSearchSelect}
        />

        <IngredientShoppingDialog
          open={homeShoppingDialogOpen}
          closeOverlay={() => {
            if (!createShoppingMutation.isPending) {
              setHomeShoppingDialogOpen(false);
            }
          }}
          ingredients={ingredients}
          foods={foods}
          shoppingForm={homeShoppingForm}
          setShoppingForm={setHomeShoppingForm}
          submitShopping={submitHomeShopping}
          isCreatingShopping={createShoppingMutation.isPending}
        />

        <Suspense fallback={null}>
          <HomeDashboardDialogs
            recipes={recipes}
            ingredients={ingredients}
            homePlanDetailItem={homePlanDetailItem}
            homePlanDetailFood={homePlanDetailFood}
            homePlanDetailForm={homePlanDetailForm}
            isHomePlanDetailEditing={isHomePlanDetailEditing}
            setHomePlanDetailForm={setHomePlanDetailForm}
            setIsHomePlanDetailEditing={setIsHomePlanDetailEditing}
            resetHomePlanDetailForm={resetHomePlanDetailForm}
            submitHomePlanDetail={submitHomePlanDetail}
            startHomePlanDetailCook={startHomePlanDetailCook}
            deleteHomePlanDetail={deleteHomePlanDetail}
            closeHomePlanDetail={closeHomePlanDetail}
            isUpdatingHomePlanDetail={updateFoodPlanItemMutation.isPending || deleteFoodPlanItemMutation.isPending}
            isCompletingHomePlanDetail={cookRecipeMutation.isPending || quickAddMealMutation.isPending}
            homeMealEnrichmentMeal={homeMealEnrichmentMeal}
            homeMealEnrichmentMembers={members}
            closeHomeMealEnrichment={() => setHomeMealEnrichmentRequest(null)}
            updateMealLog={(mealLogId, payload) => saveHomeMealEnrichment(homeMealEnrichmentMeal ?? { id: mealLogId } as MealLog, payload)}
            onInvalidMealEnrichmentSave={() => showNotice({ tone: 'warning', title: '还没有补充内容', message: '请先填写评分、家人、评论或照片，再保存这顿饭。' })}
            isUpdatingMeal={updateMealMutation.isPending || quickAddMealMutation.isPending}
            isHomePlanAddDialogOpen={isHomePlanAddDialogOpen}
            homePlanAddFood={homePlanAddFood}
            homePlanAddFoodSearch={homePlanAddFoodSearch}
            setHomePlanAddFoodSearch={setHomePlanAddFoodSearch}
            homePlanAddFoodOptions={homePlanAddFoodOptions}
            selectHomePlanAddFood={selectHomePlanAddFood}
            setHomePlanAddFoodId={setHomePlanAddFoodId}
            homePlanAddForm={homePlanAddForm}
            setHomePlanAddForm={setHomePlanAddForm}
            dashboardPlanDays={dashboardPlanDays}
            submitHomePlanAdd={submitHomePlanAdd}
            closeHomePlanAddDialog={closeHomePlanAddDialog}
            isCreatingFoodPlanItem={createFoodPlanItemMutation.isPending}
            homeMealDetail={homeMealDetail}
            homeMealDetailParticipants={homeMealDetailParticipants}
            closeHomeMealDetail={closeHomeMealDetail}
            selectedActionGroup={selectedActionGroup}
            businessDateKey={today}
            actionDialogBusy={actionDialogBusy}
            actionDialogError={actionDialogError}
            actionDialogConflict={actionDialogConflict}
            closeActionGroup={closeActionGroup}
            disposeSelectedInventoryBatches={disposeSelectedInventoryBatches}
            snoozeSelectedInventoryAlerts={snoozeSelectedInventoryAlerts}
            correctSelectedInventoryExpiryDate={correctSelectedInventoryExpiryDate}
            completionSummary={completionSummary}
            nextGroupId={nextGroupId}
            nextGroupLabel={nextGroupLabel}
            openNextActionGroup={handleOpenNextActionGroup}
            dismissCompletionSummary={dismissCompletionSummary}
            onCompletionSecondaryAction={openIngredientShopping}
            resolveAssetUrl={resolveDashboardAssetUrl}
          />
        </Suspense>

        <InventoryMaintenanceDialogs
          shoppingIntake={
            shoppingIntakeState.open
              ? {
                  open: shoppingIntakeState.open,
                  step: shoppingIntakeState.step,
                  draft: shoppingIntakeState.draft,
                  busy: shoppingIntakeState.busy || revertInventoryOperationMutation.isPending,
                  errorMessage: shoppingIntakeState.errorMessage,
                  fieldErrors: shoppingIntakeState.fieldErrors,
                  focusFieldKey: shoppingIntakeState.focusFieldKey,
                  conflictState: shoppingIntakeState.conflictState,
                  result: shoppingIntakeState.result,
                  expandedExceptionIds: shoppingIntakeState.expandedExceptionIds,
                  freeTextCandidatesByItemId,
                  freeTextLinkOptions,
                  onClose: () => {
                    if (shoppingIntakeState.result) {
                      setRecentBannerOverride(shoppingIntakeState.result);
                    }
                    shoppingIntakeState.closeIntake();
                  },
                  onGoReview: () => {
                    shoppingIntakeState.goToReview();
                  },
                  onGoSelect: shoppingIntakeState.goToSelect,
                  onToggleItem: shoppingIntakeState.toggleItemSelected,
                  onPatchItem: shoppingIntakeState.patchItem,
                  onCompleteFreeText: shoppingIntakeState.completeFreeText,
                  onLinkFreeText: (shoppingItemId, candidate) => {
                    const target = resolveFreeTextLinkTarget(candidate);
                    if (!target || !shoppingIntakeState.draft) return;
                    shoppingIntakeState.replaceDraft(
                      linkFreeTextDraft(
                        shoppingIntakeState.draft,
                        shoppingItemId,
                        target,
                        shoppingIntakeState.draft.purchaseDate,
                      ),
                    );
                  },
                  onToggleException: shoppingIntakeState.toggleExceptionExpanded,
                  onSubmit: () => {
                    void shoppingIntakeActions.submitDraft();
                  },
                  onRetry: () => {
                    void shoppingIntakeActions.retryLatest();
                  },
                  onRevertResult: (operationId) => {
                    void handleRevertInventoryOperation(operationId);
                  },
                  onViewResult: (operationId) => openOperationHistory(operationId),
                }
              : null
          }
          reconciliation={
            reconciliationState.open
              ? {
                  open: reconciliationState.open,
                  step: reconciliationState.step,
                  scope: reconciliationState.scope,
                  draft: reconciliationState.draft,
                  groups: reconciliationState.groups,
                  orderedGroups: reconciliationState.orderedGroups,
                  referenceDate: homeBusinessDateKey,
                  loading: reconciliationState.loading,
                  busy: reconciliationState.busy || revertInventoryOperationMutation.isPending,
                  errorMessage: reconciliationState.errorMessage,
                  fieldErrors: reconciliationState.fieldErrors,
                  focusFieldKey: reconciliationState.focusFieldKey,
                  conflictState: reconciliationState.conflictState,
                  result: reconciliationState.result,
                  summary: reconciliationState.summary,
                  checkedCount: reconciliationState.checkedCount,
                  totalCount: reconciliationState.totalCount,
                  canSubmit: reconciliationState.canSubmit,
                  expandedBatchGroupKeys: reconciliationState.expandedBatchGroupKeys,
                  onClose: () => {
                    if (reconciliationState.result) {
                      setRecentBannerOverride(reconciliationState.result);
                    }
                    reconciliationState.closeReconciliation({
                      familyId: family?.id ?? '',
                      userId: user?.id ?? '',
                      force: reconciliationState.loading,
                    });
                  },
                  onChangeScope: (scope) => {
                    void reconciliationActions.openReconciliation(
                      scope,
                      storageLocationForScope(scope),
                    );
                  },
                  onToggleBatchDetails: reconciliationState.toggleBatchDetails,
                  onSetIntent: (intent) => {
                    reconciliationState.setIntent(intent, new Date().toISOString());
                  },
                  onClearIntent: (targetKey) => {
                    reconciliationState.clearIntent(targetKey, new Date().toISOString());
                  },
                  onGoSummary: () => {
                    reconciliationState.goToSummary();
                  },
                  onGoReview: reconciliationState.goToReview,
                  onSubmit: () => {
                    void reconciliationActions.submitDraft();
                  },
                  onRetry: () => {
                    void reconciliationActions.retryLatest();
                  },
                  onRevertResult: (operationId) => {
                    void handleRevertInventoryOperation(operationId);
                  },
                  onViewResult: (operationId) => openOperationHistory(operationId),
                }
              : null
          }
          operationHistory={
            operationHistoryOpen
              ? {
                  open: operationHistoryOpen,
                  operations: inventoryOperations,
                  loading:
                    inventoryOperationsQuery.isLoading ||
                    (inventoryOperationsQuery.isFetching && !inventoryOperationsQuery.data),
                  busy: revertInventoryOperationMutation.isPending,
                  errorMessage:
                    operationHistoryError ??
                    queryErrorMessage(inventoryOperationsQuery.error, '读取操作历史失败'),
                  selectedOperationId,
                  detail: operationDetail,
                  detailLoading: operationDetailLoading,
                  detailError: operationDetailError,
                  conflictMessage: operationHistoryConflict,
                  initialOperationId: operationHistoryInitialId,
                  onClose: closeOperationHistory,
                  onSelectOperation: setSelectedOperationId,
                  onLoadDetail: (operationId) => {
                    void loadOperationDetail(operationId);
                  },
                  onRevert: (operationId) => {
                    void handleRevertInventoryOperation(operationId);
                  },
                  onRetry: () => {
                    void inventoryOperationsQuery.refetch();
                    if (selectedOperationId) {
                      void loadOperationDetail(selectedOperationId);
                    }
                  },
                }
              : null
          }
        />

    </AppShell>
  );
}

export default App;
