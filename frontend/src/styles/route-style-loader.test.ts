import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRouteStyleLoader, routeStyleIds } from './route-style-loader';

describe('route style loader', () => {
  it('registers every logical route and only imports each style once', async () => {
    const imports = Object.fromEntries(routeStyleIds.map((id) => [id, vi.fn(async () => undefined)]));
    const loader = createRouteStyleLoader(imports);

    await loader.load('home');
    await loader.load('home');

    expect(imports.home).toHaveBeenCalledOnce();
    expect(routeStyleIds).toEqual(expect.arrayContaining([
      'home', 'eat', 'ingredients', 'food', 'ai', 'family', 'model-usage', 'inventory-maintenance',
    ]));
  });

  it('rejects legacy and route-owned styles being enabled together in production', async () => {
    const loader = createRouteStyleLoader(
      { home: vi.fn(async () => undefined) },
      { production: true, legacyGlobalStyles: true },
    );

    await expect(loader.load('home')).rejects.toThrow('legacy global styles and route-owned styles cannot be enabled together');
  });

  it('does not load route-owned CSS while legacy rollback mode is enabled', async () => {
    const importer = vi.fn(async () => undefined);
    const loader = createRouteStyleLoader({ home: importer }, { legacyGlobalStyles: true });

    await loader.load('home');

    expect(importer).not.toHaveBeenCalled();
  });

  it('keeps the main entry on foundation/primitives/shell and puts route styles behind lazy entries', () => {
    const mainSource = readFileSync(resolve(__dirname, '../main.tsx'), 'utf8');
    const workspaceEntries = readFileSync(resolve(__dirname, '../app/AppWorkspaceEntries.ts'), 'utf8');
    expect(mainSource).not.toContain("import './styles.css'");
    expect(mainSource).toContain("import('./styles/foundation.css')");
    expect(mainSource).toContain("import('./styles/primitives.css')");
    expect(mainSource).toContain("import('./styles/route-shell.css')");
    expect(workspaceEntries).toContain("import('./routeEntries/home')");
    expect(workspaceEntries).toContain("import('./routeEntries/ai')");
  });
});
