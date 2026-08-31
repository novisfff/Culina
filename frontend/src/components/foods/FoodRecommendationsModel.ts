import type { Food, MealType, Recipe } from '../../api/types/food';
import type { MealLog } from '../../api/types/meal';
import { MEAL_TYPE_LABELS, todayKey } from '../../lib/ui';
import { getSuggestedMealTypeForHour } from './FoodWorkspaceModel';
import {
  getDaysSince, getDaysUntil, getDefaultMealType, getFoodMealHistory, getMealUsage,
  getFoodSceneTags, isFoodExpiring, isFoodMissingDecisionInfo, normalizeFoodType,
  type NormalizedFoodType,
} from './FoodWorkspaceHelpers';

export type TodayFoodRecommendation = { food: Food; mealType: MealType; score: number; reasons: string[] };

export function buildTodayFoodRecommendations(foods: Food[], mealLogs: MealLog[], options: { mealType?: MealType; today?: string; recipes?: Recipe[] } = {}): TodayFoodRecommendation[] {
  const mealType = options.mealType ?? getSuggestedMealTypeForHour();
  const today = options.today ?? todayKey();
  const recipes = options.recipes ?? [];
  const foodsById = new Map(foods.map((food) => [food.id, food]));
  const recentTypeCounts = new Map<NormalizedFoodType, number>();
  mealLogs.filter((log) => { const daysSince = getDaysSince(log.date, today); return daysSince >= 0 && daysSince <= 3; }).forEach((log) => {
    log.food_entries.forEach((entry) => { const food = foodsById.get(entry.food_id); if (!food) return; const type = normalizeFoodType(food); recentTypeCounts.set(type, (recentTypeCounts.get(type) ?? 0) + 1); });
  });
  const dominantRecentType = Array.from(recentTypeCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const scored = foods.map((food) => {
    const usage = getMealUsage(food, mealLogs); const normalizedType = normalizeFoodType(food); const reasons: string[] = []; let score = 0;
    if (food.suitable_meal_types.includes(mealType)) { score += 130; reasons.push(`适合${MEAL_TYPE_LABELS[mealType]}`); }
    else if (food.suitable_meal_types.some((meal) => meal === 'lunch' || meal === 'dinner')) { score += 45; reasons.push('适合正餐'); }
    else if (food.suitable_meal_types.length === 0) { score -= 70; reasons.push('未设置餐别'); }
    const daysUntilExpiry = getDaysUntil(food.expiry_date); const expiring = isFoodExpiring(food);
    if (expiring) { const expiryScore = daysUntilExpiry == null ? 0 : daysUntilExpiry <= 0 ? 250 : daysUntilExpiry <= 3 ? 220 : 170; score += expiryScore; reasons.push(daysUntilExpiry == null || daysUntilExpiry > 0 ? '临期，建议优先处理' : '今天需要处理'); }
    if (usage.last) { const daysSinceLast = getDaysSince(usage.last, today); const recentPenalty = daysSinceLast < 0 ? 0 : daysSinceLast <= 1 ? 160 : daysSinceLast <= 3 ? 90 : daysSinceLast <= 5 ? 45 : 0; if (recentPenalty > 0) { score -= expiring ? Math.round(recentPenalty * 0.45) : recentPenalty; reasons.push('最近吃过，暂不优先推荐'); } }
    if (food.favorite) { score += 55; reasons.push('收藏'); }
    if (usage.count >= 3) { score += 35; reasons.push('常吃'); } else if (usage.count > 0) score += usage.count * 8;
    if (food.rating != null) { score += food.rating >= 4 ? 55 : food.rating >= 3 ? 25 : -20; if (food.rating >= 4) reasons.push('高评分'); }
    if (food.repurchase === true) { score += 45; reasons.push('想再吃'); }
    if (food.repurchase === false) { score -= 90; reasons.push('近期不想再吃'); }
    if (dominantRecentType && normalizedType === dominantRecentType && !expiring) score -= 35;
    else if (dominantRecentType && normalizedType !== dominantRecentType) { score += 20; reasons.push('换一种类型'); }
    if (isFoodMissingDecisionInfo(food, recipes)) score -= 25;
    return { food, mealType: food.suitable_meal_types.includes(mealType) ? mealType : getDefaultMealType(food), score, reasons: (reasons.length > 0 ? reasons : ['可作为备选']).slice(0, 4) };
  }).sort((a, b) => b.score - a.score || b.food.updated_at.localeCompare(a.food.updated_at));
  const diverse: TodayFoodRecommendation[] = [];
  scored.forEach((item) => { if (diverse.length >= 3) return; const type = normalizeFoodType(item.food); if (diverse.length === 0 || !diverse.some((selected) => normalizeFoodType(selected.food) === type)) diverse.push(item); });
  scored.forEach((item) => { if (diverse.length >= 3) return; if (!diverse.some((selected) => selected.food.id === item.food.id)) diverse.push(item); });
  return diverse;
}
