import { createRouteEntryLoader } from './routeEntryLoader';
export const loadIngredientWorkspace = createRouteEntryLoader(
  'ingredients',
  () => Promise.all([import('../../styles/route-overlays').then((module) => module.loadRouteOverlayStyles()), import('../../components/ingredients/ingredient-route.css')]),
  () => import('../../components/ingredients/IngredientWorkspace').then((module) => ({ default: module.IngredientWorkspace })),
);
