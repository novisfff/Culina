import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const editorSourcePath = resolve(__dirname, 'IngredientEditorView.tsx');
const ingredientsStylePath = resolve(__dirname, '../../styles/04-ingredients-workspace.css');
const mobileStylePath = resolve(__dirname, '../../styles/07-mobile.css');

const staleStorageChoiceClasses = [
  'ingredients-storage-choice-row',
  'ingredients-storage-choice-chip',
  'ingredients-storage-choice-icon',
];

describe('IngredientEditorView style usage', () => {
  it('uses the shared storage chip group instead of stale storage choice styles', () => {
    const editorSource = readFileSync(editorSourcePath, 'utf8');
    const ingredientsStyleSource = readFileSync(ingredientsStylePath, 'utf8');
    const mobileStyleSource = readFileSync(mobileStylePath, 'utf8');

    expect(editorSource).toContain('OptionChipGroup');
    expect(editorSource).toContain('ingredients-storage-chip-group');
    expect(editorSource).toContain('ingredients-storage-custom-field');
    expect(ingredientsStyleSource).toContain('.ingredients-storage-chip-group');
    expect(mobileStyleSource).toContain('.ingredients-storage-chip-group');

    for (const className of staleStorageChoiceClasses) {
      expect(editorSource).not.toContain(className);
      expect(ingredientsStyleSource).not.toContain(className);
      expect(mobileStyleSource).not.toContain(className);
    }
  });
});
