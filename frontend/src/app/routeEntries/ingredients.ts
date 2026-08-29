import { createRouteEntryLoader } from './routeEntryLoader';
export const loadIngredientWorkspace = createRouteEntryLoader(
  'ingredients',
  () => import('../../components/ingredients/ingredient-route.css'),
  () => import('../../components/ingredients/IngredientWorkspace').then((module) => ({ default: module.IngredientWorkspace })),
);
