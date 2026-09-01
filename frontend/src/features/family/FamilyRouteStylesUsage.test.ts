import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const importPattern = /@import\s+['"]([^'"]+\.css)['"][^;]*;/g;

function collectRouteStyles(entryPath: string, visited = new Set<string>()): string {
  const absolutePath = resolve(entryPath);
  if (visited.has(absolutePath)) return '';
  visited.add(absolutePath);

  const source = readFileSync(absolutePath, 'utf8');
  const imports = Array.from(source.matchAll(importPattern), (match) => match[1]);
  return [
    source,
    ...imports.map((importPath) => collectRouteStyles(resolve(dirname(absolutePath), importPath), visited)),
  ].join('\n');
}

describe('Family route style ownership', () => {
  it('loads the AI service entry layout without visiting the model usage route first', () => {
    const repoRoot = resolve(__dirname, '../../..');
    const familyStyles = collectRouteStyles(resolve(repoRoot, 'src/styles/route-shell.css'))
      + collectRouteStyles(resolve(repoRoot, 'src/features/family/family-route.css'));

    expect(familyStyles).toMatch(/\.family-model-usage-entry\s*\{[^}]*display:\s*grid;/s);
    expect(familyStyles).toMatch(/\.family-model-usage-entry-icon svg\s*\{[^}]*width:/s);
    expect(familyStyles).toMatch(/\.mobile-family-model-usage-entry\s*\{[^}]*display:\s*grid;/s);
  });
});
