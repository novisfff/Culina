import type {
  ModelUsageBreakdownItem,
  ModelUsageCapability,
  ModelUsageFamilyOverview,
  ModelUsageGroupBy,
  ModelUsagePersonalOverview,
} from '../../api/types';
import { DropdownSelect, StateBlock } from '../../components/ui-kit';
import { DashboardIcon } from '../../app/shellIcons';
import {
  MODEL_USAGE_CAPABILITY_OPTIONS,
  MODEL_USAGE_METER_OPTIONS,
} from './modelUsageOptions';
import {
  capabilityMeterFallback,
  costDisplay,
  formatModelUsageQuantity,
} from './modelUsageModel';
import {
  ModelUsageAttention,
  ModelUsageEmptyState,
  ModelUsageSummary,
} from './ModelUsageOverviewSections';
import { ModelUsageTrend } from './ModelUsageTrend';
import { ModelUsageBreakdownTable } from './ModelUsageBreakdownTable';
import type { ModelUsageWorkspaceViewProps } from './modelUsageWorkspaceViewModel';

const GROUP_OPTIONS: Array<{ value: ModelUsageGroupBy; label: string }> = [
  { value: 'capability', label: '按能力' },
  { value: 'provider_model', label: '按服务商 / 模型' },
  { value: 'meter', label: '按计量项' },
];

type ModelUsageOverview = ModelUsagePersonalOverview | ModelUsageFamilyOverview;

function CapabilityIcon(props: { capability: ModelUsageCapability }) {
  switch (props.capability) {
    case 'llm':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z" />
          <path d="m19 15 1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1 1-2.5Z" />
        </svg>
      );
    case 'embedding':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="6" />
          <path d="m15.5 15.5 4.5 4.5" />
          <path d="M8 11h6" />
        </svg>
      );
    case 'rerank':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 6h16" />
          <path d="M7 12h10" />
          <path d="M10 18h4" />
        </svg>
      );
    case 'stt':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="9" y="3" width="6" height="11" rx="3" />
          <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
          <path d="M12 18v3" />
        </svg>
      );
    case 'tts':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M5 9v6h4l5 4V5L9 9H5Z" />
          <path d="M17 9a4 4 0 0 1 0 6" />
          <path d="M19.5 6.5a7.5 7.5 0 0 1 0 11" />
        </svg>
      );
    case 'realtime_audio':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 12h2l3-7 4 14 3-7h4" />
          <circle cx="12" cy="12" r="9" />
        </svg>
      );
    case 'image_generation':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="3.5" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="m21 15-5-5-11 11" />
        </svg>
      );
  }
}

function CapabilityGrid(props: { overview: ModelUsageOverview; items: ModelUsageBreakdownItem[] | null }) {
  const itemsByCapability = new Map(
    props.items?.filter((item) => item.capability).map((item) => [item.capability!, item]) ?? [],
  );

  return (
    <section className="model-usage-capabilities" aria-labelledby="model-usage-capability-heading">
      <div className="model-usage-section-head">
        <div>
          <h2 id="model-usage-capability-heading">七类模型能力</h2>
          <p>按能力查看已记录的费用或可核对的计量项。</p>
        </div>
      </div>
      <div className="model-usage-capability-grid">
        {(Object.entries(MODEL_USAGE_CAPABILITY_OPTIONS) as Array<[ModelUsageCapability, typeof MODEL_USAGE_CAPABILITY_OPTIONS.llm]>).map(
          ([capability, option]) => {
            const item = itemsByCapability.get(capability);
            const meter = capabilityMeterFallback(
              props.overview.meter_totals,
              capability,
            );
            const valueText = item
              ? costDisplay(item)
              : meter
                ? `${formatModelUsageQuantity(meter.quantity)} ${MODEL_USAGE_METER_OPTIONS[meter.meter].label}`
                : '暂无记录';
            const hasRecord = Boolean(item || meter);

            return (
              <article key={capability} className={`model-usage-capability-card ${hasRecord ? 'is-active' : 'is-empty'}`}>
                <div className="model-usage-capability-header">
                  <span className={`model-usage-capability-icon capability-tone-${capability}`}>
                    <CapabilityIcon capability={capability} />
                  </span>
                  <h3>{option.label}</h3>
                </div>
                <p>{option.description}</p>
                <strong className={`model-usage-number ${hasRecord ? 'is-active-val' : 'is-empty-val'}`}>
                  {valueText}
                </strong>
              </article>
            );
          },
        )}
      </div>
    </section>
  );
}

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

type UsageDataProps = {
  dailyTrendItems: ModelUsageBreakdownItem[];
  isDailyTrendLoading: boolean;
};

function DailyTrend(props: UsageDataProps) {
  return (
    <section className="model-usage-trend-panel" aria-labelledby="model-usage-trend-heading">
      <div className="model-usage-section-head model-usage-trend-head">
        <div>
          <h2 id="model-usage-trend-heading">每日费用趋势</h2>
          <p>按本地日期查看每天已记录的费用，仅统计已定价用量。</p>
        </div>
        <span className="model-usage-trend-mode">按日期</span>
      </div>
      <ModelUsageTrend items={props.dailyTrendItems} isLoading={props.isDailyTrendLoading} />
    </section>
  );
}

function Breakdown(props: Pick<ModelUsageWorkspaceViewProps, 'groupBy' | 'scope' | 'isOwner' | 'actions' | 'isBreakdownLoading'> & {
  items: ModelUsageBreakdownItem[] | null;
}) {
  const options = props.isOwner && props.scope === 'family'
    ? [...GROUP_OPTIONS, { value: 'subject' as const, label: '按家庭成员' }]
    : GROUP_OPTIONS;
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
        <ModelUsageBreakdownTable items={props.items} groupBy={props.groupBy} />
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
      <ModelUsageAttention alerts={props.alerts} overview={overview} />
      {props.model.state === 'empty' ? (
        <ModelUsageEmptyState />
      ) : (
        <>
          <DailyTrend dailyTrendItems={props.model.dailyTrend?.items ?? []} isDailyTrendLoading={props.model.isDailyTrendLoading} />
          <CapabilityGrid overview={overview} items={breakdown?.group_by === 'capability' ? breakdown.items : null} />
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
