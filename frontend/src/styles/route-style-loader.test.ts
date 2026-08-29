import { describe, expect, it, vi } from 'vitest';
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
});
