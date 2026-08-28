import { useCallback, useState } from 'react';
import type { UserRole } from '../../api/types/modelUsage';
import { StateBlock } from '../../components/ui-kit';
import { ModelUsageDesktopView } from './ModelUsageDesktopView';
import { ModelUsageMobileView } from './ModelUsageMobileView';
import { ModelUsagePolicyDesktopDrawer } from './ModelUsagePolicyDesktopDrawer';
import { ModelUsagePolicyMobilePage } from './ModelUsagePolicyMobilePage';
import { useModelUsagePolicy } from './useModelUsagePolicy';
import { useModelUsageQueries } from './useModelUsageQueries';
import type { ModelUsageWorkspaceActions } from './modelUsageWorkspaceViewModel';
import './model-usage-route.css';

export interface ModelUsageWorkspaceProps {
  familyId: string;
  role: UserRole;
  initialPeriod?: string | null;
  isPhoneViewport: boolean;
  onBack: () => void;
  onOpenRequestLogs?: () => void;
}

export function ModelUsageWorkspace(props: ModelUsageWorkspaceProps) {
  const [isPolicySettingsOpen, setIsPolicySettingsOpen] = useState(false);
  const queries = useModelUsageQueries({
    familyId: props.familyId,
    role: props.role,
    initialPeriod: props.initialPeriod,
  });
  const policy = useModelUsagePolicy({ familyId: props.familyId, role: props.role });
  const retry = useCallback(() => {
    void queries.overviewQuery.refetch();
    void queries.breakdownQuery.refetch();
    void queries.dailyTrendQuery.refetch();
    void queries.capabilityBreakdownQuery.refetch();
  }, [
    queries.breakdownQuery,
    queries.capabilityBreakdownQuery,
    queries.dailyTrendQuery,
    queries.overviewQuery,
  ]);
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
  const openPolicySettings = queries.isOwner ? () => setIsPolicySettingsOpen(true) : undefined;
  const closePolicySettings = () => setIsPolicySettingsOpen(false);
  const policySettings = {
    draft: policy.draft,
    policy: policy.policy,
    isLoading: policy.policyQuery.isLoading,
    isError: policy.policyQuery.isError,
    isSaving: policy.isSaving,
    saveError: policy.saveError,
    conflict: policy.conflict,
    onRetry: () => { void policy.policyQuery.refetch(); },
    onPatchDraft: policy.actions.patchDraft,
    onSave: policy.actions.save,
    onReviewConflict: () => { void policy.actions.reviewConflict(); },
    onReapplyRetainedDraft: policy.actions.reapplyRetainedDraft,
  };

  if (isPolicySettingsOpen && queries.isOwner && props.isPhoneViewport) {
    return <ModelUsagePolicyMobilePage onClose={closePolicySettings} settings={policySettings} />;
  }

  return (
    <>
      <View
        model={queries.viewModel}
        isOwner={queries.isOwner}
        scope={queries.scope}
        period={queries.period}
        groupBy={queries.groupBy}
        alerts={queries.alerts}
        trendWindow={queries.trendWindow}
        isBreakdownLoading={queries.activeBreakdownQuery.isLoading}
        isOffline={typeof navigator !== 'undefined' && navigator.onLine === false}
        actions={actions}
        onOpenPolicySettings={openPolicySettings}
        onBack={props.onBack}
        onOpenRequestLogs={props.onOpenRequestLogs ?? (() => undefined)}
      />
      {isPolicySettingsOpen && queries.isOwner && !props.isPhoneViewport ? (
        <ModelUsagePolicyDesktopDrawer onClose={closePolicySettings} settings={policySettings} />
      ) : null}
    </>
  );
}
