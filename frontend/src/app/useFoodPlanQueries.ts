import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { queryKeys } from '../api/queryKeys';

type WeekRange = { start: string; end: string };
export function useFoodPlanQueries(args: {
  isAuthenticated: boolean; enabled: boolean; needsDetail: boolean; needsScenes: boolean; needsRecommendations: boolean;
  weekRange: WeekRange; planDetailId: string | null;
}) {
  const foodPlanQuery = useQuery({
    queryKey: queryKeys.foodPlan(args.weekRange.start, args.weekRange.end),
    queryFn: () => api.getFoodPlan(args.weekRange.start, args.weekRange.end),
    enabled: args.isAuthenticated && args.enabled,
    placeholderData: keepPreviousData,
  });
  const foodPlanDetailQuery = useQuery({
    queryKey: queryKeys.foodPlanDetail(args.planDetailId ?? ''),
    queryFn: () => api.getFoodPlanItem(args.planDetailId as string),
    enabled: args.isAuthenticated && args.needsDetail && Boolean(args.planDetailId),
  });
  const foodScenesQuery = useQuery({ queryKey: queryKeys.foodScenes, queryFn: api.getFoodScenes, enabled: args.isAuthenticated && args.needsScenes });
  const foodRecommendationsQuery = useQuery({
    queryKey: queryKeys.foodRecommendations,
    queryFn: () => api.getFoodRecommendations({ limit: 12, now: new Date().toISOString() }),
    enabled: args.isAuthenticated && args.needsRecommendations,
  });
  return { foodPlanQuery, foodPlanDetailQuery, foodScenesQuery, foodRecommendationsQuery };
}
