import type {
  ModelUsageBreakdownItem,
  ModelUsageCapability,
  ModelUsageFamilyOverview,
  ModelUsageGroupBy,
  ModelUsagePersonalOverview,
} from '../../api/types';
import { DashboardIcon } from '../../app/shellIcons';
import { DropdownSelect, StateBlock } from '../../components/ui-kit';
import {
  MODEL_USAGE_CAPABILITY_OPTIONS,
  MODEL_USAGE_METER_OPTIONS,
  modelUsageGroupOptions,
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

type ModelUsageOverview = ModelUsagePersonalOverview | ModelUsageFamilyOverview;

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
    </header>
  );
}

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

function MobileCapabilities(props: { overview: ModelUsageOverview; items: ModelUsageBreakdownItem[] | null }) {
  const entriesByCapability = new Map(
    props.items?.filter((item) => item.capability).map((item) => [item.capability!, item]) ?? [],
  );
  return (
    <section className="model-usage-mobile-capabilities" aria-labelledby="model-usage-mobile-capability-heading">
      <div className="model-usage-mobile-section-head"><h2 id="model-usage-mobile-capability-heading">七类模型能力</h2></div>
      <ul>
        {Object.entries(MODEL_USAGE_CAPABILITY_OPTIONS).map(([capability, option]) => {
          const typedCapability = capability as ModelUsageCapability;
          const item = entriesByCapability.get(typedCapability);
          const meter = capabilityMeterFallback(
            props.overview.meter_totals,
            typedCapability,
          );
          const valueText = item
            ? costDisplay(item)
            : meter
              ? `${formatModelUsageQuantity(meter.quantity)} ${MODEL_USAGE_METER_OPTIONS[meter.meter].label}`
              : '暂无记录';
          const hasRecord = Boolean(item || meter);

          return (
            <li key={capability} className={hasRecord ? 'is-active' : 'is-empty'}>
              <div className="model-usage-mobile-cap-copy">
                <span className={`model-usage-capability-icon capability-tone-${capability}`}>
                  <CapabilityIcon capability={typedCapability} />
                </span>
                <div>
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                </div>
              </div>
              <span className={`model-usage-number ${hasRecord ? 'is-active-val' : 'is-empty-val'}`}>
                {valueText}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

type MobileTrendProps = {
  dailyTrendItems: ModelUsageBreakdownItem[];
  isDailyTrendLoading: boolean;
};

function MobileTrend(props: MobileTrendProps) {
  return (
    <section className="model-usage-mobile-trend-panel" aria-labelledby="model-usage-mobile-trend-heading">
      <div className="model-usage-mobile-section-head">
        <div>
          <h2 id="model-usage-mobile-trend-heading">每日费用趋势</h2>
          <p>按日期查看每天已记录的费用</p>
        </div>
        <span className="model-usage-trend-mode">每日</span>
      </div>
      <ModelUsageTrend items={props.dailyTrendItems} isLoading={props.isDailyTrendLoading} />
    </section>
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
            <h2 id="model-usage-mobile-breakdown-heading">费用细分</h2>
            <p>选择方式查看费用和计量明细</p>
          </div>
          <div className="model-usage-group-field">
            <span className="sr-only">细分方式</span>
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
        {props.isBreakdownLoading && !props.items ? <p role="status">正在加载细分数据。</p> : null}
        {!props.isBreakdownLoading && !props.items?.length ? <p>这个账期暂无可展示的细分数据。</p> : null}
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
    return <main className="model-usage-workspace model-usage-mobile model-usage-mobile-state"><StateBlock status="loading" title="正在加载模型用量" description="正在核对本账期的费用和计量状态。" /></main>;
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
          {props.isOffline ? '当前离线，正在显示已缓存的数据。' : `刷新失败，正在显示上次成功的数据：${props.model.refreshError}`}
        </p>
      ) : null}
      <ModelUsageSummary overview={overview} />
      <ModelUsageAttention alerts={props.alerts} overview={overview} />
      {props.model.state === 'empty' ? (
        <ModelUsageEmptyState />
      ) : (
        <>
          <MobileTrend dailyTrendItems={props.model.dailyTrend?.items ?? []} isDailyTrendLoading={props.model.isDailyTrendLoading} />
          <MobileCapabilities overview={overview} items={breakdown?.group_by === 'capability' ? breakdown.items : null} />
          <MobileBreakdown
            groupBy={props.groupBy}
            scope={props.scope}
            isOwner={props.isOwner}
            actions={props.actions}
            isBreakdownLoading={props.isBreakdownLoading}
            items={breakdown?.items ?? null}
          />
          <button className="model-usage-request-logs-entry" type="button" onClick={props.onOpenRequestLogs}>
            <span><strong>请求日志</strong><small>按日期、模型和状态查看</small></span>
            <DashboardIcon name="arrow-right" />
          </button>
        </>
      )}
    </main>
  );
}
