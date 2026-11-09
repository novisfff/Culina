import type { FoodPlanItem } from '../api/types/food';

export function isFoodPlanRecorded(item: Pick<FoodPlanItem, 'meal_log_id'>): boolean {
  return Boolean(item.meal_log_id);
}
