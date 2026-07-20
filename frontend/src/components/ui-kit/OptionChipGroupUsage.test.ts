import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('OptionChipGroup usages', () => {
  const repoRoot = resolve(__dirname, '../../..');
  it('does not keep SegmentedTabs usages after chip group unification', () => {
    const files = ['src/components/foods/FoodWorkspace.tsx', 'src/components/ingredients/IngredientEditorView.tsx', 'src/components/ui-kit.tsx'];
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
  it('keeps mobile ingredient create chip groups constrained inside the drawer', () => {
    const source = readFileSync(resolve(repoRoot, 'src/components/ingredients/IngredientEditorView.tsx'), 'utf8');
    const styles = readFileSync(resolve(repoRoot, 'src/styles/07-mobile.css'), 'utf8');
    expect(source).toContain('ingredients-category-chip active');
    expect(styles).toContain('.ingredients-create-workspace .ingredients-category-chip');
    expect(styles).toContain('overflow-x: hidden');
  });
  it('keeps selected OptionChipGroup colors on the shared theme palette', () => {
    const styles = ['src/styles/00-ui-kit.css', 'src/styles/04-ingredients-workspace.css', 'src/styles/07-mobile.css'].map((file) => readFileSync(resolve(repoRoot, file), 'utf8')).join('\n');
    expect(styles).toContain('color: var(--accent-strong)');
    expect(styles).not.toContain('#db5a1b');
    expect(styles).not.toContain('#fff3ea');
  });
});
