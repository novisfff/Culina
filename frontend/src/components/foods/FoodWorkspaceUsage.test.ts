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

    expect(appNavigationSource).toContain("target?: 'detail' | 'edit' | 'quickMeal'");
    expect(appNavigationSource).toContain("quickMealAction?: 'eat' | 'cook'");
    expect(stateSource).toContain("args.navigationRequest?.target === 'edit'");
    expect(stateSource).toContain("args.navigationRequest?.target === 'quickMeal'");
    expect(workspaceSource).toContain('resolveFoodNavigationRequestAction');
    expect(workspaceSource).toContain('handledNavigationRequestIdRef');
    expect(workspaceSource).toContain("quickMealAction: navigationRequest.quickMealAction ?? 'eat'");
    expect(stateSource).toContain('expected_row_version: editingFood.row_version');
    expect(workspaceSource).toMatch(/updateFoodFavorite\(food\.id, !food\.favorite, food\.row_version\)/);
    expect(workspaceSource).toContain('expected_food_row_version: food.row_version');
  });

  it('exports focused Food surfaces and keeps the compatibility workspace as an adapter', () => {
    const discoverSource = readSource('FoodDiscoverSurface.tsx');
    const planSource = readSource('FoodPlanSurface.tsx');
    const workspaceSource = readSource('FoodWorkspace.tsx');
    const hubSource = readSource('FoodHubView.tsx');
    const mobileSource = readSource('FoodMobileView.tsx');

    expect(discoverSource).toContain('export function FoodDiscoverSurface');
    expect(planSource).toContain('export function FoodPlanSurface');
    expect(workspaceSource).toContain('<FoodDiscoverSurface');
    expect(workspaceSource).toContain('<FoodPlanSurface');
    expect(workspaceSource).toContain("surface === 'plan'");
    expect(discoverSource).not.toContain('<AppShell');
    expect(planSource).not.toContain('<AppShell');
    expect(hubSource).not.toContain('title="食物"');
    expect(mobileSource).not.toMatch(/<h1>\s*食物\s*<\/h1>/);
  });
});
