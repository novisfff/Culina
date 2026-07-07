import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('SearchableResourceSelect usages', () => {
  const repoRoot = resolve(__dirname, '../../..');

  it('do not pass legacy business picker style classes into the shared component', () => {
    const files = [
      'src/components/ingredients/IngredientShoppingOverlay.tsx',
      'src/components/ingredients/IngredientInventoryOverlay.tsx',
      'src/components/recipes/RecipeIngredientResolutionDialog.tsx',
      'src/components/recipes/RecipeShoppingDialog.tsx',
      'src/components/recipes/RecipePlanDialogs.tsx',
      'src/components/foods/FoodPlanDialog.tsx',
      'src/features/home/HomeDashboardDialogs.tsx',
      'src/components/ui-kit/SearchableResourceSelect.tsx',
      'src/styles/03-recipe-workspace.css',
      'src/styles/04-ingredients-workspace.css',
      'src/styles/05-workspace-overlays.css',
      'src/styles/07-mobile.css',
    ];
    const legacyClassNames = [
      'custom-combobox-container',
      'custom-combobox-dropdown',
      'custom-combobox-option',
      'recipe-ingredient-picker-list',
      'recipe-ingredient-picker-option',
      'recipe-ingredient-resolution-candidates',
      'recipe-ingredient-resolution-candidate',
      'recipe-shopping-combobox',
      'recipe-shopping-combobox-field',
      'recipe-shopping-combobox-menu',
      'recipe-plan-option-panel',
      'recipe-plan-option',
      'ingredients-restock-picker-shell',
      'ingredients-restock-picker-toggle',
      'ingredients-restock-picker-menu',
      'ingredients-restock-picker-empty',
      'ingredients-picker-chevron',
      'ingredients-restock-suggestions',
      'ingredients-restock-resource-option',
    ];

    const source = files.map((file) => readFileSync(resolve(repoRoot, file), 'utf8')).join('\n');

    expect(legacyClassNames.filter((className) => source.includes(className))).toEqual([]);
  });

  it('uses server-backed paginated ingredient search for restock and shopping resource selects', () => {
    const files = [
      'src/components/ingredients/IngredientShoppingOverlay.tsx',
      'src/components/ingredients/IngredientInventoryOverlay.tsx',
      'src/features/home/HomeDashboardDialogs.tsx',
    ];
    const source = files.map((file) => readFileSync(resolve(repoRoot, file), 'utf8')).join('\n');

    expect(source.match(/useIngredientResourceSearch/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(source).toContain('hasMore={');
    expect(source).toContain('onLoadMore={');
    expect(source).not.toContain('.slice(0, 8)');
    expect(source).not.toContain('.slice(0, 10)');
    expect(source).not.toContain('ingredients-restock-picker-field');
  });

  it('uses the shared ingredient resource search hook for all ingredient resource selectors', () => {
    const files = [
      'src/components/ingredients/IngredientShoppingOverlay.tsx',
      'src/components/ingredients/IngredientInventoryOverlay.tsx',
      'src/components/recipes/RecipeIngredientResolutionDialog.tsx',
      'src/components/recipes/RecipeShoppingDialog.tsx',
      'src/features/home/HomeDashboardDialogs.tsx',
    ];
    const source = files.map((file) => readFileSync(resolve(repoRoot, file), 'utf8')).join('\n');

    expect(source.match(/useIngredientResourceSearch/g)?.length ?? 0).toBeGreaterThanOrEqual(6);
    expect(source).not.toContain('api.getIngredients');
    expect(source).not.toContain('ingredientPickerSearch');
    expect(source).not.toContain('.slice(0, 8)');
    expect(source).not.toContain('.slice(0, 10)');
  });

  it('renders food and recipe planning pickers through the unified resource select', () => {
    const files = [
      'src/components/foods/FoodPlanDialog.tsx',
      'src/components/recipes/RecipePlanDialogs.tsx',
      'src/components/recipes/RecipeWorkspace.tsx',
      'src/features/home/HomeDashboardDialogs.tsx',
    ];
    const source = files.map((file) => readFileSync(resolve(repoRoot, file), 'utf8')).join('\n');

    expect(source.match(/SearchableResourceSelect/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(source.match(/useFoodResourceSearch/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(source.match(/useRecipeResourceSearch/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(source).toContain('hasMore={');
    expect(source).toContain('onLoadMore={');
    expect(source).not.toContain('recipe-plan-combobox');
    expect(source).not.toContain('recipe-plan-search-input');
    expect(source).not.toContain('recipe-plan-option-panel');
    expect(source).not.toContain('recipe-plan-option');
    expect(source).not.toContain('.slice(0, 8)');
  });

  it('keeps searchable resource selectors visually consistent without leading icons', () => {
    const files = [
      'src/components/ingredients/IngredientShoppingOverlay.tsx',
      'src/components/ingredients/IngredientInventoryOverlay.tsx',
      'src/components/recipes/RecipeIngredientResolutionDialog.tsx',
      'src/components/recipes/RecipeShoppingDialog.tsx',
      'src/components/recipes/RecipePlanDialogs.tsx',
      'src/components/foods/FoodPlanDialog.tsx',
      'src/features/home/HomeDashboardDialogs.tsx',
    ];
    const source = files.map((file) => readFileSync(resolve(repoRoot, file), 'utf8')).join('\n');

    expect(source).not.toContain('leadingIcon={');
    expect(source).not.toContain('leadingIconClassName=');
  });

  it('does not expose a leading icon API on the shared resource selector', () => {
    const source = readFileSync(resolve(repoRoot, 'src/components/ui-kit/SearchableResourceSelect.tsx'), 'utf8');

    expect(source).not.toContain('leadingIcon');
    expect(source).not.toContain('leadingIconClassName');
  });
});
