export const routeStyleIds = [
  'home',
  'eat',
  'ingredients',
  'food',
  'ai',
  'family',
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

const defaultRouteStyleLoader = createRouteStyleLoader({
  home: () => import('../features/home/home-route.css'),
  eat: () => Promise.all([
    import('../features/eat/eat-route.css'),
    import('../features/eat/recipe-route.css'),
    import('../features/meals/meal-route.css'),
  ]),
  ingredients: () => Promise.all([
    import('../components/ingredients/ingredient-route.css'),
    import('../features/meals/meal-route.css'),
  ]),
  food: () => Promise.all([
    import('../components/foods/food-route.css'),
    import('../features/eat/recipe-route.css'),
    import('../features/meals/meal-route.css'),
  ]),
  ai: () => import('../components/ai/ai-route.css'),
  family: () => import('../features/family/family-route.css'),
  'model-usage': () => Promise.all([
    import('../features/model-usage/model-usage-route.css'),
    import('../features/family-model-settings/family-model-settings-route.css'),
  ]),
  'inventory-maintenance': () => import('../features/inventory/inventory-route.css'),
}, {
  production: import.meta.env.PROD,
  legacyGlobalStyles: import.meta.env.VITE_LEGACY_GLOBAL_STYLES === '1',
});

export const loadRouteStyles = defaultRouteStyleLoader.load;
