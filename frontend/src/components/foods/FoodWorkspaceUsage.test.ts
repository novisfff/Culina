// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '../../..');
const foodsDir = resolve(repoRoot, 'src/components/foods');

function readSource(fileName: string) {
  return readFileSync(resolve(foodsDir, fileName), 'utf8');
}

describe('FoodWorkspace navigation usage', () => {


  it('supports edit and quick-meal navigation requests from other workspaces', () => {
    const appNavigationSource = readFileSync(resolve(repoRoot, 'src/app/useAppGlobalSearchNavigation.ts'), 'utf8');
    const stateSource = readFileSync(resolve(repoRoot, 'src/components/foods/useFoodWorkspaceState.ts'), 'utf8');
    const workspaceSource = readSource('FoodWorkspace.tsx');
    const navigationModelSource = readSource('FoodNavigationModel.ts');
    const navigationHookSource = readSource('useFoodNavigationRequests.ts');

    expect(appNavigationSource).toContain("target?: 'detail' | 'edit' | 'quickMeal'");
    expect(appNavigationSource).toContain("quickMealAction?: 'eat' | 'cook'");
    // Global search emits semantic food targets, not Food request IDs.
    expect(appNavigationSource).toContain("args.navigate({ workspace: 'eat', view: 'food', foodId: selection.entityId })");
    expect(appNavigationSource).not.toContain('setFoodNavigationRequest');
    expect(stateSource).toContain("args.navigationRequest?.target === 'edit'");
    expect(stateSource).toContain("args.navigationRequest?.target === 'quickMeal'");
    expect(navigationModelSource).toContain('resolveFoodNavigationRequestAction');
    expect(navigationHookSource).toContain('handledRequestIdRef');
    expect(navigationModelSource).toContain("quickMealAction: navigationRequest.quickMealAction ?? 'eat'");
    expect(stateSource).toContain('expected_row_version: editingFood.row_version');
    expect(workspaceSource).toMatch(/updateFoodFavorite\(food\.id, !food\.favorite, food\.row_version\)/);
    // Ordinary Food recording uses recordMeal + MealQuickRecordView; stock is a separate command.
    expect(workspaceSource).toContain('recordMeal');
    expect(workspaceSource).toContain('MealQuickRecordView');
    expect(workspaceSource).not.toContain('expected_food_row_version: food.row_version');
    expect(workspaceSource).not.toContain('deduct_food_stock');
  });


  it('keeps the independently scrolling food list out of browser scroll anchoring', () => {
    const foodCss = readFileSync(resolve(repoRoot, 'src/styles/06-food-workspace.css'), 'utf8');

    expect(foodCss).toMatch(
      /@media \(min-width: 1024px\)[\s\S]*?\.food-content-main\s*\{[^}]*overflow-anchor:\s*none;/,
    );
  });


});
