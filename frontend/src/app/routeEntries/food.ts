import { createRouteEntryLoader } from './routeEntryLoader';
export const loadFoodWorkspace = createRouteEntryLoader(
  'food',
  () => Promise.all([import('../../styles/route-overlays').then((module) => module.loadRouteOverlayStyles()), import('../../components/foods/food-route.css')]),
  () => import('../../components/foods/FoodWorkspace').then((module) => ({ default: module.FoodWorkspace })),
);
