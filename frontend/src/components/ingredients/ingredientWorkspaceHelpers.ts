import type { MealType } from '../../api/types/meal';
import type { ShoppingListItem } from '../../api/types/inventory';

export function createClientRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `meal-record-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function getDefaultFoodStockMealType(hour = new Date().getHours()): MealType {
  if (hour >= 5 && hour < 10) return 'breakfast';
  if (hour >= 10 && hour < 15) return 'lunch';
  if (hour >= 15 && hour < 21) return 'dinner';
  return 'snack';
}

export function resolveErrorMessage(reason: unknown, fallback: string) {
  return reason instanceof Error && reason.message.trim() ? reason.message : fallback;
}

export function isPendingShopping(item: ShoppingListItem) {
  return !item.done;
}
