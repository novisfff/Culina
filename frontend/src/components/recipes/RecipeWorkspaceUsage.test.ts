import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const recipesDir = resolve(__dirname);

function readSource(fileName: string) {
  return readFileSync(resolve(recipesDir, fileName), 'utf8');
}

describe('RecipeWorkspace task surface usage', () => {
  it('exports RecipeTaskSurface that composes detail/editor/cook without the library shell', () => {
    const taskSource = readSource('RecipeTaskSurface.tsx');
    const workspaceSource = readSource('RecipeWorkspace.tsx');

    expect(taskSource).toContain('export function RecipeTaskSurface');
    expect(taskSource).toContain("mode: 'view'");
    expect(taskSource).toContain("mode: 'edit'");
    expect(taskSource).toContain("mode: 'cook'");
    expect(taskSource).toContain('relationWritable');
    expect(taskSource).toContain("from './RecipeDetailView'");
    expect(taskSource).toContain("from './RecipeEditorView'");
    expect(taskSource).toContain("from './RecipeCookView'");
    expect(taskSource).not.toContain('RecipeLibraryView');
    expect(taskSource).not.toContain("from './RecipeLibraryView'");

    expect(workspaceSource).toContain('RecipeTaskSurface');
    expect(workspaceSource).toContain('<RecipeTaskSurface');
  });
});
