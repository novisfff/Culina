import { createRouteStyleLoader, type RouteStyleId } from '../../styles/route-style-loader';

export function createRouteEntryLoader<T>(
  route: RouteStyleId,
  styles: () => Promise<unknown>,
  component: () => Promise<T>,
) {
  const styleLoader = createRouteStyleLoader({ [route]: styles }, {
    production: import.meta.env.PROD,
    legacyGlobalStyles: import.meta.env.VITE_LEGACY_GLOBAL_STYLES === '1',
  });
  return async () => {
    await styleLoader.load(route);
    return component();
  };
}
