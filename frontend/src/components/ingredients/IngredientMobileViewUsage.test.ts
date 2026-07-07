import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sourcePath = resolve(__dirname, 'IngredientMobileView.tsx');

describe('IngredientMobileView shared overlay usage', () => {
  it('uses the shared overlay frame for the mobile shopping drawer', () => {
    const source = readFileSync(sourcePath, 'utf8');

    expect(source).toContain('WorkspaceOverlayFrame');
    expect(source).toContain('rootClassName="ingredient-workspace-overlay-root mobile-ingredient-shopping-drawer-root"');
    expect(source).toContain('backdropClassName="mobile-ingredient-shopping-drawer-backdrop"');
    expect(source).toContain('closeOnBackdrop={!props.isUpdatingShopping}');
    expect(source).not.toContain(
      'className="workspace-overlay-root ingredient-workspace-overlay-root mobile-ingredient-shopping-drawer-root"',
    );
    expect(source).not.toContain(
      'className="workspace-overlay-backdrop mobile-ingredient-shopping-drawer-backdrop"',
    );
  });
});
