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

  it('reuses the same complete shopping dialog on home and ingredients surfaces', () => {
    const workspaceSource = readFileSync(sourcePath, 'utf8');
    const appSource = readFileSync(resolve(__dirname, '../../App.tsx'), 'utf8');

    expect(workspaceSource).toContain('<IngredientShoppingDialog');
    expect(appSource).toContain('<IngredientShoppingDialog');
    expect(appSource).not.toContain("target: 'shopping',\n      ingredientId");
  });
});

describe('IngredientShoppingOverlay free-text option', () => {
  it('exposes an explicit free-text/other-purchase path without title auto-binding', () => {
    const shoppingOverlay = readFileSync(resolve(__dirname, 'IngredientShoppingOverlay.tsx'), 'utf8');

    expect(shoppingOverlay).toContain('其他采购');
    expect(shoppingOverlay).toContain("targetType: 'free_text'");
    expect(shoppingOverlay).toContain("id: 'free_text:other'");
    expect(shoppingOverlay).toContain('// Typing never auto-binds by title');
    expect(shoppingOverlay).not.toContain('ingredientSearch.findIngredientByName(nextTitle)');
    expect(shoppingOverlay).not.toContain('采购清单只能选择已有档案');
    expect(shoppingOverlay).toContain('primaryDisabled={!canSubmit}');
  });
});


describe('IngredientWorkspaceOverlays shopping intake cutover', () => {
  it('does not plumb pendingShoppingToComplete into inventory overlay', () => {
    const source = readFileSync(sourcePath, 'utf8');
    expect(source).not.toContain('pendingShoppingToComplete');
    expect(source).not.toContain('PendingShoppingCompletion');
  });
});
