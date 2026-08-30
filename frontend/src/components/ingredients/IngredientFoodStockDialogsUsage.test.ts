import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('IngredientWorkspace food-stock dialog ownership', () => {
  it('delegates food-stock overlays to the focused dialog view', () => {
    const workspaceSource = readFileSync(resolve(__dirname, 'IngredientWorkspace.tsx'), 'utf8');
    const controllerSource = readFileSync(resolve(__dirname, 'IngredientFoodStockRecordController.tsx'), 'utf8');
    const dialogSource = readFileSync(resolve(__dirname, 'IngredientFoodStockDialogs.tsx'), 'utf8');

    expect(workspaceSource).toContain('<IngredientFoodStockRecordController');
    expect(workspaceSource).not.toContain('ingredients-food-stock-restock-section');
    expect(controllerSource).toContain('<IngredientFoodStockDialogs');
    expect(dialogSource).toContain('export function IngredientFoodStockDialogs');
    expect(dialogSource).toContain('submitFoodStockAdjustDialog');
  });
});
