import { PageLoadingState, StateBlock } from '../../components/ui-kit';
import { DashboardIcon } from '../../app/shellIcons';
import {
  ModelUsageAttention,
  ModelUsageEmptyState,
  ModelUsageSummary,
} from './ModelUsageOverviewSections';
import { ModelUsageBreakdown } from './ModelUsageBreakdown';
import { ModelUsageInsights } from './ModelUsageInsights';
import type { ModelUsageWorkspaceViewProps } from './modelUsageWorkspaceViewModel';

function UsageHeader(props: Pick<ModelUsageWorkspaceViewProps, 'isOwner' | 'scope' | 'period' | 'actions' | 'onOpenPolicySettings' | 'onBack' | 'onOpenRequestLogs'>) {
  const title = props.scope === 'family' ? '家庭模型用量' : '我的模型用量';
  return (
    <header className="model-usage-header">
      <div className="model-usage-header-top-bar">
        <button className="model-usage-back" type="button" onClick={props.onBack}>
          <DashboardIcon name="arrow-left" />
          <span>返回家庭</span>
        </button>
        <div className="model-usage-page-actions">
          <button type="button" className="secondary-button" onClick={props.onOpenRequestLogs}>请求记录</button>
        {props.isOwner && props.onOpenPolicySettings ? (
          <button className="model-usage-policy-entry" type="button" onClick={props.onOpenPolicySettings}>
            <DashboardIcon name="edit" />
            <span>预算设置</span>
          </button>
        ) : null}
        </div>
      </div>
      <div className="model-usage-header-main-row">
        <div className="model-usage-header-copy">
          <p className="model-usage-eyebrow">家庭工作区</p>
          <h1>{title}</h1>
          <p className="model-usage-subhead">{props.scope === 'family' ? '查看家庭费用、预算余量与使用明细。' : '查看自己的模型费用与使用明细。'}</p>
        </div>
        <div className="model-usage-header-controls">
          {props.isOwner ? (
            <div className="model-usage-scope-toggle" aria-label="用量范围">
              <button type="button" aria-pressed={props.scope === 'family'} onClick={() => props.actions.setScope('family')}>家庭</button>
              <button type="button" aria-pressed={props.scope === 'me'} onClick={() => props.actions.setScope('me')}>我的</button>
            </div>
          ) : null}
          <label className="model-usage-period-field">
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
      </div>
    </header>
  );
}


export function ModelUsageDesktopView(props: ModelUsageWorkspaceViewProps) {
  if (props.model.state === 'loading') {
    return <PageLoadingState title="模型用量" eyebrow={props.scope === 'family' ? '正在加载家庭' : '正在加载我的'} description="正在核对本统计周期的费用和用量明细。" className="model-usage-page-loading" />;
  }
  if (props.model.state === 'error') {
    return (
      <main className="model-usage-workspace model-usage-desktop">
        <StateBlock status="error" title="模型用量加载失败" description={props.model.errorMessage} actionLabel="重新加载" onAction={props.actions.retry} />
      </main>
    );
  }

  const { overview, breakdown } = props.model;
  return (
    <main className="model-usage-workspace model-usage-desktop" aria-busy={props.model.isRefreshing || undefined}>
      <UsageHeader {...props} />
      {props.model.isRefreshing ? <p className="model-usage-refresh-status" role="status">正在刷新当前统计周期的数据。</p> : null}
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
