import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const componentSourcePath = resolve(__dirname, 'IngredientConsumeOverlay.tsx');
const ingredientsStylePath = resolve(__dirname, '../../styles/04-ingredients-workspace.css');

const staleClasses = [
  'consume-quick-identity-summary',
  'consume-quick-summary-card',
  'consume-quick-live-row',
  'consume-quick-live-card',
  'consume-quick-range-editor-shell',
  'consume-quick-range-editor-input',
  'ingredients-consume-unit-row',
  'ingredients-consume-unit-chip',
  'ingredients-consume-unit-section',
  'ingredients-consume-unit-single',
  'ingredients-consume-unit-single-main',
  'ingredients-consume-unit-single-meta',
];

describe('IngredientConsumeOverlay style usage', () => {
  it('uses the current consume quick classes and drops stale summary/live editor styles', () => {
    const componentSource = readFileSync(componentSourcePath, 'utf8');
    const styleSource = readFileSync(ingredientsStylePath, 'utf8');

    expect(componentSource).toContain('consume-quick-footer-summary');
    expect(componentSource).toContain('QuantityUnitField');
    expect(componentSource).toContain('ingredients-consume-quantity-field');
    expect(componentSource).toContain('consume-quick-range-field');
    expect(componentSource).toContain('consume-quick-shortcut-row');
    expect(styleSource).toContain('.consume-quick-footer-summary');
    expect(styleSource).toContain('.consume-quick-range-field');
    expect(styleSource).toContain('.consume-quick-shortcut-row');

    for (const className of staleClasses) {
      expect(componentSource).not.toContain(className);
      expect(styleSource).not.toContain(className);
    }
  });
});
