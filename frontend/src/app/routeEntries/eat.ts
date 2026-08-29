import { createRouteEntryLoader } from './routeEntryLoader';
export const loadEatWorkspace = createRouteEntryLoader(
  'eat',
  () => Promise.all([import('../../features/eat/eat-route.css'), import('../../features/eat/recipe-route.css')]),
  () => import('../../features/eat/EatWorkspace').then((module) => ({ default: module.EatWorkspace })),
);
