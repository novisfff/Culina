import { describe, expect, it } from 'vitest';
import { resolveWorkspaceRoute } from './appRouteEntries';
import { initialNavigationState } from './appNavigationModel';

describe('AppWorkspaceRouter route contract', () => {
  it('selects one route for each primary workspace', () => {
    for (const workspace of ['home', 'eat', 'ingredients', 'ai', 'family'] as const) {
      const state = { ...initialNavigationState, primaryTab: workspace };
      expect(resolveWorkspaceRoute(state).workspace).toBe(workspace);
    }
  });
});
