import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('FoodWorkspace shopping overlay ownership', () => {
  it('delegates food and recipe shopping dialogs to the shopping overlay view', () => {
    const workspace = readFileSync(resolve(__dirname, 'FoodWorkspace.tsx'), 'utf8');
    const overlays = readFileSync(resolve(__dirname, 'FoodWorkspaceShoppingOverlays.tsx'), 'utf8');
    expect(workspace).toContain('<FoodWorkspaceShoppingOverlays');
    expect(workspace).not.toContain('<FoodShoppingDialog\n');
    expect(workspace).not.toContain('<RecipeShoppingDialog\n');
    expect(overlays).toContain('export function FoodWorkspaceShoppingOverlays');
  });
});
