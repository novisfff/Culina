import type {
  ActivityHighlightsResponse,
  ActivityLog,
  FamilyDetail,
  Food,
  FoodPlanItem,
  FoodRecommendations,
  Ingredient,
  IngredientInventoryState,
  InventoryItem,
  MealLog,
  Member,
  Recipe,
  ShoppingListItem,
  UserSummary,
} from '../api/types';
import {
  buildInventoryActionGroups,
  countUniqueAvailableIngredients,
  type InventoryActionGroup,
} from '../features/inventory/inventoryActionModel';
import { getFoodCover } from '../lib/ui';
import { businessDateKey } from '../lib/date';
import type { FamilyStatCard } from '../features/family/FamilySettings';
import {
  buildHomeDashboardViewModel,
  buildHomeHighlightsViewModel,
  buildHomeRequiredActions,
  type HomeRestockFormState,
} from '../features/home/homeDashboardModel';

type HomeActivityHighlightsInput = {
  data?: ActivityHighlightsResponse;
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
};

type UseAppHomeViewModelArgs = {
  user: UserSummary | null;
  membershipRole?: string | null;
  family: FamilyDetail | null | undefined;
  members: Member[];
  memberEditMemberId: string;
  ingredients: Ingredient[];
  inventoryItems: InventoryItem[];
  inventoryStates?: IngredientInventoryState[];
  shoppingItems: ShoppingListItem[];
  recipes: Recipe[];
  foods: Food[];
  foodPlanItems: FoodPlanItem[];
  foodRecommendations: FoodRecommendations | null;
  mealLogs: MealLog[];
  activityLogs: ActivityLog[];
  activityHighlights: HomeActivityHighlightsInput;
  dashboardRecommendationPage: number;
  desktopRecommendationCursor?: number;
  mobileRecommendationCursor?: number;
  selectedDashboardPlanDate: string;
  foodPlanWeekRange: { start: string; end: string };
  homePlanDetailItemId: string | null;
  homePlanAddFoodId: string | null;
  homePlanAddFoodSearch: string;
  homeRestockShoppingItemId: string | null;
  homeMealDetailId: string | null;
  homeRestockForm: HomeRestockFormState | null;
  /** Optional prebuilt groups so App can share one projection with home state. */
  inventoryActionGroups?: InventoryActionGroup[];
  resolveDashboardAssetUrl: (url?: string) => string | undefined;
  now?: Date;
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
  const businessDate = businessDateKey(args.now ?? new Date(), 'Asia/Shanghai');
  const inventoryActionGroups = args.inventoryActionGroups ?? buildInventoryActionGroups({
    inventoryItems: args.inventoryItems,
    inventoryStates: args.inventoryStates ?? [],
    ingredients: args.ingredients,
    shoppingItems: args.shoppingItems,
    referenceDate: businessDate,
  });
  const availableIngredientCount = countUniqueAvailableIngredients({
    inventoryItems: args.inventoryItems,
    inventoryStates: args.inventoryStates ?? [],
    referenceDate: businessDate,
  });
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
  const homeHighlightsViewModel = buildHomeHighlightsViewModel(args.activityHighlights);
  const sidebarActivityLabel = homeHighlightsViewModel.weekCountLabel;
  const sidebarUserMeta = currentUser?.username ? `${sidebarRoleLabel} · ${currentUser.username}` : sidebarRoleLabel;
  const sidebarUserNote = args.family?.location
    ? `${args.family.location} · ${sidebarFamilyName}`
    : sidebarFamilyName;
  const today = businessDate;
  const dashboardViewModel = buildHomeDashboardViewModel({
    inventoryItems: args.inventoryItems,
    inventoryActionGroups,
    availableIngredientCount,
    shoppingItems: args.shoppingItems,
    foodPlanItems: args.foodPlanItems,
    foodRecommendations: args.foodRecommendations,
    recipes: args.recipes,
    mealLogs: args.mealLogs,
    today,
    dashboardRecommendationPage: args.dashboardRecommendationPage,
    desktopRecommendationCursor: args.desktopRecommendationCursor,
    mobileRecommendationCursor: args.mobileRecommendationCursor,
    selectedDashboardPlanDate: args.selectedDashboardPlanDate,
    foodPlanWeekRange: args.foodPlanWeekRange,
  });
  const {
    actions: homeRequiredActions,
    hasMoreHomeActions,
  } = buildHomeRequiredActions({
    inventoryGroups: dashboardViewModel.homeEligibleInventoryActionGroups,
    pendingShoppingCount: dashboardViewModel.pendingShoppingCount,
  });
  const homeRestockShoppingItem = args.homeRestockShoppingItemId
    ? args.shoppingItems.find((item) => item.id === args.homeRestockShoppingItemId) ?? null
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

  // Temporary compatibility for pre-Task-7B home UI props; badge/count use grouped actions.
  const inventoryAlerts = dashboardViewModel.homeEligibleInventoryActionGroups.map((group) => ({
    id: group.id,
    title: group.title,
    detail: group.detail,
    tone: group.kind === 'low_stock' ? ('warning' as const) : ('danger' as const),
  }));

  return {
    homePlanDetailItem,
    homePlanDetailFood,
    homePlanAddFood,
    homePlanAddFoodOptions,
    currentUser,
    isOwner,
    inventoryActionGroups,
    inventoryAlerts,
    businessDateKey: businessDate,
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
    homeHighlightsViewModel,
    homeRequiredActions,
    hasMoreHomeActions,
    homeRestockShoppingItem,
    homeMealDetail,
    homeMealDetailParticipants,
    homeRestockIngredient,
    homeRestockIngredientImageUrl,
  };
}
