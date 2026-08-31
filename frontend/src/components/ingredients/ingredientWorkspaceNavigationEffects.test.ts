import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Ingredient workspace navigation side-effect ownership', () => {
  it('keeps shopping/create/priority request effects out of the workspace view', () => {
    const workspaceSource = readFileSync(resolve(__dirname, 'IngredientWorkspace.tsx'), 'utf8');
    const effectsSource = readFileSync(resolve(__dirname, 'useIngredientWorkspaceNavigationEffects.ts'), 'utf8');

    expect(workspaceSource).toContain('useIngredientWorkspaceNavigationEffects');
    expect(workspaceSource).not.toContain('handledSideEffectNavigationRequestIdRef');
    expect(effectsSource).toContain('export function useIngredientWorkspaceNavigationEffects');
    expect(effectsSource).toContain('focusPrioritySurface');
  });
});
