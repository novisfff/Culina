import { useCallback } from 'react';
import type { UserRole } from '../../api/types';
import { StateBlock } from '../../components/ui-kit';
import { ModelUsageDesktopView } from './ModelUsageDesktopView';
import { ModelUsageMobileView } from './ModelUsageMobileView';
import { useModelUsageQueries } from './useModelUsageQueries';
import type { ModelUsageWorkspaceActions } from './modelUsageWorkspaceViewModel';

export interface ModelUsageWorkspaceProps {
  familyId: string;
  role: UserRole;
  initialPeriod?: string | null;
  isPhoneViewport: boolean;
  onBack: () => void;
}

export function ModelUsageWorkspace(props: ModelUsageWorkspaceProps) {
  const queries = useModelUsageQueries({
    familyId: props.familyId,
    role: props.role,
    initialPeriod: props.initialPeriod,
  });
  const retry = useCallback(() => {
    void queries.overviewQuery.refetch();
    void queries.breakdownQuery.refetch();
    void queries.dailyTrendQuery.refetch();
  }, [queries.breakdownQuery, queries.dailyTrendQuery, queries.overviewQuery]);
  const actions: ModelUsageWorkspaceActions = {
    ...queries.actions,
    retry,
  };

  if (!props.familyId) {
    return (
      <main className="model-usage-workspace">
        <StateBlock
          status="empty"
          title="暂时没有家庭上下文"
          description="返回家庭页后，确认当前账号已加入一个家庭。"
          actionLabel="返回家庭"
          onAction={props.onBack}
        />
      </main>
    );
  }

  const View = props.isPhoneViewport ? ModelUsageMobileView : ModelUsageDesktopView;
  return (
    <View
      model={queries.viewModel}
      isOwner={queries.isOwner}
      scope={queries.scope}
      period={queries.period}
      groupBy={queries.groupBy}
      alerts={queries.alerts}
      isBreakdownLoading={queries.activeBreakdownQuery.isLoading}
      isOffline={typeof navigator !== 'undefined' && navigator.onLine === false}
      actions={actions}
      onBack={props.onBack}
    />
  );
}
