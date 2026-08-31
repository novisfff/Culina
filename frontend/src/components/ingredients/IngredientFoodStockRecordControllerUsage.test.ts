import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Ingredient food-stock record controller ownership', () => {
  it('owns ordinary record and inventory follow-up overlays outside the workspace', () => {
    const workspace = readFileSync(resolve(__dirname, 'IngredientWorkspace.tsx'), 'utf8');
    const controller = readFileSync(resolve(__dirname, 'IngredientFoodStockRecordController.tsx'), 'utf8');

    expect(workspace).toContain('<IngredientFoodStockRecordController');
    expect(workspace).not.toContain('<MealQuickRecordView');
    expect(workspace).not.toContain('<IngredientFoodStockDialogs');
    expect(controller).toContain('<MealQuickRecordView');
    expect(controller).toContain('<IngredientFoodStockDialogs');
  });
});
