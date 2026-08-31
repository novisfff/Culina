import { createRouteEntryLoader } from './routeEntryLoader';
export const loadIngredientWorkspace = createRouteEntryLoader(
  'ingredients',
  () => Promise.all([import('../../styles/05-workspace-overlays.css'), import('../../components/ingredients/ingredient-route.css')]),
  () => import('../../components/ingredients/IngredientWorkspace').then((module) => ({ default: module.IngredientWorkspace })),
);
