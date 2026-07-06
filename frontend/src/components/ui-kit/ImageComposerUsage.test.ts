import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('ImageComposer usages', () => {
  const repoRoot = resolve(__dirname, '../../..');

  it('uses the shared composer for food, ingredient, and recipe editor images', () => {
    const files = [
      'src/components/foods/FoodEditorForm.tsx',
      'src/components/ingredients/IngredientEditorView.tsx',
      'src/components/recipes/RecipeEditorView.tsx',
    ];
    const source = files.map((file) => readFileSync(resolve(repoRoot, file), 'utf8')).join('\n');

    expect(source.match(/<ImageComposer/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(source).toContain('title="食物图片"');
    expect(source).toContain('title="食材图片"');
    expect(source).toContain('title={`${entityLabel}封面`}');
  });

  it('keeps ImageComposer implemented under the ui-kit component directory', () => {
    const legacyUiKitSource = readFileSync(resolve(repoRoot, 'src/components/ui-kit.tsx'), 'utf8');
    const indexSource = readFileSync(resolve(repoRoot, 'src/components/ui-kit/index.ts'), 'utf8');
    const componentSource = readFileSync(resolve(repoRoot, 'src/components/ui-kit/ImageComposer.tsx'), 'utf8');
    const foundationStyles = readFileSync(resolve(repoRoot, 'src/styles/00-foundation.css'), 'utf8');
    const uiKitStyles = readFileSync(resolve(repoRoot, 'src/styles/00-ui-kit.css'), 'utf8');

    expect(legacyUiKitSource).not.toContain('export function ImageComposer');
    expect(indexSource).toContain("export * from './ImageComposer';");
    expect(componentSource).toContain('export function ImageComposer');
    expect(componentSource).not.toContain('className="intro-card-header"');
    expect(componentSource).not.toContain('className="intro-tip-item"');
    expect(foundationStyles).not.toContain('.image-composer-head');
    expect(foundationStyles).not.toContain('.image-composer-result-grid');
    expect(foundationStyles).not.toContain('.intro-card-header');
    expect(foundationStyles).not.toContain('.intro-tip-item');
    expect(uiKitStyles).toContain('.image-composer-result-grid');
    expect(uiKitStyles).toContain('.image-composer-actions');
  });

  it('does not keep the legacy handwritten recipe cover upload controls', () => {
    const recipeEditorSource = readFileSync(resolve(repoRoot, 'src/components/recipes/RecipeEditorView.tsx'), 'utf8');
    const recipeStyles = readFileSync(resolve(repoRoot, 'src/styles/03-recipe-workspace.css'), 'utf8');
    const foodStyles = readFileSync(resolve(repoRoot, 'src/styles/06-food-workspace.css'), 'utf8');

    expect(recipeEditorSource).not.toContain('recipe-editor-cover-actions');
    expect(recipeEditorSource).not.toContain('type="file"');
    expect(recipeEditorSource).not.toContain('editorReferenceUrl');
    expect(recipeStyles).not.toContain('recipe-editor-cover-actions');
    expect(recipeStyles).not.toContain('recipe-editor-cover-grid');
    expect(recipeStyles).not.toContain('recipe-editor-cover-workspace');
    expect(foodStyles).not.toContain('recipe-editor-cover-preview');
  });
});
