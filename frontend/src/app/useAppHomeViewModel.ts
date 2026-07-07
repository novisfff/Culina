import type {
  ActivityLog,
  FamilyDetail,
  Food,
  FoodPlanItem,
  FoodRecommendations,
  Ingredient,
  InventoryItem,
  MealLog,
  Member,
  Recipe,
  ShoppingListItem,
  UserSummary,
} from '../api/types';
import { buildDisposableExpiredInventoryItems, buildIngredientSummaries } from '../components/ingredients/workspaceModel';
import { buildInventoryAlerts, getFoodCover, todayKey } from '../lib/ui';
import type { FamilyStatCard } from '../features/family/FamilySettings';
import {
  buildHomeDashboardViewModel,
  type HomeRestockFormState,
} from '../features/home/homeDashboardModel';

type UseAppHomeViewModelArgs = {
  user: UserSummary | null;
  membershipRole?: string | null;
  family: FamilyDetail | null | undefined;
  members: Member[];
  memberEditMemberId: string;
  ingredients: Ingredient[];
  inventoryItems: InventoryItem[];
  shoppingItems: ShoppingListItem[];
  recipes: Recipe[];
  foods: Food[];
  foodPlanItems: FoodPlanItem[];
  foodRecommendations: FoodRecommendations | null;
  mealLogs: MealLog[];
  activityLogs: ActivityLog[];
  dashboardRecommendationPage: number;
  visibleDashboardTodoCount: number;
  visibleExpiryCount: number;
  selectedDashboardPlanDate: string;
  foodPlanWeekRange: { start: string; end: string };
  homePlanDetailItemId: string | null;
  homePlanAddFoodId: string | null;
  homePlanAddFoodSearch: string;
  homeRestockShoppingItemId: string | null;
  homeExpiryReviewItemId: string | null;
  homeMealDetailId: string | null;
  homeRestockForm: HomeRestockFormState | null;
  homeExpiredDisposalIngredientId: string | null;
  resolveDashboardAssetUrl: (url?: string) => string | undefined;
};

export function useAppHomeViewModel(args: UseAppHomeViewModelArgs) {
  const homePlanDetailItem = args.homePlanDetailItemId
    ? args.foodPlanItems.find((item) => item.id === args.homePlanDetailItemId) ?? null
    : null;
  const homePlanDetailFood = homePlanDetailItem
    ? args.foods.find((food) => food.id === homePlanDetailItem.food_id) ?? null
    : null;
  const homePlanAddFood = args.homePlanAddFoodId
    ? args.foods.find((food) => food.id === args.homePlanAddFoodId) ?? null
    : null;
  const homePlanAddFoodOptions = args.foods.filter((food) => {
    const query = args.homePlanAddFoodSearch.trim().toLowerCase();
    if (!query) return true;
    return [food.name, food.category, food.source_name, food.purchase_source, food.scene, food.notes, food.routine_note]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(query);
  });

  const currentUser = args.user;
  const isOwner = args.membershipRole === 'Owner';
  const inventoryAlerts = buildInventoryAlerts(args.inventoryItems, args.ingredients);
  const pendingShoppingCount = args.shoppingItems.filter((item) => !item.done).length;
  const aiRecommendationCount = (args.family?.ai_recommendations ?? []).length;
  const recentMeals = [...args.mealLogs].slice(0, 6);
  const currentUserRecentLogs = currentUser
    ? args.activityLogs.filter((log) => log.actor_name === currentUser.display_name).length
    : 0;
  const familyOwnerMember = args.members.find((member) => member.role === 'Owner') ?? args.members[0];
  const editingMember = args.members.find((member) => member.id === args.memberEditMemberId);
  const weekActivityCount = args.activityLogs.filter((log) => {
    const timestamp = Date.parse(log.created_at);
    return Number.isFinite(timestamp) && Date.now() - timestamp <= 7 * 24 * 60 * 60 * 1000;
  }).length;
  const familyHeroImageUrl =
    args.family?.image?.url ??
    recentMeals.find((item) => item.photos[0])?.photos[0]?.url ??
    args.foods.map((food) => getFoodCover(food, args.recipes)).find(Boolean) ??
    '/images/family-kitchen-cover.jpg';
  const familyStatCards: FamilyStatCard[] = [
    {
      label: '家庭成员',
      value: args.members.length,
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
      value: args.family?.location || '未填写',
      unit: '',
      detail: args.family?.motto || '补充口号和位置',
      icon: 'map-pin',
      tone: 'purple',
    },
  ];
  const headerName = currentUser?.display_name ?? '家庭成员';
  const sidebarRoleLabel = args.membershipRole === 'Owner' ? 'Owner' : '成员';
  const sidebarFamilyName = args.family?.name ?? 'Culina 家庭厨房';
  const sidebarLocation = args.family?.location || '未设置位置';
  const sidebarMotto = args.family?.motto || '把食物、食材、记录和协作放在一个安静的大屏工作区里。';
  const sidebarMemberLabel = `${args.members.length} 位成员`;
  const sidebarActivityLabel = weekActivityCount > 0 ? `本周协作 ${weekActivityCount} 次` : '协作中';
  const sidebarUserMeta = currentUser?.username ? `${sidebarRoleLabel} · ${currentUser.username}` : sidebarRoleLabel;
  const sidebarUserNote = args.family?.location
    ? `${args.family.location} · ${sidebarFamilyName}`
    : sidebarFamilyName;
  const today = todayKey();
  const ingredientById = new Map(args.ingredients.map((ingredient) => [ingredient.id, ingredient]));
  const dashboardViewModel = buildHomeDashboardViewModel({
    inventoryItems: args.inventoryItems,
    inventoryAlertCount: inventoryAlerts.length,
    shoppingItems: args.shoppingItems,
    foodPlanItems: args.foodPlanItems,
    foodRecommendations: args.foodRecommendations,
    recipes: args.recipes,
    mealLogs: args.mealLogs,
    today,
    dashboardRecommendationPage: args.dashboardRecommendationPage,
    visibleDashboardTodoCount: args.visibleDashboardTodoCount,
    visibleExpiryCount: args.visibleExpiryCount,
    selectedDashboardPlanDate: args.selectedDashboardPlanDate,
    foodPlanWeekRange: args.foodPlanWeekRange,
  });
  const homeRestockShoppingItem = args.homeRestockShoppingItemId
    ? args.shoppingItems.find((item) => item.id === args.homeRestockShoppingItemId) ?? null
    : null;
  const homeExpiryReviewItem = args.homeExpiryReviewItemId
    ? dashboardViewModel.expiringInventoryItems.find((item) => item.id === args.homeExpiryReviewItemId) ?? null
    : null;
  const homeExpiryReviewIngredient = homeExpiryReviewItem
    ? ingredientById.get(homeExpiryReviewItem.ingredient_id) ?? null
    : null;
  const homeMealDetail = args.homeMealDetailId
    ? args.mealLogs.find((item) => item.id === args.homeMealDetailId) ?? null
    : null;
  const homeMealDetailParticipants = homeMealDetail
    ? args.members.filter((member) => homeMealDetail.participant_user_ids.includes(member.id))
    : [];
  const homeRestockIngredient =
    args.homeRestockForm?.ingredientId
      ? args.ingredients.find((item) => item.id === args.homeRestockForm?.ingredientId) ?? null
      : null;
  const homeRestockIngredientImageUrl =
    homeRestockIngredient?.image?.url ? args.resolveDashboardAssetUrl(homeRestockIngredient.image.url) : undefined;

  const homeExpiredDisposalIngredient = args.homeExpiredDisposalIngredientId
    ? args.ingredients.find((item) => item.id === args.homeExpiredDisposalIngredientId) ?? null
    : null;
  const ingredientSummaries = homeExpiredDisposalIngredient
    ? buildIngredientSummaries({
        ingredients: [homeExpiredDisposalIngredient],
        inventoryItems: args.inventoryItems.filter((item) => item.ingredient_id === homeExpiredDisposalIngredient.id),
        recipes: args.recipes,
      })
    : [];
  const homeExpiredDisposalSummary =
    ingredientSummaries[0] ?? null;
  const homeExpiredDisposalItems = homeExpiredDisposalSummary
    ? buildDisposableExpiredInventoryItems(homeExpiredDisposalSummary)
    : [];

  return {
    homePlanDetailItem,
    homePlanDetailFood,
    homePlanAddFood,
    homePlanAddFoodOptions,
    currentUser,
    isOwner,
    inventoryAlerts,
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
    ...dashboardViewModel,
    homeRestockShoppingItem,
    homeExpiryReviewItem,
    homeExpiryReviewIngredient,
    homeMealDetail,
    homeMealDetailParticipants,
    homeRestockIngredient,
    homeRestockIngredientImageUrl,
    homeExpiredDisposalSummary,
    homeExpiredDisposalItems,
  };
}
