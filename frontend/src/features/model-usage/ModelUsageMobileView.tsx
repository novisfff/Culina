import type {
  ModelUsageBreakdownItem,
  ModelUsageCapability,
  ModelUsageFamilyOverview,
  ModelUsageGroupBy,
  ModelUsagePersonalOverview,
} from '../../api/types';
import { DashboardIcon } from '../../app/shellIcons';
import { StateBlock, StatusBadge } from '../../components/ui-kit';
import {
  MODEL_USAGE_CAPABILITY_OPTIONS,
  MODEL_USAGE_MEMBER_BUDGET_STATE_OPTIONS,
  MODEL_USAGE_METER_OPTIONS,
} from './modelUsageOptions';
import {
  capabilityMeterFallback,
  costDisplay,
  formatModelUsageCny,
  formatModelUsageQuantity,
  formatModelUsageTrackingStartedAt,
} from './modelUsageModel';
import { ModelUsageHealth } from './ModelUsageHealth';
import { ModelUsageTrend } from './ModelUsageTrend';
import type { ModelUsageWorkspaceViewProps } from './modelUsageWorkspaceViewModel';

const MOBILE_GROUP_OPTIONS: Array<{ value: ModelUsageGroupBy; label: string }> = [
  { value: 'capability', label: '按能力' },
  { value: 'provider_model', label: '按模型' },
  { value: 'meter', label: '按计量' },
  { value: 'daily_capability_cost', label: '按天' },
];

type ModelUsageOverview = ModelUsagePersonalOverview | ModelUsageFamilyOverview;

function isFamilyOverview(overview: ModelUsageOverview): overview is ModelUsageFamilyOverview {
  return overview.scope === 'family';
}

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
      </div>
      <div className="model-usage-mobile-controls">
        {props.isOwner && props.onOpenPolicySettings ? (
          <button className="model-usage-policy-entry" type="button" onClick={props.onOpenPolicySettings}>预算设置</button>
        ) : null}
        {props.isOwner ? (
          <div className="model-usage-scope-toggle" aria-label="用量范围">
            <button type="button" aria-pressed={props.scope === 'family'} onClick={() => props.actions.setScope('family')}>家庭</button>
            <button type="button" aria-pressed={props.scope === 'me'} onClick={() => props.actions.setScope('me')}>我的</button>
          </div>
        ) : null}
        <label>
          <span>账期</span>
          <input
            aria-label="选择账期"
            type="month"
            value={props.period}
            onChange={(event) => {
              if (/^\d{4}-\d{2}$/.test(event.target.value)) props.actions.setPeriod(event.target.value);
            }}
          />
        </label>
      </div>
    </header>
  );
}

function MobileAttention(props: Pick<ModelUsageWorkspaceViewProps, 'alerts'> & { overview: ModelUsageOverview }) {
  const personalBudgetState = props.overview.scope === 'me'
    ? props.overview.family_budget_state
    : null;
  const state = personalBudgetState ? MODEL_USAGE_MEMBER_BUDGET_STATE_OPTIONS[personalBudgetState] : null;
  if (!props.overview.measurement_health.measurement_gap && !props.alerts.length && (!state || personalBudgetState === 'sufficient')) {
    return null;
  }
  return (
    <section className="model-usage-mobile-attention">
      <StatusBadge tone="warning">需要关注</StatusBadge>
      <strong>{props.overview.measurement_health.measurement_gap ? '部分时间段的计量可能不完整' : state?.label ?? '家庭额度需要留意'}</strong>
      <p>{props.overview.measurement_health.measurement_gap ? '已记录费用可能低于真实费用，请结合计量完整度查看。' : state?.message ?? '请查看本月费用和预算提醒。'}</p>
    </section>
  );
}

function MobileCostCard(props: { overview: ModelUsageOverview; cost: string }) {
  if (isFamilyOverview(props.overview)) {
    return (
      <section className="model-usage-mobile-cost-card" aria-labelledby="model-usage-mobile-budget-heading">
        <div>
          <span id="model-usage-mobile-budget-heading">家庭月预算</span>
          <strong className="model-usage-number">{props.overview.monthly_budget_cny === null ? '未设置' : formatModelUsageCny(props.overview.monthly_budget_cny)}</strong>
        </div>
        <dl>
          <div><dt>已记录</dt><dd className="model-usage-number">{props.cost}</dd></div>
          <div><dt>预留</dt><dd className="model-usage-number">{formatModelUsageCny(props.overview.reserved_cost_cny)}</dd></div>
        </dl>
        <small>{props.overview.hard_limit_enabled ? '已开启硬限制' : '未开启硬限制'}</small>
      </section>
    );
  }
  const state = MODEL_USAGE_MEMBER_BUDGET_STATE_OPTIONS[props.overview.family_budget_state];
  return (
    <section className="model-usage-mobile-cost-card" aria-labelledby="model-usage-mobile-cost-heading">
      <span id="model-usage-mobile-cost-heading">我的已记录费用</span>
      <strong className="model-usage-number">{props.cost}</strong>
      <StatusBadge tone={props.overview.family_budget_state === 'sufficient' ? 'success' : 'warning'}>{state.label}</StatusBadge>
    </section>
  );
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
          return (
            <li key={capability}>
              <div><strong>{option.label}</strong><small>{option.description}</small></div>
              <span className="model-usage-number">{item ? costDisplay(item) : meter ? `${formatModelUsageQuantity(meter.quantity)} ${MODEL_USAGE_METER_OPTIONS[meter.meter].label}` : '暂无记录'}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function MobileBreakdown(props: Pick<ModelUsageWorkspaceViewProps, 'groupBy' | 'scope' | 'isOwner' | 'actions' | 'isBreakdownLoading'> & {
  items: ModelUsageBreakdownItem[] | null;
  dailyTrendItems: ModelUsageBreakdownItem[];
  isDailyTrendLoading: boolean;
}) {
  const options = props.isOwner && props.scope === 'family'
    ? [...MOBILE_GROUP_OPTIONS, { value: 'subject' as const, label: '成员' }]
    : MOBILE_GROUP_OPTIONS;
  return (
    <section className="model-usage-mobile-breakdown" aria-labelledby="model-usage-mobile-breakdown-heading">
      <div className="model-usage-mobile-section-head">
        <h2 id="model-usage-mobile-breakdown-heading">趋势与细分</h2>
        <label>
          <span className="sr-only">统计维度</span>
          <select aria-label="统计维度" value={props.groupBy} onChange={(event) => props.actions.setGroupBy(event.target.value as ModelUsageGroupBy)}>
            {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
      </div>
      <ModelUsageTrend items={props.dailyTrendItems} isLoading={props.isDailyTrendLoading} />
      {props.isBreakdownLoading && !props.items ? <p role="status">正在加载细分数据。</p> : null}
      {!props.isBreakdownLoading && !props.items?.length ? <p>这个账期暂无可展示的细分数据。</p> : null}
      {props.items?.length ? (
        <ul>
          {props.items.map((item) => (
            <li key={`${item.label}-${item.local_day ?? ''}`}>
              <strong className="model-usage-provider-name">{item.capability ? MODEL_USAGE_CAPABILITY_OPTIONS[item.capability].label : item.meter ? MODEL_USAGE_METER_OPTIONS[item.meter].label : item.label}</strong>
              <span className="model-usage-number">{costDisplay(item)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function ModelUsageMobileView(props: ModelUsageWorkspaceViewProps) {
  if (props.model.state === 'loading') {
    return <main className="model-usage-workspace model-usage-mobile"><StateBlock status="loading" title="正在加载模型用量" description="正在核对本账期的费用和计量状态。" /></main>;
  }
  if (props.model.state === 'error') {
    return <main className="model-usage-workspace model-usage-mobile"><StateBlock status="error" title="模型用量加载失败" description={props.model.errorMessage} actionLabel="重新加载" onAction={props.actions.retry} /></main>;
  }

  const { overview, breakdown } = props.model;
  const trackingStartedAt = formatModelUsageTrackingStartedAt(overview.tracking_started_at);
  return (
    <main className="model-usage-workspace model-usage-mobile" aria-busy={props.model.isRefreshing || undefined}>
      <CompactHeader {...props} />
      {props.isOffline || props.model.refreshError ? (
        <p className="model-usage-refresh-error" role="status">
          {props.isOffline ? '当前离线，正在显示已缓存的数据。' : `刷新失败，正在显示上次成功的数据：${props.model.refreshError}`}
        </p>
      ) : null}
      {overview.is_partial_period ? (
        <p className="model-usage-mobile-partial" role="status">
          {trackingStartedAt
            ? `统计从 ${trackingStartedAt}开始，本月数据不包含此前调用。`
            : '本月数据不包含开始统计前的调用。'}
        </p>
      ) : null}
      <MobileAttention alerts={props.alerts} overview={overview} />
      <MobileCostCard overview={overview} cost={props.model.cost} />
      {props.model.state === 'empty' ? (
        <StateBlock status="empty" title="这个账期暂无模型用量" description="后续使用模型功能后，会在这里显示费用和计量状态。" />
      ) : (
        <>
          <MobileCapabilities overview={overview} items={breakdown?.group_by === 'capability' ? breakdown.items : null} />
          <MobileBreakdown
            groupBy={props.groupBy}
            scope={props.scope}
            isOwner={props.isOwner}
            actions={props.actions}
            isBreakdownLoading={props.isBreakdownLoading}
            items={breakdown?.items ?? null}
            dailyTrendItems={props.model.dailyTrend?.items ?? []}
            isDailyTrendLoading={props.model.isDailyTrendLoading}
          />
        </>
      )}
      <ModelUsageHealth health={overview.measurement_health} compact />
    </main>
  );
}
