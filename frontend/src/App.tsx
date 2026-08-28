import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from './api/client';
import { invalidateAfterInventoryChanged, invalidateAfterInventoryOperation } from './api/cacheInvalidation';
import { queryKeys } from './api/queryKeys';
import { AppNotificationCenter, AppShell } from './app/AppShell';
import { type PrimaryTabKey } from './app/appNavigationModel';
import { useAppGlobalSearchNavigation } from './app/useAppGlobalSearchNavigation';
import { useAppHomeHandlers } from './app/useAppHomeHandlers';
import { useAppFamilyViewModel } from './app/useAppFamilyViewModel';
import { useAppHomeViewModel } from './app/useAppHomeViewModel';
import { useAppMutations } from './app/useAppMutations';
import { useAppNavigationState } from './app/useAppNavigationState';
import { useAppWorkspaceQueries } from './app/useAppWorkspaceQueries';
import { useAppNavigationEffects } from './app/useAppNavigationEffects';
import { useAppHomeController } from './app/useAppHomeController';
import { useAppInventoryOperationHistory } from './app/useAppInventoryOperations';
import { AppWorkspaceRouter } from './app/AppWorkspaceRouter';
import { AppOverlayHost } from './app/AppOverlayHost';
import { AppGlobalOverlays } from './app/AppGlobalOverlays';
import type { AppOverlayState } from './app/appOverlayState';
import {
  relatedSelfMadeFoods,
  buildCookLaunchContext,
  resolveEatTask,
} from './features/eat/EatWorkspaceViewModel';
import type {
  InventoryOperationDetail,
  InventoryOperationResult,
  MealLog,
  MealType,
  UpdateMealLogPayload,
} from './api/types';
import { useAuth } from './auth/AuthContext';
import { AuthStatusScreen, LoginScreen } from './components/LoginScreen';
import { addDateKeyDays, getWeekRange } from './lib/date';
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
import { useMealRecordResultState } from './features/meals/useMealRecordResultState';
import { useFamilySettingsState } from './features/family/useFamilySettingsState';
import { useHomeDashboardState } from './features/home/useHomeDashboardState';
import { useHomeDashboardActions } from './features/home/useHomeDashboardActions';
import { refreshHomeInventoryActions } from './features/home/useHomeInventoryRefresh';
import type { HomeMealEnrichmentOpenRequest } from './features/home/useHomeDashboardActions';
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
import { useAppNotifications } from './hooks/useAppNotifications';
import { resolveAssetUrl } from './lib/assets';
import {
  buildShoppingForm,
  type ShoppingDialogFormState,
} from './components/ingredients/ingredientWorkspaceForms';
import { resolveShoppingFormSubmission } from './components/ingredients/shoppingFormSubmission';
import { messageFromApiError, queryErrorMessage } from './app/appErrorModel';
import { useAppShellLayoutState } from './app/useAppShellLayoutState';
import { primaryTabToTarget, querySettleStatus } from './app/appRouteModel';
import { AppFamilyWorkspace } from './app/AppFamilyWorkspace';

const AiWorkspace = lazy(() =>
  import('./components/ai/AiWorkspace').then((module) => ({ default: module.AiWorkspace }))
);
const EatWorkspace = lazy(() =>
  import('./features/eat/EatWorkspace').then((module) => ({ default: module.EatWorkspace }))
);
const HomeDashboard = lazy(() =>
  import('./features/home/HomeDashboard').then((module) => ({ default: module.HomeDashboard }))
);
const MealLogWorkspace = lazy(() =>
  import('./features/meals/MealLogWorkspace').then((module) => ({ default: module.MealLogWorkspace }))
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
const InventoryMaintenanceDialogs = lazy(() =>
  import('./features/inventory/InventoryMaintenanceDialogs').then((module) => ({
    default: module.InventoryMaintenanceDialogs,
  }))
);
function WorkspaceLoadingFallback() {
  return (
    <main className="page-stack">
      <section className="card page-section">
        <EmptyState title="正在准备家庭厨房" description="页面内容正在加载，请稍候。" />
      </section>
    </main>
  );
}

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
  const [homeShoppingDialogOpen, setHomeShoppingDialogOpen] = useState(false);
  const [homeShoppingForm, setHomeShoppingForm] = useState<ShoppingDialogFormState>(() => buildShoppingForm());
  const [cookResumePromptOpen, setCookResumePromptOpen] = useState(false);
  const { notice, showNotice, clearNotice } = useNotice();
  const queryClient = useQueryClient();
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
        date: businessDateKey(new Date(), 'Asia/Shanghai'),
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
  const loadMealCandidates = useCallback(
    (date: string, mealType: MealType) => api.getMealCandidates(date, mealType),
    [],
  );

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

  const homeShoppingController = useAppHomeController({
    ingredients,
    foods,
    form: homeShoppingForm,
    setOpen: setHomeShoppingDialogOpen,
    setForm: setHomeShoppingForm,
    createShopping: (payload) => createShoppingMutation.mutateAsync(payload as never),
  });
  const openHomeIngredientShoppingDialog = useCallback(
    (ingredientId: string) => homeShoppingController.openForIngredient(ingredientId, showNotice),
    [homeShoppingController, showNotice],
  );
  const submitHomeShopping = useCallback(
    (event: FormEvent<HTMLFormElement>) => homeShoppingController.submit(event, showNotice),
    [homeShoppingController, showNotice],
  );

  function openReconciliation(args?: { scope?: 'suggested' | 'refrigerated' | 'frozen' | 'room_temperature' | 'all' }) {
    const scope = args?.scope ?? 'suggested';
    void reconciliationActions.openReconciliation(scope, storageLocationForScope(scope));
  }

  const [recentBannerOverride, setRecentBannerOverride] = useState<InventoryOperationResult | null>(null);

  const operationHistory = useAppInventoryOperationHistory({
    getDetail: api.getInventoryOperation,
    errorMessage: (reason) => messageFromApiError(reason, '加载变更详情失败'),
    isRevertPending: revertInventoryOperationMutation.isPending,
  });

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

  const openOperationHistory = operationHistory.openHistory;
  const closeOperationHistory = operationHistory.closeHistory;
  const loadOperationDetail = operationHistory.loadDetail;

  async function handleRevertInventoryOperation(operationId: string) {
    operationHistory.setConflict(null);
    operationHistory.setError(null);
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
      if (operationHistory.selectedOperationId === operationId) {
        try {
          const detail = await api.getInventoryOperation(operationId);
          operationHistory.setDetail(detail);
        } catch {
          operationHistory.setDetail((current) =>
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
        title: '已撤销本次变更',
        message: result.summary.description || '库存已恢复到变更前状态。',
      });
    } catch (reason) {
      const message = messageFromApiError(reason, '撤销失败，请稍后重试');
      if (operationHistory.open) {
        operationHistory.setConflict(message);
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
    weekHighlightCount: activityHighlightsQuery.data?.week_highlight_count,
    businessDateKey: homeBusinessDateKey,
  });

  function retryHomeHighlights() {
    void activityHighlightsQuery.refetch();
  }

  function openFamilyActivity() {
    setFamilyOverlayMode('activity');
    navigation.navigate({ workspace: 'family' });
  }

  const selectedPlanSummary = selectedDashboardPlanDay
    ? `${selectedDashboardPlanDateLabel} · ${selectedDashboardPlanDay.totalCount} 项餐食安排`
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
    return refreshHomeInventoryActions({
      invalidateChanged: () => invalidateAfterInventoryChanged(queryClient),
      invalidateShopping: () => queryClient.invalidateQueries({ queryKey: queryKeys.shoppingList }),
      fetchInventory: () => queryClient.fetchQuery({ queryKey: queryKeys.inventory, queryFn: () => api.getInventory() }),
      fetchStates: () => queryClient.fetchQuery({ queryKey: queryKeys.inventoryStates, queryFn: () => api.listInventoryStates() }),
      fetchIngredients: () => queryClient.fetchQuery({ queryKey: queryKeys.ingredients, queryFn: () => api.getIngredients() }),
      fetchShopping: () => queryClient.fetchQuery({ queryKey: queryKeys.shoppingList, queryFn: () => api.getShoppingList() }),
      referenceDate: homeBusinessDateKey,
    });
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
      items={appNotifications.items}
      isLoading={appNotifications.isLoading}
      variant="mobileIcon"
      onDismissBackgroundTask={aiImageJobMonitor.dismissJob}
      onRetryBackgroundTask={aiImageJobMonitor.retryJob}
      retryingBackgroundTaskId={aiImageJobMonitor.retryingJobId}
      onOpenModelUsageAlert={appNotifications.openModelUsageAlert}
      onDismissModelUsageAlert={appNotifications.dismissModelUsageAlert}
    />
  );
  const appOverlayState: AppOverlayState = globalSearchOpen
    ? { kind: 'global-search' }
    : homeShoppingDialogOpen
      ? { kind: 'ingredient-shopping', ingredientId: 'home' }
      : shoppingIntakeState.open || reconciliationState.open || operationHistory.open
        ? { kind: 'inventory-maintenance', busy: shoppingIntakeState.busy || reconciliationState.busy || revertInventoryOperationMutation.isPending }
        : { kind: 'none' };

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
      <AppWorkspaceRouter navigationState={navigation.state}>

          {navigation.state.primaryTab === 'home' && (
          <Suspense fallback={<WorkspaceLoadingFallback />}>
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
            dashboardPlanDays={dashboardPlanDays}
            compactPlanDays={dashboardPlanDays}
            selectedDashboardPlanDay={selectedDashboardPlanDay}
            selectedDashboardPlanDateLabel={selectedDashboardPlanDateLabel}
            selectedPlanSummary={selectedPlanSummary}
            pendingShoppingCount={pendingShoppingCount}
            pendingShoppingPreview={pendingShoppingPreview}
            foodPlanWeekRange={foodPlanWeekRange}
            homeHighlights={homeHighlightsViewModel}
            foods={foods}
            recipes={recipes}
            ingredients={ingredients}
            mealLogs={mealLogs}
            inventoryItems={inventoryItems}
            isQuickAdding={recordMealMutation.isPending}
            isCreatingFoodPlanItem={createFoodPlanItemMutation.isPending}
            resolveAssetUrl={resolveDashboardAssetUrl}
            businessDateKey={homeBusinessDateKey}
            recordMeal={(payload) => recordMealMutation.mutateAsync(payload)}
            loadMealCandidates={loadMealCandidates}
            onRecordSuccess={(response) => mealRecordResultState.publishRecordResult(response)}
            recordResult={mealRecordResultState.result}
            isRevertingRecord={mealRecordResultState.isReverting}
            recordRevertError={mealRecordResultState.revertError}
            recordRateError={mealRecordResultState.rateError}
            onRevertRecord={() => void mealRecordResultState.revert()}
            onViewRecord={() => mealRecordResultState.viewMeal()}
            onRateRecord={(rating) => void mealRecordResultState.rate(rating)}
            onDismissRecord={() => mealRecordResultState.dismiss()}
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
            onOpenIngredientCreate={openIngredientCreate}
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
          </Suspense>
        )}

        {navigation.state.primaryTab === 'eat' ? (
          <Suspense fallback={<WorkspaceLoadingFallback />}>
            <EatWorkspace
              navigation={navigation}
              resolvedTask={resolvedEatTask}
              completionPending={
                cookRecipeMutation.isPending
                || recordMealMutation.isPending
                || completeFoodPlanItemMutation.isPending
                || updateFoodPlanItemMutation.isPending
                || deleteFoodPlanItemMutation.isPending
              }
              cookResumePromptOpen={cookResumePromptOpen}
              taskBodyArgs={{
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
                isRecordingMeal: recordMealMutation.isPending,
                isCompletingPlan: completeFoodPlanItemMutation.isPending,
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
                recordMeal: (payload) => recordMealMutation.mutateAsync(payload),
                completeFoodPlanItem: (itemId, payload) =>
                  completeFoodPlanItemMutation.mutateAsync({ itemId, payload }),
                onRecordSuccess: (response) => mealRecordResultState.publishRecordResult(response),
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
                    date: businessDateKey(new Date(), 'Asia/Shanghai'),
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
              }}
              discoverContent={
                <FoodWorkspace
                  recipes={recipes}
                  ingredients={ingredients}
                  foods={foods}
                  inventoryItems={inventoryItems}
                  mealLogs={mealLogs}
                  members={members}
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
                  recordMeal={(payload) => recordMealMutation.mutateAsync(payload)}
                  loadMealCandidates={loadMealCandidates}
                  onRecordSuccess={(response) => mealRecordResultState.publishRecordResult(response)}
                  recordResult={mealRecordResultState.result}
                  isRevertingRecord={mealRecordResultState.isReverting}
                  recordRevertError={mealRecordResultState.revertError}
                  recordRateError={mealRecordResultState.rateError}
                  onRevertRecord={() => void mealRecordResultState.revert()}
                  onViewRecord={() => mealRecordResultState.viewMeal()}
                  onRateRecord={(rating) => void mealRecordResultState.rate(rating)}
                  onDismissRecord={() => mealRecordResultState.dismiss()}
                  completeFoodPlanItem={(itemId, payload) =>
                    completeFoodPlanItemMutation.mutateAsync({ itemId, payload })
                  }
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
                  isQuickAdding={recordMealMutation.isPending}
                  isCompletingPlan={completeFoodPlanItemMutation.isPending}
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
                  mealInsights={mealInsights}
                  mealInsightsStatus={
                    mealInsightsQuery.isError
                      ? 'error'
                      : mealInsightsQuery.isLoading || mealInsightsQuery.isPending
                        ? 'loading'
                        : mealInsightsQuery.isSuccess
                          ? 'success'
                          : 'idle'
                  }
                  onRetryMealInsights={() => {
                    void mealInsightsQuery.refetch();
                  }}
                  isUpdatingMeal={updateMealMutation.isPending}
                  notificationCenter={mobileNotificationCenter}
                  focusMealLogId={
                    resolvedEatTask.kind === 'meal' ? resolvedEatTask.mealLog.id : null
                  }
                  updateMealLog={(mealLogId, payload) => updateMealMutation.mutateAsync({ mealLogId, payload })}
                  onBackHome={() => navigation.navigate({ workspace: 'home' })}
                  onBackToEat={() => navigation.navigate({ workspace: 'eat', view: 'discover' })}
                  onRecordMeal={() =>
                    navigation.navigate({
                      workspace: 'eat',
                      view: 'meal-create',
                      source: { kind: 'direct' },
                      date: businessDateKey(new Date(), 'Asia/Shanghai'),
                      mealType: 'dinner',
                    })
                  }
                  recordResult={mealRecordResultState.result}
                  isRevertingRecord={mealRecordResultState.isReverting}
                  recordRevertError={mealRecordResultState.revertError}
                  recordRateError={mealRecordResultState.rateError}
                  onRevertRecord={() => void mealRecordResultState.revert()}
                  onViewRecord={() => mealRecordResultState.viewMeal()}
                  onRateRecord={(rating) => void mealRecordResultState.rate(rating)}
                  onDismissRecord={() => mealRecordResultState.dismiss()}
                  updateMealComposition={(mealLogId, payload) =>
                    updateMealCompositionMutation.mutateAsync({ mealLogId, payload })
                  }
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
              recordMeal={(payload) => recordMealMutation.mutateAsync(payload)}
              loadMealCandidates={loadMealCandidates}
              onRecordSuccess={(response) => mealRecordResultState.publishRecordResult(response)}
              recordResult={mealRecordResultState.result}
              isRevertingRecord={mealRecordResultState.isReverting}
              recordRevertError={mealRecordResultState.revertError}
              recordRateError={mealRecordResultState.rateError}
              onRevertRecord={() => void mealRecordResultState.revert()}
              onViewRecord={() => mealRecordResultState.viewMeal()}
              onRateRecord={(rating) => void mealRecordResultState.rate(rating)}
              onDismissRecord={() => mealRecordResultState.dismiss()}
              isRecordingMeal={recordMealMutation.isPending}
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
              onNavigationRequestConsumed={consumeIngredientNavigationRequest}
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
              familyId={family?.id ?? ''}
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
          <AppFamilyWorkspace
            state={navigation.state}
            isOwner={isOwner}
            family={family ?? null}
            familyQueryError={familyQuery.error}
            members={members}
            currentUser={currentUser}
            membership={membership}
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
        )}

        <AppOverlayHost state={appOverlayState}>
        <AppGlobalOverlays
          search={{
            open: globalSearchOpen,
            onClose: () => setGlobalSearchOpen(false),
            onSelect: handleGlobalSearchSelect,
          }}
          shopping={{
            open: homeShoppingDialogOpen,
            closeOverlay: () => {
              if (!createShoppingMutation.isPending) setHomeShoppingDialogOpen(false);
            },
            ingredients,
            foods,
            shoppingForm: homeShoppingForm,
            setShoppingForm: setHomeShoppingForm,
            submitShopping: submitHomeShopping,
            isCreatingShopping: createShoppingMutation.isPending,
          }}
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
            openHomeMealRecord={(item) => {
              closeHomePlanDetail();
              setHomeMealEnrichmentRequest({ mealLogId: item.meal_log_id ?? undefined, planItem: item });
            }}
            deleteHomePlanDetail={deleteHomePlanDetail}
            closeHomePlanDetail={closeHomePlanDetail}
            isUpdatingHomePlanDetail={updateFoodPlanItemMutation.isPending || deleteFoodPlanItemMutation.isPending}
            isCompletingHomePlanDetail={cookRecipeMutation.isPending || completeFoodPlanItemMutation.isPending}
            homeMealEnrichmentMeal={homeMealEnrichmentMeal}
            homeMealEnrichmentMembers={members}
            foodPlanItems={foodPlanItems}
            foods={foods}
            recordMeal={(payload) => recordMealMutation.mutateAsync(payload)}
            revertMealRecord={(operationId) => revertMealRecordMutation.mutateAsync(operationId)}
            onHomeMealEnrichmentMealChanged={(meal) => setHomeMealEnrichmentRequest((current) => ({
              mealLog: meal,
              planItem: current?.planItem,
            }))}
            closeHomeMealEnrichment={() => setHomeMealEnrichmentRequest(null)}
            updateMealLog={(mealLogId, payload) => saveHomeMealEnrichment(homeMealEnrichmentMeal ?? { id: mealLogId } as MealLog, payload)}
            onInvalidMealEnrichmentSave={() => showNotice({ tone: 'warning', title: '还没有补充内容', message: '请先填写评分、家人、备注或照片，再保存这顿饭。' })}
            isUpdatingMeal={updateMealMutation.isPending}
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

        <Suspense fallback={null}>
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
            operationHistory.open
              ? {
                  open: operationHistory.open,
                  operations: inventoryOperations,
                  loading:
                    inventoryOperationsQuery.isLoading ||
                    (inventoryOperationsQuery.isFetching && !inventoryOperationsQuery.data),
                  busy: revertInventoryOperationMutation.isPending,
                  errorMessage:
                    operationHistory.error ??
                    queryErrorMessage(inventoryOperationsQuery.error, '加载库存变更记录失败'),
                  selectedOperationId: operationHistory.selectedOperationId,
                  detail: operationHistory.detail,
                  detailLoading: operationHistory.detailLoading,
                  detailError: operationHistory.detailError,
                  conflictMessage: operationHistory.conflict,
                  initialOperationId: operationHistory.initialOperationId,
                  onClose: closeOperationHistory,
                  onSelectOperation: operationHistory.setSelectedOperationId,
                  onLoadDetail: (operationId) => {
                    void loadOperationDetail(operationId);
                  },
                  onRevert: (operationId) => {
                    void handleRevertInventoryOperation(operationId);
                  },
                  onRetry: () => {
                    void inventoryOperationsQuery.refetch();
                    if (operationHistory.selectedOperationId) {
                      void loadOperationDetail(operationHistory.selectedOperationId);
                    }
                  },
                }
              : null
          }
        />
        </Suspense>

        </AppOverlayHost>
      </AppWorkspaceRouter>
    </AppShell>
  );
}

export default App;
