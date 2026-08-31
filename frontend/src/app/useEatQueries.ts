import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { queryKeys } from '../api/queryKeys';
export function useEatQueries(args: { isAuthenticated: boolean; needsRecipes: boolean; needsInsights: boolean; needsFoods: boolean; needsMealLogs: boolean; needsMealInsights: boolean }) {
  const recipesQuery = useQuery({ queryKey: queryKeys.recipes, queryFn: () => api.getRecipes(), enabled: args.isAuthenticated && args.needsRecipes });
  const recipeDiscoveryQuery = useQuery({ queryKey: queryKeys.recipeDiscovery, queryFn: () => api.getRecipeDiscovery(8), enabled: args.isAuthenticated && args.needsInsights });
  const recipeStatsQuery = useQuery({ queryKey: queryKeys.recipeStats, queryFn: () => api.getRecipeStats(undefined, undefined, 10), enabled: args.isAuthenticated && args.needsInsights });
  const foodsQuery = useQuery({ queryKey: queryKeys.foods, queryFn: () => api.getFoods(), enabled: args.isAuthenticated && args.needsFoods });
  const mealLogsQuery = useQuery({ queryKey: queryKeys.mealLogs, queryFn: api.getMealLogs, enabled: args.isAuthenticated && args.needsMealLogs });
  const mealInsightsQuery = useQuery({ queryKey: queryKeys.mealInsights, queryFn: api.getMealInsights, enabled: args.isAuthenticated && args.needsMealInsights });
  return { recipesQuery, recipeDiscoveryQuery, recipeStatsQuery, foodsQuery, mealLogsQuery, mealInsightsQuery };
}
