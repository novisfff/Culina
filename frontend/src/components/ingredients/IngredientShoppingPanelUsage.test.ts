import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const panelSourcePath = resolve(__dirname, 'IngredientWorkspacePanels.tsx');
const ingredientsStylePath = resolve(__dirname, '../../styles/04-ingredients-workspace.css');
const foodStylePath = resolve(__dirname, '../../styles/06-food-workspace.css');

const staleShoppingToolbarClasses = [
  'ingredients-shopping-summary',
  'ingredients-shopping-toolbar-shell',
  'ingredients-shopping-toolbar-head',
  'ingredients-shopping-toolbar-copy',
  'ingredients-shopping-title-line',
  'ingredients-shopping-title-icon',
  'ingredients-shopping-action-icon',
  'ingredients-shopping-toolbar-summary',
  'ingredients-shopping-toolbar-actions',
  'ingredients-shopping-toolbar-metrics',
  'ingredients-shopping-toolbar-metric',
  'ingredients-shopping-toolbar-metric-icon',
  'ingredients-shopping-filter-label',
  'ingredients-shopping-row',
];

describe('IngredientShoppingPanel style usage', () => {
  it('uses the current shopping filter and stage classes without stale toolbar styles', () => {
    const panelSource = readFileSync(panelSourcePath, 'utf8');
    const styleSource = readFileSync(ingredientsStylePath, 'utf8');
    const foodStyleSource = readFileSync(foodStylePath, 'utf8');

    expect(panelSource).toContain('ingredients-shopping-filter-shell');
    expect(panelSource).toContain('ingredients-shopping-toolbar-tools');
    expect(panelSource).toContain('ingredients-shopping-stage');
    expect(panelSource).toContain('shopping-work-row-list');
    expect(styleSource).toContain('.ingredients-shopping-filter-shell');
    expect(styleSource).toContain('.ingredients-shopping-toolbar-tools');
    expect(styleSource).toContain('.ingredients-shopping-stage');
    expect(styleSource).toContain('.shopping-work-row');

    for (const className of staleShoppingToolbarClasses) {
      expect(panelSource).not.toContain(className);
      expect(styleSource).not.toContain(className);
      expect(foodStyleSource).not.toContain(className);
    }
  });
});
