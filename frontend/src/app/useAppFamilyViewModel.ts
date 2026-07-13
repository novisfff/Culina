import type {
  FamilyDetail,
  Food,
  MealLog,
  Member,
  MembershipSummary,
  Recipe,
  ShoppingListItem,
  UserSummary,
} from '../api/types';
import type { FamilyActivityQueryState } from '../features/family/FamilyActivityViewerModel';
import type { FamilyStatCard } from '../features/family/FamilySettings';
import { getFoodCover } from '../lib/ui';

export function buildAppFamilyViewModel(input: FamilyActivityQueryState & {
  currentUserId?: string;
  now?: Date;
}) {
  const hasData = input.data !== undefined;
  const logs = input.data ?? [];
  const nowMs = (input.now ?? new Date()).getTime();
  const weekActivityValue = logs.filter((log) => {
    const timestamp = Date.parse(log.created_at);
    return Number.isFinite(timestamp) && nowMs - timestamp <= 7 * 24 * 60 * 60 * 1000;
  }).length;
  const activityPhase: 'loading' | 'empty' | 'ready' | 'error' = hasData
    ? (logs.length === 0 ? 'empty' : 'ready')
    : input.isError
      ? 'error'
      : 'loading';
  return {
    logs,
    activityPhase,
    hasRefreshError: hasData && input.isError,
    currentUserRecentLogs: hasData
      ? logs.filter((log) => log.actor_id === input.currentUserId).length
      : null,
    weekActivityValue: hasData ? weekActivityValue : '--' as const,
  };
}

export function buildFamilyStatCards(input: {
  members: Member[];
  isOwner: boolean;
  pendingShoppingCount: number;
  currentUserRecentLogs: number | null;
  weekActivityValue: number | '--';
  family?: FamilyDetail | null;
}): FamilyStatCard[] {
  return [
    {
      label: '家庭成员',
      value: input.members.length,
      unit: '人',
      detail: '一起管理厨房',
      icon: 'family',
      tone: 'green',
    },
    {
      label: input.isOwner ? '待处理采购' : '我的记录',
      value: input.isOwner
        ? input.pendingShoppingCount
        : (input.currentUserRecentLogs ?? '--'),
      unit: input.isOwner ? '项' : '次',
      detail: input.isOwner ? '等待家人确认' : '今日参与协作',
      icon: input.isOwner ? 'mail' : 'edit',
      tone: 'orange',
    },
    {
      label: '本周协作',
      value: input.weekActivityValue,
      unit: '次',
      detail: '做菜、采购和记录',
      icon: 'bar-chart',
      tone: 'yellow',
    },
    {
      label: '家庭资料',
      value: input.family?.location || '未填写',
      unit: '',
      detail: input.family?.motto || '补充口号和位置',
      icon: 'map-pin',
      tone: 'purple',
    },
  ];
}

export function useAppFamilyViewModel(args: {
  activityQuery: FamilyActivityQueryState;
  user: UserSummary | null;
  membership?: MembershipSummary | null;
  family?: FamilyDetail | null;
  members: Member[];
  shoppingItems: ShoppingListItem[];
  mealLogs: MealLog[];
  foods: Food[];
  recipes: Recipe[];
  now?: Date;
}) {
  const isOwner = args.membership?.role === 'Owner';
  const pendingShoppingCount = args.shoppingItems.filter((item) => !item.done).length;
  const activityModel = buildAppFamilyViewModel({
    ...args.activityQuery,
    currentUserId: args.user?.id,
    now: args.now,
  });
  const familyOwnerMember = args.members.find((member) => member.role === 'Owner') ?? args.members[0];
  const recentMeals = [...args.mealLogs].slice(0, 6);
  const familyHeroImageUrl =
    args.family?.image?.url ??
    recentMeals.find((item) => item.photos[0])?.photos[0]?.url ??
    args.foods.map((food) => getFoodCover(food, args.recipes)).find(Boolean) ??
    '/images/family-kitchen-cover.jpg';
  const familyStatCards = buildFamilyStatCards({
    members: args.members,
    isOwner,
    pendingShoppingCount,
    currentUserRecentLogs: activityModel.currentUserRecentLogs,
    weekActivityValue: activityModel.weekActivityValue,
    family: args.family,
  });

  return {
    ...activityModel,
    isOwner,
    pendingShoppingCount,
    familyOwnerMember,
    familyHeroImageUrl,
    familyStatCards,
  };
}
