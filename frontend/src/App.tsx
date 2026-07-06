import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api/client';
import { queryKeys } from './api/queryKeys';
import { AppNotificationCenter, AppShell, type TabKey } from './app/AppShell';
import { useAppGlobalSearchNavigation } from './app/useAppGlobalSearchNavigation';
import { useAppHomeHandlers } from './app/useAppHomeHandlers';
import { useAppHomeViewModel } from './app/useAppHomeViewModel';
import { useAppMutations } from './app/useAppMutations';
import { useAppWorkspaceQueries } from './app/useAppWorkspaceQueries';
import type {
  MealLog,
  UpdateMealLogPayload,
} from './api/types';
import { useAuth } from './auth/AuthContext';
import { LoginScreen } from './components/LoginScreen';
import { addDateKeyDays, getRecipeWeekRange } from './components/recipes/workspaceModel';
import {
  EmptyState,
} from './components/ui-kit';
import {
  FOOD_TYPE_LABELS,
  buildInventoryAlerts,
  getFoodCover,
  todayKey,
} from './lib/ui';
import { MealLogWorkspace } from './features/meals/MealLogWorkspace';
import type { FamilyStatCard } from './features/family/FamilySettings';
import { useFamilySettingsState } from './features/family/useFamilySettingsState';
import {
  type HomeRestockFormState,
} from './features/home/homeDashboardModel';
import { useHomeDashboardState } from './features/home/useHomeDashboardState';
import { useHomeDashboardActions } from './features/home/useHomeDashboardActions';
import type { HomeMealEnrichmentOpenRequest } from './features/home/useHomeDashboardActions';
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
    visibleExpiryCount,
    setVisibleExpiryCount,
    visibleDashboardTodoCount,
    setVisibleDashboardTodoCount,
    homeExpiredDisposalIngredientId,
    setHomeExpiredDisposalIngredientId,
    homeExpiryReviewItemId,
    setHomeExpiryReviewItemId,
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
  } = useHomeDashboardState({ foodPlanWeekRange });
  const { notice, showNotice, clearNotice } = useNotice();
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
    shoppingItems,
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
  const {
    ingredientNavigationRequest,
    setIngredientNavigationRequest,
    ingredientNavigationRequestIdRef,
    foodNavigationRequest,
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
    consumeInventoryMutation,
    disposeExpiredInventoryMutation,
    createShoppingMutation,
    updateShoppingMutation,
    deleteShoppingMutation,
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
  useEffect(() => {
    setVisibleExpiryCount(10);
  }, [inventoryItems.length]);

  if (!isAuthenticated) {
    return <LoginScreen />;
  }

  const isBootLoading = authLoading || (!hasBooted && isWorkspaceBootLoading);

  if (isBootLoading) {
    return (
      <main className="login-shell">
        <section className="login-card">
          <h1>正在连接家庭厨房...</h1>
          <p className="subtle">家庭数据加载中...</p>
        </section>
      </main>
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
    expiringInventoryItems,
    visibleExpiringInventoryItems,
    activeFoodPlanItems,
    pendingShoppingPreview,
    todaysMeals,
    dashboardStats,
    dashboardRecommendationItems,
    dashboardRecommendationPageCount,
    dashboardRecommendations,
    dashboardTodoItems,
    visibleDashboardTodoItems,
    hasMoreDashboardTodoItems,
    dashboardCompletedCount,
    dashboardWeekMealCapacity,
    dashboardPlanSummary,
    dashboardPlanDays,
    selectedDashboardPlanDay,
    selectedDashboardPlanDateLabel,
    homeRestockShoppingItem,
    homeExpiryReviewItem,
    homeExpiryReviewIngredient,
    homeMealDetail,
    homeMealDetailParticipants,
    homeRestockIngredient,
    homeRestockIngredientImageUrl,
    homeExpiredDisposalSummary,
    homeExpiredDisposalItems,
  } = useAppHomeViewModel({
    user,
    membershipRole: membership?.role,
    family,
    members,
    memberEditMemberId: memberEditForm.memberId,
    ingredients,
    inventoryItems,
    shoppingItems,
    recipes,
    foods,
    foodPlanItems,
    foodRecommendations,
    mealLogs,
    activityLogs,
    dashboardRecommendationPage,
    visibleDashboardTodoCount,
    visibleExpiryCount,
    selectedDashboardPlanDate,
    foodPlanWeekRange,
    homePlanDetailItemId,
    homePlanAddFoodId,
    homePlanAddFoodSearch,
    homeRestockShoppingItemId,
    homeExpiryReviewItemId,
    homeMealDetailId,
    homeRestockForm,
    homeExpiredDisposalIngredientId,
    resolveDashboardAssetUrl,
  });

  function resolveDashboardAssetUrl(url?: string) {
    return resolveAssetUrl(url, { passthroughPrefixes: ['/images/'] });
  }

  const {
    openIngredientsCatalog,
    openIngredientDetail,
    openIngredientExpiredDisposal,
    openHomeExpiryReview,
    closeHomeExpiryReview,
    openHomeRestock,
    closeHomeRestock,
    closeHomeMealDetail,
    handleDashboardTodoClick,
    updateHomeRestockForm,
    handleExpiryListScroll,
    handleDashboardTodoListScroll,
  } = useAppHomeHandlers({
    ingredientNavigationRequestIdRef,
    setIngredientNavigationRequest,
    setActiveTab,
    setHomeExpiredDisposalIngredientId,
    setHomeExpiryReviewItemId,
    setHomeRestockShoppingItemId,
    setHomeRestockForm,
    setHomeMealDetailId,
    setVisibleExpiryCount,
    setVisibleDashboardTodoCount,
    ingredients,
    expiringInventoryCount: expiringInventoryItems.length,
    dashboardTodoCount: dashboardTodoItems.length,
  });

  const {
    startHomePlanDetailCook,
    submitHomeExpiredDisposal,
    submitHomeRestock,
    submitHomePlanDetail,
    supplementHomePlanDetailRecord,
    deleteHomePlanDetail,
    submitHomePlanAdd,
  } = useHomeDashboardActions({
    showNotice,
    homeExpiredDisposalSummary,
    homeExpiredDisposalItems,
    homeRestockShoppingItem,
    homeRestockForm,
    homeRestockIngredient,
    homePlanDetailItem,
    homePlanDetailForm,
    homePlanAddFood,
    homePlanAddForm,
    createInventory: (payload) => createInventoryMutation.mutateAsync(payload),
    updateShoppingDone: (itemId, done) => updateShoppingMutation.mutateAsync({ itemId, payload: { done } }),
    disposeExpiredInventory: (payload) => disposeExpiredInventoryMutation.mutateAsync(payload),
    updateFoodPlanItem: (itemId, payload) => updateFoodPlanItemMutation.mutateAsync({ itemId, payload }),
    deleteFoodPlanItem: (itemId) => deleteFoodPlanItemMutation.mutateAsync(itemId),
    createFoodPlanItem: (payload) => createFoodPlanItemMutation.mutateAsync(payload),
    quickAddMeal: (payload) => quickAddMealMutation.mutateAsync(payload),
    closeHomeRestock,
    closeHomeExpiredDisposal: () => setHomeExpiredDisposalIngredientId(null),
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
            dashboardCompletedCount={dashboardCompletedCount}
            dashboardTodoItems={dashboardTodoItems}
            visibleDashboardTodoItems={visibleDashboardTodoItems}
            hasMoreDashboardTodoItems={hasMoreDashboardTodoItems}
            activeFoodPlanItems={activeFoodPlanItems}
            foodPlanItems={foodPlanItems}
            dashboardWeekMealCapacity={dashboardWeekMealCapacity}
            dashboardPlanDays={dashboardPlanDays}
            selectedDashboardPlanDay={selectedDashboardPlanDay}
            selectedDashboardPlanDateLabel={selectedDashboardPlanDateLabel}
            pendingShoppingCount={pendingShoppingCount}
            pendingShoppingPreview={pendingShoppingPreview}
            visibleExpiringInventoryItems={visibleExpiringInventoryItems}
            hasMoreExpiringInventoryItems={visibleExpiryCount < expiringInventoryItems.length}
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
            onIngredientsCatalogOpen={openIngredientsCatalog}
            onIngredientExpiredDisposalOpen={openIngredientExpiredDisposal}
            onIngredientDetailOpen={openIngredientDetail}
            onDashboardTodoClick={handleDashboardTodoClick}
            onExpiryListScroll={handleExpiryListScroll}
            onDashboardTodoListScroll={handleDashboardTodoListScroll}
            onFoodPlanPreviousWeek={() => setSelectedRecipePlanDate(addDateKeyDays(foodPlanWeekRange.start, -7))}
            onFoodPlanCurrentWeek={() => setSelectedRecipePlanDate(todayKey())}
            onFoodPlanNextWeek={() => setSelectedRecipePlanDate(addDateKeyDays(foodPlanWeekRange.end, 1))}
          />
        )}

        {activeTab === 'foods' && (
          <Suspense fallback={<WorkspaceLoadingFallback />}>
            <FoodWorkspace
              foods={foods}
              recipes={recipes}
              ingredients={ingredients}
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
              inventoryItems={inventoryItems}
              shoppingItems={shoppingItems}
              recipes={recipes}
              notificationCenter={mobileNotificationCenter}
              navigationRequest={ingredientNavigationRequest}
              createIngredient={(payload) => createIngredientMutation.mutateAsync(payload)}
              updateIngredient={(ingredientId, payload) => updateIngredientMutation.mutateAsync({ ingredientId, payload })}
              createInventory={(payload) => createInventoryMutation.mutateAsync(payload)}
              consumeInventory={(payload) => consumeInventoryMutation.mutateAsync(payload)}
              disposeExpiredInventory={(payload) => disposeExpiredInventoryMutation.mutateAsync(payload)}
              createShoppingItem={(payload) => createShoppingMutation.mutateAsync(payload)}
              updateShoppingItem={(payload) => updateShoppingMutation.mutateAsync(payload)}
              deleteShoppingItem={(itemId) => deleteShoppingMutation.mutateAsync(itemId)}
              isCreatingIngredient={createIngredientMutation.isPending}
              isUpdatingIngredient={updateIngredientMutation.isPending}
              isCreatingInventory={createInventoryMutation.isPending}
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
            homeExpiryReviewItem={homeExpiryReviewItem}
            homeExpiryReviewIngredient={homeExpiryReviewIngredient}
            closeHomeExpiryReview={closeHomeExpiryReview}
            openIngredientDetail={openIngredientDetail}
            homeMealDetail={homeMealDetail}
            homeMealDetailParticipants={homeMealDetailParticipants}
            closeHomeMealDetail={closeHomeMealDetail}
            homeRestockShoppingItem={homeRestockShoppingItem}
            homeRestockForm={homeRestockForm}
            homeRestockIngredient={homeRestockIngredient}
            homeRestockIngredientImageUrl={homeRestockIngredientImageUrl}
            updateHomeRestockForm={updateHomeRestockForm}
            closeHomeRestock={closeHomeRestock}
            submitHomeRestock={submitHomeRestock}
            isCreatingInventory={createInventoryMutation.isPending}
            homeExpiredDisposalSummary={homeExpiredDisposalSummary}
            homeExpiredDisposalItems={homeExpiredDisposalItems}
            setHomeExpiredDisposalIngredientId={setHomeExpiredDisposalIngredientId}
            submitHomeExpiredDisposal={submitHomeExpiredDisposal}
            isDisposingExpiredInventory={disposeExpiredInventoryMutation.isPending}
            resolveAssetUrl={resolveDashboardAssetUrl}
          />
        </Suspense>

    </AppShell>
  );
}

export default App;
