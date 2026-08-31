import { querySettleStatus } from './appRouteModel';
import type { resolveEatTask } from '../features/eat/EatWorkspaceViewModel';

type ResolutionArgs = Parameters<typeof resolveEatTask>[0];
type QueryState = Parameters<typeof querySettleStatus>[0];

type Args = {
  task: ResolutionArgs['task'];
  recipes: ResolutionArgs['recipes'];
  foods: ResolutionArgs['foods'];
  planDetail: ResolutionArgs['planDetail'];
  mealLogs: ResolutionArgs['mealLogs'];
  recipesQuery: QueryState;
  foodsQuery: QueryState;
  planDetailQuery: QueryState;
  mealLogsQuery: QueryState;
  mealLogsFetching: boolean;
};

/** Maps app query state into Eat's stable task-resolution contract. */
export function useAppEatTaskResolutionArgs(args: Args): ResolutionArgs {
  return {
    task: args.task,
    recipes: args.recipes,
    foods: args.foods,
    recipesStatus: querySettleStatus(args.recipesQuery),
    foodsStatus: querySettleStatus(args.foodsQuery),
    planDetail: args.planDetail,
    planDetailStatus: querySettleStatus(args.planDetailQuery),
    mealLogs: args.mealLogs,
    mealLogsStatus: querySettleStatus(args.mealLogsQuery),
    mealLogsFetching: args.mealLogsFetching,
  };
}
