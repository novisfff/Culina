import { createRouteEntryLoader } from './routeEntryLoader';
export const loadMealLogWorkspace = createRouteEntryLoader(
  'meal-log',
  () => Promise.all([import('../../styles/05-workspace-overlays.css'), import('../../features/meals/meal-route.css')]),
  () => import('../../features/meals/MealLogWorkspace').then((module) => ({ default: module.MealLogWorkspace })),
);
