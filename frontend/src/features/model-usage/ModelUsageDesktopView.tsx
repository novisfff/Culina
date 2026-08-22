import type {
  ModelUsageBreakdownItem,
  ModelUsageGroupBy,
} from '../../api/types';
import { DropdownSelect, StateBlock } from '../../components/ui-kit';
import { DashboardIcon } from '../../app/shellIcons';
import { modelUsageGroupOptions } from './modelUsageOptions';
import {
  ModelUsageAttention,
  ModelUsageEmptyState,
  ModelUsageSummary,
} from './ModelUsageOverviewSections';
import { ModelUsageBreakdownTable } from './ModelUsageBreakdownTable';
import { ModelUsageInsights } from './ModelUsageInsights';
import type { ModelUsageWorkspaceViewProps } from './modelUsageWorkspaceViewModel';

function UsageHeader(props: Pick<ModelUsageWorkspaceViewProps, 'isOwner' | 'scope' | 'period' | 'actions' | 'onOpenPolicySettings' | 'onBack'>) {
  const title = props.scope === 'family' ? '家庭模型用量' : '我的模型用量';
  return (
    <header className="model-usage-header">
      <div className="model-usage-header-top-bar">
        <button className="model-usage-back" type="button" onClick={props.onBack}>
          <DashboardIcon name="arrow-left" />
          <span>返回家庭</span>
        </button>
        {props.isOwner && props.onOpenPolicySettings ? (
          <button className="model-usage-policy-entry" type="button" onClick={props.onOpenPolicySettings}>
            <DashboardIcon name="edit" />
            <span>预算设置</span>
          </button>
        ) : null}
      </div>
      <div className="model-usage-header-main-row">
        <div className="model-usage-header-copy">
          <p className="model-usage-eyebrow">家庭工作区</p>
          <h1>{title}</h1>
          <p className="model-usage-subhead">查看与管理本账期家庭模型 API 调用费用、额度与使用趋势。</p>
        </div>
        <div className="model-usage-header-controls">
          {props.isOwner ? (
            <div className="model-usage-scope-toggle" aria-label="用量范围">
              <button type="button" aria-pressed={props.scope === 'family'} onClick={() => props.actions.setScope('family')}>家庭</button>
              <button type="button" aria-pressed={props.scope === 'me'} onClick={() => props.actions.setScope('me')}>我的</button>
            </div>
          ) : null}
          <label className="model-usage-period-field">
            <span>账期</span>
            <div className="model-usage-period-input-wrapper">
              <DashboardIcon name="calendar" />
              <input
                aria-label="选择账期"
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

function Breakdown(props: Pick<ModelUsageWorkspaceViewProps, 'groupBy' | 'scope' | 'isOwner' | 'actions' | 'isBreakdownLoading'> & {
  items: ModelUsageBreakdownItem[] | null;
}) {
  const options = modelUsageGroupOptions(props.scope);
  return (
    <section className="model-usage-breakdown model-usage-breakdown-ledger" aria-labelledby="model-usage-breakdown-heading">
        <div className="model-usage-section-head model-usage-breakdown-head">
          <div>
            <h2 id="model-usage-breakdown-heading">费用细分</h2>
            <p>选择一种方式查看本账期的费用和计量明细。</p>
          </div>
          <div className="model-usage-group-field">
            <span className="model-usage-group-label">细分方式</span>
            <div className="model-usage-group-select-wrapper">
              <DropdownSelect
                ariaLabel="细分方式"
                placeholder="选择细分方式"
                value={props.groupBy}
                options={options}
                onChange={(value) => {
                  if (value) props.actions.setGroupBy(value as ModelUsageGroupBy);
                }}
              />
              <select
                aria-label="细分方式"
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
      {props.isBreakdownLoading && !props.items ? (
        <div className="model-usage-breakdown-loading" role="status">正在加载细分数据。</div>
      ) : props.items?.length ? (
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
      ) : (
        <p className="model-usage-breakdown-empty">这个账期暂无可展示的细分数据。</p>
      )}
    </section>
  );
}

export function ModelUsageDesktopView(props: ModelUsageWorkspaceViewProps) {
  if (props.model.state === 'loading') {
    return (
      <main className="model-usage-workspace model-usage-desktop">
        <StateBlock status="loading" title="正在加载模型用量" description="正在核对本账期的费用和计量状态。" />
      </main>
    );
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
      {props.model.isRefreshing ? <p className="model-usage-refresh-status" role="status">正在刷新本账期数据。</p> : null}
      {props.isOffline || props.model.refreshError ? (
        <p className="model-usage-refresh-error" role="status">
          {props.isOffline ? '当前离线，正在显示已缓存的数据。' : `刷新失败，正在显示上次成功的数据：${props.model.refreshError}`}
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
          <Breakdown
            groupBy={props.groupBy}
            scope={props.scope}
            isOwner={props.isOwner}
            actions={props.actions}
            isBreakdownLoading={props.isBreakdownLoading}
            items={breakdown?.items ?? null}
          />
          <button className="model-usage-request-logs-entry" type="button" onClick={props.onOpenRequestLogs}>
            <span><strong>请求日志</strong><small>按日期、模型和状态查看每次请求</small></span>
            <DashboardIcon name="arrow-right" />
          </button>
        </>
      )}
    </main>
  );
}
