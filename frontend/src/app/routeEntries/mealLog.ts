import { createRouteEntryLoader } from './routeEntryLoader';
export const loadMealLogWorkspace = createRouteEntryLoader(
  'meal-log',
  () => import('../../features/meals/meal-route.css'),
  () => import('../../features/meals/MealLogWorkspace').then((module) => ({ default: module.MealLogWorkspace })),
);
