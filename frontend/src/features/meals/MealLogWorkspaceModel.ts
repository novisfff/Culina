import type { FoodPlanItem, MealLog, Member } from '../../api/types';
import { addDateKeyDays } from '../../lib/date';
import { formatDate, todayKey } from '../../lib/ui';
import { buildMealTitle, getMealRatingSummary, isMealLogEnriched, resolveMealSource, type MealSource } from './MealLogEnrichmentModel';

export type MealLogStatusFilter = 'all' | 'pending' | 'done';
export type MealLogMealFilter = 'all' | 'breakfast' | 'lunch' | 'dinner' | 'snack';

export const STATUS_FILTERS: Array<{ key: MealLogStatusFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'pending', label: '待补充' },
  { key: 'done', label: '已补充' },
];

export const MEAL_FILTERS: Array<{ key: MealLogMealFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'breakfast', label: '早餐' },
  { key: 'lunch', label: '午餐' },
  { key: 'dinner', label: '晚餐' },
  { key: 'snack', label: '加餐' },
];

export function getMealLogStatus(meal: MealLog) {
  if (isMealLogEnriched(meal)) return 'done';
  return 'pending';
}

export function getMealLogStatusLabel(meal: MealLog) {
  const status = getMealLogStatus(meal);
  return status === 'done' ? '已补充' : '待补充';
}

export function getMealIconName(mealType: MealLogMealFilter) {
  if (mealType === 'all') return 'all';
  return mealType;
}

export type MealToneClass = 'meal-tone-breakfast' | 'meal-tone-lunch' | 'meal-tone-dinner' | 'meal-tone-snack';

const MEAL_TONE_CLASSES: Record<MealLog['meal_type'], MealToneClass> = {
  breakfast: 'meal-tone-breakfast',
  lunch: 'meal-tone-lunch',
  dinner: 'meal-tone-dinner',
  snack: 'meal-tone-snack',
};

export function getMealTone(mealType: MealLog['meal_type']): MealToneClass {
  return MEAL_TONE_CLASSES[mealType];
}

export function formatMealTime(meal: MealLog) {
  const date = new Date(meal.created_at);
  if (Number.isNaN(date.getTime())) return '--:--';
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

export function formatDateGroupLabel(dateKey: string) {
  if (dateKey === todayKey()) return `今天 · ${formatDate(dateKey)}`;
  return formatDate(dateKey);
}

export function groupMealsByDate(meals: MealLog[]) {
  const groups = new Map<string, MealLog[]>();
  for (const meal of meals) {
    const items = groups.get(meal.date);
    if (items) {
      items.push(meal);
      continue;
    }
    groups.set(meal.date, [meal]);
  }
  return Array.from(groups, ([date, items]) => ({ date, meals: items }));
}

export function getParticipantMembers(meal: MealLog, members: Member[]) {
  return meal.participant_user_ids
    .map((id) => members.find((member) => member.id === id))
    .filter((member): member is Member => Boolean(member));
}

export function getWeekRecordCount(meals: MealLog[]) {
  const today = todayKey();
  const weekStartKey = addDateKeyDays(today, -6);
  return meals.filter((meal) => meal.date >= weekStartKey && meal.date <= today).length;
}

export function buildMealSources(meals: MealLog[], foodPlanItems: FoodPlanItem[]) {
  return new Map(meals.map((meal) => [meal.id, resolveMealSource(meal, foodPlanItems)]));
}

export function filterMealLogs(args: {
  meals: MealLog[];
  mealSources: Map<string, MealSource>;
  searchQuery: string;
  statusFilter: MealLogStatusFilter;
  mealFilter: MealLogMealFilter;
}) {
  const query = args.searchQuery.trim().toLowerCase();
  return args.meals.filter((meal) => {
    const source = args.mealSources.get(meal.id);
    const haystack = `${buildMealTitle(meal)} ${meal.notes} ${source?.label ?? ''}`.toLowerCase();
    const matchesSearch = !query || haystack.includes(query);
    const matchesStatus = args.statusFilter === 'all' || getMealLogStatus(meal) === args.statusFilter;
    const matchesMeal = args.mealFilter === 'all' || meal.meal_type === args.mealFilter;
    return matchesSearch && matchesStatus && matchesMeal;
  });
}

export function buildMealLogWorkspaceViewModel(args: {
  recentMeals: MealLog[];
  foodPlanItems: FoodPlanItem[];
  members: Member[];
  selectedMealId: string | null;
  searchQuery: string;
  statusFilter: MealLogStatusFilter;
  mealFilter: MealLogMealFilter;
}) {
  const mealSources = buildMealSources(args.recentMeals, args.foodPlanItems);
  const pendingMeals = args.recentMeals.filter((meal) => !isMealLogEnriched(meal)).slice(0, 5);
  const todayMeals = args.recentMeals.filter((meal) => meal.date === todayKey());
  const enrichedCount = args.recentMeals.filter(isMealLogEnriched).length;
  const weekRecordCount = getWeekRecordCount(args.recentMeals);
  const selectedMeal = args.recentMeals.find((meal) => meal.id === args.selectedMealId) ?? pendingMeals[0] ?? args.recentMeals[0] ?? null;
  const selectedSource = selectedMeal ? (mealSources.get(selectedMeal.id) ?? null) : null;
  const selectedParticipantMembers = selectedMeal ? getParticipantMembers(selectedMeal, args.members) : [];
  const filteredMeals = filterMealLogs({
    meals: args.recentMeals,
    mealSources,
    searchQuery: args.searchQuery,
    statusFilter: args.statusFilter,
    mealFilter: args.mealFilter,
  });

  return {
    mealSources,
    pendingMeals,
    todayMeals,
    enrichedCount,
    weekRecordCount,
    selectedMeal,
    selectedSource,
    selectedParticipantMembers,
    groupedMeals: groupMealsByDate(filteredMeals),
  };
}

export { buildMealTitle, getMealRatingSummary, isMealLogEnriched, resolveMealSource };
