import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sourcePath = resolve(__dirname, 'IngredientWorkspaceOverlays.tsx');

describe('IngredientWorkspaceOverlays shared overlay usage', () => {
  it('uses the shared overlay frame instead of a local backdrop shell', () => {
    const source = readFileSync(sourcePath, 'utf8');

    expect(source).toContain('WorkspaceOverlayFrame');
    expect(source).toContain('rootClassName={INGREDIENT_WORKSPACE_OVERLAY_ROOT_CLASS}');
    expect(source).not.toContain('<div className="workspace-overlay-root');
    expect(source).not.toContain('<div className="workspace-overlay-backdrop"');
  });
});
