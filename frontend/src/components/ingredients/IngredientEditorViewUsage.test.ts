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


describe('IngredientEditorView tracking transition guard', () => {
  it('renders a blocking confirmation surface for tracking mode changes', () => {
    const editorSource = readFileSync(editorSourcePath, 'utf8');
    const editorStateSource = readFileSync(resolve(__dirname, 'useIngredientEditorState.ts'), 'utf8');

    expect(editorSource).toContain('ingredients-tracking-transition-modal');
    expect(editorSource).toContain('切换为只记录有无');
    expect(editorSource).toContain('切换为记录数量');
    expect(editorSource).toContain('onConfirmTrackingTransition');
    expect(editorStateSource).toContain('transitionIngredientTrackingMode');
    expect(editorStateSource).toContain('trackingTransitionDraft');
    expect(editorStateSource).toContain('expected_ingredient_row_version');
    expect(editorStateSource).toContain('presence_resolution');
    expect(editorStateSource).toContain('exact_resolution');
    expect(editorStateSource).toContain('// Transition first; never silently submit the generic profile update for mode changes.');
  });
});
