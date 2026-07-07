import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '../../..');

describe('FoodWorkspace navigation usage', () => {
  it('supports edit and quick-meal navigation requests from other workspaces', () => {
    const appNavigationSource = readFileSync(resolve(repoRoot, 'src/app/useAppGlobalSearchNavigation.ts'), 'utf8');
    const stateSource = readFileSync(resolve(repoRoot, 'src/components/foods/useFoodWorkspaceState.ts'), 'utf8');
    const workspaceSource = readFileSync(resolve(repoRoot, 'src/components/foods/FoodWorkspace.tsx'), 'utf8');

    expect(appNavigationSource).toContain("target?: 'detail' | 'edit' | 'quickMeal'");
    expect(appNavigationSource).toContain("quickMealAction?: 'eat' | 'cook'");
    expect(stateSource).toContain("args.navigationRequest?.target === 'edit'");
    expect(stateSource).toContain("args.navigationRequest?.target === 'quickMeal'");
    expect(workspaceSource).toContain("props.navigationRequest?.target === 'edit'");
    expect(workspaceSource).toContain("props.navigationRequest?.target === 'quickMeal'");
    expect(workspaceSource).toContain('openQuickMealDialog(food, getDefaultMealType(food), navigationRequest.quickMealAction ??');
  });
});
