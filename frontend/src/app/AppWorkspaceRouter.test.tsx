import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveWorkspaceRoute } from './appRouteEntries';
import { initialNavigationState } from './appNavigationModel';

describe('AppWorkspaceRouter route contract', () => {
  it('owns the shared workspace loading fallback in the app composition layer', () => {
    const appSource = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');
    const routerSource = readFileSync(resolve(__dirname, './AppWorkspaceRouter.tsx'), 'utf8');
    expect(appSource).not.toContain('function WorkspaceLoadingFallback');
    expect(routerSource).toContain('WorkspaceLoadingFallback');
  });

  it('selects one route for each primary workspace', () => {
    for (const workspace of ['home', 'eat', 'ingredients', 'ai', 'family'] as const) {
      const state = { ...initialNavigationState, primaryTab: workspace };
      expect(resolveWorkspaceRoute(state).workspace).toBe(workspace);
    }
  });
});
