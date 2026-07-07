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
    'src/components/recipes/RecipeWorkspace.tsx',
    'src/components/recipes/RecipeLibraryView.tsx',
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

  it('keeps current recipe library and cook assistant styles without stale helper classes', () => {
    expect(recipeSources).toContain('recipe-filter-row');
    expect(recipeSources).toContain('recipe-cook-ai-drag-bar');
    expect(recipeSources).toContain('recipe-plan-item');

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

  it('does not keep unreachable FormActions selectors for recipe plan detail actions', () => {
    const overlayStyles = readFileSync(resolve(repoRoot, 'src/styles/05-workspace-overlays.css'), 'utf8');

    expect(overlayStyles).toContain('.recipe-plan-detail-actions {');
    expect(overlayStyles).toContain('.recipe-plan-detail-actions .solid-button');
    expect(overlayStyles).not.toContain('.recipe-plan-detail-actions .ui-form-actions-row');
    expect(overlayStyles).not.toContain('.recipe-plan-detail-actions .ui-form-actions-spacer');
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

  it('keeps recipe plan week switcher styles in recipe styles instead of ingredient styles', () => {
    const recipeStyles = readFileSync(resolve(repoRoot, 'src/styles/03-recipe-workspace.css'), 'utf8');
    const ingredientStyles = readFileSync(resolve(repoRoot, 'src/styles/04-ingredients-workspace.css'), 'utf8');
    const foodStyles = readFileSync(resolve(repoRoot, 'src/styles/06-food-workspace.css'), 'utf8');

    expect(recipeSources).toContain('className="recipe-plan-switcher"');
    expect(recipeStyles).toContain('.recipe-plan-switcher {');
    expect(foodStyles).toContain('.food-plan-switcher.recipe-plan-switcher');
    expect(ingredientStyles).not.toContain('.recipe-plan-switcher');
  });

  it('keeps recipe discovery card and plan action styles out of ingredient styles', () => {
    const ingredientStyles = readFileSync(resolve(repoRoot, 'src/styles/04-ingredients-workspace.css'), 'utf8');
    const overlayStyles = readFileSync(resolve(repoRoot, 'src/styles/05-workspace-overlays.css'), 'utf8');
    const foodStyles = readFileSync(resolve(repoRoot, 'src/styles/06-food-workspace.css'), 'utf8');
    const recipeStyles = readFileSync(resolve(repoRoot, 'src/styles/03-recipe-workspace.css'), 'utf8');

    expect(recipeSources).toContain('recipe-discovery-card-body');
    expect(recipeSources).toContain('recipe-discovery-card-hit');
    expect(recipeSources).toContain('recipe-discovery-side');
    expect(recipeSources).toContain('recipe-side-list-item');
    expect(recipeSources).toContain('recipe-plan-add-button');
    expect(recipeStyles).toContain('.recipe-discovery-side');
    expect(recipeStyles).toContain('.recipe-side-list-item');
    expect(recipeStyles).toContain('.recipe-side-thumb');
    expect(overlayStyles).toContain('.recipe-discovery-card-body');
    expect(overlayStyles).toContain('.recipe-discovery-card-hit');
    expect(foodStyles).not.toContain('.recipe-plan-add-button.solid-button');
    expect(foodStyles).not.toContain('.recipe-discovery-card-hit');
    expect(foodStyles).not.toContain('.recipe-discovery-side .recipe-side-list-item');
    expect(foodStyles).not.toContain('.recipe-discovery-side .recipe-side-thumb');
    expect(ingredientStyles).not.toContain('.recipe-discovery-card-body');
    expect(ingredientStyles).not.toContain('.recipe-discovery-card-hit');
    expect(ingredientStyles).not.toContain('.recipe-plan-add-button');
  });

  it('keeps recipe cover illustration styles in recipe styles instead of ingredient styles', () => {
    const recipeStyles = readFileSync(resolve(repoRoot, 'src/styles/03-recipe-workspace.css'), 'utf8');
    const ingredientStyles = readFileSync(resolve(repoRoot, 'src/styles/04-ingredients-workspace.css'), 'utf8');
    const overlayStyles = readFileSync(resolve(repoRoot, 'src/styles/05-workspace-overlays.css'), 'utf8');
    const foodStyles = readFileSync(resolve(repoRoot, 'src/styles/06-food-workspace.css'), 'utf8');

    expect(recipeSources).toContain('recipe-cover-illustration');
    expect(recipeStyles).toContain('.recipe-work-cover .recipe-cover-illustration');
    expect(recipeStyles).toContain('.recipe-cover-illustration.tone-fish');
    expect(recipeStyles).toContain('.recipe-mini-thumb .recipe-cover-illustration small');
    expect(recipeStyles).toContain('.mobile-recipe-cover .media-placeholder-spark');
    expect(overlayStyles).toContain('Recipe cover ratio ownership moved out of the food workspace stylesheet.');
    expect(overlayStyles).toContain('.recipe-work-cover {\n  aspect-ratio: 4 / 3;');
    expect(overlayStyles).toContain('.recipe-discovery-card .recipe-discovery-card-cover {\n  margin: 10px 10px 0;\n  aspect-ratio: 1.16 / 1;');
    expect(foodStyles).not.toContain('.recipe-work-cover,\n.recipe-discovery-card .recipe-discovery-card-cover');
    expect(foodStyles).not.toContain('.mobile-recipe-cover .media-placeholder-spark');
    expect(ingredientStyles).not.toContain('recipe-cover-illustration');
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
