import { createRouteEntryLoader } from './routeEntryLoader';
export const loadFoodWorkspace = createRouteEntryLoader(
  'food',
  () => Promise.all([import('../../styles/05-workspace-overlays.css'), import('../../components/foods/food-route.css')]),
  () => import('../../components/foods/FoodWorkspace').then((module) => ({ default: module.FoodWorkspace })),
);
