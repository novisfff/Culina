import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('IngredientWorkspace food-stock action ownership', () => {
  it('owns its query client inside the action hook', () => {
    const actionSource = readFileSync(resolve(__dirname, 'useIngredientFoodStockActions.ts'), 'utf8');
    expect(actionSource).toContain('useQueryClient');
    expect(actionSource).not.toContain('queryClient: QueryClient');
  });

  it('keeps inventory mutations in the focused action hook', () => {
    const workspaceSource = readFileSync(resolve(__dirname, 'IngredientWorkspace.tsx'), 'utf8');
    const actionSource = readFileSync(resolve(__dirname, 'useIngredientFoodStockActions.ts'), 'utf8');
    expect(workspaceSource).toContain('useIngredientFoodStockActions');
    expect(workspaceSource).not.toContain('api.consumeFoodStock');
    expect(workspaceSource).not.toContain('api.restockFoodStock');
    expect(actionSource).toContain('api.consumeFoodStock');
    expect(actionSource).toContain('api.restockFoodStock');
    expect(actionSource).toContain('invalidateAfterFoodChanged');
  });
});
