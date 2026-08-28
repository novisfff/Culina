import { describe, expect, it } from 'vitest';
import { resolveEatTaskSlot } from './taskBodies/eatTaskPorts';
describe('Eat task body routing', () => {
  it.each([
    ['food', 'foodTaskContent'], ['ready-recipe', 'recipeTaskContent'], ['plan', 'planTaskContent'],
    ['cook', 'cookTaskContent'], ['meal', 'mealTaskContent'], ['meal-create', 'mealCreateContent'],
  ] as const)('maps %s to its single content slot', (kind, slot) => {
    expect(resolveEatTaskSlot(kind)).toBe(slot);
  });
});
