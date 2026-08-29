import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveWorkspaceRoute } from './appRouteEntries';
import { initialNavigationState } from './appNavigationModel';

describe('AppWorkspaceRouter route contract', () => {
  it('owns the shared workspace loading fallback in the app composition layer', () => {
    const appSource = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');
    const routerSource = readFileSync(resolve(__dirname, './AppWorkspaceRouter.tsx'), 'utf8');
    const entriesSource = readFileSync(resolve(__dirname, './AppWorkspaceEntries.ts'), 'utf8');
    expect(appSource).not.toContain('function WorkspaceLoadingFallback');
    expect(appSource).not.toContain('fallback={<WorkspaceLoadingFallback />');
    expect(appSource).not.toContain('<WorkspaceRouteBoundary>');
    expect(appSource).not.toContain('<AiWorkspace');
    expect(appSource).not.toContain('<FoodWorkspace');
    expect(appSource).not.toContain('<IngredientWorkspace');
    expect(routerSource).toContain('WorkspaceLoadingFallback');
    expect(routerSource).toContain('WorkspaceRouteBoundary');
    expect(appSource).not.toContain("import('./features/eat/EatWorkspace')");
    expect(appSource).not.toContain("import('./components/ingredients/IngredientWorkspace')");
    expect(entriesSource).toContain('AppAiWorkspace');
    expect(entriesSource).toContain('AppIngredientWorkspace');
  });

  it('selects one route for each primary workspace', () => {
    for (const workspace of ['home', 'eat', 'ingredients', 'ai', 'family'] as const) {
      const state = { ...initialNavigationState, primaryTab: workspace };
      expect(resolveWorkspaceRoute(state).workspace).toBe(workspace);
    }
  });
});
