import type { FoodPlanItem, MealLog, Member } from '../../api/types';
import { addDateKeyDays } from '../../lib/date';
import { formatDate, todayKey } from '../../lib/ui';
import { buildMealTitle, getMealRatingSummary, isMealLogEnriched, resolveMealSource, type MealSource } from './MealLogEnrichmentModel';

export type MealLogStatusFilter = 'all' | 'pending' | 'done';
export type MealLogMealFilter = 'all' | 'breakfast' | 'lunch' | 'dinner' | 'snack';

export type MealRecordPresentation = {
  validity: 'valid';
  enrichment: 'basic' | 'enriched';
  actionLabel: '补充这餐' | '查看这餐';
};

export const STATUS_FILTERS: Array<{ key: MealLogStatusFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'pending', label: '基础记录' },
  { key: 'done', label: '已丰富' },
];

export const MEAL_FILTERS: Array<{ key: MealLogMealFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'breakfast', label: '早餐' },
  { key: 'lunch', label: '午餐' },
  { key: 'dinner', label: '晚餐' },
  { key: 'snack', label: '加餐' },
];

export function getMealRecordPresentation(meal: MealLog): MealRecordPresentation {
  const hasEnrichment = Boolean(
    meal.photos.length ||
      meal.notes.trim() ||
      meal.mood.trim() ||
      meal.food_entries.some((entry) => entry.rating != null),
  );
  return {
    validity: 'valid',
    enrichment: hasEnrichment ? 'enriched' : 'basic',
    actionLabel: hasEnrichment ? '查看这餐' : '补充这餐',
  };
}

export function getMealLogStatus(meal: MealLog) {
  return getMealRecordPresentation(meal).enrichment === 'enriched' ? 'done' : 'pending';
}

export function getMealLogStatusLabel(meal: MealLog) {
  return getMealRecordPresentation(meal).enrichment === 'enriched' ? '已丰富' : '基础记录';
}

/** Prefer newest date, then newest created_at. Never prioritizes basic over enriched. */
export function selectInitialMeal(meals: MealLog[]): MealLog | null {
  if (meals.length === 0) return null;
  return [...meals].sort((left, right) => {
    if (left.date !== right.date) {
      return right.date.localeCompare(left.date);
    }
    return right.created_at.localeCompare(left.created_at);
  })[0] ?? null;
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
  const basicMeals = args.recentMeals
    .filter((meal) => getMealRecordPresentation(meal).enrichment === 'basic')
    .slice(0, 5);
  const todayMeals = args.recentMeals.filter((meal) => meal.date === todayKey());
  const enrichedCount = args.recentMeals.filter(
    (meal) => getMealRecordPresentation(meal).enrichment === 'enriched',
  ).length;
  const weekRecordCount = getWeekRecordCount(args.recentMeals);
  const selectedMeal =
    args.recentMeals.find((meal) => meal.id === args.selectedMealId) ??
    selectInitialMeal(args.recentMeals) ??
    null;
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
    basicMeals,
    /** @deprecated alias for basicMeals — kept for temporary call sites during surface extraction */
    pendingMeals: basicMeals,
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
