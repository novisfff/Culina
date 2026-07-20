import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const staleRecipeClasses = [
  'recipe-tag-row',
  'recipe-chip',
  'recipe-filter-select',
  'recipe-panel-head',
  'recipe-step-list',
  'recipe-plan-item-controls',
  'recipe-filter-action',
  'recipe-cook-ai-prompts',
  'recipe-cook-ai-drag-handle',
  'recipe-category-large',
  'recipe-category-scroll-cue',
  'recipe-category-section',
  'recipe-cover-empty',
  'recipe-discovery-card-placeholder',
  'recipe-discovery-card-title',
  'recipe-discovery-pill',
  'recipe-discovery-plan-hit',
  'recipe-discovery-tags',
  'recipe-ingredient-resolution-status',
  'recipe-title-mark',
];

describe('Recipe legacy style cleanup', () => {
  const repoRoot = resolve(__dirname, '../../..');
  const recipeSources = [
    'src/components/recipes/RecipeWorkspaceCards.tsx',
    'src/components/recipes/RecipeDetailView.tsx',
    'src/components/recipes/RecipeCookView.tsx',
    'src/components/recipes/CookingAssistantPanel.tsx',
  ]
    .map((file) => readFileSync(resolve(repoRoot, file), 'utf8'))
    .join('\n');
  const styleSources = [
    'src/styles/00-foundation.css',
    'src/styles/03-recipe-workspace.css',
    'src/styles/04-ingredients-workspace.css',
    'src/styles/05-workspace-overlays.css',
    'src/styles/07-mobile.css',
  ]
    .map((file) => readFileSync(resolve(repoRoot, file), 'utf8'))
    .join('\n');

  it('keeps current recipe task and cook assistant styles without stale helper classes', () => {
    expect(recipeSources).toContain('recipe-cook-ai-drag-bar');

    for (const className of staleRecipeClasses) {
      expect(recipeSources).not.toContain(className);
      expect(styleSources).not.toContain(className);
    }
  });

  it('keeps recipe plan dialog chrome in overlay styles instead of ingredient styles', () => {
    const ingredientStyles = readFileSync(resolve(repoRoot, 'src/styles/04-ingredients-workspace.css'), 'utf8');
    const overlayStyles = readFileSync(resolve(repoRoot, 'src/styles/05-workspace-overlays.css'), 'utf8');

    expect(overlayStyles).toContain('.recipe-plan-modal.workspace-modal');
    expect(overlayStyles).toContain('.recipe-plan-dialog-form');
    expect(overlayStyles).toContain('.recipe-plan-dialog-hero');
    expect(overlayStyles).toContain('.recipe-plan-dialog-actions .solid-button');
    expect(overlayStyles).not.toContain('.recipe-plan-dialog-actions .ui-form-actions-row');
    expect(overlayStyles).not.toContain('.recipe-plan-dialog-actions .ui-form-actions-spacer');
    expect(ingredientStyles).not.toContain('.workspace-modal.recipe-plan-modal');
    expect(ingredientStyles).not.toContain('.recipe-plan-dialog-form');
    expect(ingredientStyles).not.toContain('.recipe-plan-dialog-hero');
  });

  it('lets shared modal footers own recipe AI draft action layout', () => {
    const recipeStyles = readFileSync(resolve(repoRoot, 'src/styles/03-recipe-workspace.css'), 'utf8');

    expect(recipeStyles).toContain('.recipe-ai-draft-modal-actions .solid-button:disabled');
    expect(recipeStyles).not.toContain('.recipe-ai-draft-modal-actions .ui-form-actions-row');
    expect(recipeStyles).not.toContain('.recipe-ai-draft-modal-actions .ui-form-actions-spacer');
    expect(recipeStyles).not.toContain('.recipe-ai-draft-modal-actions {\n  grid-template-columns');
  });

  it('does not keep stale ingredient resolution footer selectors inside the body panel', () => {
    const overlayStyles = readFileSync(resolve(repoRoot, 'src/styles/05-workspace-overlays.css'), 'utf8');

    expect(overlayStyles).toContain('.recipe-ingredient-resolution-dialog');
    expect(overlayStyles).not.toContain('.recipe-ingredient-resolution-dialog .ui-form-actions-row');
  });

  it('lets shared modal footers own recipe shopping action alignment', () => {
    const overlayStyles = readFileSync(resolve(repoRoot, 'src/styles/05-workspace-overlays.css'), 'utf8');

    expect(overlayStyles).toContain('.recipe-shopping-actions .solid-button');
    expect(overlayStyles).toContain('.recipe-shopping-actions .ui-form-actions-row {\n    display: grid;');
    expect(overlayStyles).not.toContain('.recipe-shopping-actions .ui-form-actions-spacer');
    expect(overlayStyles).not.toContain('.recipe-shopping-actions .ui-form-actions-row {\n  justify-content: flex-end;');
  });

  it('keeps recipe plan detail action layouts scoped to their current states', () => {
    const overlayStyles = readFileSync(resolve(repoRoot, 'src/styles/05-workspace-overlays.css'), 'utf8');

    expect(overlayStyles).toContain('.recipe-plan-detail-actions {');
    expect(overlayStyles).toContain('.recipe-plan-detail-actions .solid-button');
    expect(overlayStyles).toContain('.recipe-plan-detail-actions.is-recorded .ui-form-actions-row');
    expect(overlayStyles).toContain('.recipe-plan-detail-actions.is-standard .ui-form-actions-row');
    expect(overlayStyles).toContain('.recipe-plan-detail-actions.is-editing .ui-form-actions-row');
    expect(overlayStyles).toContain('.recipe-plan-detail-actions.is-recipe .ui-form-actions-row');
  });

  it('keeps cook finish mobile action grid without duplicate desktop footer overrides', () => {
    const recipeStyles = readFileSync(resolve(repoRoot, 'src/styles/03-recipe-workspace.css'), 'utf8');

    expect(recipeStyles).toContain('.recipe-cook-finish-actions .ui-form-actions-row {\n    display: grid;');
    expect(recipeStyles).toContain('grid-template-columns: 1fr 1fr;');
    expect(recipeStyles).not.toContain('.recipe-cook-finish-actions {\n  flex-wrap: wrap;');
    expect(recipeStyles).not.toContain('.recipe-cook-finish-actions .ui-form-actions-spacer');
    expect(recipeStyles).not.toContain('.recipe-cook-finish-actions .ui-form-actions-row {\n  justify-content: flex-end;');
    expect(recipeStyles).not.toContain('  .recipe-cook-finish-actions {\n    display: grid;');
  });

  it('keeps recipe scene cover ratio in overlay styles instead of food workspace media fallbacks', () => {
    const overlayStyles = readFileSync(resolve(repoRoot, 'src/styles/05-workspace-overlays.css'), 'utf8');
    const foodStyles = readFileSync(resolve(repoRoot, 'src/styles/06-food-workspace.css'), 'utf8');

    expect(overlayStyles).toContain('.recipe-scene-generate-card {');
    expect(overlayStyles).toContain('aspect-ratio: 4 / 3;');
    expect(overlayStyles).toContain('.recipe-scene-generate-card.has-image {\n  min-height: 0;');
    expect(foodStyles).not.toContain('.recipe-scene-generate-card');
  });
});
