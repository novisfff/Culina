import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Food legacy style cleanup', () => {
  const repoRoot = resolve(__dirname, '../../..');

  it('keeps linked recipe summary styles scoped to the food detail drawer', () => {
    const detailSource = readFileSync(resolve(repoRoot, 'src/components/foods/FoodDetailDrawer.tsx'), 'utf8');
    const foodStyles = readFileSync(resolve(repoRoot, 'src/styles/06-food-workspace.css'), 'utf8');
    const staleGenericRecipeSummaryClasses = [
      '.recipe-badge',
      '.recipe-badge-icon',
      '.recipe-title',
      '.recipe-status-alert',
      '.recipe-ingredients-pills',
      '.recipe-steps-timeline',
      '.metric-box',
      '.metric-value',
      '.metric-label',
      '.metric-divider',
      '.ingredient-pill',
      '.pill-dot',
      '.pill-name',
      '.pill-status',
      '.timeline-item',
      '.timeline-badge',
      '.timeline-content',
      '.timeline-text',
    ];

    expect(detailSource).toContain('food-detail-recipe-badge');
    expect(detailSource).toContain('food-detail-recipe-metric-card');
    expect(detailSource).toContain('food-detail-recipe-status-alert');
    expect(detailSource).toContain('food-detail-recipe-ingredient-pill');
    expect(detailSource).toContain('food-detail-recipe-steps-timeline');
    expect(foodStyles).toContain('.food-detail-recipe-badge');
    expect(foodStyles).toContain('.food-detail-recipe-metric-card');
    expect(foodStyles).toContain('.food-detail-recipe-status-alert');
    expect(foodStyles).toContain('.food-detail-recipe-ingredient-pill');
    expect(foodStyles).toContain('.food-detail-recipe-steps-timeline');

    for (const className of staleGenericRecipeSummaryClasses) {
      expect(detailSource).not.toContain(`className="${className.slice(1)}`);
      expect(detailSource).not.toContain(`className={\`${className.slice(1)}`);
      expect(foodStyles).not.toContain(className);
    }
  });

  it('does not hide recipe or shopping action buttons from food mobile rules', () => {
    const foodStyles = readFileSync(resolve(repoRoot, 'src/styles/06-food-workspace.css'), 'utf8');

    expect(foodStyles).toContain('.mobile-dashboard-page,\n.mobile-food-page,');
    expect(foodStyles).not.toMatch(/\.recipe-(create-button|discovery-card-hit|plan-add-button|shopping-add-button)[\s\S]{0,500}\.mobile-dashboard-page/);
    expect(foodStyles).not.toMatch(/\.shopping-work-row-primary-action[\s\S]{0,500}\.mobile-dashboard-page/);
  });

  it('lets shared modal footers own food scene form action layout', () => {
    const overlayStyles = readFileSync(resolve(repoRoot, 'src/styles/05-workspace-overlays.css'), 'utf8');

    expect(overlayStyles).toContain('.food-scene-form-actions .solid-button');
    expect(overlayStyles).not.toContain('.food-scene-form-actions {\n  display: flex;');
    expect(overlayStyles).not.toContain('.food-scene-form-actions .ui-form-actions-row');
    expect(overlayStyles).not.toContain('.food-scene-form-actions .ui-form-actions-spacer');
  });

  it('uses the shared form action layout for quick meal footer buttons', () => {
    const foodStyles = readFileSync(resolve(repoRoot, 'src/styles/06-food-workspace.css'), 'utf8');

    expect(foodStyles).not.toContain('.food-quick-meal-actions .ui-form-actions-row');
    expect(foodStyles).not.toContain('.food-quick-meal-actions .ui-form-actions-spacer');
    expect(foodStyles).not.toContain('.food-quick-meal-actions .solid-button');
  });

  it('keeps food detail action layout scoped to desktop footer and mobile action bar', () => {
    const foodStyles = readFileSync(resolve(repoRoot, 'src/styles/06-food-workspace.css'), 'utf8');

    expect(foodStyles).toContain('.food-detail-drawer > .workspace-overlay-footer .food-detail-actions .ui-form-actions-row');
    expect(foodStyles).toContain('.food-detail-actions-mobile .ui-form-actions-row');
    expect(foodStyles).not.toContain('.food-detail-actions {\n  width: 100%;');
  });

  it('keeps food card primary and icon actions at the same visual height', () => {
    const foodStyles = readFileSync(resolve(repoRoot, 'src/styles/06-food-workspace.css'), 'utf8');

    expect(foodStyles).toMatch(/\.food-card-actions \.food-card-primary-action\.solid-button \{[^}]*height: 36px;[^}]*min-height: 36px;[^}]*padding-block: 0;/);
  });

  it('keeps the desktop food detail information dense and the quick record block compact', () => {
    const detailSource = readFileSync(resolve(repoRoot, 'src/components/foods/FoodDetailDrawer.tsx'), 'utf8');
    const foodStyles = readFileSync(resolve(repoRoot, 'src/styles/06-food-workspace.css'), 'utf8');

    expect(detailSource).toContain('food-detail-quick-section');
    expect(foodStyles).toMatch(/\.food-detail-drawer \.food-fact-grid \{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
    expect(foodStyles).toMatch(/\.food-detail-quick-section \{[^}]*padding: 12px 14px;[^}]*gap: 8px;/);
  });

  it('keeps a visible gap between desktop food detail sections', () => {
    const foodStyles = readFileSync(resolve(repoRoot, 'src/styles/06-food-workspace.css'), 'utf8');

    expect(foodStyles).toMatch(/\.food-detail-drawer > \.workspace-overlay-body \{[^}]*display: grid;[^}]*gap: 12px;/);
  });

  it('keeps food scene cover ratio in overlay styles instead of generic food media fallbacks', () => {
    const overlayStyles = readFileSync(resolve(repoRoot, 'src/styles/05-workspace-overlays.css'), 'utf8');
    const foodStyles = readFileSync(resolve(repoRoot, 'src/styles/06-food-workspace.css'), 'utf8');

    expect(overlayStyles).toContain('.food-scene-cover-preview {');
    expect(overlayStyles).toContain('aspect-ratio: 4 / 3;');
    expect(foodStyles).not.toContain('.food-scene-cover-preview');
  });

  it('keeps ImageComposer overrides scoped to the food workspace', () => {
    const foodStyles = readFileSync(resolve(repoRoot, 'src/styles/06-food-workspace.css'), 'utf8');

    expect(foodStyles).toContain('.food-workspace .image-composer-workspace-inline');
    expect(foodStyles).toContain('.food-workspace .image-composer-primary-dropzone');
    expect(foodStyles).toContain('.food-workspace .image-composer-result-media');
    expect(foodStyles).toContain('.food-workspace .image-composer-result-placeholder');
    expect(foodStyles).not.toMatch(/(?:^|\n)\s*\.image-composer-/);
  });

  it('does not keep obsolete food filter toolbar action overrides', () => {
    const foodSource = readFileSync(resolve(repoRoot, 'src/components/foods/FoodWorkspace.tsx'), 'utf8');
    const foodStyles = readFileSync(resolve(repoRoot, 'src/styles/06-food-workspace.css'), 'utf8');

    expect(foodSource).toContain('food-library-head-actions');
    expect(foodSource).toContain('food-library-search-row');
    expect(foodStyles).toContain('.food-library-head-actions');
    expect(foodStyles).toMatch(/\.food-library-search-row \{\s*display: grid;\s*grid-template-columns: minmax\(0, 1fr\) auto;/);
    expect(foodStyles).toMatch(/\.food-library-head-actions \{[^}]*flex-wrap: nowrap;[^}]*white-space: nowrap;/);
    expect(foodStyles).toMatch(/@media \(min-width: 768px\) \{[\s\S]*?\.workspace-drawer\.food-detail-drawer[\s\S]*?grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);[\s\S]*?grid-column: auto;/);
    expect(foodStyles).not.toContain('.food-filter-shell .workspace-toolbar-actions');
  });
});
