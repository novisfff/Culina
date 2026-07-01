import type { ActivityLog, ActivityLogQuery, Member } from '../../api/types';
import { addDateKeyDays, getWeekRange, todayKey, toDateKey } from '../../lib/date';

export type FamilyActivityDatePreset = 'all' | 'today' | 'week' | 'month' | 'custom';

export type FamilyActivityFilters = {
  datePreset: FamilyActivityDatePreset;
  startDate: string;
  endDate: string;
  actorId: string;
  action: string;
  entityType: string;
};

export type FamilyActivityOption = {
  value: string;
  label: string;
};

export type FamilyActivityGroup = {
  key: string;
  label: string;
  items: ActivityLog[];
};

export const FAMILY_ACTIVITY_PAGE_SIZE = 50;

export const DEFAULT_FAMILY_ACTIVITY_FILTERS: FamilyActivityFilters = {
  datePreset: 'all',
  startDate: '',
  endDate: '',
  actorId: '',
  action: '',
  entityType: '',
};

export const FAMILY_ACTIVITY_DATE_PRESETS: Array<{ value: FamilyActivityDatePreset; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'today', label: '今天' },
  { value: 'week', label: '本周' },
  { value: 'month', label: '近 30 天' },
  { value: 'custom', label: '自定义' },
];

export const FAMILY_ACTIVITY_ACTION_LABELS: Record<string, string> = {
  create: '新增',
  update: '更新',
  invite: '邀请',
  switch: '切换',
};

export const FAMILY_ACTIVITY_ENTITY_LABELS: Record<string, string> = {
  Family: '家庭',
  Membership: '成员',
  User: '成员',
  Ingredient: '食材',
  InventoryItem: '库存',
  ShoppingListItem: '购物清单',
  Recipe: '菜谱',
  FoodPlanItem: '菜单计划',
  MealLog: '餐食记录',
  Food: '食物',
};

export function familyActivityActionLabel(action: string) {
  return FAMILY_ACTIVITY_ACTION_LABELS[action] ?? action;
}

export function familyActivityEntityLabel(entityType: string) {
  return FAMILY_ACTIVITY_ENTITY_LABELS[entityType] ?? entityType;
}

export function resolveFamilyActivityDateRange(
  filters: FamilyActivityFilters,
  currentDateKey = todayKey()
): Pick<FamilyActivityFilters, 'startDate' | 'endDate'> {
  if (filters.datePreset === 'today') {
    return { startDate: currentDateKey, endDate: currentDateKey };
  }
  if (filters.datePreset === 'week') {
    const range = getWeekRange(currentDateKey);
    return { startDate: range.start, endDate: range.end };
  }
  if (filters.datePreset === 'month') {
    return { startDate: addDateKeyDays(currentDateKey, -29), endDate: currentDateKey };
  }
  if (filters.datePreset === 'custom') {
    return { startDate: filters.startDate, endDate: filters.endDate };
  }
  return { startDate: '', endDate: '' };
}

export function buildFamilyActivityQuery(
  filters: FamilyActivityFilters,
  limit: number,
  currentDateKey = todayKey()
): ActivityLogQuery {
  const range = resolveFamilyActivityDateRange(filters, currentDateKey);
  return {
    start_date: range.startDate || undefined,
    end_date: range.endDate || undefined,
    actor_id: filters.actorId || undefined,
    action: filters.action || undefined,
    entity_type: filters.entityType || undefined,
    limit,
    offset: 0,
  };
}

export function buildFamilyActivityActorOptions(logs: ActivityLog[], members: Member[]): FamilyActivityOption[] {
  const actorNameById = new Map<string, string>();
  members.forEach((member) => actorNameById.set(member.id, member.display_name));
  logs.forEach((log) => {
    if (!actorNameById.has(log.actor_id) && log.actor_name) {
      actorNameById.set(log.actor_id, log.actor_name);
    }
  });
  return Array.from(actorNameById.entries())
    .map(([value, label]) => ({ value, label }))
    .sort((first, second) => first.label.localeCompare(second.label, 'zh-CN'));
}

export function buildFamilyActivityActionOptions(logs: ActivityLog[]): FamilyActivityOption[] {
  return Array.from(new Set(logs.map((log) => log.action).filter(Boolean)))
    .map((value) => ({ value, label: familyActivityActionLabel(value) }))
    .sort((first, second) => first.label.localeCompare(second.label, 'zh-CN'));
}

export function buildFamilyActivityEntityOptions(logs: ActivityLog[]): FamilyActivityOption[] {
  return Array.from(new Set(logs.map((log) => log.entity_type).filter(Boolean)))
    .map((value) => ({ value, label: familyActivityEntityLabel(value) }))
    .sort((first, second) => first.label.localeCompare(second.label, 'zh-CN'));
}

export function groupFamilyActivitiesByDate(logs: ActivityLog[]): FamilyActivityGroup[] {
  const groups = new Map<string, ActivityLog[]>();
  logs.forEach((log) => {
    const key = toDateKey(new Date(log.created_at));
    groups.set(key, [...(groups.get(key) ?? []), log]);
  });

  return Array.from(groups.entries()).map(([key, items]) => ({
    key,
    label: new Intl.DateTimeFormat('zh-CN', {
      month: 'long',
      day: 'numeric',
      weekday: 'short',
    }).format(new Date(`${key}T00:00:00`)),
    items,
  }));
}

export function familyActivityEmptyDescription(hasFilters: boolean) {
  if (hasFilters) {
    return '没有符合筛选条件的家庭活动，可以换个日期或操作人看看。';
  }
  return '记录餐食、采购、食材和家庭资料后，这里会展示协作动态。';
}

export function hasFamilyActivityFilters(filters: FamilyActivityFilters) {
  return (
    filters.datePreset !== 'all' ||
    Boolean(filters.actorId) ||
    Boolean(filters.action) ||
    Boolean(filters.entityType)
  );
}
