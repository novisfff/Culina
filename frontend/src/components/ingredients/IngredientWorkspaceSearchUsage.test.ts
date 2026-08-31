import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('IngredientWorkspace search ownership', () => {
  it('keeps search queries and applied result projection in the data hook', () => {
    const workspace = readFileSync(resolve(__dirname, 'IngredientWorkspace.tsx'), 'utf8');
    const search = readFileSync(resolve(__dirname, 'useIngredientWorkspaceSearch.ts'), 'utf8');
    expect(workspace).toContain('useIngredientWorkspaceSearch');
    expect(workspace).not.toContain('queryKeys.ingredientSearch');
    expect(workspace).not.toContain('queryKeys.inventorySearch');
    expect(search).toContain('queryKeys.ingredientSearch');
    expect(search).toContain('queryKeys.inventorySearch');
    expect(search).toContain('placeholderData: keepPreviousData');
  });
});
