import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from './api/client';
import { isApiError } from './api/request';
import { invalidateAfterInventoryChanged, invalidateAfterInventoryOperation } from './api/cacheInvalidation';
import { queryKeys } from './api/queryKeys';
import { AppNotificationCenter, AppShell, type TabKey } from './app/AppShell';
import { useAppGlobalSearchNavigation } from './app/useAppGlobalSearchNavigation';
import { useAppHomeHandlers } from './app/useAppHomeHandlers';
import { useAppHomeViewModel } from './app/useAppHomeViewModel';
import { useAppMutations } from './app/useAppMutations';
import { useAppWorkspaceQueries } from './app/useAppWorkspaceQueries';
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
  FOOD_TYPE_LABELS,
  getFoodCover,
  todayKey,
} from './lib/ui';
import { MealLogWorkspace } from './features/meals/MealLogWorkspace';
import type { FamilyStatCard } from './features/family/FamilySettings';
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
  linkFreeTextDraft,
  suggestFreeTextLinkCandidates,
  type FreeTextLinkCandidate,
  type FreeTextLinkTarget,
} from './features/inventory/shoppingIntakeModel';
import { resolveMealSource } from './features/meals/MealLogEnrichmentModel';
import { useNotice } from './hooks/useNotice';
import { useAiImageJobMonitor } from './hooks/useAiImageJobMonitor';
import { resolveAssetUrl } from './lib/assets';
import { readStringStorage, writeStringStorage } from './lib/storage';
import { HomeDashboard } from './features/home/HomeDashboard';
import { GlobalSearchOverlay } from './features/search/GlobalSearchOverlay';

const AiWorkspace = lazy(() =>
  import('./components/ai/AiWorkspace').then((module) => ({ default: module.AiWorkspace }))
);
const FoodWorkspace = lazy(() =>
  import('./components/foods/FoodWorkspace').then((module) => ({ default: module.FoodWorkspace }))
);
const IngredientWorkspace = lazy(() =>
  import('./components/ingredients/IngredientWorkspace').then((module) => ({ default: module.IngredientWorkspace }))
);
const RecipeWorkspace = lazy(() =>
  import('./components/recipes/RecipeWorkspace').then((module) => ({ default: module.RecipeWorkspace }))
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
  const [selectedRecipePlanDate, setSelectedRecipePlanDate] = useState(todayKey());
  const foodPlanWeekRange = useMemo(() => getRecipeWeekRange(selectedRecipePlanDate), [selectedRecipePlanDate]);
  const [activeTab, setActiveTab] = useState<TabKey>(() => {
    const cached = readStringStorage('culina-active-tab', '');
    return (cached as TabKey) || 'home';
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(defaultSidebarCollapsed);
  const [hasBooted, setHasBooted] = useState(false);
  const [pendingRecipeCookId, setPendingRecipeCookId] = useState<string | null>(null);
  const [pendingFoodPlanCookItemId, setPendingFoodPlanCookItemId] = useState<string | null>(null);
  const [pendingRecipeCookReturnTarget, setPendingRecipeCookReturnTarget] = useState<TabKey | null>(null);
  const [homeMealEnrichmentRequest, setHomeMealEnrichmentRequest] = useState<HomeMealEnrichmentOpenRequest | null>(null);
  const { notice, showNotice, clearNotice } = useNotice();
  const queryClient = useQueryClient();
  const aiImageJobMonitor = useAiImageJobMonitor(isAuthenticated, { onNotice: showNotice });

  useEffect(() => {
    writeStringStorage('culina-active-tab', activeTab);
    resetPageScroll();
  }, [activeTab]);

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
    recipeDiscoveryQuery,
    recipeStatsQuery,
    recipeFavoritesQuery,
    foodPlanQuery,
    foodScenesQuery,
    foodsQuery,
    mealLogsQuery,
    activityLogsQuery,
    aiConversationsQuery,
    isBootLoading: isWorkspaceBootLoading,
    members,
    ingredients,
    inventoryItems,
    inventoryStates,
    shoppingItems,
    inventoryOperations,
    recipes,
    recipeDiscovery,
    recipeStats,
    recipeFavorites,
    foodPlanItems,
    foodScenes,
    foods,
    foodRecommendations,
    mealLogs,
    activityLogs,
    aiConversations,
    family,
  } = useAppWorkspaceQueries({
    activeTab,
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
    dashboardRecommendationPage,
    setDashboardRecommendationPage,
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
  });

  const {
    ingredientNavigationRequest,
    setIngredientNavigationRequest,
    ingredientNavigationRequestIdRef,
    foodNavigationRequest,
    setFoodNavigationRequest,
    foodNavigationRequestIdRef,
    foodPlanNavigationRequest,
    recipeNavigationRequest,
    globalSearchOpen,
    setGlobalSearchOpen,
    handleGlobalSearchSelect,
  } = useAppGlobalSearchNavigation({
    foods,
    isPhoneViewport,
    setActiveTab,
    setSelectedRecipePlanDate,
  });

  const handleTabChange = useCallback((tab: TabKey) => {
    setActiveTab(isPhoneViewport && tab === 'recipes' ? 'foods' : tab);
  }, [isPhoneViewport]);

  const handleMobileRecipeLibraryRedirect = useCallback(() => {
    setActiveTab('foods');
  }, []);

  const startRecipeCook = useCallback((recipeId: string, foodPlanItemId?: string) => {
    setPendingRecipeCookId(recipeId);
    setPendingFoodPlanCookItemId(foodPlanItemId ?? null);
    setPendingRecipeCookReturnTarget(activeTab);
    setActiveTab('recipes');
  }, [activeTab]);

  useEffect(() => {
    if (!authLoading && !isWorkspaceBootLoading) {
      setHasBooted(true);
    }
  }, [authLoading, isWorkspaceBootLoading]);

  const {
    createIngredientMutation,
    updateIngredientMutation,
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
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.shoppingList }),
        queryClient.invalidateQueries({ queryKey: queryKeys.inventory }),
        queryClient.invalidateQueries({ queryKey: queryKeys.inventoryStates }),
        queryClient.invalidateQueries({ queryKey: queryKeys.ingredients }),
        queryClient.invalidateQueries({ queryKey: queryKeys.foods }),
      ]);
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
      const message = isApiError(reason)
        ? reason.detail || '撤销失败，请稍后重试'
        : reason instanceof Error
          ? reason.message
          : '撤销失败，请稍后重试';
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
    currentUserRecentLogs,
    familyOwnerMember,
    editingMember,
    weekActivityCount,
    familyHeroImageUrl,
    familyStatCards,
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
    dashboardRecommendationPageCount,
    dashboardRecommendations,
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
    activityLogs,
    dashboardRecommendationPage,
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

  const {
    openIngredientsCatalog,
    openIngredientDetail,
    openIngredientShopping,
    openIngredientPriority,
    openHomeRestock,
    closeHomeRestock,
    closeHomeMealDetail,
    updateHomeRestockForm,
  } = useAppHomeHandlers({
    ingredientNavigationRequestIdRef,
    setIngredientNavigationRequest,
    setActiveTab,
    setHomeRestockShoppingItemId,
    setHomeRestockForm,
    setHomeMealDetailId,
    ingredients,
    openShoppingIntake,
  });
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
    supplementHomePlanDetailRecord,
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
    startRecipeCook,
    openMealLogEnrichment: setHomeMealEnrichmentRequest,
  });

  const homeMealEnrichmentMeal =
    homeMealEnrichmentRequest?.mealLog ??
    mealLogs.find((meal) => meal.id === homeMealEnrichmentRequest?.mealLogId) ??
    null;
  const homeMealEnrichmentPlanItems = homeMealEnrichmentRequest?.planItem
    ? [homeMealEnrichmentRequest.planItem, ...foodPlanItems.filter((item) => item.id !== homeMealEnrichmentRequest.planItem?.id)]
    : foodPlanItems;
  const homeMealEnrichmentSource = homeMealEnrichmentMeal
    ? homeMealEnrichmentRequest?.planItem
      ? { label: '来自菜单计划', status: 'planned' as const, planItem: homeMealEnrichmentRequest.planItem }
      : resolveMealSource(homeMealEnrichmentMeal, homeMealEnrichmentPlanItems)
    : null;

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
      activeTab={activeTab}
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
      onTabChange={handleTabChange}
      onToggleSidebar={() => setSidebarCollapsed((current) => !current)}
      onOpenProfile={() => setFamilyOverlayMode('profile')}
      onLogout={() => void logout()}
    >

          {activeTab === 'home' && (
          <HomeDashboard
            sidebarFamilyName={sidebarFamilyName}
            sidebarMotto={sidebarMotto}
            sidebarLocation={sidebarLocation}
            sidebarMemberLabel={sidebarMemberLabel}
            sidebarActivityLabel={sidebarActivityLabel}
            inventoryAlerts={inventoryAlerts}
            notificationCenter={mobileNotificationCenter}
            dashboardStats={dashboardStats}
            dashboardRecommendationItems={dashboardRecommendationItems}
            dashboardRecommendationPageCount={dashboardRecommendationPageCount}
            dashboardRecommendations={dashboardRecommendations}
            foodRecommendations={foodRecommendations}
            homeInventoryActionGroups={homeInventoryActionGroups}
            hasLaterInventoryActionGroups={hasLaterInventoryActionGroups}
            hasFullListInventoryActionGroups={hasFullListInventoryActionGroups}
            activeFoodPlanItems={activeFoodPlanItems}
            foodPlanItems={foodPlanItems}
            dashboardWeekMealCapacity={dashboardWeekMealCapacity}
            dashboardPlanDays={dashboardPlanDays}
            selectedDashboardPlanDay={selectedDashboardPlanDay}
            selectedDashboardPlanDateLabel={selectedDashboardPlanDateLabel}
            pendingShoppingCount={pendingShoppingCount}
            pendingShoppingPreview={pendingShoppingPreview}
            dashboardPlanSummary={dashboardPlanSummary}
            foodPlanWeekRange={foodPlanWeekRange}
            foods={foods}
            recipes={recipes}
            ingredients={ingredients}
            members={members}
            mealLogs={mealLogs}
            inventoryItems={inventoryItems}
            activityLogs={activityLogs}
            recentMeals={recentMeals}
            isQuickAdding={quickAddMealMutation.isPending}
            isCreatingFoodPlanItem={createFoodPlanItemMutation.isPending}
            resolveAssetUrl={resolveDashboardAssetUrl}
            quickAddMeal={(payload) => quickAddMealMutation.mutateAsync(payload)}
            createFoodPlanItem={(payload) => createFoodPlanItemMutation.mutateAsync(payload)}
            onNavigate={handleTabChange}
            onOpenGlobalSearch={() => setGlobalSearchOpen(true)}
            onRecommendationPageChange={setDashboardRecommendationPage}
            onStartRecipe={startRecipeCook}
            onSelectedPlanDateChange={setSelectedDashboardPlanDate}
            onHomePlanAddDialogOpen={openHomePlanAddDialog}
            onHomePlanAddEmptyDialogOpen={openHomePlanAddEmptyDialog}
            onHomePlanDetailOpen={openHomePlanDetail}
            onHomeRestockOpen={openHomeRestock}
            onOpenActionGroup={handleOpenActionGroup}
            onOpenIngredientShopping={openIngredientShopping}
            onOpenIngredientPriority={openIngredientPriority}
            onFoodPlanPreviousWeek={() => setSelectedRecipePlanDate(addDateKeyDays(foodPlanWeekRange.start, -7))}
            onFoodPlanCurrentWeek={() => setSelectedRecipePlanDate(todayKey())}
            onFoodPlanNextWeek={() => setSelectedRecipePlanDate(addDateKeyDays(foodPlanWeekRange.end, 1))}
          />
        )}

        {activeTab === 'foods' && (
          <Suspense fallback={<WorkspaceLoadingFallback />}>
            <FoodWorkspace
              recipes={recipes}
              ingredients={ingredients}
              foods={foods}
              inventoryItems={inventoryItems}
              mealLogs={mealLogs}
              foodRecommendations={foodRecommendations}
              foodScenes={foodScenes}
              foodPlanItems={foodPlanItems}
              foodPlanWeekRange={foodPlanWeekRange}
              notificationCenter={mobileNotificationCenter}
              navigationRequest={foodNavigationRequest}
              foodPlanNavigationRequest={foodPlanNavigationRequest}
              createFood={(payload) => createFoodMutation.mutateAsync(payload)}
              updateFood={(foodId, payload) => updateFoodMutation.mutateAsync({ foodId, payload })}
              updateFoodFavorite={(foodId, favorite) => toggleFavoriteMutation.mutateAsync({ foodId, favorite })}
              createRecipe={(payload) => createRecipeMutation.mutateAsync(payload)}
              updateRecipe={(recipeId, payload) => updateRecipeMutation.mutateAsync({ recipeId, payload })}
              quickAddMeal={(payload) => quickAddMealMutation.mutateAsync(payload)}
              createShoppingItem={(payload) => createShoppingMutation.mutateAsync(payload)}
              createFoodPlanItem={(payload) => createFoodPlanItemMutation.mutateAsync(payload)}
              updateFoodPlanItem={(itemId, payload) => updateFoodPlanItemMutation.mutateAsync({ itemId, payload })}
              deleteFoodPlanItem={(itemId) => deleteFoodPlanItemMutation.mutateAsync(itemId)}
              createFoodScene={(payload) => createFoodSceneMutation.mutateAsync(payload)}
              updateFoodScene={(sceneId, payload) => updateFoodSceneMutation.mutateAsync({ sceneId, payload })}
              deleteFoodScene={(sceneId) => deleteFoodSceneMutation.mutateAsync(sceneId)}
              onStartRecipe={startRecipeCook}
              onOpenLogs={() => setActiveTab('logs')}
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
            />
          </Suspense>
        )}

        {activeTab === 'recipes' && (
          <Suspense fallback={<WorkspaceLoadingFallback />}>
            <main className="page-stack">
              <RecipeWorkspace
                recipes={recipes}
                ingredients={ingredients}
                inventoryItems={inventoryItems}
                mealLogs={mealLogs}
                foods={foods}
                shoppingItems={shoppingItems}
                recipeFavorites={recipeFavorites}
                recipeDiscovery={recipeDiscovery}
                recipeStats={recipeStats}
                recipePlanItems={[]}
                recipeScenes={foodScenes}
                recipePlanWeekRange={foodPlanWeekRange}
                startRecipeId={pendingRecipeCookId}
                startFoodPlanItemId={pendingFoodPlanCookItemId}
                startRecipeReturnTarget={
                  pendingRecipeCookReturnTarget === 'home' ||
                  pendingRecipeCookReturnTarget === 'foods' ||
                  pendingRecipeCookReturnTarget === 'recipes'
                    ? pendingRecipeCookReturnTarget
                    : null
                }
                navigationRequest={recipeNavigationRequest}
                notificationCenter={mobileNotificationCenter}
                onMobileLibraryRedirect={isPhoneViewport ? handleMobileRecipeLibraryRedirect : undefined}
                onStartRecipeHandled={() => {
                  setPendingRecipeCookId(null);
                  setPendingFoodPlanCookItemId(null);
                  setPendingRecipeCookReturnTarget(null);
                }}
                onCookReturnToSource={(target) => {
                  setPendingRecipeCookId(null);
                  setPendingFoodPlanCookItemId(null);
                  setPendingRecipeCookReturnTarget(null);
                  setActiveTab(target);
                }}
                onRecipePlanPreviousWeek={() => setSelectedRecipePlanDate(addDateKeyDays(foodPlanWeekRange.start, -7))}
                onRecipePlanCurrentWeek={() => setSelectedRecipePlanDate(todayKey())}
                onRecipePlanNextWeek={() => setSelectedRecipePlanDate(addDateKeyDays(foodPlanWeekRange.end, 1))}
                createIngredient={(payload) => createIngredientMutation.mutateAsync(payload)}
                createRecipe={(payload) => createRecipeMutation.mutateAsync(payload)}
                updateRecipe={(recipeId, payload) => updateRecipeMutation.mutateAsync({ recipeId, payload })}
                deleteRecipe={(recipeId) => deleteRecipeMutation.mutateAsync(recipeId)}
                cookRecipe={(recipeId, payload) => cookRecipeMutation.mutateAsync({ recipeId, payload })}
                previewCookRecipe={(recipeId, payload) => previewCookRecipeMutation.mutateAsync({ recipeId, payload })}
                generateRecipeDraft={(payload) => api.generateRecipeDraft(payload)}
                createShoppingItem={(payload) => createShoppingMutation.mutateAsync(payload)}
                addRecipeFavorite={(recipeId) => addRecipeFavoriteMutation.mutateAsync(recipeId)}
                removeRecipeFavorite={(recipeId) => removeRecipeFavoriteMutation.mutateAsync(recipeId)}
                createRecipePlanItem={async () => {
                  throw new Error('菜单计划已迁移到食物页');
                }}
                updateRecipePlanItem={async () => {
                  throw new Error('菜单计划已迁移到食物页');
                }}
                deleteRecipePlanItem={async () => {
                  throw new Error('菜单计划已迁移到食物页');
                }}
                createRecipeScene={(payload) => createFoodSceneMutation.mutateAsync(payload)}
                updateRecipeScene={(sceneId, payload) => updateFoodSceneMutation.mutateAsync({ sceneId, payload })}
                deleteRecipeScene={(sceneId) => deleteFoodSceneMutation.mutateAsync(sceneId)}
                isCreatingRecipe={createRecipeMutation.isPending}
                isUpdatingRecipe={updateRecipeMutation.isPending}
                isDeletingRecipe={deleteRecipeMutation.isPending}
                isCreatingIngredient={createIngredientMutation.isPending}
                isCookingRecipe={cookRecipeMutation.isPending}
                isCreatingShopping={createShoppingMutation.isPending}
                isUpdatingFavorite={addRecipeFavoriteMutation.isPending || removeRecipeFavoriteMutation.isPending}
                isUpdatingPlan={
                  createFoodPlanItemMutation.isPending ||
                  updateFoodPlanItemMutation.isPending ||
                  deleteFoodPlanItemMutation.isPending
                }
                isUpdatingScene={
                  createFoodSceneMutation.isPending ||
                  updateFoodSceneMutation.isPending ||
                  deleteFoodSceneMutation.isPending
                }
              />
            </main>
          </Suspense>
        )}

        {activeTab === 'ingredients' && (
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
              deleteShoppingItem={(itemId) => deleteShoppingMutation.mutateAsync(itemId)}
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

        {activeTab === 'logs' && (
          <MealLogWorkspace
            foodPlanItems={foodPlanItems}
            members={members}
            recentMeals={recentMeals}
            isUpdatingMeal={updateMealMutation.isPending}
            notificationCenter={mobileNotificationCenter}
            updateMealLog={(mealLogId, payload) => updateMealMutation.mutateAsync({ mealLogId, payload })}
            onBackHome={() => setActiveTab('home')}
          />
        )}

        {activeTab === 'ai' && (
          <Suspense fallback={<WorkspaceLoadingFallback />}>
            <AiWorkspace
              conversations={aiConversations}
              isLoading={aiConversationsQuery.isLoading}
              currentUser={user}
              createFoodPlanItem={(payload) => createFoodPlanItemMutation.mutateAsync(payload)}
              isCreatingFoodPlanItem={createFoodPlanItemMutation.isPending}
              onBackHome={() => setActiveTab('home')}
            />
          </Suspense>
        )}

        {activeTab === 'family' && (
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
              activityLogs={activityLogs}
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
              onNavigate={handleTabChange}
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
            supplementHomePlanDetailRecord={supplementHomePlanDetailRecord}
            deleteHomePlanDetail={deleteHomePlanDetail}
            closeHomePlanDetail={closeHomePlanDetail}
            isUpdatingHomePlanDetail={updateFoodPlanItemMutation.isPending || deleteFoodPlanItemMutation.isPending}
            isCompletingHomePlanDetail={cookRecipeMutation.isPending || quickAddMealMutation.isPending}
            isSupplementingHomePlanDetail={quickAddMealMutation.isPending}
            homeMealEnrichmentMeal={homeMealEnrichmentMeal}
            homeMealEnrichmentSource={homeMealEnrichmentSource}
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
                  loading: false,
                  busy: revertInventoryOperationMutation.isPending,
                  errorMessage: operationHistoryError,
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
