import type {
  ModelUsageAlert,
  ModelUsageGroupBy,
  ModelUsageScope,
} from '../../api/types';
import type { ModelUsageWorkspaceViewModel } from './modelUsageModel';

export type ModelUsageWorkspaceActions = {
  setScope: (scope: ModelUsageScope) => void;
  setPeriod: (period: string) => void;
  setGroupBy: (groupBy: ModelUsageGroupBy) => void;
  retry: () => void;
};

export type ModelUsageWorkspaceViewProps = {
  model: ModelUsageWorkspaceViewModel;
  isOwner: boolean;
  scope: ModelUsageScope;
  period: string;
  groupBy: ModelUsageGroupBy;
  alerts: ModelUsageAlert[];
  isBreakdownLoading: boolean;
  isOffline: boolean;
  actions: ModelUsageWorkspaceActions;
  onOpenPolicySettings?: () => void;
  onBack: () => void;
};
