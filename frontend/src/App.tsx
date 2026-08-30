import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { AppShell } from './app/AppShell';
import { type PrimaryTabKey } from './app/appNavigationModel';
import { useAppGlobalSearchNavigation } from './app/useAppGlobalSearchNavigation';
import { useAppHomeHandlers } from './app/useAppHomeHandlers';
import { useAppFamilyViewModel } from './app/useAppFamilyViewModel';
import { useAppHomeViewModel } from './app/useAppHomeViewModel';
import { useAppMutations } from './app/useAppMutations';
import { useAppNavigationState } from './app/useAppNavigationState';
import { useAppWorkspaceQueries } from './app/useAppWorkspaceQueries';
import { useAppNavigationEffects } from './app/useAppNavigationEffects';
import { useAppHomeShoppingState } from './app/useAppHomeController';
import { useAppInventoryOperationHistory } from './app/useAppInventoryOperations';
import { useAppInventoryRevert } from './app/useAppInventoryRevert';
import { AppWorkspaceRouter, WorkspaceRouteBoundary } from './app/AppWorkspaceRouter';
import { AppAiWorkspaceRoute } from './app/AppAiWorkspaceRoute';
import { AppFoodWorkspaceRoute } from './app/AppFoodWorkspaceRoute';
import { AppIngredientWorkspaceRoute } from './app/AppIngredientWorkspaceRoute';
import { AppHomeWorkspaceRoute } from './app/AppHomeWorkspaceRoute';
import { AppEatWorkspaceRoute } from './app/AppEatWorkspaceRoute';
import { AppMealLogWorkspaceRoute } from './app/AppMealLogWorkspaceRoute';
import { AppFamilyWorkspaceRoute } from './app/AppFamilyWorkspaceRoute';
import { AppOverlayHost } from './app/AppOverlayHost';
import type { InventoryOperationResult, MealLog, UpdateMealLogPayload } from './api/types';
import { useAuth } from './auth/AuthContext';
import { AuthStatusScreen, LoginScreen } from './components/LoginScreen';
import { getWeekRange } from './lib/date';
import { businessDateKey } from './lib/date';
import {
  buildInventoryActionGroups,
  selectHomeEligibleInventoryActionGroups,
} from './features/inventory/inventoryActionModel';
import {
  todayKey,
} from './lib/ui';
import { useMealRecordResultState } from './features/meals/useMealRecordResultState';
import { useMealCandidateLoader } from './features/meals/useMealCandidateLoader';
import { useFamilySettingsState } from './features/family/useFamilySettingsState';
import { useHomeDashboardState } from './features/home/useHomeDashboardState';
import { useHomeDashboardActions } from './features/home/useHomeDashboardActions';
import type { HomeMealEnrichmentOpenRequest } from './features/home/useHomeDashboardActions';
import {
  InventoryOperationBanner,
  selectRecentBannerOperationWithOverride,
} from './features/inventory/InventoryOperationBanner';
import { useReconciliationController } from './features/inventory/useReconciliationController';
import { useInventoryOperationLoaders } from './features/inventory/useInventoryOperationLoaders';
import { useInventoryRefreshSources } from './features/inventory/useInventoryRefreshSources';
import { useShoppingIntakeController } from './features/inventory/useShoppingIntakeController';
import { useNotice } from './hooks/useNotice';
import { useAiImageJobMonitor } from './hooks/useAiImageJobMonitor';
import { useAppNotifications } from './hooks/useAppNotifications';
import { resolveAssetUrl } from './lib/assets';
import { resolveShoppingFormSubmission } from './components/ingredients/shoppingFormSubmission';
import { messageFromApiError, queryErrorMessage } from './app/appErrorModel';
import { useAppShellLayoutState } from './app/useAppShellLayoutState';
import { primaryTabToTarget } from './app/appRouteModel';
import { useAppCookNavigation } from './app/useAppCookNavigation';
import { useAppHomeInventoryActions } from './app/useAppHomeInventoryActions';
import { useAppPlanRecipeNavigation } from './app/useAppPlanRecipeNavigation';
import { useAppFoodPlanWeekNavigation } from './app/useAppFoodPlanWeekNavigation';
import { useAppInventoryMaintenanceDialogProps } from './app/useAppInventoryMaintenanceDialogProps';
import { useAppHomeDashboardDialogProps } from './app/useAppHomeDashboardDialogProps';
import { useAppOverlayComposition } from './app/useAppOverlayComposition';
import { useAppEatTaskBodyArgs } from './app/useAppEatTaskBodyArgs';
import { useAppEatTaskResolutionArgs } from './app/useAppEatTaskResolutionArgs';
import { AppWorkspaceRouteComposition } from './app/AppWorkspaceRouteComposition';
function App() {
  const {
    isAuthenticated,
    isInitializing: authInitializing,
    isLoading: authLoading,
    user,
    membership,
    logout,
  } = useAuth();
  const { isPhoneViewport, sidebarCollapsed, setSidebarCollapsed } = useAppShellLayoutState();
  const navigation = useAppNavigationState();
  const [selectedRecipePlanDate, setSelectedRecipePlanDate] = useState(todayKey());
  const foodPlanWeekRange = useMemo(() => getWeekRange(selectedRecipePlanDate), [selectedRecipePlanDate]);
  const [hasBooted, setHasBooted] = useState(false);
  const [homeMealEnrichmentRequest, setHomeMealEnrichmentRequest] = useState<HomeMealEnrichmentOpenRequest | null>(null);
  const [cookResumePromptOpen, setCookResumePromptOpen] = useState(false);
  const { notice, showNotice, clearNotice } = useNotice();
  const aiImageJobMonitor = useAiImageJobMonitor(isAuthenticated, { onNotice: showNotice });
  useAppNavigationEffects({
    primaryTab: navigation.state.primaryTab,
    eatBaseView: navigation.state.eat.baseView,
    taskKind: navigation.state.eat.task?.kind,
    familyView: navigation.state.family.view,
  });
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
    mealInsightsQuery,
    activityLogsQuery,
    activityHighlightsQuery,
    aiConversationsQuery,
    activeMealRecordOperations,
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
    mealInsights,
    aiConversations,
    family,
  } = useAppWorkspaceQueries({
    navigationState: navigation.state,
    isAuthenticated,
    foodPlanWeekRange,
  });
  const appNotifications = useAppNotifications({
    enabled: isAuthenticated,
    familyId: family?.id ?? '',
    role: membership?.role ?? 'Member',
    background: aiImageJobMonitor,
    onOpenModelUsageAlert: (alert) => {
      navigation.navigate({ workspace: 'family', view: 'modelUsage', period: alert.period });
    },
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
    consumeIngredientNavigationRequest,
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
  const foodPlanWeekNavigation = useAppFoodPlanWeekNavigation({
    weekRange: foodPlanWeekRange,
    today: todayKey(),
    setSelectedDate: setSelectedRecipePlanDate,
  });
  const { startRecipeCook, startCookWithFood } = useAppCookNavigation({
    foods,
    recipes,
    foodPlanItems,
    foodPlanDetail,
    navigate: navigation.navigate,
  });
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
    snoozeStateExpiryAlertMutation,
    correctStateExpiryDateMutation,
    setInventoryStateAbsentMutation,
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
    recordMealMutation,
    updateMealCompositionMutation,
    revertMealRecordMutation,
    completeFoodPlanItemMutation,
  } = useAppMutations();

  const mealRecordResultState = useMealRecordResultState({
    activeOperations: activeMealRecordOperations,
    foods,
    revertOperation: (operationId) => revertMealRecordMutation.mutateAsync(operationId),
    rateMeal: (mealLogId, payload) =>
      updateMealMutation.mutateAsync({ mealLogId, payload }),
    onViewMeal: (mealLogId) => {
      navigation.navigate({ workspace: 'eat', view: 'history', mealLogId });
    },
  });

  // Stable identity so compact record effects do not re-fetch/reset target on every App render.
  const loadMealCandidates = useMealCandidateLoader();
  const { fetchReconciliation, getOperationDetail } = useInventoryOperationLoaders();
  const inventoryRefreshSources = useInventoryRefreshSources();

  const shoppingIntakeState = useShoppingIntakeController({
    shoppingItems,
    ingredients,
    foods,
    inventoryStates,
    referenceDate: homeBusinessDateKey,
    submitShoppingIntake: (payload) => submitShoppingIntakeMutation.mutateAsync(payload),
    invalidateAfterInventoryOperation: inventoryRefreshSources.invalidateOperation,
    showNotice,
    refreshSources: inventoryRefreshSources.refreshSources,
  });

  const reconciliationController = useReconciliationController({
    familyId: family?.id ?? '',
    userId: user?.id ?? '',
    referenceDate: homeBusinessDateKey,
    fetchReconciliation,
    submitReconciliation: (payload) => submitInventoryReconciliationMutation.mutateAsync(payload),
    invalidateAfterInventoryOperation: inventoryRefreshSources.invalidateOperation,
    showNotice,
  });
  const { state: reconciliationState, actions: reconciliationActions } = reconciliationController;

  const homeShoppingState = useAppHomeShoppingState({
    ingredients,
    foods,
    createShopping: (payload) => createShoppingMutation.mutateAsync(payload as never),
  });
  const openHomeIngredientShoppingDialog = useCallback(
    (ingredientId: string) => homeShoppingState.openForIngredient(ingredientId, showNotice),
    [homeShoppingState, showNotice],
  );
  const submitHomeShopping = useCallback(
    (event: FormEvent<HTMLFormElement>) => homeShoppingState.submit(event, showNotice),
    [homeShoppingState, showNotice],
  );

  function openReconciliation(args?: { scope?: 'suggested' | 'refrigerated' | 'frozen' | 'room_temperature' | 'all' }) {
    const scope = args?.scope ?? 'suggested';
    reconciliationController.openForScope(scope);
  }

  const [recentBannerOverride, setRecentBannerOverride] = useState<InventoryOperationResult | null>(null);

  const operationHistory = useAppInventoryOperationHistory({
    getDetail: getOperationDetail,
    errorMessage: (reason) => messageFromApiError(reason, '加载变更详情失败'),
    isRevertPending: revertInventoryOperationMutation.isPending,
  });

  const recentBannerOperation = useMemo(() => {
    return selectRecentBannerOperationWithOverride(inventoryOperations, recentBannerOverride, Date.now());
  }, [inventoryOperations, recentBannerOverride]);

  const openOperationHistory = operationHistory.openHistory;
  const closeOperationHistory = operationHistory.closeHistory;
  const loadOperationDetail = operationHistory.loadDetail;

  const handleRevertInventoryOperation = useAppInventoryRevert({
    mutate: (operationId) => revertInventoryOperationMutation.mutateAsync(operationId),
    operationHistory,
    shoppingResult: shoppingIntakeState.result,
    setShoppingResult: shoppingIntakeState.setResult,
    reconciliationResult: reconciliationState.result,
    setReconciliationResult: (result, familyId, userId) => reconciliationState.setResultAndClearDraft({ result, familyId, userId }),
    familyId: family?.id ?? '',
    userId: user?.id ?? '',
    getDetail: getOperationDetail,
    setRecentBannerOverride,
    showNotice,
    errorMessage: messageFromApiError,
  });

  const openShoppingIntake = (args?: { selectedItemId?: string }) => shoppingIntakeState.openShoppingIntake(args?.selectedItemId);

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
    openIngredientCreate,
    openIngredientDetail,
    openIngredientShopping,
    openIngredientPriority,
    openHomeRestock,
    closeHomeRestock,
    closeHomeMealDetail,
    updateHomeRestockForm,
    startRecommendedRecipe,
    startPlanRecipe: startPlanRecipeRaw,
    openFamilyActivity,
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
    setFamilyOverlayMode,
  });

  // Prefer latest foodPlanDetail.updated_at when cook originates from an open plan item.
  const startPlanRecipe = useAppPlanRecipeNavigation({
    foodPlanDetail,
    startPlanRecipe: startPlanRecipeRaw,
  });

  // Plan-detail task (including global search) focuses the week after detail fetch.
  useEffect(() => {
    const task = navigation.state.eat.task;
    if (task?.kind !== 'plan-detail' || !foodPlanDetail) return;
    if (foodPlanDetail.id !== task.foodPlanItemId) return;
    setSelectedRecipePlanDate(foodPlanDetail.plan_date);
  }, [foodPlanDetail, navigation.state.eat.task]);

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
    hasLaterInventoryActionGroups,
    hasFullListInventoryActionGroups,
    activeFoodPlanItems,
    pendingShoppingPreview,
    todaysMeals,
    dashboardStats,
    dashboardRecommendationItems,
    desktopRecommendations,
    mobileRecommendations,
    dashboardPlanDays,
    selectedDashboardPlanDay,
    selectedDashboardPlanDateLabel,
    homeMealDetail,
    homeMealDetailParticipants,
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
    weekHighlightCount: activityHighlightsQuery.data?.week_highlight_count,
    businessDateKey: homeBusinessDateKey,
  });

  function retryHomeHighlights() {
    void activityHighlightsQuery.refetch();
  }

  const selectedPlanSummary = selectedDashboardPlanDay
    ? `${selectedDashboardPlanDateLabel} · ${selectedDashboardPlanDay.totalCount} 项餐食安排`
    : selectedDashboardPlanDateLabel;


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


  function handleOpenNextActionGroup() {
    const group = openNextActionGroup();
    if (group?.kind === 'low_stock') {
      openIngredientShopping(group.ingredientId);
    }
  }

  const refreshInventoryActions = useAppHomeInventoryActions({
    sources: inventoryRefreshSources,
    referenceDate: homeBusinessDateKey,
  });

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
    snoozeStateExpiryAlert: (ingredientId, payload) =>
      snoozeStateExpiryAlertMutation.mutateAsync({ ingredientId, payload }),
    correctStateExpiryDate: (ingredientId, payload) =>
      correctStateExpiryDateMutation.mutateAsync({ ingredientId, payload }),
    setInventoryStateAbsent: (ingredientId, payload) =>
      setInventoryStateAbsentMutation.mutateAsync({ ingredientId, payload }),
    refreshInventoryActions,
    completeActionGroup,
    closeActionGroup,
    setActionDialogBusy,
    setActionDialogError,
    setActionDialogConflict,
    updateFoodPlanItem: (itemId, payload) => updateFoodPlanItemMutation.mutateAsync({ itemId, payload }),
    deleteFoodPlanItem: (itemId) => deleteFoodPlanItemMutation.mutateAsync(itemId),
    createFoodPlanItem: (payload) => createFoodPlanItemMutation.mutateAsync(payload),
    completeFoodPlanItem: (itemId, payload) =>
      completeFoodPlanItemMutation.mutateAsync({ itemId, payload }),
    closeHomePlanDetail,
    closeHomePlanAddDialog,
    setIsHomePlanDetailEditing,
    startPlanRecipe,
    openMealLogEnrichment: setHomeMealEnrichmentRequest,
    // Plan complete must never publish ordinary record undo.
    publishRecordResult: undefined,
  });

  const homeMealEnrichmentMeal =
    homeMealEnrichmentRequest?.mealLog ??
    mealLogs.find((meal) => meal.id === homeMealEnrichmentRequest?.mealLogId) ??
    null;
  async function saveHomeMealEnrichment(meal: MealLog, payload: UpdateMealLogPayload) {
    // Plan complete already creates the meal via completeFoodPlanItem; enrichment only patches it.
    await updateMealMutation.mutateAsync({ mealLogId: meal.id, payload });
  }

  const {
    noticeToast,
    mobileNotificationCenter,
    appOverlayState,
  } = useAppOverlayComposition({
    notice,
    clearNotice,
    appNotifications,
    aiImageJobMonitor,
    globalSearchOpen,
    homeShoppingOpen: homeShoppingState.open,
    inventoryMaintenanceOpen: shoppingIntakeState.open || reconciliationState.open || operationHistory.open,
    inventoryBusy: shoppingIntakeState.busy || reconciliationState.busy || revertInventoryOperationMutation.isPending,
  });

  const inventoryMaintenanceDialogProps = useAppInventoryMaintenanceDialogProps({
    shoppingIntakeState,
    reconciliationController,
    operationHistory,
    inventoryOperations,
    inventoryOperationsQuery: {
      isLoading: inventoryOperationsQuery.isLoading,
      isFetching: inventoryOperationsQuery.isFetching,
      data: inventoryOperationsQuery.data,
      error: inventoryOperationsQuery.error,
      refetch: () => inventoryOperationsQuery.refetch(),
    },
    referenceDate: homeBusinessDateKey,
    familyId: family?.id ?? '',
    userId: user?.id ?? '',
    isRevertPending: revertInventoryOperationMutation.isPending,
    setRecentBannerOverride,
    handleRevertInventoryOperation,
    openOperationHistory,
    closeOperationHistory,
    loadOperationDetail,
  });

  const homeDashboardDialogProps = useAppHomeDashboardDialogProps({
    recipes: recipes,
    ingredients: ingredients,
    homePlanDetailItem: homePlanDetailItem,
    homePlanDetailFood: homePlanDetailFood,
    homePlanDetailForm: homePlanDetailForm,
    isHomePlanDetailEditing: isHomePlanDetailEditing,
    setHomePlanDetailForm: setHomePlanDetailForm,
    setIsHomePlanDetailEditing: setIsHomePlanDetailEditing,
    resetHomePlanDetailForm: resetHomePlanDetailForm,
    submitHomePlanDetail: submitHomePlanDetail,
    startHomePlanDetailCook: startHomePlanDetailCook,
    deleteHomePlanDetail: deleteHomePlanDetail,
    closeHomePlanDetail: closeHomePlanDetail,
    updateFoodPlanItemPending: updateFoodPlanItemMutation.isPending,
    deleteFoodPlanItemPending: deleteFoodPlanItemMutation.isPending,
    cookRecipePending: cookRecipeMutation.isPending,
    completeFoodPlanItemPending: completeFoodPlanItemMutation.isPending,
    homeMealEnrichmentMeal: homeMealEnrichmentMeal,
    homeMealEnrichmentMembers: members,
    foodPlanItems: foodPlanItems,
    foods: foods,
    recordMeal: (payload) => recordMealMutation.mutateAsync(payload),
    revertMealRecord: (operationId) => revertMealRecordMutation.mutateAsync(operationId),
    setHomeMealEnrichmentRequest,
    saveHomeMealEnrichment,
    showNotice,
    updateMealPending: updateMealMutation.isPending,
    isHomePlanAddDialogOpen: isHomePlanAddDialogOpen,
    homePlanAddFood: homePlanAddFood,
    homePlanAddFoodSearch: homePlanAddFoodSearch,
    setHomePlanAddFoodSearch: setHomePlanAddFoodSearch,
    homePlanAddFoodOptions: homePlanAddFoodOptions,
    selectHomePlanAddFood: selectHomePlanAddFood,
    setHomePlanAddFoodId: setHomePlanAddFoodId,
    homePlanAddForm: homePlanAddForm,
    setHomePlanAddForm: setHomePlanAddForm,
    dashboardPlanDays: dashboardPlanDays,
    submitHomePlanAdd: submitHomePlanAdd,
    closeHomePlanAddDialog: closeHomePlanAddDialog,
    createFoodPlanItemPending: createFoodPlanItemMutation.isPending,
    homeMealDetail: homeMealDetail,
    homeMealDetailParticipants: homeMealDetailParticipants,
    closeHomeMealDetail: closeHomeMealDetail,
    selectedActionGroup: selectedActionGroup,
    businessDateKey: today,
    actionDialogBusy: actionDialogBusy,
    actionDialogError: actionDialogError,
    actionDialogConflict: actionDialogConflict,
    closeActionGroup: closeActionGroup,
    disposeSelectedInventoryBatches: disposeSelectedInventoryBatches,
    snoozeSelectedInventoryAlerts: snoozeSelectedInventoryAlerts,
    correctSelectedInventoryExpiryDate: correctSelectedInventoryExpiryDate,
    completionSummary: completionSummary,
    nextGroupId: nextGroupId,
    nextGroupLabel: nextGroupLabel,
    openNextActionGroup: handleOpenNextActionGroup,
    dismissCompletionSummary: dismissCompletionSummary,
    onCompletionSecondaryAction: openIngredientShopping,
    resolveAssetUrl: resolveDashboardAssetUrl,
  });

  if (authInitializing) {
    return (
      <AuthStatusScreen
        title="正在连接家庭厨房…"
        description="正在恢复登录状态…"
      />
    );
  }

  if (!isAuthenticated) {
    return <LoginScreen />;
  }

  const isBootLoading = authLoading || (!hasBooted && isWorkspaceBootLoading);
  if (isBootLoading) {
    return (
      <AuthStatusScreen
        title="正在连接家庭厨房…"
        description="家庭数据加载中…"
      />
    );
  }

  const routeContext = { navigation, recipes, foods, ingredients, inventoryItems, mealLogs, foodPlanItems, members, foodPlanDetail, foodPlanDetailQuery, recipesQuery, foodsQuery, mealLogsQuery, mealLogsFetching: mealLogsQuery.isFetching, mealRecordResultState, cookRecipeMutation, recordMealMutation, completeFoodPlanItemMutation, updateFoodPlanItemMutation, deleteFoodPlanItemMutation, createFoodPlanItemMutation, createShoppingMutation, updateFoodMutation, updateRecipeMutation, createFoodMutation, toggleFavoriteMutation, createRecipeMutation, updateMealMutation, foodScenes, foodPlanWeekRange, foodPlanNavigationRequest, isPhoneViewport, mobileNotificationCenter, inventoryAlerts, dashboardStats, desktopRecommendations, mobileRecommendations, dashboardRecommendationItems, homeInventoryActionGroups, hasLaterInventoryActionGroups, hasFullListInventoryActionGroups, homeRequiredActions, hasMoreHomeActions, activeFoodPlanItems, foodRecommendations, pendingShoppingCount, pendingShoppingPreview, homeHighlightsViewModel, selectedDashboardPlanDay, selectedDashboardPlanDateLabel, selectedPlanSummary, homeBusinessDateKey, recordMeal: (payload: any) => recordMealMutation.mutateAsync(payload), loadMealCandidates, showNextDesktopRecommendations, showNextMobileRecommendation, startRecommendedRecipe, startPlanRecipe, setSelectedDashboardPlanDate, openHomePlanAddDialog, openHomePlanAddEmptyDialog, openHomePlanDetail, openHomeRestock, handleOpenActionGroup, openIngredientShopping, openIngredientCreate, openIngredientPriority, openShoppingIntake, openFamilyActivity, openFoodPlanWeek, retryHomeHighlights, openReconciliation, foodPlanWeekNavigation, startRecipeCook, startCookWithFood, setCookResumePromptOpen, cookResumePromptOpen, user, membership, family, familyQuery, familyQueryError: familyQuery.error, currentUser, familyHeroImageUrl, familyStatCards, currentUserRecentLogs, familyOwnerMember, familyActivityQuery, familyActivityPhase, isOwner, editingMember, familyOverlayMode, inviteForm, profileForm, memberEditForm, passwordForm, familyForm, isCreatingMember, isUpdatingProfile, isUpdatingMember, isUpdatingPassword, isUpdatingFamily, familyFormError, profileImageControls, familyImageControls, sidebarFamilyName, sidebarMotto, sidebarLocation, sidebarMemberLabel, sidebarActivityLabel, resolveDashboardAssetUrl, setFamilyOverlayMode, setInviteForm, setProfileForm, setMemberEditForm, setPasswordForm, setFamilyForm, openMemberEdit, submitInvite, submitProfile, submitMemberEdit, submitPassword, submitFamily, globalSearchOpen, setGlobalSearchOpen, handleGlobalSearchSelect };
  Object.assign(routeContext, { inventoryStates, shoppingItems, recentMeals, mealInsights, mealInsightsQuery, aiConversations, aiConversationsQuery, dashboardPlanDays, previewCookRecipeMutation, businessDateKey, updateShoppingMutation, createFoodSceneMutation, updateFoodSceneMutation, deleteFoodSceneMutation, updateMealCompositionMutation, openOperationHistory, recentBannerOperation, handleRevertInventoryOperation, ingredientNavigationRequest, consumeIngredientNavigationRequest, createIngredientMutation, updateIngredientMutation, transitionIngredientTrackingModeMutation, createInventoryMutation, upsertInventoryStateMutation, consumeInventoryMutation, disposeExpiredInventoryMutation, snoozeInventoryExpiryAlertsMutation, correctInventoryExpiryDateMutation, deleteShoppingMutation });
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
      notifications={appNotifications.items}
      notificationsLoading={appNotifications.isLoading}
      onDismissBackgroundTask={aiImageJobMonitor.dismissJob}
      onRetryBackgroundTask={aiImageJobMonitor.retryJob}
      retryingBackgroundTaskId={aiImageJobMonitor.retryingJobId}
      onOpenModelUsageAlert={appNotifications.openModelUsageAlert}
      onDismissModelUsageAlert={appNotifications.dismissModelUsageAlert}
      onTabChange={handlePrimaryTabChange}
      onToggleSidebar={() => setSidebarCollapsed((current) => !current)}
      onOpenProfile={() => setFamilyOverlayMode('profile')}
      onLogout={() => {
        void logout().catch((reason) => {
          showNotice({
            tone: 'danger',
            title: '退出失败',
            message: reason instanceof Error ? reason.message : '暂时无法退出，请稍后重试。',
          });
        });
      }}
    >
      {/* routes={{...}} is owned by AppWorkspaceRouteComposition. */}
      <AppWorkspaceRouteComposition context={routeContext} />

      <AppOverlayHost
          state={appOverlayState}
          global={{
            search: {
              open: globalSearchOpen,
              onClose: () => setGlobalSearchOpen(false),
              onSelect: handleGlobalSearchSelect,
            },
            shopping: {
              open: homeShoppingState.open,
              closeOverlay: () => {
                if (!createShoppingMutation.isPending) homeShoppingState.setOpen(false);
              },
              ingredients,
              foods,
              shoppingForm: homeShoppingState.form,
              setShoppingForm: homeShoppingState.setForm,
              submitShopping: submitHomeShopping,
              isCreatingShopping: createShoppingMutation.isPending,
            },
          }}
          home={homeDashboardDialogProps}
          inventory={inventoryMaintenanceDialogProps}
      />
    </AppShell>
  );
}

export default App;
