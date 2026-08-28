import type { AppNavigationTarget, PrimaryTabKey } from './appNavigationModel';
import type { QuerySettleStatus } from '../features/eat/EatWorkspaceViewModel';

export function querySettleStatus(query: {
  isPending?: boolean;
  isLoading?: boolean;
  isError?: boolean;
  isSuccess?: boolean;
  data?: unknown;
}): QuerySettleStatus {
  if (query.isError) return 'error';
  if (query.isSuccess || query.data !== undefined) return 'success';
  if (query.isPending || query.isLoading) return 'pending';
  return 'idle';
}

export function primaryTabToTarget(
  tab: PrimaryTabKey,
  currentEatBaseView: 'discover' | 'plan' | 'history',
  alreadyOnEat: boolean,
): AppNavigationTarget {
  if (tab === 'eat') return { workspace: 'eat', view: alreadyOnEat ? currentEatBaseView : 'discover' };
  return { workspace: tab };
}
