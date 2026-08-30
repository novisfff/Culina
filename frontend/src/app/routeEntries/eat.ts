import { createRouteEntryLoader } from './routeEntryLoader';
export const loadEatWorkspace = createRouteEntryLoader(
  'eat',
  () => Promise.all([import('../../styles/route-overlays').then((module) => module.loadRouteOverlayStyles()), import('../../features/eat/eat-route.css'), import('../../features/eat/recipe-route.css')]),
  () => import('../../features/eat/EatWorkspace').then((module) => ({ default: module.EatWorkspace })),
);
