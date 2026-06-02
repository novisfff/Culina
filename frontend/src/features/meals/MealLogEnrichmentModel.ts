import type { FoodPlanItem, MealLog, UpdateMealLogPayload } from '../../api/types';
import { formatDate } from '../../lib/ui';

export type MealSource = {
  label: string;
  status: 'planned' | 'manual';
  planItem?: FoodPlanItem;
};

export const MAX_MEAL_PHOTOS = 6;

export function isMealLogEnriched(meal: MealLog) {
  return Boolean(
    meal.notes.trim() ||
      meal.photos.length > 0 ||
      meal.food_entries.some((entry) => entry.rating != null)
  );
}

export function resolveMealSource(meal: MealLog, foodPlanItems: FoodPlanItem[]): MealSource {
  const planItem = foodPlanItems.find((item) => item.meal_log_id === meal.id);
  if (!planItem) return { label: '手动补录', status: 'manual' };
  return { label: `来自菜单 · ${formatDate(planItem.plan_date)}`, status: 'planned', planItem };
}

export function buildMealTitle(meal: MealLog) {
  return meal.food_entries.map((entry) => entry.food_name).filter(Boolean).join('、') || '未关联食物';
}

export function formatMealRatingValue(rating: number) {
  return `${rating.toFixed(1).replace(/\.0$/, '')} 分`;
}

export function parseMealRatingValue(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function getMealRatingSummary(meal: MealLog) {
  const ratings = meal.food_entries
    .map((entry) => entry.rating)
    .filter((rating): rating is number => typeof rating === 'number' && Number.isFinite(rating));
  if (ratings.length === 0) return meal.mood.trim();
  if (ratings.length === 1) return formatMealRatingValue(ratings[0]);
  const average = ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length;
  return `${formatMealRatingValue(average)} · ${ratings.length} 道菜`;
}

export function buildMealEntryRatingDraft(meal: MealLog) {
  return Object.fromEntries(meal.food_entries.map((entry) => [entry.id, entry.rating == null ? '' : String(entry.rating)]));
}

export function buildUpdateMealLogPayload(args: {
  meal: MealLog;
  participants: string[];
  notes: string;
  entryRatings: Record<string, string>;
  mediaIds?: string[];
}): UpdateMealLogPayload {
  const foodEntryRatings = args.meal.food_entries.map((entry) => ({
    id: entry.id,
    rating: parseMealRatingValue(args.entryRatings[entry.id] ?? ''),
  }));
  const ratedValues = foodEntryRatings
    .map((entry) => entry.rating)
    .filter((rating): rating is number => rating !== null);
  const averageRating = ratedValues.length > 0 ? ratedValues.reduce((sum, rating) => sum + rating, 0) / ratedValues.length : null;

  return {
    participant_user_ids: args.participants,
    notes: args.notes.trim(),
    mood: averageRating == null ? '' : formatMealRatingValue(averageRating),
    food_entry_ratings: foodEntryRatings,
    ...(args.mediaIds ? { media_ids: args.mediaIds } : {}),
  };
}
