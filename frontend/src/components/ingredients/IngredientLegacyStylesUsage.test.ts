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

const staleChecklistAndSummaryClasses = [
  'ingredients-checklist',
  'ingredients-checklist-row',
  'ingredients-checklist-copy',
  'ingredients-row-actions',
  'ingredients-check-indicator',
  'ingredients-helper-check',
  'ingredient-action-card',
  'ingredient-summary-card',
  'ingredient-summary-thumb',
  'ingredient-summary-thumb-shell',
];

const staleCatalogToolbarClasses = [
  'ingredients-catalog-task-strip',
  'ingredients-catalog-task-strip-head',
  'ingredients-catalog-metric-strip',
  'ingredients-catalog-toolbar-head',
  'ingredients-catalog-title-group',
  'ingredients-catalog-title-line',
  'ingredients-catalog-mini-metrics',
  'ingredients-catalog-mini-metric-icon',
  'ingredients-catalog-create-button',
];

const staleLayoutHelperClasses = [
  'ingredients-category-rail',
  'ingredients-toolbar-stack',
  'ingredients-storage-meta',
  'ingredients-summary-grid',
];

const staleShoppingAndStorageClasses = [
  'ingredients-shopping-quantity-row',
  'ingredients-compact-unit-field',
  'ingredients-inventory-storage-kicker',
  'ingredients-inventory-storage-head',
  'ingredients-inventory-storage-head-side',
  'ingredients-inventory-storage-titleblock',
  'ingredients-inventory-storage-tip',
  'ingredients-shopping-history-row',
];

const staleVisualAndExpandClasses = [
  'ingredient-visual-source',
  'ingredient-visual-source-soft',
  'ingredient-visual-note',
  'ingredient-work-card-expand-trigger',
  'ingredient-work-card-expand-chevron',
  'ingredient-work-card-expand-actions',
  'ingredients-storage-workbench-density-tight',
  'ingredients-storage-group-shelf',
  'ingredients-restock-locked-field',
];

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
    expect(globalStyles).not.toContain("@import './styles/04-ingredients-workspace.css' layer(domain);");
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

  it('keeps current ingredient card styles without stale checklist and summary classes', () => {
    const workspaceSource = readFileSync(workspaceSourcePath, 'utf8');
    const inventoryCardSource = readFileSync(inventoryCardSourcePath, 'utf8');
    const ingredientsStyleSource = readFileSync(ingredientsStylePath, 'utf8');
    const primitiveStyleSource = readFileSync(sharedPrimitiveStylePath, 'utf8');

    expect(inventoryCardSource).toContain('ingredient-card-interactive');
    expect(ingredientsStyleSource).toContain('.ingredient-card-interactive');
    expect(primitiveStyleSource).toContain('.ingredient-card-interactive:hover');

    for (const className of staleChecklistAndSummaryClasses) {
      expect(workspaceSource).not.toContain(className);
      expect(inventoryCardSource).not.toContain(className);
      expect(ingredientsStyleSource).not.toContain(className);
      expect(primitiveStyleSource).not.toContain(className);
    }
  });

  it('keeps the current catalog toolbar without stale title and metric strip classes', () => {
    const workspaceSource = readFileSync(workspaceSourcePath, 'utf8');
    const ingredientsStyleSource = readFileSync(ingredientsStylePath, 'utf8');
    const primitiveStyleSource = readFileSync(sharedPrimitiveStylePath, 'utf8');
    const overlayStyleSource = readFileSync(overlayStylePath, 'utf8');
    const foodStyleSource = readFileSync(foodStylePath, 'utf8');

    expect(ingredientsStyleSource).toContain('.ingredients-catalog-toolbar');
    expect(ingredientsStyleSource).toContain('.ingredients-catalog-search-row');
    expect(ingredientsStyleSource).toContain('.ingredients-catalog-filter-bar');

    for (const className of staleCatalogToolbarClasses) {
      expect(workspaceSource).not.toContain(className);
      expect(ingredientsStyleSource).not.toContain(className);
      expect(primitiveStyleSource).not.toContain(className);
      expect(overlayStyleSource).not.toContain(className);
      expect(foodStyleSource).not.toContain(className);
    }
  });

  it('keeps current catalog and editor layout classes without stale layout helpers', () => {
    const workspaceSource = readFileSync(workspaceSourcePath, 'utf8');
    const ingredientsStyleSource = readFileSync(ingredientsStylePath, 'utf8');
    const foodStyleSource = readFileSync(foodStylePath, 'utf8');

    expect(ingredientsStyleSource).toContain('.ingredients-category-presets');
    expect(ingredientsStyleSource).toContain('.ingredient-grid-catalog');
    expect(ingredientsStyleSource).toContain('.ingredients-storage-workbench');

    for (const className of staleLayoutHelperClasses) {
      expect(workspaceSource).not.toContain(className);
      expect(ingredientsStyleSource).not.toContain(className);
      expect(foodStyleSource).not.toContain(className);
    }
  });

  it('keeps current shopping quantity and storage header styles without stale helpers', () => {
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

    for (const className of staleShoppingAndStorageClasses) {
      expect(workspaceSource).not.toContain(className);
      expect(shoppingHistorySource).not.toContain(className);
      expect(shoppingOverlaySource).not.toContain(className);
      expect(workspacePanelsSource).not.toContain(className);
      expect(ingredientsStyleSource).not.toContain(className);
      expect(foodStyleSource).not.toContain(className);
    }
  });

  it('keeps current visual card and expand styles without stale visual helpers', () => {
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

    for (const className of staleVisualAndExpandClasses) {
      expect(workspaceSource).not.toContain(className);
      expect(quickDetailSource).not.toContain(className);
      expect(catalogCardSource).not.toContain(className);
      expect(workspacePanelsSource).not.toContain(className);
      expect(ingredientsStyleSource).not.toContain(className);
      expect(foodStyleSource).not.toContain(className);
    }
  });
});
