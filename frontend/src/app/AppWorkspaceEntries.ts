import { lazy } from 'react';

export const AppAiWorkspace = lazy(() =>
  import('../components/ai/AiWorkspace').then((module) => ({ default: module.AiWorkspace })),
);
export const AppEatWorkspace = lazy(() =>
  import('../features/eat/EatWorkspace').then((module) => ({ default: module.EatWorkspace })),
);
export const AppHomeDashboard = lazy(() =>
  import('../features/home/HomeDashboard').then((module) => ({ default: module.HomeDashboard })),
);
export const AppMealLogWorkspace = lazy(() =>
  import('../features/meals/MealLogWorkspace').then((module) => ({ default: module.MealLogWorkspace })),
);
export const AppFoodWorkspace = lazy(() =>
  import('../components/foods/FoodWorkspace').then((module) => ({ default: module.FoodWorkspace })),
);
export const AppIngredientWorkspace = lazy(() =>
  import('../components/ingredients/IngredientWorkspace').then((module) => ({ default: module.IngredientWorkspace })),
);
