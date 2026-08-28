import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('FoodWorkspace detail overlay ownership', () => {
  it('delegates detail projection and drawer rendering to the focused overlay', () => {
    const workspace = readFileSync(resolve(__dirname, 'FoodWorkspace.tsx'), 'utf8');
    const overlay = readFileSync(resolve(__dirname, 'FoodWorkspaceDetailOverlay.tsx'), 'utf8');
    expect(workspace).toContain('<FoodWorkspaceDetailOverlay');
    expect(workspace).not.toContain('<FoodDetailDrawer');
    expect(overlay).toContain('buildFoodRelationViewModelFromRecipeCards');
    expect(overlay).toContain('export function FoodWorkspaceDetailOverlay');
  });
});
