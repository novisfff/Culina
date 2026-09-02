import type {
  ModelUsageBreakdownItem,
  ModelUsageGroupBy,
} from '../../api/types/modelUsage';
import { DashboardIcon } from '../../app/shellIcons';
import { DropdownSelect, PageLoadingState, StateBlock } from '../../components/ui-kit';
import { modelUsageGroupOptions } from './modelUsageOptions';
import {
  ModelUsageAttention,
  ModelUsageEmptyState,
  ModelUsageSummary,
} from './ModelUsageOverviewSections';
import { ModelUsageBreakdownTable } from './ModelUsageBreakdownTable';
import { ModelUsageInsights } from './ModelUsageInsights';
import type { ModelUsageWorkspaceViewProps } from './modelUsageWorkspaceViewModel';

function CompactHeader(props: Pick<ModelUsageWorkspaceViewProps, 'isOwner' | 'scope' | 'period' | 'actions' | 'onOpenPolicySettings' | 'onBack'>) {
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

function MobileBreakdown(props: Pick<ModelUsageWorkspaceViewProps, 'groupBy' | 'scope' | 'isOwner' | 'actions' | 'isBreakdownLoading'> & {
  items: ModelUsageBreakdownItem[] | null;
}) {
  const options = modelUsageGroupOptions(props.scope);
  return (
    <section className="model-usage-mobile-breakdown model-usage-breakdown-ledger" aria-labelledby="model-usage-mobile-breakdown-heading">
        <div className="model-usage-mobile-section-head">
          <div>
            <h2 id="model-usage-mobile-breakdown-heading">费用明细</h2>
            <p>选择方式查看费用和用量明细</p>
          </div>
          <div className="model-usage-group-field">
            <span className="sr-only">查看方式</span>
            <div className="model-usage-group-select-wrapper">
              <DropdownSelect
                ariaLabel="查看方式"
                placeholder="选择查看方式"
                value={props.groupBy}
                options={options}
                onChange={(value) => {
                  if (value) props.actions.setGroupBy(value as ModelUsageGroupBy);
                }}
              />
              <select
                aria-label="查看方式"
                tabIndex={-1}
                className="model-usage-test-select-fallback"
                value={props.groupBy}
                onChange={(event) => props.actions.setGroupBy(event.target.value as ModelUsageGroupBy)}
              >
                {options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
        {props.isBreakdownLoading && !props.items ? <p role="status">正在加载费用明细。</p> : null}
        {!props.isBreakdownLoading && !props.items?.length ? <p>这个统计周期还没有可展示的费用明细。</p> : null}
        {props.items?.length ? (
          props.scope === 'family' ? (
            <ModelUsageBreakdownTable
              scope="family"
              items={props.items as import('../../api/types').ModelUsageFamilyBreakdownItem[]}
              groupBy={props.groupBy as import('../../api/types').ModelUsageFamilyGroupBy}
            />
          ) : (
            <ModelUsageBreakdownTable
              scope="me"
              items={props.items as import('../../api/types').ModelUsagePersonalBreakdownItem[]}
              groupBy={props.groupBy as import('../../api/types').ModelUsagePersonalGroupBy}
            />
          )
        ) : null}
    </section>
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
      {props.model.state === 'empty' ? (
        <>
          <ModelUsageAttention alerts={props.alerts} overview={overview} />
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
          <ModelUsageAttention alerts={props.alerts} overview={overview} />
          <MobileBreakdown
            groupBy={props.groupBy}
            scope={props.scope}
            isOwner={props.isOwner}
            actions={props.actions}
            isBreakdownLoading={props.isBreakdownLoading}
            items={breakdown?.items ?? null}
          />
          <button className="model-usage-request-logs-entry" type="button" onClick={props.onOpenRequestLogs}>
            <span><strong>请求记录</strong><small>按日期、模型和状态查看</small></span>
            <DashboardIcon name="arrow-right" />
          </button>
        </>
      )}
    </main>
  );
}
