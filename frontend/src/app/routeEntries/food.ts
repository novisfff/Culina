import { createRouteEntryLoader } from './routeEntryLoader';
export const loadFoodWorkspace = createRouteEntryLoader(
  'food',
  () => import('../../components/foods/food-route.css'),
  () => import('../../components/foods/FoodWorkspace').then((module) => ({ default: module.FoodWorkspace })),
);
