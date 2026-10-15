// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceSourcePath = resolve(__dirname, 'IngredientWorkspace.tsx');
const inventoryCardSourcePath = resolve(__dirname, 'IngredientInventoryCard.tsx');
const shoppingHistorySourcePath = resolve(__dirname, 'ShoppingHistoryRow.tsx');
const quickDetailSourcePath = resolve(__dirname, 'IngredientQuickDetailPopover.tsx');
const shoppingOverlaySourcePath = resolve(__dirname, 'IngredientShoppingOverlay.tsx');
const workspacePanelsSourcePath = resolve(__dirname, 'IngredientWorkspacePanels.tsx');
const ingredientsStylePath = resolve(__dirname, '../../styles/04-ingredients-workspace.css');
const sharedPrimitiveStylePath = resolve(__dirname, '../../styles/legacy-primitives.css');
const overlayStylePath = resolve(__dirname, '../../styles/05-workspace-overlays.css');
const foodStylePath = resolve(__dirname, '../../styles/06-food-workspace.css');

const currentWorkspaceStyleSelectors = [
  '.ingredients-workspace',
  '.ingredients-panel-shell',
  '.ingredients-catalog-toolbar',
  '.ingredients-inventory-toolbar',
  '.ingredients-shopping-filter-shell',
  '.ingredient-visual-card-catalog',
  '.ingredient-visual-card-inventory',
  '.inventory-ingredient-card',
  '.ingredient-work-card-action-button',
];

describe('Ingredient legacy style cleanup', () => {
  it('loads ingredient workspace styles from the lazy route entry', () => {
    const repoRoot = resolve(__dirname, '../../..');
    const globalStyles = readFileSync(resolve(repoRoot, 'src/styles.css'), 'utf8');
    const routeStyles = readFileSync(resolve(__dirname, 'ingredient-route.css'), 'utf8');
    expect(globalStyles).toContain("@import './components/ingredients/ingredient-route.css' layer(domain);");
    expect(routeStyles).toContain("@import '../../styles/04-ingredients-workspace.css' layer(domain);");
  });

  it('keeps ingredient workspace ownership in the ingredient stylesheet', () => {
    const ingredientsStyleSource = readFileSync(ingredientsStylePath, 'utf8');
    const foodStyleSource = readFileSync(foodStylePath, 'utf8');

    for (const selector of currentWorkspaceStyleSelectors) {
      expect(ingredientsStyleSource).toContain(selector);
      expect(foodStyleSource).not.toContain(selector);
    }

    expect(foodStyleSource).not.toMatch(
      /(^|\s)\.(ingredients|ingredient-visual|ingredient-work-card|inventory-ingredient)-[A-Za-z0-9_-]+/,
    );
  });

  it('keeps current ingredient card styles', () => {
    const workspaceSource = readFileSync(workspaceSourcePath, 'utf8');
    const inventoryCardSource = readFileSync(inventoryCardSourcePath, 'utf8');
    const ingredientsStyleSource = readFileSync(ingredientsStylePath, 'utf8');
    const primitiveStyleSource = readFileSync(sharedPrimitiveStylePath, 'utf8');

    expect(inventoryCardSource).toContain('ingredient-card-interactive');
    expect(ingredientsStyleSource).toContain('.ingredient-card-interactive');
    expect(primitiveStyleSource).toContain('.ingredient-card-interactive:hover');

  });

  it('keeps the current catalog toolbar', () => {
    const workspaceSource = readFileSync(workspaceSourcePath, 'utf8');
    const ingredientsStyleSource = readFileSync(ingredientsStylePath, 'utf8');
    const primitiveStyleSource = readFileSync(sharedPrimitiveStylePath, 'utf8');
    const overlayStyleSource = readFileSync(overlayStylePath, 'utf8');
    const foodStyleSource = readFileSync(foodStylePath, 'utf8');

    expect(ingredientsStyleSource).toContain('.ingredients-catalog-toolbar');
    expect(ingredientsStyleSource).toContain('.ingredients-catalog-search-row');
    expect(ingredientsStyleSource).toContain('.ingredients-catalog-filter-bar');

  });

  it('keeps current catalog and editor layout classes', () => {
    const workspaceSource = readFileSync(workspaceSourcePath, 'utf8');
    const ingredientsStyleSource = readFileSync(ingredientsStylePath, 'utf8');
    const foodStyleSource = readFileSync(foodStylePath, 'utf8');

    expect(ingredientsStyleSource).toContain('.ingredients-category-presets');
    expect(ingredientsStyleSource).toContain('.ingredient-grid-catalog');
    expect(ingredientsStyleSource).toContain('.ingredients-storage-workbench');

  });

  it('keeps current shopping quantity and storage header styles', () => {
    const workspaceSource = readFileSync(workspaceSourcePath, 'utf8');
    const shoppingHistorySource = readFileSync(shoppingHistorySourcePath, 'utf8');
    const shoppingOverlaySource = readFileSync(shoppingOverlaySourcePath, 'utf8');
    const workspacePanelsSource = readFileSync(workspacePanelsSourcePath, 'utf8');
    const ingredientsStyleSource = readFileSync(ingredientsStylePath, 'utf8');
    const foodStyleSource = readFileSync(foodStylePath, 'utf8');

    expect(shoppingOverlaySource).toContain('QuantityUnitField');
    expect(shoppingOverlaySource).toContain('ingredients-restock-quantity-row');
    expect(workspacePanelsSource).toContain('ingredients-inventory-mixed-group');
    expect(workspacePanelsSource).toContain('ingredients-inventory-mixed-grid');
    expect(shoppingHistorySource).toContain('shopping-history-row');
    expect(ingredientsStyleSource).toContain('.ingredients-restock-quantity-row');

  });

  it('keeps current visual card and expand styles', () => {
    const workspaceSource = readFileSync(workspaceSourcePath, 'utf8');
    const quickDetailSource = readFileSync(quickDetailSourcePath, 'utf8');
    const catalogCardSource = readFileSync(resolve(__dirname, 'IngredientCatalogCard.tsx'), 'utf8');
    const workspacePanelsSource = readFileSync(workspacePanelsSourcePath, 'utf8');
    const ingredientsStyleSource = readFileSync(ingredientsStylePath, 'utf8');
    const foodStyleSource = readFileSync(foodStylePath, 'utf8');

    expect(catalogCardSource).toContain('ingredient-work-card-more-icon');
    expect(quickDetailSource).toContain('ingredient-quick-detail-popover');
    expect(catalogCardSource).toContain('ingredient-visual-meta');
    expect(workspacePanelsSource).toContain('ingredients-storage-workbench-density-compact');
    expect(ingredientsStyleSource).toContain('.ingredient-quick-detail-popover');
    expect(ingredientsStyleSource).toContain('.ingredients-storage-workbench-density-compact');

  });
});
