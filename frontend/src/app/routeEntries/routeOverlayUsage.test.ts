import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const routeEntryFiles = [
  'ai.ts',
  'eat.ts',
  'family.ts',
  'food.ts',
  'home.ts',
  'ingredients.ts',
  'inventory.ts',
  'mealLog.ts',
  'modelUsage.ts',
];

describe('lazy route overlay style ownership', () => {
  it('loads shared overlay CSS through the common async entry', () => {
    for (const file of routeEntryFiles) {
      const source = readFileSync(resolve(__dirname, file), 'utf8');
      expect(source, file).toContain("import('../../styles/05-workspace-overlays.css')");
    }
  });
});
