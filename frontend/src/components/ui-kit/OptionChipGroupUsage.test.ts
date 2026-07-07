import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('OptionChipGroup usages', () => {
  const repoRoot = resolve(__dirname, '../../..');

  it('does not keep SegmentedTabs usages after chip group unification', () => {
    const files = [
      'src/components/foods/FoodWorkspace.tsx',
      'src/components/ingredients/IngredientEditorView.tsx',
      'src/components/ui-kit.tsx',
    ];
    const source = files.map((file) => readFileSync(resolve(repoRoot, file), 'utf8')).join('\n');

    expect(source).not.toContain('<SegmentedTabs');
    expect(source).not.toContain('function SegmentedTabs');
    expect(source).not.toContain(' segmented-tabs');
    expect(source).not.toContain(' segmented-tab');
  });

  it('uses small OptionChipGroup controls for food library type and meal filters', () => {
    const source = readFileSync(resolve(repoRoot, 'src/components/foods/FoodWorkspace.tsx'), 'utf8');

    expect(source).toContain('ariaLabel="食物类型"');
    expect(source).toContain('ariaLabel="适合餐别"');
    expect(source.match(/size="small"/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('uses medium OptionChipGroup controls for recipe quick filters', () => {
    const source = readFileSync(resolve(repoRoot, 'src/components/recipes/RecipeWorkspace.tsx'), 'utf8');
    const styles = [
      'src/styles/03-recipe-workspace.css',
      'src/styles/05-workspace-overlays.css',
      'src/styles/07-mobile.css',
    ]
      .map((file) => readFileSync(resolve(repoRoot, file), 'utf8'))
      .join('\n');

    expect(source).toContain('ariaLabel="菜谱快捷筛选"');
    expect(source).toContain('size="medium"');
    expect(source).not.toContain('recipe-filter-chip');
    expect(styles).not.toContain('recipe-filter-chip');
  });

  it('keeps mobile ingredient create chip groups constrained inside the drawer', () => {
    const source = readFileSync(resolve(repoRoot, 'src/components/ingredients/IngredientEditorView.tsx'), 'utf8');
    const styles = readFileSync(resolve(repoRoot, 'src/styles/07-mobile.css'), 'utf8');

    expect(source).toContain('ingredients-category-chip active');
    expect(source).toContain('<IngredientCategoryIcon name={item.icon} />');
    expect(source).not.toContain('ariaLabel="食材分类"');
    expect(styles).toContain('.ingredients-create-workspace .ingredients-category-chip');
    expect(styles).not.toContain('.ingredients-create-workspace .ingredients-category-chip-group');
    expect(styles).toContain('.ingredients-create-basic-section .ingredients-unit-option-group');
    expect(styles).toContain('.ingredients-create-basic-section .ingredients-storage-chip-group');
    expect(source).toContain('ingredients-storage-field-group');
    expect(source).toContain('ingredients-storage-custom-field');
    expect(styles).toContain('.ingredients-create-basic-section .ingredients-storage-custom-field .text-input');
    expect(styles).toContain('flex-wrap: wrap');
    expect(styles).toContain('min-width: 58px');
    expect(styles).toContain('.ingredients-create-rules-section .ingredients-rule-option-group .ui-option-chip');
    expect(styles).toContain('overflow-x: hidden');
    expect(styles).toContain('min-width: 0');
  });

  it('keeps selected OptionChipGroup colors on the shared theme palette', () => {
    const styles = [
      'src/styles/00-ui-kit.css',
      'src/styles/04-ingredients-workspace.css',
      'src/styles/07-mobile.css',
    ]
      .map((file) => readFileSync(resolve(repoRoot, file), 'utf8'))
      .join('\n');

    expect(styles).toContain('color: var(--accent-strong)');
    expect(styles).not.toContain('#db5a1b');
    expect(styles).not.toContain('#fff3ea');
  });

  it('uses OptionChipGroup for mobile food and ingredient library filters', () => {
    const foodSource = readFileSync(resolve(repoRoot, 'src/components/foods/FoodMobileView.tsx'), 'utf8');
    const ingredientSource = readFileSync(resolve(repoRoot, 'src/components/ingredients/IngredientMobileView.tsx'), 'utf8');
    const mobileStyles = readFileSync(resolve(repoRoot, 'src/styles/07-mobile.css'), 'utf8');

    expect(foodSource).toContain('<OptionChipGroup');
    expect(foodSource).toContain('ariaLabel="食物分类"');
    expect(foodSource).toContain('className="mobile-food-chip-group"');
    expect(ingredientSource).toContain('<OptionChipGroup');
    expect(ingredientSource).toContain('ariaLabel="食材筛选"');
    expect(ingredientSource).toContain('className="mobile-ingredient-chip-group"');
    expect(foodSource).not.toContain('mobile-food-tabs');
    expect(ingredientSource).not.toContain('mobile-ingredient-tabs');
    expect(mobileStyles).not.toContain('.mobile-food-tabs');
    expect(mobileStyles).not.toContain('.mobile-ingredient-tabs');
  });
});
