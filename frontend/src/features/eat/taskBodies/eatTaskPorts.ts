export type EatTaskContentSlot = 'foodTaskContent' | 'recipeTaskContent' | 'planTaskContent' | 'cookTaskContent' | 'mealTaskContent' | 'mealCreateContent';
export function resolveEatTaskSlot(kind: string): EatTaskContentSlot | null {
  const slots: Record<string, EatTaskContentSlot> = { food: 'foodTaskContent', 'ready-recipe': 'recipeTaskContent', plan: 'planTaskContent', cook: 'cookTaskContent', meal: 'mealTaskContent', 'meal-create': 'mealCreateContent' };
  return slots[kind] ?? null;
}
