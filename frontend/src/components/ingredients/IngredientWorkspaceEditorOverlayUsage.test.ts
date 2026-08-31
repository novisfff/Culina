import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Ingredient workspace editor overlay ownership', () => {
  it('keeps editor modal and controller projection outside the workspace composer', () => {
    const workspaceSource = readFileSync(resolve(__dirname, 'IngredientWorkspace.tsx'), 'utf8');
    const overlaySource = readFileSync(resolve(__dirname, 'IngredientWorkspaceEditorOverlay.tsx'), 'utf8');

    expect(workspaceSource).toContain('IngredientWorkspaceEditorOverlay');
    expect(workspaceSource).not.toContain('<IngredientEditorView');
    expect(overlaySource).toContain('trackingTransitionDraft');
    expect(overlaySource).toContain('ingredientImageComposer.upload');
  });
});
