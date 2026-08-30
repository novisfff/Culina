import { createRouteEntryLoader } from './routeEntryLoader';
export const loadMealLogWorkspace = createRouteEntryLoader(
  'meal-log',
  () => Promise.all([import('../../styles/route-overlays').then((module) => module.loadRouteOverlayStyles()), import('../../features/meals/meal-route.css')]),
  () => import('../../features/meals/MealLogWorkspace').then((module) => ({ default: module.MealLogWorkspace })),
);
