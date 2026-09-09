import { DashboardIcon } from '../../app/shellIcons';
import { PageLoadingState, StateBlock } from '../../components/ui-kit';
import {
  ModelUsageAttention,
  ModelUsageEmptyState,
  ModelUsageSummary,
} from './ModelUsageOverviewSections';
import { ModelUsageBreakdown } from './ModelUsageBreakdown';
import { ModelUsageInsights } from './ModelUsageInsights';
import type { ModelUsageWorkspaceViewProps } from './modelUsageWorkspaceViewModel';

function CompactHeader(props: Pick<ModelUsageWorkspaceViewProps, 'isOwner' | 'scope' | 'period' | 'actions' | 'onOpenPolicySettings' | 'onBack' | 'onOpenRequestLogs'>) {
  return (
    <header className="model-usage-mobile-header">
      <div className="model-usage-mobile-title-row">
        <button className="model-usage-mobile-back" type="button" aria-label="返回家庭页" onClick={props.onBack}>
          <DashboardIcon name="arrow-left" />
        </button>
        <div>
          <p>家庭工作区</p>
          <h1>{props.scope === 'family' ? '家庭模型用量' : '我的模型用量'}</h1>
        </div>

      </div>
      <div className="model-usage-page-actions">
        <button className="secondary-button" type="button" onClick={props.onOpenRequestLogs}>请求记录</button>
        {props.isOwner && props.onOpenPolicySettings ? (
          <button className="model-usage-policy-entry" type="button" onClick={props.onOpenPolicySettings}>预算设置</button>
        ) : null}
      </div>
      <div className="model-usage-mobile-controls">
        {props.isOwner ? (
          <div className="model-usage-scope-toggle" aria-label="用量范围">
            <button type="button" aria-pressed={props.scope === 'family'} onClick={() => props.actions.setScope('family')}>家庭</button>
            <button type="button" aria-pressed={props.scope === 'me'} onClick={() => props.actions.setScope('me')}>我的</button>
          </div>
        ) : null}
        <label>
          <span>统计周期</span>
          <div className="model-usage-period-input-wrapper">
            <DashboardIcon name="calendar" />
            <input
              aria-label="选择统计周期"
              type="month"
              value={props.period}
              onChange={(event) => {
                if (/^\d{4}-\d{2}$/.test(event.target.value)) props.actions.setPeriod(event.target.value);
              }}
            />
          </div>
        </label>
      </div>
    </header>
  );
}


export function ModelUsageMobileView(props: ModelUsageWorkspaceViewProps) {
  if (props.model.state === 'loading') {
    return <PageLoadingState title="模型用量" eyebrow={props.scope === 'family' ? '正在加载家庭' : '正在加载我的'} description="正在核对本统计周期的费用和用量明细。" className="model-usage-page-loading" />;
  }
  if (props.model.state === 'error') {
    return <main className="model-usage-workspace model-usage-mobile model-usage-mobile-state"><StateBlock status="error" title="模型用量加载失败" description={props.model.errorMessage} actionLabel="重新加载" onAction={props.actions.retry} /></main>;
  }

  const { overview, breakdown } = props.model;
  return (
    <main className="model-usage-workspace model-usage-mobile" aria-busy={props.model.isRefreshing || undefined}>
      <CompactHeader {...props} />
      {props.isOffline || props.model.refreshError ? (
        <p className="model-usage-refresh-error" role="status">
          {props.isOffline ? '当前离线，以下显示已缓存的数据。' : `暂时无法刷新，以下显示最近一次成功加载的数据：${props.model.refreshError}`}
        </p>
      ) : null}
      <ModelUsageSummary overview={overview} />
      <ModelUsageAttention alerts={props.alerts} overview={overview} />
      {props.model.state === 'empty' ? (
        <>
          <ModelUsageEmptyState />
        </>
      ) : (
        <>
          <ModelUsageInsights
            overview={overview}
            trendWindow={props.trendWindow}
            dailyTrendItems={props.model.dailyTrend?.items ?? []}
            capabilityItems={props.model.capabilityBreakdown?.items ?? []}
            isDailyTrendLoading={props.model.isDailyTrendLoading}
            isCapabilityBreakdownLoading={props.model.isCapabilityBreakdownLoading}
          />
          <ModelUsageBreakdown
            groupBy={props.groupBy}
            scope={props.scope}
            isOwner={props.isOwner}
            actions={props.actions}
            isBreakdownLoading={props.isBreakdownLoading}
            items={breakdown?.items ?? null}
          />

        </>
      )}
    </main>
  );
}
