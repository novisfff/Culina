import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sourcePath = resolve(__dirname, 'IngredientWorkspace.tsx');

describe('IngredientWorkspace shared overlay usage', () => {
  it('uses the shared overlay frame for the mobile ingredient detail popover', () => {
    const source = readFileSync(sourcePath, 'utf8');

    expect(source).toContain('rootClassName="ingredient-workspace-overlay-root mobile-ingredient-detail-popover-root"');
    expect(source).toContain('backdropClassName="mobile-ingredient-detail-popover-backdrop"');
    expect(source).not.toContain(
      `className="workspace-overlay-root ingredient-workspace-overlay-root mobile-ingredient-detail-popover-root"`,
    );
    expect(source).not.toContain(
      `className="workspace-overlay-backdrop mobile-ingredient-detail-popover-backdrop"`,
    );
  });

  it('uses the shared overlay frame for the ingredient editor modal', () => {
    const source = readFileSync(sourcePath, 'utf8');

    expect(source).toContain('WorkspaceOverlayFrame');
    expect(source).toContain('rootClassName="ingredient-workspace-overlay-root"');
    expect(source).toContain('closeOnBackdrop={!isIngredientFormSubmitting}');
    expect(source).toContain('onClose={closeIngredientFormIfAllowed}');
    expect(source).not.toContain(
      `<div className="workspace-overlay-root ingredient-workspace-overlay-root">
          <div className="workspace-overlay-backdrop" onClick={goBackFromIngredientForm} />`,
    );
  });

  it('renders unified inventory source filters and food stock copy', () => {
    const panelsSource = readFileSync(resolve(__dirname, 'IngredientWorkspacePanels.tsx'), 'utf8');
    expect(panelsSource).toContain('全部库存');
    expect(panelsSource).toContain('食材库存');
    expect(panelsSource).toContain('成品速食');
    expect(panelsSource).toContain('getUnifiedInventoryActionLabel');

    const workspaceSource = readFileSync(sourcePath, 'utf8');
    expect(workspaceSource).toContain('api.getInventoryOverview');
    expect(workspaceSource).toContain('queryKeys.inventoryOverview');
  });

  it('routes unified food-stock actions into existing food workspace flows', () => {
    const workspaceSource = readFileSync(sourcePath, 'utf8');
    const appSource = readFileSync(resolve(__dirname, '../../App.tsx'), 'utf8');

    expect(workspaceSource).toContain('props.onOpenFoodEditor?.(foodId)');
    expect(workspaceSource).toContain('props.onOpenFoodQuickMeal?.(foodId)');
    expect(workspaceSource).not.toContain('成品库存先到食物页处理');
    expect(workspaceSource).not.toContain('记餐入口还在食物页');
    expect(appSource).toContain('onOpenFoodEditor={(foodId)');
    expect(appSource).toContain('onOpenFoodQuickMeal={(foodId)');
  });
});
