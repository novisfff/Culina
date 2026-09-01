import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('FoodWorkspace editor overlay ownership', () => {
  it('delegates the food editor modal lifecycle to a focused overlay component', () => {
    const workspace = readFileSync(resolve(__dirname, 'FoodWorkspace.tsx'), 'utf8');
    const overlay = readFileSync(resolve(__dirname, 'FoodWorkspaceEditorOverlay.tsx'), 'utf8');
    expect(workspace).toContain('<FoodWorkspaceEditorOverlay');
    expect(workspace).not.toContain('<FoodEditorForm');
    expect(overlay).toContain('export function FoodWorkspaceEditorOverlay');
    expect(overlay).toContain('closeOnBackdrop={!props.isSavingFood}');
    expect(overlay).toContain('size="large"');
  });
});
