import type { MealLog, Member } from '../../api/types';
import { addDateKeyDays } from '../../lib/date';
import { formatDate, todayKey } from '../../lib/ui';
import { buildMealTitle, getMealRatingSummary } from './MealLogEnrichmentModel';

export type MealLogMealFilter = 'all' | 'breakfast' | 'lunch' | 'dinner' | 'snack';

export const MEAL_FILTERS: Array<{ key: MealLogMealFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'breakfast', label: '早餐' },
  { key: 'lunch', label: '午餐' },
  { key: 'dinner', label: '晚餐' },
  { key: 'snack', label: '加餐' },
];

/** Prefer newest date, then newest created_at. */
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

/** Participant count only when present. */
export function getMealParticipantCount(meal: MealLog): number | null {
  return meal.participant_user_ids.length > 0 ? meal.participant_user_ids.length : null;
}

/** Media count only when present. */
export function getMealMediaCount(meal: MealLog): number | null {
  return meal.photos.length > 0 ? meal.photos.length : null;
}

/** Rating summary only when a meaningful value is present. */
export function getMealRatingValue(meal: MealLog): string | null {
  const summary = getMealRatingSummary(meal).trim();
  return summary ? summary : null;
}

export function getWeekRecordCount(meals: MealLog[]) {
  const today = todayKey();
  const weekStartKey = addDateKeyDays(today, -6);
  return meals.filter((meal) => meal.date >= weekStartKey && meal.date <= today).length;
}

export function filterMealLogs(args: {
  meals: MealLog[];
  searchQuery: string;
  mealFilter: MealLogMealFilter;
}) {
  const query = args.searchQuery.trim().toLowerCase();
  return args.meals.filter((meal) => {
    const haystack = `${buildMealTitle(meal)} ${meal.notes}`.toLowerCase();
    const matchesSearch = !query || haystack.includes(query);
    const matchesMeal = args.mealFilter === 'all' || meal.meal_type === args.mealFilter;
    return matchesSearch && matchesMeal;
  });
}

export function buildMealLogWorkspaceViewModel(args: {
  recentMeals: MealLog[];
  members: Member[];
  selectedMealId: string | null;
  searchQuery: string;
  mealFilter: MealLogMealFilter;
}) {
  const todayMeals = args.recentMeals.filter((meal) => meal.date === todayKey());
  const weekRecordCount = getWeekRecordCount(args.recentMeals);
  const selectedMeal =
    args.recentMeals.find((meal) => meal.id === args.selectedMealId) ??
    selectInitialMeal(args.recentMeals) ??
    null;
  const selectedParticipantMembers = selectedMeal ? getParticipantMembers(selectedMeal, args.members) : [];
  const filteredMeals = filterMealLogs({
    meals: args.recentMeals,
    searchQuery: args.searchQuery,
    mealFilter: args.mealFilter,
  });

  return {
    todayMeals,
    weekRecordCount,
    selectedMeal,
    selectedParticipantMembers,
    selectedRatingValue: selectedMeal ? getMealRatingValue(selectedMeal) : null,
    selectedParticipantCount: selectedMeal ? getMealParticipantCount(selectedMeal) : null,
    selectedMediaCount: selectedMeal ? getMealMediaCount(selectedMeal) : null,
    groupedMeals: groupMealsByDate(filteredMeals),
  };
}

export { buildMealTitle, getMealRatingSummary };
