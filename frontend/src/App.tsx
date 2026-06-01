import { lazy, Suspense, useEffect, useMemo, useRef, useState, type FormEvent, type UIEvent } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api/client';
import {
  invalidateAfterFoodChanged,
  invalidateAfterFoodPlanChanged,
  invalidateAfterFoodSceneChanged,
  invalidateAfterIngredientChanged,
  invalidateAfterInventoryChanged,
  invalidateAfterLegacyAiQuery,
  invalidateAfterMealLogChanged,
  invalidateAfterQuickMealAdded,
  invalidateAfterRecipeChanged,
  invalidateAfterRecipeCooked,
  invalidateAfterRecipeDeleted,
  invalidateAfterRecipeFavoriteChanged,
  invalidateAfterShoppingChanged,
} from './api/cacheInvalidation';
import { queryKeys } from './api/queryKeys';
import { AppShell, type TabKey } from './app/AppShell';
import {
  DashboardIcon,
} from './app/shellIcons';
import type {
  AiMode,
  Food,
  Ingredient,
  FoodRecommendations,
  FoodPlanItem,
  IngredientExpiryMode,
  InventoryItem,
  InventoryStatus,
  MealLog,
  Recipe,
  RecipeDiscovery,
  FoodScene,
  RecipeStats,
  ShoppingListItem,
} from './api/types';
import { useAuth } from './auth/AuthContext';
import { FoodPlanDetailModal } from './components/foods/FoodPlanDetailModal';
import {
  buildDisposableExpiredInventoryItems,
  buildIngredientSummaries,
} from './components/ingredients/workspaceModel';
import { LoginScreen } from './components/LoginScreen';
import { addDateKeyDays, getRecipeWeekRange } from './components/recipes/workspaceModel';
import {
  ActionButton,
  Avatar,
  Badge,
  EmptyState,
  PageHeader,
  SectionHeading,
  WorkspaceModal,
} from './components/ui-kit';
import {
  AI_MODE_LABELS,
  FOOD_TYPE_LABELS,
  INVENTORY_STATUS_LABELS,
  MEAL_TYPE_LABELS,
  buildIngredientPlaceholderSvg,
  buildInventoryAlerts,
  formatDate,
  formatDateTime,
  formatRelativeDays,
  getFoodCover,
  todayKey,
} from './lib/ui';
import { MealLogComposer } from './features/meals/MealLogComposer';
import { useMealLogComposerState } from './features/meals/useMealLogComposerState';
import type { FamilyStatCard } from './features/family/FamilySettings';
import { useFamilySettingsState } from './features/family/useFamilySettingsState';
import {
  DASHBOARD_PLAN_MEAL_TYPES,
  DASHBOARD_TODO_PAGE_SIZE,
  buildHomeDashboardViewModel,
  buildHomeRestockForm,
  getExpiryDaysLeft,
  parsePositiveNumber,
  resolveExpiryDateFromDays,
  resolveInventoryStatusForStorage,
  type DashboardTodoItem,
  type HomeRestockFormState,
} from './features/home/homeDashboardModel';
import { getDefaultHomePlanMealType, useHomeDashboardState } from './features/home/useHomeDashboardState';
import { useHomeDashboardActions } from './features/home/useHomeDashboardActions';
import { useNotice } from './hooks/useNotice';
import { resolveAssetUrl } from './lib/assets';
import { readStringStorage, writeStringStorage } from './lib/storage';
import { HomeDashboard } from './features/home/HomeDashboard';

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
const FamilySettings = lazy(() =>
  import('./features/family/FamilySettings').then((module) => ({ default: module.FamilySettings }))
);

type IngredientNavigationRequest = {
  view: 'catalog' | 'detail';
  ingredientId?: string;
  requestId: number;
};

type DashboardExpiryTodoInventoryItem = InventoryItem & { daysLeft: number };


const SIDEBAR_COLLAPSED_KEY = 'culina-large-shell-sidebar-collapsed-v3';

function defaultSidebarCollapsed() {
  return readStringStorage(SIDEBAR_COLLAPSED_KEY, '') === '1';
}

function resetPageScroll() {
  window.requestAnimationFrame(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    document.scrollingElement?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  });
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
  const queryClient = useQueryClient();
  const { isAuthenticated, isLoading: authLoading, user, membership, logout } = useAuth();
  const [selectedRecipePlanDate, setSelectedRecipePlanDate] = useState(todayKey());
  const foodPlanWeekRange = useMemo(() => getRecipeWeekRange(selectedRecipePlanDate), [selectedRecipePlanDate]);
  const [activeTab, setActiveTab] = useState<TabKey>(() => {
    const cached = readStringStorage('culina-active-tab', '');
    return (cached as TabKey) || 'home';
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(defaultSidebarCollapsed);
  const [aiMode, setAiMode] = useState<AiMode>('recommendation');
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiFoodId, setAiFoodId] = useState('');
  const [selectedAiIngredientIds, setSelectedAiIngredientIds] = useState<string[]>([]);
  const [pendingRecipeCookId, setPendingRecipeCookId] = useState<string | null>(null);
  const [pendingFoodPlanCookItemId, setPendingFoodPlanCookItemId] = useState<string | null>(null);
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
  const [ingredientNavigationRequest, setIngredientNavigationRequest] = useState<IngredientNavigationRequest | null>(null);
  const ingredientNavigationRequestIdRef = useRef(0);
  const { notice, showNotice, clearNotice } = useNotice();

  useEffect(() => {
    writeStringStorage('culina-active-tab', activeTab);
    resetPageScroll();
  }, [activeTab]);

  useEffect(() => {
    writeStringStorage(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed ? '1' : '0');
  }, [sidebarCollapsed]);

  const familyQuery = useQuery({
    queryKey: queryKeys.family,
    queryFn: api.getFamily,
    enabled: isAuthenticated,
  });
  const membersQuery = useQuery({
    queryKey: queryKeys.members,
    queryFn: api.getMembers,
    enabled: isAuthenticated,
  });
  const ingredientsQuery = useQuery({
    queryKey: queryKeys.ingredients,
    queryFn: api.getIngredients,
    enabled: isAuthenticated,
  });
  const inventoryQuery = useQuery({
    queryKey: queryKeys.inventory,
    queryFn: api.getInventory,
    enabled: isAuthenticated,
  });
  const shoppingQuery = useQuery({
    queryKey: queryKeys.shoppingList,
    queryFn: api.getShoppingList,
    enabled: isAuthenticated,
  });
  const recipesQuery = useQuery({
    queryKey: queryKeys.recipes,
    queryFn: api.getRecipes,
    enabled: isAuthenticated,
  });
  const recipeDiscoveryQuery = useQuery({
    queryKey: queryKeys.recipeDiscovery,
    queryFn: () => api.getRecipeDiscovery(8),
    enabled: isAuthenticated,
  });
  const recipeStatsQuery = useQuery({
    queryKey: queryKeys.recipeStats,
    queryFn: () => api.getRecipeStats(undefined, undefined, 10),
    enabled: isAuthenticated,
  });
  const recipeFavoritesQuery = useQuery({
    queryKey: queryKeys.recipeFavorites,
    queryFn: api.getRecipeFavorites,
    enabled: isAuthenticated,
  });
  const foodPlanQuery = useQuery({
    queryKey: queryKeys.foodPlan(foodPlanWeekRange.start, foodPlanWeekRange.end),
    queryFn: () => api.getFoodPlan(foodPlanWeekRange.start, foodPlanWeekRange.end),
    enabled: isAuthenticated,
    placeholderData: keepPreviousData,
  });
  const foodScenesQuery = useQuery({
    queryKey: queryKeys.foodScenes,
    queryFn: api.getFoodScenes,
    enabled: isAuthenticated,
  });
  const foodsQuery = useQuery({
    queryKey: queryKeys.foods,
    queryFn: api.getFoods,
    enabled: isAuthenticated,
  });
  const foodRecommendationsQuery = useQuery({
    queryKey: queryKeys.foodRecommendations,
    queryFn: () => api.getFoodRecommendations({ limit: 12, now: new Date().toISOString() }),
    enabled: isAuthenticated,
  });
  const mealLogsQuery = useQuery({
    queryKey: queryKeys.mealLogs,
    queryFn: api.getMealLogs,
    enabled: isAuthenticated,
  });
  const activityLogsQuery = useQuery({
    queryKey: queryKeys.activityLogs,
    queryFn: api.getActivityLogs,
    enabled: isAuthenticated,
  });
  const aiConversationsQuery = useQuery({
    queryKey: queryKeys.aiConversations,
    queryFn: api.getAiConversations,
    enabled: isAuthenticated,
  });

  const createIngredientMutation = useMutation({
    mutationFn: api.createIngredient,
    onSuccess: () => {
      invalidateAfterIngredientChanged(queryClient);
    },
  });
  const updateIngredientMutation = useMutation({
    mutationFn: ({ ingredientId, payload }: { ingredientId: string; payload: Parameters<typeof api.updateIngredient>[1] }) =>
      api.updateIngredient(ingredientId, payload),
    onSuccess: () => {
      invalidateAfterIngredientChanged(queryClient);
    },
  });
  const createInventoryMutation = useMutation({
    mutationFn: api.createInventory,
    onSuccess: () => {
      invalidateAfterInventoryChanged(queryClient);
    },
  });
  const consumeInventoryMutation = useMutation({
    mutationFn: api.consumeInventory,
    onSuccess: () => {
      invalidateAfterInventoryChanged(queryClient);
    },
  });
  const disposeExpiredInventoryMutation = useMutation({
    mutationFn: api.disposeExpiredInventory,
    onSuccess: () => {
      invalidateAfterInventoryChanged(queryClient);
    },
  });
  const createShoppingMutation = useMutation({
    mutationFn: api.createShoppingItem,
    onSuccess: () => {
      invalidateAfterShoppingChanged(queryClient);
    },
  });
  const updateShoppingMutation = useMutation({
    mutationFn: ({ itemId, done }: { itemId: string; done: boolean }) => api.updateShoppingItem(itemId, done),
    onSuccess: () => {
      invalidateAfterShoppingChanged(queryClient);
    },
  });
  const createRecipeMutation = useMutation({
    mutationFn: api.createRecipe,
    onSuccess: () => {
      invalidateAfterRecipeChanged(queryClient);
    },
  });
  const updateRecipeMutation = useMutation({
    mutationFn: ({ recipeId, payload }: { recipeId: string; payload: Parameters<typeof api.updateRecipe>[1] }) =>
      api.updateRecipe(recipeId, payload),
    onSuccess: () => {
      invalidateAfterRecipeChanged(queryClient);
    },
  });
  const deleteRecipeMutation = useMutation({
    mutationFn: api.deleteRecipe,
    onSuccess: () => {
      invalidateAfterRecipeDeleted(queryClient);
    },
  });
  const cookRecipeMutation = useMutation({
    mutationFn: ({ recipeId, payload }: { recipeId: string; payload: Parameters<typeof api.cookRecipe>[1] }) =>
      api.cookRecipe(recipeId, payload),
    onSuccess: () => {
      invalidateAfterRecipeCooked(queryClient);
    },
  });
  const previewCookRecipeMutation = useMutation({
    mutationFn: ({ recipeId, payload }: { recipeId: string; payload: Parameters<typeof api.previewCookRecipe>[1] }) =>
      api.previewCookRecipe(recipeId, payload),
  });
  const addRecipeFavoriteMutation = useMutation({
    mutationFn: api.addRecipeFavorite,
    onSuccess: () => {
      invalidateAfterRecipeFavoriteChanged(queryClient);
    },
  });
  const removeRecipeFavoriteMutation = useMutation({
    mutationFn: api.removeRecipeFavorite,
    onSuccess: () => {
      invalidateAfterRecipeFavoriteChanged(queryClient);
    },
  });
  const createFoodPlanItemMutation = useMutation({
    mutationFn: api.createFoodPlanItem,
    onSuccess: () => {
      invalidateAfterFoodPlanChanged(queryClient);
    },
  });
  const updateFoodPlanItemMutation = useMutation({
    mutationFn: ({ itemId, payload }: { itemId: string; payload: Parameters<typeof api.updateFoodPlanItem>[1] }) =>
      api.updateFoodPlanItem(itemId, payload),
    onSuccess: () => {
      invalidateAfterFoodPlanChanged(queryClient);
    },
  });
  const deleteFoodPlanItemMutation = useMutation({
    mutationFn: api.deleteFoodPlanItem,
    onSuccess: () => {
      invalidateAfterFoodPlanChanged(queryClient);
    },
  });
  const createFoodSceneMutation = useMutation({
    mutationFn: api.createFoodScene,
    onSuccess: () => {
      invalidateAfterFoodSceneChanged(queryClient);
    },
  });
  const updateFoodSceneMutation = useMutation({
    mutationFn: ({ sceneId, payload }: { sceneId: string; payload: Parameters<typeof api.updateFoodScene>[1] }) =>
      api.updateFoodScene(sceneId, payload),
    onSuccess: () => {
      invalidateAfterFoodSceneChanged(queryClient);
    },
  });
  const deleteFoodSceneMutation = useMutation({
    mutationFn: api.deleteFoodScene,
    onSuccess: () => {
      invalidateAfterFoodSceneChanged(queryClient);
    },
  });
  const createFoodMutation = useMutation({
    mutationFn: api.createFood,
    onSuccess: () => {
      invalidateAfterFoodChanged(queryClient);
    },
  });
  const updateFoodMutation = useMutation({
    mutationFn: ({ foodId, payload }: { foodId: string; payload: Parameters<typeof api.updateFood>[1] }) =>
      api.updateFood(foodId, payload),
    onSuccess: () => {
      invalidateAfterFoodChanged(queryClient);
    },
  });
  const toggleFavoriteMutation = useMutation({
    mutationFn: ({ foodId, favorite }: { foodId: string; favorite: boolean }) =>
      api.updateFoodFavorite(foodId, favorite),
    onSuccess: () => {
      invalidateAfterFoodChanged(queryClient);
    },
  });
  const createMealMutation = useMutation({
    mutationFn: api.createMealLog,
    onSuccess: () => {
      invalidateAfterMealLogChanged(queryClient);
    },
  });
  const quickAddMealMutation = useMutation({
    mutationFn: api.quickAddMealLog,
    onSuccess: () => {
      invalidateAfterQuickMealAdded(queryClient);
    },
  });
  const aiMutation = useMutation({
    mutationFn: api.queryAi,
    onSuccess: () => {
      invalidateAfterLegacyAiQuery(queryClient);
    },
  });

  const members = membersQuery.data ?? [];
  const ingredients = ingredientsQuery.data ?? [];
  const inventoryItems = inventoryQuery.data ?? [];
  const shoppingItems = shoppingQuery.data ?? [];
  const recipes = recipesQuery.data ?? [];
  const recipeDiscovery: RecipeDiscovery | null = recipeDiscoveryQuery.data ?? null;
  const recipeStats: RecipeStats | null = recipeStatsQuery.data ?? null;
  const recipeFavorites = recipeFavoritesQuery.data ?? [];
  const foodPlanItems = foodPlanQuery.data ?? [];
  const foodScenes: FoodScene[] = foodScenesQuery.data ?? [];
  const foods = foodsQuery.data ?? [];
  const foodRecommendations: FoodRecommendations | null = foodRecommendationsQuery.data ?? null;
  const mealLogs = mealLogsQuery.data ?? [];
  const activityLogs = activityLogsQuery.data ?? [];
  const aiConversations = aiConversationsQuery.data ?? [];
  const family = familyQuery.data;
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
  const homePlanDetailItem = homePlanDetailItemId
    ? foodPlanItems.find((item) => item.id === homePlanDetailItemId) ?? null
    : null;
  const homePlanDetailFood = homePlanDetailItem
    ? foods.find((food) => food.id === homePlanDetailItem.food_id) ?? null
    : null;
  const homePlanAddFood = homePlanAddFoodId
    ? foods.find((food) => food.id === homePlanAddFoodId) ?? null
    : null;
  const homePlanAddFoodOptions = foods
    .filter((food) => {
      const query = homePlanAddFoodSearch.trim().toLowerCase();
      if (!query) return true;
      return [food.name, food.category, food.source_name, food.purchase_source, food.scene, food.notes, food.routine_note]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(query);
    })
    .slice(0, 8);
  const mealLogComposer = useMealLogComposerState({
    foods,
    memberIds: members.map((member) => member.id),
    currentUserId: user?.id,
    showNotice,
    createMealLog: (payload) => createMealMutation.mutateAsync(payload),
  });

  useEffect(() => {
    setVisibleExpiryCount(10);
  }, [inventoryItems.length]);

  if (!isAuthenticated) {
    return <LoginScreen />;
  }

  const isBootLoading =
    authLoading ||
    familyQuery.isLoading ||
    membersQuery.isLoading ||
    ingredientsQuery.isLoading ||
    inventoryQuery.isLoading ||
    shoppingQuery.isLoading ||
    recipesQuery.isLoading ||
    recipeFavoritesQuery.isLoading ||
    (foodPlanQuery.isLoading && !foodPlanQuery.data) ||
    foodScenesQuery.isLoading ||
    foodsQuery.isLoading ||
    mealLogsQuery.isLoading ||
    activityLogsQuery.isLoading ||
    aiConversationsQuery.isLoading;

  if (isBootLoading) {
    return (
      <main className="login-shell">
        <section className="login-card">
          <h1>正在连接家庭厨房...</h1>
          <p className="subtle">真实后端、MySQL 和家庭数据正在加载。</p>
        </section>
      </main>
    );
  }

  const currentUser = user;
  const isOwner = membership?.role === 'Owner';
  const inventoryAlerts = buildInventoryAlerts(inventoryItems, ingredients);
  const pendingShoppingCount = shoppingItems.filter((item) => !item.done).length;
  const aiRecommendationCount = (family?.ai_recommendations ?? []).length;
  const recentMeals = [...mealLogs].slice(0, 6);
  const currentUserRecentLogs = currentUser
    ? activityLogs.filter((log) => log.actor_name === currentUser.display_name).length
    : 0;
  const familyOwnerMember = members.find((member) => member.role === 'Owner') ?? members[0];
  const editingMember = members.find((member) => member.id === memberEditForm.memberId);
  const weekActivityCount = activityLogs.filter((log) => {
    const timestamp = Date.parse(log.created_at);
    return Number.isFinite(timestamp) && Date.now() - timestamp <= 7 * 24 * 60 * 60 * 1000;
  }).length;
  const familyHeroImageUrl =
    family?.image?.url ??
    recentMeals.find((item) => item.photos[0])?.photos[0]?.url ??
    foods.map((food) => getFoodCover(food, recipes)).find(Boolean) ??
    '/images/family-kitchen-cover.jpg';
  const familyStatCards: FamilyStatCard[] = [
    {
      label: '家庭成员',
      value: members.length,
      unit: '人',
      detail: '一起管理厨房',
      icon: 'family',
      tone: 'green',
    },
    {
      label: isOwner ? '待处理采购' : '我的记录',
      value: isOwner ? pendingShoppingCount : currentUserRecentLogs,
      unit: isOwner ? '项' : '次',
      detail: isOwner ? '等待家人确认' : '今日参与协作',
      icon: isOwner ? 'mail' : 'edit',
      tone: 'orange',
    },
    {
      label: '本周协作',
      value: weekActivityCount,
      unit: '次',
      detail: '做菜、采购和记录',
      icon: 'bar-chart',
      tone: 'yellow',
    },
    {
      label: '家庭资料',
      value: family?.location || '未填写',
      unit: '',
      detail: family?.motto || '补充口号和位置',
      icon: 'map-pin',
      tone: 'purple',
    },
  ];
  async function submitAi(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      await aiMutation.mutateAsync({
        mode: aiMode,
        prompt: aiPrompt.trim(),
        food_id: aiFoodId || undefined,
        ingredient_ids: selectedAiIngredientIds,
      });
      setAiPrompt('');
    } catch (reason) {
      showNotice({ tone: 'danger', title: 'AI 请求失败', message: reason instanceof Error ? reason.message : 'AI 请求失败' });
    }
  }

  function updateAiIngredients(ingredientId: string, checked: boolean) {
    setSelectedAiIngredientIds((current) =>
      checked ? [...current, ingredientId] : current.filter((item) => item !== ingredientId)
    );
  }

  const headerName = currentUser?.display_name ?? '家庭成员';
  const sidebarRoleLabel = membership?.role === 'Owner' ? 'Owner' : '成员';
  const sidebarFamilyName = family?.name ?? 'Culina 家庭厨房';
  const sidebarLocation = family?.location || '未设置位置';
  const sidebarMotto = family?.motto || '把食物、食材、记录和协作放在一个安静的大屏工作区里。';
  const sidebarMemberLabel = `${members.length} 位成员`;
  const sidebarActivityLabel = weekActivityCount > 0 ? `本周协作 ${weekActivityCount} 次` : '协作中';
  const sidebarUserMeta = currentUser?.username ? `${sidebarRoleLabel} · ${currentUser.username}` : sidebarRoleLabel;
  const sidebarUserNote = family?.location
    ? `${family.location} · ${sidebarFamilyName}`
    : sidebarFamilyName;
  const today = todayKey();
  const ingredientById = new Map(ingredients.map((ingredient) => [ingredient.id, ingredient]));
  const {
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
  } = buildHomeDashboardViewModel({
    inventoryItems,
    inventoryAlertCount: inventoryAlerts.length,
    shoppingItems,
    foodPlanItems,
    foodRecommendations,
    recipes,
    mealLogs,
    today,
    dashboardRecommendationPage,
    visibleDashboardTodoCount,
    visibleExpiryCount,
    selectedDashboardPlanDate,
    foodPlanWeekRange,
  });
  const homeRestockShoppingItem = homeRestockShoppingItemId
    ? shoppingItems.find((item) => item.id === homeRestockShoppingItemId) ?? null
    : null;
  const homeExpiryReviewItem = homeExpiryReviewItemId
    ? expiringInventoryItems.find((item) => item.id === homeExpiryReviewItemId) ?? null
    : null;
  const homeExpiryReviewIngredient = homeExpiryReviewItem
    ? ingredientById.get(homeExpiryReviewItem.ingredient_id) ?? null
    : null;
  const homeMealDetail = homeMealDetailId
    ? mealLogs.find((item) => item.id === homeMealDetailId) ?? null
    : null;
  const homeMealDetailParticipants = homeMealDetail
    ? members.filter((member) => homeMealDetail.participant_user_ids.includes(member.id))
    : [];
  const homeRestockIngredient =
    homeRestockForm?.ingredientId ? ingredients.find((item) => item.id === homeRestockForm.ingredientId) ?? null : null;
  const homeRestockIngredientImageUrl =
    homeRestockIngredient?.image?.url ? resolveDashboardAssetUrl(homeRestockIngredient.image.url) : undefined;

  function resolveDashboardAssetUrl(url?: string) {
    return resolveAssetUrl(url, { passthroughPrefixes: ['/images/'] });
  }

  function openIngredientsCatalog() {
    ingredientNavigationRequestIdRef.current += 1;
    setIngredientNavigationRequest({ view: 'catalog', requestId: ingredientNavigationRequestIdRef.current });
    setActiveTab('ingredients');
  }

  function openIngredientDetail(ingredientId: string) {
    ingredientNavigationRequestIdRef.current += 1;
    setIngredientNavigationRequest({ view: 'detail', ingredientId, requestId: ingredientNavigationRequestIdRef.current });
    setActiveTab('ingredients');
  }

  function openIngredientExpiredDisposal(ingredientId: string) {
    setHomeExpiredDisposalIngredientId(ingredientId);
  }

  function openHomeExpiryReview(item: DashboardExpiryTodoInventoryItem) {
    setHomeExpiryReviewItemId(item.id);
  }

  function closeHomeExpiryReview() {
    setHomeExpiryReviewItemId(null);
  }

  function openHomeRestock(item: ShoppingListItem) {
    setHomeRestockShoppingItemId(item.id);
    setHomeRestockForm(buildHomeRestockForm(item, ingredients));
  }

  function closeHomeRestock() {
    setHomeRestockShoppingItemId(null);
    setHomeRestockForm(null);
  }

  function closeHomeMealDetail() {
    setHomeMealDetailId(null);
  }

  function handleDashboardTodoClick(item: DashboardTodoItem) {
    if (item.type === 'expiry') {
      if (item.item.daysLeft < 0) {
        openIngredientExpiredDisposal(item.item.ingredient_id);
        return;
      }
      openHomeExpiryReview(item.item);
      return;
    }
    if (item.type === 'shopping') {
      openHomeRestock(item.item);
      return;
    }
    setHomeMealDetailId(item.item.id);
  }

  function updateHomeRestockForm(next: HomeRestockFormState) {
    setHomeRestockForm(next);
  }

  function handleExpiryListScroll(event: UIEvent<HTMLDivElement>) {
    const target = event.currentTarget;
    if (target.scrollTop + target.clientHeight < target.scrollHeight - 24) {
      return;
    }
    setVisibleExpiryCount((current) => Math.min(current + 10, expiringInventoryItems.length));
  }

  function handleDashboardTodoListScroll(event: UIEvent<HTMLDivElement>) {
    const target = event.currentTarget;
    if (target.scrollTop + target.clientHeight < target.scrollHeight - 18) {
      return;
    }
    setVisibleDashboardTodoCount((current) => Math.min(current + DASHBOARD_TODO_PAGE_SIZE, dashboardTodoItems.length));
  }

  const ingredientSummaries = buildIngredientSummaries({
    ingredients,
    inventoryItems,
    recipes,
  });
  const homeExpiredDisposalSummary =
    ingredientSummaries.find((item) => item.ingredient.id === homeExpiredDisposalIngredientId) ?? null;
  const homeExpiredDisposalItems = homeExpiredDisposalSummary
    ? buildDisposableExpiredInventoryItems(homeExpiredDisposalSummary)
    : [];
  const {
    startHomePlanDetailCook,
    submitHomeExpiredDisposal,
    submitHomeRestock,
    submitHomePlanDetail,
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
    updateShoppingDone: (itemId, done) => updateShoppingMutation.mutateAsync({ itemId, done }),
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
    startRecipeCook: (recipeId, foodPlanItemId) => {
      setPendingRecipeCookId(recipeId);
      setPendingFoodPlanCookItemId(foodPlanItemId);
      setActiveTab('recipes');
    },
  });

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
      onTabChange={setActiveTab}
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
            dashboardStats={dashboardStats}
            dashboardRecommendationItems={dashboardRecommendationItems}
            dashboardRecommendationPageCount={dashboardRecommendationPageCount}
            dashboardRecommendations={dashboardRecommendations}
            foodRecommendations={foodRecommendations}
            today={today}
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
            activityLogs={activityLogs}
            recentMeals={recentMeals}
            isQuickAdding={quickAddMealMutation.isPending}
            isCreatingFoodPlanItem={createFoodPlanItemMutation.isPending}
            resolveAssetUrl={resolveDashboardAssetUrl}
            quickAddMeal={(payload) => quickAddMealMutation.mutateAsync(payload)}
            onNavigate={setActiveTab}
            onRecommendationPageChange={setDashboardRecommendationPage}
            onPendingRecipeCookChange={setPendingRecipeCookId}
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
              createFood={(payload) => createFoodMutation.mutateAsync(payload)}
              updateFood={(foodId, payload) => updateFoodMutation.mutateAsync({ foodId, payload })}
              updateFoodFavorite={(foodId, favorite) => toggleFavoriteMutation.mutateAsync({ foodId, favorite })}
              quickAddMeal={(payload) => quickAddMealMutation.mutateAsync(payload)}
              createFoodPlanItem={(payload) => createFoodPlanItemMutation.mutateAsync(payload)}
              updateFoodPlanItem={(itemId, payload) => updateFoodPlanItemMutation.mutateAsync({ itemId, payload })}
              deleteFoodPlanItem={(itemId) => deleteFoodPlanItemMutation.mutateAsync(itemId)}
              createFoodScene={(payload) => createFoodSceneMutation.mutateAsync(payload)}
              updateFoodScene={(sceneId, payload) => updateFoodSceneMutation.mutateAsync({ sceneId, payload })}
              deleteFoodScene={(sceneId) => deleteFoodSceneMutation.mutateAsync(sceneId)}
              onOpenRecipes={() => setActiveTab('recipes')}
              onStartRecipe={(recipeId, foodPlanItemId) => {
                setPendingRecipeCookId(recipeId);
                setPendingFoodPlanCookItemId(foodPlanItemId ?? null);
                setActiveTab('recipes');
              }}
              onOpenLogs={() => setActiveTab('logs')}
              onFoodPlanPreviousWeek={() => setSelectedRecipePlanDate(addDateKeyDays(foodPlanWeekRange.start, -7))}
              onFoodPlanCurrentWeek={() => setSelectedRecipePlanDate(todayKey())}
              onFoodPlanNextWeek={() => setSelectedRecipePlanDate(addDateKeyDays(foodPlanWeekRange.end, 1))}
              isSavingFood={createFoodMutation.isPending || updateFoodMutation.isPending}
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
                onStartRecipeHandled={() => {
                  setPendingRecipeCookId(null);
                  setPendingFoodPlanCookItemId(null);
                }}
                onRecipePlanPreviousWeek={() => setSelectedRecipePlanDate(addDateKeyDays(foodPlanWeekRange.start, -7))}
                onRecipePlanCurrentWeek={() => setSelectedRecipePlanDate(todayKey())}
                onRecipePlanNextWeek={() => setSelectedRecipePlanDate(addDateKeyDays(foodPlanWeekRange.end, 1))}
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
              navigationRequest={ingredientNavigationRequest}
              createIngredient={(payload) => createIngredientMutation.mutateAsync(payload)}
              updateIngredient={(ingredientId, payload) => updateIngredientMutation.mutateAsync({ ingredientId, payload })}
              createInventory={(payload) => createInventoryMutation.mutateAsync(payload)}
              consumeInventory={(payload) => consumeInventoryMutation.mutateAsync(payload)}
              disposeExpiredInventory={(payload) => disposeExpiredInventoryMutation.mutateAsync(payload)}
              createShoppingItem={(payload) => createShoppingMutation.mutateAsync(payload)}
              updateShoppingItem={(payload) => updateShoppingMutation.mutateAsync(payload)}
              isCreatingIngredient={createIngredientMutation.isPending}
              isUpdatingIngredient={updateIngredientMutation.isPending}
              isCreatingInventory={createInventoryMutation.isPending}
              isConsumingInventory={consumeInventoryMutation.isPending}
              isDisposingExpiredInventory={disposeExpiredInventoryMutation.isPending}
              isCreatingShopping={createShoppingMutation.isPending}
              isUpdatingShopping={updateShoppingMutation.isPending}
            />
          </Suspense>
        )}

        {activeTab === 'logs' && (
          <main className="page-stack">
            <PageHeader
              variant="compact"
              eyebrow="记录"
              title="记录今天吃了什么"
              description="记录完成后，库存建议会跟着这顿饭一起留下。"
            />
            <div className="page-columns page-columns-split">
              <MealLogComposer
                form={mealLogComposer.form}
                foods={foods}
                members={members}
                entries={mealLogComposer.entries}
                selectedParticipants={mealLogComposer.selectedParticipants}
                isSubmitting={createMealMutation.isPending}
                isGeneratingPhoto={mealLogComposer.imageComposer.state.isGenerating}
                photoErrorMessage={mealLogComposer.imageComposer.state.errorMessage}
                onSubmit={mealLogComposer.submit}
                onFormChange={mealLogComposer.setForm}
                onToggleFood={mealLogComposer.toggleFood}
                onUpdateFood={mealLogComposer.updateFood}
                onUpdateParticipant={mealLogComposer.updateParticipant}
                onUploadPhoto={(files) => void mealLogComposer.imageComposer.upload(files)}
                onGeneratePhoto={(mode) => void mealLogComposer.imageComposer.generate(mode)}
                onResetPhoto={mealLogComposer.imageComposer.reset}
              />

              <aside className="card page-section page-side-column">
                <SectionHeading title="最近记录" description="最近的餐食记录会持续保留在这里" />
                <div className="stack-list">
                  {recentMeals.map((meal) => (
                    <article key={meal.id} className="meal-card">
                      <div className="inline-between">
                        <div>
                          <h3>
                            {formatDate(meal.date)} · {MEAL_TYPE_LABELS[meal.meal_type]}
                          </h3>
                          <p>{meal.food_entries.map((entry) => entry.food_name).join('、')}</p>
                        </div>
                        <Badge>{meal.mood}</Badge>
                      </div>
                      <p className="subtle">{meal.notes || '没有额外备注'}</p>
                      {meal.deduction_suggestions.length > 0 && (
                        <div className="tag-row">
                          {meal.deduction_suggestions.map((item) => (
                            <Badge key={item.id}>
                              {item.ingredient_name} {item.suggested_amount}
                              {item.unit}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              </aside>
            </div>
          </main>
        )}

        {activeTab === 'ai' && (
          <Suspense fallback={<WorkspaceLoadingFallback />}>
            <AiWorkspace conversations={aiConversations} isLoading={aiConversationsQuery.isLoading} currentUser={user} onBackHome={() => setActiveTab('home')} />
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
              onNavigate={setActiveTab}
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

        {homePlanDetailItem && (
          <FoodPlanDetailModal
            item={homePlanDetailItem}
            food={homePlanDetailFood}
            recipes={recipes}
            form={homePlanDetailForm}
            isEditing={isHomePlanDetailEditing}
            isUpdatingPlan={updateFoodPlanItemMutation.isPending || deleteFoodPlanItemMutation.isPending}
            isCompleting={cookRecipeMutation.isPending || quickAddMealMutation.isPending}
            onClose={closeHomePlanDetail}
            onChangeForm={setHomePlanDetailForm}
            onEditingChange={setIsHomePlanDetailEditing}
            onResetEdit={() => resetHomePlanDetailForm(homePlanDetailItem)}
            onSubmit={(event) => void submitHomePlanDetail(event)}
            onComplete={() => void startHomePlanDetailCook(homePlanDetailItem)}
            onDelete={() => void deleteHomePlanDetail(homePlanDetailItem)}
            resolveAssetUrl={(url) => resolveDashboardAssetUrl(url) ?? url}
          />
        )}

        {isHomePlanAddDialogOpen && (
          <div className="workspace-overlay-root">
            <div className="workspace-overlay-backdrop" onClick={closeHomePlanAddDialog} />
            <WorkspaceModal
              title="加食物到菜单"
              description="选择日期和餐次后加入当前周菜单。"
              eyebrow="菜单计划"
              onClose={closeHomePlanAddDialog}
              className="recipe-plan-modal food-plan-modal"
            >
              <form className="recipe-plan-dialog-form" onSubmit={(event) => void submitHomePlanAdd(event)}>
                {homePlanAddFood ? (
                  <div className="recipe-plan-dialog-hero">
                    <div className="recipe-plan-selected-cover">
                      {getFoodCover(homePlanAddFood, recipes) ? (
                        <img src={resolveDashboardAssetUrl(getFoodCover(homePlanAddFood, recipes))} alt={homePlanAddFood.name} />
                      ) : (
                        <div className="recipe-plan-cover-empty">{homePlanAddFood.name.slice(0, 2)}</div>
                      )}
                    </div>
                    <div className="recipe-plan-selected-copy">
                      <span className="recipe-plan-dialog-kicker">即将加入</span>
                      <strong>{homePlanAddFood.name}</strong>
                      <div className="recipe-plan-selected-meta">
                        <span>
                          <DashboardIcon name="list" />
                          {FOOD_TYPE_LABELS[homePlanAddFood.type]}
                        </span>
                        <span>
                          <DashboardIcon name="calendar" />
                          {homePlanAddFood.source_name || homePlanAddFood.purchase_source || homePlanAddFood.category || '常吃食物'}
                        </span>
                        <span>
                          <DashboardIcon name={homePlanAddFood.recipe_id ? 'pot' : 'receipt'} />
                          {homePlanAddFood.recipe_id ? '关联菜谱' : '可直接记录'}
                        </span>
                      </div>
                    </div>
                    <button className="recipe-plan-change-food" type="button" onClick={() => setHomePlanAddFoodId(null)}>
                      修改
                    </button>
                  </div>
                ) : (
                  <div className="recipe-plan-picker">
                    <label htmlFor="home-food-plan-search">选择食物</label>
                    <div className="recipe-plan-combobox">
                      <DashboardIcon name="list" />
                      <input
                        id="home-food-plan-search"
                        className="recipe-plan-search-input"
                        value={homePlanAddFoodSearch}
                        placeholder="搜索食物、来源、场景或备注"
                        onChange={(event) => setHomePlanAddFoodSearch(event.target.value)}
                      />
                    </div>
                    <div className="recipe-plan-option-panel">
                      {homePlanAddFoodOptions.length > 0 ? (
                        homePlanAddFoodOptions.map((food) => {
                          const cover = getFoodCover(food, recipes);
                          return (
                            <button
                              key={food.id}
                              type="button"
                              className="recipe-plan-option"
                              onClick={() => selectHomePlanAddFood(food)}
                            >
                              <span className="recipe-plan-option-cover recipe-work-cover">
                                {cover ? <img src={resolveDashboardAssetUrl(cover)} alt="" /> : <span>{food.name.slice(0, 2)}</span>}
                              </span>
                              <span>
                                <strong>{food.name}</strong>
                                <small>{[FOOD_TYPE_LABELS[food.type], food.source_name || food.purchase_source || food.category, food.recipe_id ? '可开始做' : '可记到今天'].filter(Boolean).join(' · ')}</small>
                              </span>
                              <Badge className="recipe-plan-option-status">{MEAL_TYPE_LABELS[getDefaultHomePlanMealType(food, homePlanAddForm.mealType)]}</Badge>
                            </button>
                          );
                        })
                      ) : (
                        <div className="recipe-plan-option-empty">没有找到匹配的食物</div>
                      )}
                    </div>
                  </div>
                )}

                <div className="recipe-plan-form-row">
                  <label className="recipe-plan-date-field">
                    <span>计划日期</span>
                    <div className="recipe-plan-date-strip" role="radiogroup" aria-label="计划日期">
                      {dashboardPlanDays.map((day) => (
                        <button
                          key={day.date}
                          type="button"
                          className={homePlanAddForm.planDate === day.date ? 'active' : ''}
                          aria-pressed={homePlanAddForm.planDate === day.date}
                          onClick={() => setHomePlanAddForm((current) => ({ ...current, planDate: day.date }))}
                        >
                          <span>{day.isToday ? '今天' : `周${day.weekday}`}</span>
                          <strong>{day.date.slice(5).replace('-', '/')}</strong>
                        </button>
                      ))}
                    </div>
                  </label>
                  <label className="recipe-plan-meal-field">
                    <span>餐次</span>
                    <div className="recipe-plan-meal-segment" role="radiogroup" aria-label="餐次">
                      {DASHBOARD_PLAN_MEAL_TYPES.map((mealType) => (
                        <button
                          key={mealType}
                          type="button"
                          className={homePlanAddForm.mealType === mealType ? 'active' : ''}
                          aria-pressed={homePlanAddForm.mealType === mealType}
                          onClick={() => setHomePlanAddForm((current) => ({ ...current, mealType }))}
                        >
                          {MEAL_TYPE_LABELS[mealType]}
                        </button>
                      ))}
                    </div>
                  </label>
                </div>
                <label className="recipe-plan-note-field">
                  <span>备注</span>
                  <input
                    className="text-input"
                    value={homePlanAddForm.note}
                    placeholder="比如：少油、常点套餐、提前解冻"
                    onChange={(event) => setHomePlanAddForm((current) => ({ ...current, note: event.target.value }))}
                  />
                </label>
                <div className="workspace-overlay-actions">
                  <ActionButton tone="primary" type="submit" disabled={createFoodPlanItemMutation.isPending || !homePlanAddFood}>
                    {createFoodPlanItemMutation.isPending ? '加入中...' : '加入菜单'}
                  </ActionButton>
                  <ActionButton tone="secondary" type="button" onClick={closeHomePlanAddDialog}>
                    取消
                  </ActionButton>
                </div>
              </form>
            </WorkspaceModal>
          </div>
        )}

        {homeExpiryReviewItem && (
          <div className="workspace-overlay-root">
            <div className="workspace-overlay-backdrop" onClick={closeHomeExpiryReview} />
            <WorkspaceModal
              title="处理临期食材"
              description="先核对这批库存的信息；需要调整数量、位置或继续处理时进入食材详情。"
              closeLabel="×"
              closeAriaLabel="关闭"
              className="dashboard-todo-modal"
              onClose={closeHomeExpiryReview}
            >
              <div className="dashboard-todo-dialog">
                <section className="dashboard-todo-dialog-hero">
                  <div className="dashboard-todo-dialog-media">
                    {homeExpiryReviewIngredient?.image?.url ? (
                      <img
                        src={resolveDashboardAssetUrl(homeExpiryReviewIngredient.image.url)}
                        alt={homeExpiryReviewIngredient.name}
                      />
                    ) : (
                      <span>{homeExpiryReviewItem.ingredient_name.slice(0, 1)}</span>
                    )}
                  </div>
                  <div className="dashboard-todo-dialog-copy">
                    <Badge className={homeExpiryReviewItem.daysLeft <= 1 ? 'dashboard-danger-badge' : 'dashboard-wait-badge'}>
                      {homeExpiryReviewItem.daysLeft <= 0 ? '今天到期' : formatRelativeDays(homeExpiryReviewItem.expiry_date ?? today)}
                    </Badge>
                    <h3>{homeExpiryReviewItem.ingredient_name}</h3>
                    <p>
                      {homeExpiryReviewIngredient?.category || '未分类'} · {homeExpiryReviewItem.storage_location || '未记录位置'}
                    </p>
                  </div>
                </section>

                <div className="dashboard-todo-dialog-grid">
                  <article>
                    <span>剩余数量</span>
                    <strong>{homeExpiryReviewItem.remaining_quantity ?? homeExpiryReviewItem.quantity}{homeExpiryReviewItem.unit}</strong>
                  </article>
                  <article>
                    <span>库存状态</span>
                    <strong>{INVENTORY_STATUS_LABELS[homeExpiryReviewItem.status]}</strong>
                  </article>
                  <article>
                    <span>购买日期</span>
                    <strong>{formatDate(homeExpiryReviewItem.purchase_date)}</strong>
                  </article>
                  <article>
                    <span>到期日期</span>
                    <strong>{homeExpiryReviewItem.expiry_date ? formatDate(homeExpiryReviewItem.expiry_date) : '未记录'}</strong>
                  </article>
                </div>

                {homeExpiryReviewItem.notes && (
                  <p className="dashboard-todo-dialog-note">{homeExpiryReviewItem.notes}</p>
                )}

                <div className="workspace-overlay-actions">
                  <ActionButton
                    tone="primary"
                    type="button"
                    onClick={() => {
                      const ingredientId = homeExpiryReviewItem.ingredient_id;
                      closeHomeExpiryReview();
                      openIngredientDetail(ingredientId);
                    }}
                  >
                    查看食材详情
                  </ActionButton>
                  <ActionButton tone="secondary" type="button" onClick={closeHomeExpiryReview}>
                    关闭
                  </ActionButton>
                </div>
              </div>
            </WorkspaceModal>
          </div>
        )}

        {homeMealDetail && (
          <div className="workspace-overlay-root">
            <div className="workspace-overlay-backdrop" onClick={closeHomeMealDetail} />
            <WorkspaceModal
              title="餐食详情"
              description="这条今日待办已经完成，下面是本餐记录。"
              closeLabel="×"
              closeAriaLabel="关闭"
              className="dashboard-todo-modal meal-detail-modal"
              onClose={closeHomeMealDetail}
            >
              <div className="dashboard-todo-dialog meal-detail-dialog">
                <section className="meal-detail-head">
                  <div>
                    <Badge className="dashboard-done-badge">已完成</Badge>
                    <h3>{MEAL_TYPE_LABELS[homeMealDetail.meal_type]}</h3>
                    <p>{formatDate(homeMealDetail.date)} · {formatDateTime(homeMealDetail.created_at)}</p>
                  </div>
                  {homeMealDetail.mood && <strong>{homeMealDetail.mood}</strong>}
                </section>

                <section className="meal-detail-section">
                  <span>本餐食物</span>
                  <div className="meal-detail-food-list">
                    {homeMealDetail.food_entries.length > 0 ? (
                      homeMealDetail.food_entries.map((entry) => (
                        <article key={entry.id} className="meal-detail-food-item">
                          <div>
                            <strong>{entry.food_name}</strong>
                            {entry.note && <p>{entry.note}</p>}
                          </div>
                          <Badge>{entry.servings} 份</Badge>
                        </article>
                      ))
                    ) : (
                      <p className="subtle">这餐没有关联具体食物。</p>
                    )}
                  </div>
                </section>

                <section className="meal-detail-section">
                  <span>参与成员</span>
                  <div className="meal-detail-member-row">
                    {homeMealDetailParticipants.length > 0 ? (
                      homeMealDetailParticipants.map((member) => (
                        <span key={member.id} className="meal-detail-member">
                          <Avatar label={member.display_name} seed={member.avatar_seed} imageUrl={member.avatar_image?.url} />
                          {member.display_name}
                        </span>
                      ))
                    ) : (
                      <p className="subtle">未记录参与成员。</p>
                    )}
                  </div>
                </section>

                {homeMealDetail.notes && (
                  <section className="meal-detail-section">
                    <span>备注</span>
                    <p className="meal-detail-note">{homeMealDetail.notes}</p>
                  </section>
                )}

                {homeMealDetail.photos.length > 0 && (
                  <section className="meal-detail-section">
                    <span>照片</span>
                    <div className="meal-detail-photo-grid">
                      {homeMealDetail.photos.map((photo) => (
                        <img key={photo.id} src={resolveDashboardAssetUrl(photo.url)} alt={photo.alt || photo.name} />
                      ))}
                    </div>
                  </section>
                )}

                <div className="workspace-overlay-actions">
                  <ActionButton tone="primary" type="button" onClick={closeHomeMealDetail}>
                    知道了
                  </ActionButton>
                </div>
              </div>
            </WorkspaceModal>
          </div>
        )}

        {homeRestockShoppingItem && homeRestockForm && (
          <div className="workspace-overlay-root">
            <div className="workspace-overlay-backdrop" onClick={closeHomeRestock} />
            <WorkspaceModal
              title="登记这批库存"
              description="从首页采购提醒快速入库，保存后会把这条采购项标记完成。"
              closeLabel="×"
              closeAriaLabel="关闭"
              className="workspace-modal-wide inventory-restock-modal"
              onClose={closeHomeRestock}
            >
              <form className="ingredients-restock-form" onSubmit={(event) => void submitHomeRestock(event)}>
                <div className="ingredients-restock-scroll">
                  <div className="ingredients-restock-source-note">
                    <Badge>来自采购提醒</Badge>
                    <span>{homeRestockShoppingItem.title}</span>
                  </div>

                  <section className="ingredients-restock-identity-card">
                    <div className="ingredients-restock-identity-media">
                      <img
                        src={homeRestockIngredientImageUrl ?? buildIngredientPlaceholderSvg(homeRestockShoppingItem.title)}
                        alt={homeRestockIngredient?.name ?? homeRestockShoppingItem.title}
                      />
                    </div>
                    <div className="ingredients-restock-identity-copy">
                      <div className="ingredients-restock-identity-head">
                        <div>
                          <h4>{homeRestockIngredient?.name ?? (homeRestockForm.ingredientQuery || homeRestockShoppingItem.title)}</h4>
                          <p>
                            {homeRestockIngredient
                              ? `${homeRestockIngredient.category || '未分类'} · 默认 ${homeRestockIngredient.default_unit || '个'} · ${homeRestockIngredient.default_storage || '冷藏'}`
                              : '先匹配一份食材档案'}
                          </p>
                        </div>
                        <Badge>{homeRestockIngredient ? '已匹配食材' : '待匹配'}</Badge>
                      </div>
                    </div>
                  </section>

                  <label className="ingredients-restock-search-field">
                    <span>食材</span>
                    <input
                      className="text-input"
                      list="home-restock-ingredient-options"
                      placeholder="搜索或选择食材"
                      value={homeRestockForm.ingredientQuery}
                      onChange={(event) => {
                        const nextQuery = event.target.value;
                        const ingredient = ingredients.find((item) => item.name === nextQuery) ?? null;
                        const nextStorage = ingredient?.default_storage || homeRestockForm.storageLocation || '冷藏';
                        const nextExpiryMode = ingredient?.default_expiry_mode ?? homeRestockForm.expiryInputMode;
                        const nextExpiryDays =
                          nextExpiryMode === 'days'
                            ? ingredient?.default_expiry_days
                              ? String(ingredient.default_expiry_days)
                              : homeRestockForm.expiryDays || '3'
                            : '';
                        updateHomeRestockForm({
                          ...homeRestockForm,
                          ingredientId: ingredient?.id ?? '',
                          ingredientQuery: nextQuery,
                          unit: ingredient?.default_unit || homeRestockForm.unit,
                          storageLocation: nextStorage,
                          status: resolveInventoryStatusForStorage(nextStorage),
                          expiryInputMode: nextExpiryMode,
                          expiryDays: nextExpiryDays,
                          expiryDate:
                            nextExpiryMode === 'days'
                              ? resolveExpiryDateFromDays(homeRestockForm.purchaseDate, nextExpiryDays)
                              : '',
                        });
                      }}
                    />
                    <datalist id="home-restock-ingredient-options">
                      {ingredients.map((ingredient) => (
                        <option key={ingredient.id} value={ingredient.name} />
                      ))}
                    </datalist>
                  </label>

                  <section className="ingredients-restock-field-group ingredients-restock-quantity-section">
                    <div className="form-grid compact-grid">
                      <label>
                        <span>数量</span>
                        <input
                          className="text-input"
                          type="number"
                          min="0.01"
                          step="0.01"
                          value={homeRestockForm.quantity}
                          onChange={(event) => updateHomeRestockForm({ ...homeRestockForm, quantity: event.target.value })}
                        />
                      </label>
                      <label>
                        <span>单位</span>
                        <input
                          className="text-input"
                          value={homeRestockForm.unit}
                          onChange={(event) => updateHomeRestockForm({ ...homeRestockForm, unit: event.target.value })}
                        />
                      </label>
                    </div>
                  </section>

                  <section className="ingredients-restock-field-group">
                    <div className="ingredients-restock-field-head">
                      <span>购买时间</span>
                      <p className="subtle">默认今天，需要时再改。</p>
                    </div>
                    <div className="ingredients-restock-choice-row">
                      {[
                        { label: '今天', date: todayKey() },
                        { label: '昨天', date: addDateKeyDays(todayKey(), -1) },
                      ].map((item) => (
                        <button
                          key={item.label}
                          type="button"
                          className={homeRestockForm.purchaseDate === item.date ? 'ingredients-choice-chip active' : 'ingredients-choice-chip'}
                          onClick={() =>
                            updateHomeRestockForm({
                              ...homeRestockForm,
                              purchaseDate: item.date,
                              expiryDate:
                                homeRestockForm.expiryInputMode === 'days'
                                  ? resolveExpiryDateFromDays(item.date, homeRestockForm.expiryDays)
                                  : homeRestockForm.expiryDate,
                            })
                          }
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>
                    <label>
                      <span>购买日期</span>
                      <input
                        className="text-input"
                        type="date"
                        value={homeRestockForm.purchaseDate}
                        onChange={(event) =>
                          updateHomeRestockForm({
                            ...homeRestockForm,
                            purchaseDate: event.target.value,
                            expiryDate:
                              homeRestockForm.expiryInputMode === 'days'
                                ? resolveExpiryDateFromDays(event.target.value, homeRestockForm.expiryDays)
                                : homeRestockForm.expiryDate,
                          })
                        }
                      />
                    </label>
                  </section>

                  <section className="ingredients-restock-field-group">
                    <div className="ingredients-restock-field-head">
                      <span>存放位置</span>
                      <p className="subtle">按这次实际放的位置点一下。</p>
                    </div>
                    <div className="ingredients-restock-choice-row">
                      {['冷藏', '冷冻', '常温'].map((storage) => (
                        <button
                          key={storage}
                          type="button"
                          className={homeRestockForm.storageLocation === storage ? 'ingredients-choice-chip active' : 'ingredients-choice-chip'}
                          onClick={() =>
                            updateHomeRestockForm({
                              ...homeRestockForm,
                              storageLocation: storage,
                              status: resolveInventoryStatusForStorage(storage),
                            })
                          }
                        >
                          {storage}
                        </button>
                      ))}
                    </div>
                    <input
                      className="text-input"
                      placeholder="自定义位置"
                      value={homeRestockForm.storageLocation}
                      onChange={(event) =>
                        updateHomeRestockForm({
                          ...homeRestockForm,
                          storageLocation: event.target.value,
                          status: resolveInventoryStatusForStorage(event.target.value),
                        })
                      }
                    />
                  </section>

                  <section className="ingredients-restock-field-group">
                    <div className="ingredients-restock-field-head">
                      <span>到期信息</span>
                      <p className="subtle">确认这批食材怎么跟踪到期。</p>
                    </div>
                    <div className="ingredients-restock-choice-row">
                      {[
                        { value: 'none', label: '不记录' },
                        { value: 'days', label: '几天后到期' },
                        { value: 'manual_date', label: '包装到期日' },
                      ].map((item) => (
                        <button
                          key={item.value}
                          type="button"
                          className={homeRestockForm.expiryInputMode === item.value ? 'ingredients-choice-chip active' : 'ingredients-choice-chip'}
                          onClick={() => {
                            const nextMode = item.value as IngredientExpiryMode;
                            const nextDays = nextMode === 'days' ? homeRestockForm.expiryDays || '3' : '';
                            updateHomeRestockForm({
                              ...homeRestockForm,
                              expiryInputMode: nextMode,
                              expiryDays: nextDays,
                              expiryDate:
                                nextMode === 'days'
                                  ? resolveExpiryDateFromDays(homeRestockForm.purchaseDate, nextDays)
                                  : nextMode === 'manual_date'
                                    ? homeRestockForm.expiryDate
                                    : '',
                            });
                          }}
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>
                    {homeRestockForm.expiryInputMode === 'days' && (
                      <div className="form-grid compact-grid">
                        <label>
                          <span>买后几天到期</span>
                          <input
                            className="text-input"
                            type="number"
                            min="1"
                            value={homeRestockForm.expiryDays}
                            onChange={(event) =>
                              updateHomeRestockForm({
                                ...homeRestockForm,
                                expiryDays: event.target.value,
                                expiryDate: resolveExpiryDateFromDays(homeRestockForm.purchaseDate, event.target.value),
                              })
                            }
                          />
                        </label>
                        <div className="ingredients-restock-result-card">
                          <span>预计到期日</span>
                          <strong>{homeRestockForm.expiryDate ? formatDate(homeRestockForm.expiryDate) : '先填天数'}</strong>
                          <p>{homeRestockForm.purchaseDate} 购入</p>
                        </div>
                      </div>
                    )}
                    {homeRestockForm.expiryInputMode === 'manual_date' && (
                      <label>
                        <span>包装到期日</span>
                        <input
                          className="text-input"
                          type="date"
                          value={homeRestockForm.expiryDate}
                          onChange={(event) => updateHomeRestockForm({ ...homeRestockForm, expiryDate: event.target.value })}
                        />
                      </label>
                    )}
                  </section>

                  <section className="ingredients-modal-advanced">
                    <div className="form-grid compact-grid ingredients-modal-advanced-fields">
                      <label>
                        <span>状态</span>
                        <select
                          className="text-input"
                          value={homeRestockForm.status}
                          onChange={(event) =>
                            updateHomeRestockForm({ ...homeRestockForm, status: event.target.value as InventoryStatus })
                          }
                        >
                          {Object.entries(INVENTORY_STATUS_LABELS).map(([key, label]) => (
                            <option key={key} value={key}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="span-two">
                        <span>备注</span>
                        <textarea
                          className="text-input"
                          rows={3}
                          value={homeRestockForm.notes}
                          onChange={(event) => updateHomeRestockForm({ ...homeRestockForm, notes: event.target.value })}
                        />
                      </label>
                    </div>
                  </section>
                </div>

                <div className="ingredients-restock-footer-bar">
                  <div className="workspace-overlay-actions">
                    <ActionButton tone="secondary" type="button" onClick={closeHomeRestock} disabled={createInventoryMutation.isPending}>
                      取消
                    </ActionButton>
                    <ActionButton
                      tone="primary"
                      type="submit"
                      disabled={createInventoryMutation.isPending || !homeRestockForm.ingredientId}
                    >
                      {createInventoryMutation.isPending ? '保存中...' : '保存这批库存'}
                    </ActionButton>
                  </div>
                </div>
              </form>
            </WorkspaceModal>
          </div>
        )}

        {homeExpiredDisposalSummary && (
          <div className="workspace-overlay-root">
            <div className="workspace-overlay-backdrop" onClick={() => setHomeExpiredDisposalIngredientId(null)} />
            <WorkspaceModal
              title="销毁已过期批次"
              description="会将这些过期批次的剩余量清零，但保留批次历史记录和活动日志。"
              closeLabel="×"
              closeAriaLabel="关闭"
              className="workspace-modal-wide destroy-expired-modal"
              onClose={() => setHomeExpiredDisposalIngredientId(null)}
            >
              <form className="destroy-expired-form" onSubmit={(event) => void submitHomeExpiredDisposal(event)}>
              <div className="destroy-expired-scroll">
                <section className="ingredients-restock-identity-card destroy-expired-summary-card">
                  <div className="ingredients-restock-identity-media">
                    {homeExpiredDisposalSummary.ingredient.image?.url ? (
                      <img
                        src={resolveDashboardAssetUrl(homeExpiredDisposalSummary.ingredient.image.url)}
                        alt={homeExpiredDisposalSummary.ingredient.name}
                      />
                    ) : (
                      <span>{homeExpiredDisposalSummary.ingredient.name.slice(0, 1)}</span>
                    )}
                  </div>
                  <div className="ingredients-restock-identity-copy">
                    <div className="ingredients-restock-identity-head">
                      <div>
                        <h4>{homeExpiredDisposalSummary.ingredient.name}</h4>
                        <p>{homeExpiredDisposalSummary.ingredient.category || '未分类'} · {homeExpiredDisposalSummary.primaryStorage}</p>
                      </div>
                      <div className="destroy-expired-summary-badges">
                        <Badge>{homeExpiredDisposalItems.length} 条待销毁</Badge>
                        <Badge>{homeExpiredDisposalSummary.quantitySummaries[0]?.label ?? '当前已空'}</Badge>
                      </div>
                    </div>
                    <div className="destroy-expired-summary-grid">
                      <article className="destroy-expired-summary-metric is-primary">
                        <span>本次处理范围</span>
                        <strong>{homeExpiredDisposalItems.length} 条过期批次</strong>
                        <p>仅包含已经过期且当前仍有剩余量的批次。</p>
                      </article>
                      <article className="destroy-expired-summary-metric">
                        <span>处理结果</span>
                        <strong>清零剩余量</strong>
                        <p>批次记录、备注和活动日志都会继续保留。</p>
                      </article>
                    </div>
                  </div>
                </section>

                <section className="ingredients-restock-field-group destroy-expired-list-section">
                  <div className="ingredients-restock-field-head">
                    <span>将要销毁的批次</span>
                    <p className="subtle">只列出到期日早于今天的剩余批次；今天到期和未来到期不会出现在这里。</p>
                  </div>
                  {homeExpiredDisposalItems.length > 0 ? (
                    <div className="destroy-expired-list">
                      {homeExpiredDisposalItems.map((item) => {
                        const expiredDays = Math.abs(getExpiryDaysLeft(item.expiryDate, today));
                        return (
                          <article key={item.id} className="destroy-expired-item">
                            <div className="destroy-expired-item-head">
                              <div className="destroy-expired-item-title">
                                <strong>{item.remainingLabel}</strong>
                                <span>{item.storageLocation}</span>
                              </div>
                              <div className="destroy-expired-item-badges">
                                <Badge className="destroy-expired-item-badge is-danger">
                                  已过期 {expiredDays} 天
                                </Badge>
                                <Badge>{INVENTORY_STATUS_LABELS[item.status]}</Badge>
                              </div>
                            </div>
                            <div className="destroy-expired-item-meta">
                              <span>购买于 {formatDate(item.purchaseDate)}</span>
                              <span>到期日 {formatDate(item.expiryDate)}</span>
                            </div>
                            <p className="destroy-expired-item-note" title={item.notes || '当前没有备注'}>
                              {item.notes || '当前没有备注'}
                            </p>
                          </article>
                        );
                      })}
                    </div>
                  ) : (
                    <EmptyState
                      title="当前没有可销毁的批次"
                      description="这份食材现在没有“已过期且仍有剩余量”的批次，可以直接关闭这个面板。"
                    />
                  )}
                </section>
              </div>

              <div className="destroy-expired-footer-bar">
                <div className="destroy-expired-footer-summary">
                  <span>确认后将处理</span>
                  <strong>{homeExpiredDisposalItems.length} 条过期批次</strong>
                  <p>
                    {homeExpiredDisposalItems.length > 0
                      ? '系统会把这些批次的剩余量清零，并在刷新后同步库存状态。'
                      : '当前没有可销毁的过期批次。'}
                  </p>
                </div>
                <div className="workspace-overlay-actions">
                  <ActionButton
                    tone="secondary"
                    type="button"
                    onClick={() => setHomeExpiredDisposalIngredientId(null)}
                    disabled={disposeExpiredInventoryMutation.isPending}
                  >
                    取消
                  </ActionButton>
                  <ActionButton
                    tone="primary"
                    type="submit"
                    disabled={disposeExpiredInventoryMutation.isPending || homeExpiredDisposalItems.length === 0}
                  >
                    {disposeExpiredInventoryMutation.isPending ? '销毁中...' : '确认销毁'}
                  </ActionButton>
                </div>
              </div>
              </form>
            </WorkspaceModal>
          </div>
        )}
    </AppShell>
  );
}

export default App;
