import { lazy } from 'react';

export const AppAiWorkspace = lazy(() =>
  import('./routeEntries/ai').then((module) => module.loadAiWorkspace()),
);
export const AppEatWorkspace = lazy(() =>
  import('./routeEntries/eat').then((module) => module.loadEatWorkspace()),
);
export const AppHomeDashboard = lazy(() =>
  import('./routeEntries/home').then((module) => module.loadHomeDashboard()),
);
export const AppMealLogWorkspace = lazy(() =>
  import('./routeEntries/mealLog').then((module) => module.loadMealLogWorkspace()),
);
export const AppFoodWorkspace = lazy(() =>
  import('./routeEntries/food').then((module) => module.loadFoodWorkspace()),
);
export const AppIngredientWorkspace = lazy(() =>
  import('./routeEntries/ingredients').then((module) => module.loadIngredientWorkspace()),
);
