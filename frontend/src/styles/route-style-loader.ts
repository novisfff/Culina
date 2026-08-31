export const routeStyleIds = [
  'home',
  'eat',
  'meal-log',
  'ingredients',
  'food',
  'ai',
  'family',
  'family-model-settings',
  'model-usage',
  'inventory-maintenance',
] as const;

export type RouteStyleId = (typeof routeStyleIds)[number];
type Importer = () => Promise<unknown>;
type Importers = Partial<Record<RouteStyleId, Importer>>;

export function createRouteStyleLoader(
  importers: Importers,
  options: { production?: boolean; legacyGlobalStyles?: boolean } = {},
) {
  const loaded = new Set<RouteStyleId>();
  const loading = new Map<RouteStyleId, Promise<void>>();

  return {
    async load(route: RouteStyleId): Promise<void> {
      if (options.production && options.legacyGlobalStyles) {
        throw new Error('legacy global styles and route-owned styles cannot be enabled together');
      }
      if (options.legacyGlobalStyles || loaded.has(route)) return;
      const existing = loading.get(route);
      if (existing) return existing;
      const importer = importers[route];
      if (!importer) throw new Error(`No route style importer registered for ${route}`);
      const request = importer()
        .then(() => { loaded.add(route); })
        .finally(() => { loading.delete(route); });
      loading.set(route, request);
      return request;
    },
  };
}
