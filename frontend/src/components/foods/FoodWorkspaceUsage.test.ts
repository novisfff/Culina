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
    // Global search emits semantic food targets, not Food request IDs.
    expect(appNavigationSource).toContain("args.navigate({ workspace: 'eat', view: 'food', foodId: selection.entityId })");
    expect(appNavigationSource).not.toContain('setFoodNavigationRequest');
    expect(stateSource).toContain("args.navigationRequest?.target === 'edit'");
    expect(stateSource).toContain("args.navigationRequest?.target === 'quickMeal'");
    expect(workspaceSource).toContain('resolveFoodNavigationRequestAction');
    expect(workspaceSource).toContain('handledNavigationRequestIdRef');
    expect(workspaceSource).toContain("quickMealAction: navigationRequest.quickMealAction ?? 'eat'");
    expect(stateSource).toContain('expected_row_version: editingFood.row_version');
    expect(workspaceSource).toMatch(/updateFoodFavorite\(food\.id, !food\.favorite, food\.row_version\)/);
    expect(workspaceSource).toContain('expected_food_row_version: food.row_version');
  });

  it('exports focused Food surfaces and keeps the unified workspace composition', () => {
    const discoverSource = readSource('FoodDiscoverSurface.tsx');
    const planSource = readSource('FoodPlanSurface.tsx');
    const workspaceSource = readSource('FoodWorkspace.tsx');
    const hubSource = readSource('FoodHubView.tsx');
    const mobileSource = readSource('FoodMobileView.tsx');
    const foodCss = readFileSync(resolve(repoRoot, 'src/styles/06-food-workspace.css'), 'utf8');

    expect(discoverSource).toContain('export function FoodDiscoverSurface');
    expect(planSource).toContain('export function FoodPlanSurface');
    expect(workspaceSource).toContain('<FoodDiscoverSurface');
    expect(workspaceSource).toContain('<FoodPlanSurface');
    expect(workspaceSource).not.toContain("surface?: 'discover' | 'plan'");
    expect(workspaceSource).not.toContain("surface === 'plan'");
    expect(discoverSource).not.toContain('<AppShell');
    expect(planSource).not.toContain('<AppShell');
    expect(hubSource).not.toContain('title="食物"');
    expect(mobileSource).not.toMatch(/<h1>\s*食物\s*<\/h1>/);

    // Plan surface root is the sidebar grid item (no anonymous wrapper).
    expect(planSource).toMatch(
      /<section[\s\S]*className="eat-plan-surface food-sidebar-section food-sidebar-plan-section"/,
    );
    expect(planSource).not.toContain('eat-plan-surface-panel');

    // Desktop keeps PageHeader chrome (description + actions) without primary 食物 title.
    expect(hubSource).toContain('<PageHeader');
    expect(hubSource).toContain('variant="compact"');
    expect(hubSource).toContain('actions={props.heroActions}');
    expect(hubSource).toContain('从常吃、临期、外卖外食和可记录的家常菜里快速选一份，马上记到今天。');

    // Discover surface must not break the food-desktop-view height chain.
    expect(foodCss).toMatch(/\.eat-discover-surface\s*\{\s*display:\s*contents;/);
  });
});
