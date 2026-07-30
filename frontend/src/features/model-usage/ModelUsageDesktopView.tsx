import type {
  ModelUsageBreakdownItem,
  ModelUsageCapability,
  ModelUsageFamilyOverview,
  ModelUsageGroupBy,
  ModelUsagePersonalOverview,
} from '../../api/types';
import { StateBlock, StatusBadge } from '../../components/ui-kit';
import { DashboardIcon } from '../../app/shellIcons';
import {
  MODEL_USAGE_CAPABILITY_METERS,
  MODEL_USAGE_CAPABILITY_OPTIONS,
  MODEL_USAGE_MEMBER_BUDGET_STATE_OPTIONS,
  MODEL_USAGE_METER_OPTIONS,
} from './modelUsageOptions';
import {
  costDisplay,
  formatModelUsageCny,
  formatModelUsageQuantity,
  formatModelUsageTrackingStartedAt,
} from './modelUsageModel';
import { ModelUsageHealth } from './ModelUsageHealth';
import { ModelUsageTrend } from './ModelUsageTrend';
import type { ModelUsageWorkspaceViewProps } from './modelUsageWorkspaceViewModel';

const GROUP_OPTIONS: Array<{ value: ModelUsageGroupBy; label: string }> = [
  { value: 'capability', label: '按能力' },
  { value: 'provider_model', label: '按服务商 / 模型' },
  { value: 'meter', label: '按计量项' },
  { value: 'daily_capability_cost', label: '按天费用' },
];

type ModelUsageOverview = ModelUsagePersonalOverview | ModelUsageFamilyOverview;

function formatPeriod(period: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  return match ? `${match[1]} 年 ${Number(match[2])} 月` : period;
}

function breakdownLabel(item: ModelUsageBreakdownItem): string {
  if (item.capability) return MODEL_USAGE_CAPABILITY_OPTIONS[item.capability].label;
  if (item.meter) return MODEL_USAGE_METER_OPTIONS[item.meter].label;
  return item.label;
}

function isFamilyOverview(overview: ModelUsageOverview): overview is ModelUsageFamilyOverview {
  return overview.scope === 'family';
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
            const meter = props.overview.meter_totals.find((total) =>
              MODEL_USAGE_CAPABILITY_METERS[capability].includes(total.meter),
            );
            return (
              <article key={capability} className="model-usage-capability-card">
                <h3>{option.label}</h3>
                <p>{option.description}</p>
                <strong className="model-usage-number">
                  {item
                    ? costDisplay(item)
                    : meter
                      ? `${formatModelUsageQuantity(meter.quantity)} ${MODEL_USAGE_METER_OPTIONS[meter.meter].label}`
                      : '暂无记录'}
                </strong>
              </article>
            );
          },
        )}
      </div>
    </section>
  );
}

function UsageHeader(props: Pick<ModelUsageWorkspaceViewProps, 'isOwner' | 'scope' | 'period' | 'actions' | 'onBack'>) {
  const title = props.scope === 'family' ? '家庭模型用量' : '我的模型用量';
  return (
    <header className="model-usage-header">
      <div className="model-usage-header-copy">
        <button className="model-usage-back" type="button" onClick={props.onBack}>
          <DashboardIcon name="arrow-left" />
          返回家庭
        </button>
        <p className="model-usage-eyebrow">家庭工作区</p>
        <h1>{title}</h1>
        <p>查看模型调用的费用、计量状态和可用额度。</p>
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

function BudgetSummary(props: { overview: ModelUsageOverview; cost: string }) {
  if (!isFamilyOverview(props.overview)) {
    const budgetState = MODEL_USAGE_MEMBER_BUDGET_STATE_OPTIONS[props.overview.family_budget_state];
    return (
      <section className="model-usage-budget model-usage-personal-budget" aria-labelledby="model-usage-cost-heading">
        <div>
          <p>我的已记录费用</p>
          <strong id="model-usage-cost-heading" className="model-usage-number">{props.cost}</strong>
        </div>
        <div>
          <StatusBadge tone={props.overview.family_budget_state === 'sufficient' ? 'success' : 'warning'}>
            {budgetState.label}
          </StatusBadge>
          <p>{budgetState.message}</p>
        </div>
      </section>
    );
  }

  return (
    <section className="model-usage-budget" aria-labelledby="model-usage-budget-heading">
      <div className="model-usage-budget-primary">
        <p id="model-usage-budget-heading">家庭月预算</p>
        <strong className="model-usage-number">
          {props.overview.monthly_budget_cny === null ? '未设置' : formatModelUsageCny(props.overview.monthly_budget_cny)}
        </strong>
        <small>{props.overview.hard_limit_enabled ? '已开启硬限制' : '未开启硬限制'}</small>
      </div>
      <dl className="model-usage-budget-facts">
        <div>
          <dt>已记录费用</dt>
          <dd className="model-usage-number">{props.cost}</dd>
        </div>
        <div>
          <dt>当前预留</dt>
          <dd className="model-usage-number">{formatModelUsageCny(props.overview.reserved_cost_cny)}</dd>
        </div>
        <div>
          <dt>额度判断</dt>
          <dd className="model-usage-number">{formatModelUsageCny(props.overview.effective_spend_cny)}</dd>
        </div>
      </dl>
      {props.overview.measurement_health.measurement_gap ? (
        <p className="model-usage-budget-warning">当前已记录费用可能低于真实费用，请结合计量完整度查看。</p>
      ) : null}
    </section>
  );
}

function Attention(props: Pick<ModelUsageWorkspaceViewProps, 'alerts' | 'scope'> & { overview: ModelUsageOverview }) {
  const personalBudgetState = props.overview.scope === 'me'
    ? props.overview.family_budget_state
    : null;
  const personalState = personalBudgetState
    ? MODEL_USAGE_MEMBER_BUDGET_STATE_OPTIONS[personalBudgetState]
    : null;
  const hasAttention = props.overview.measurement_health.measurement_gap || props.alerts.length > 0 || (
    personalBudgetState !== null && personalBudgetState !== 'sufficient'
  );
  if (!hasAttention) return null;

  return (
    <section className="model-usage-attention" aria-labelledby="model-usage-attention-heading">
      <div>
        <StatusBadge tone="warning">需要关注</StatusBadge>
        <h2 id="model-usage-attention-heading">
          {props.overview.measurement_health.measurement_gap
            ? '部分时间段的计量可能不完整'
            : personalState
              ? personalState.label
              : '家庭额度需要留意'}
        </h2>
        <p>
          {props.overview.measurement_health.measurement_gap
            ? '已记录费用可能低于真实费用，系统会保留计量状态供后续核对。'
            : personalState
              ? personalState.message
              : '请查看本月费用、预留金额和预算提醒。'}
        </p>
      </div>
    </section>
  );
}

function Breakdown(props: Pick<ModelUsageWorkspaceViewProps, 'groupBy' | 'scope' | 'isOwner' | 'actions' | 'isBreakdownLoading'> & {
  items: ModelUsageBreakdownItem[] | null;
  dailyTrendItems: ModelUsageBreakdownItem[];
  isDailyTrendLoading: boolean;
}) {
  const options = props.isOwner && props.scope === 'family'
    ? [...GROUP_OPTIONS, { value: 'subject' as const, label: '按家庭成员' }]
    : GROUP_OPTIONS;
  return (
    <section className="model-usage-breakdown" aria-labelledby="model-usage-breakdown-heading">
      <div className="model-usage-section-head model-usage-breakdown-head">
        <div>
          <h2 id="model-usage-breakdown-heading">趋势与细分</h2>
          <p>按不同维度查看本账期的已记录费用和计量项。</p>
        </div>
        <label className="model-usage-group-field">
          <span>统计维度</span>
          <select aria-label="统计维度" value={props.groupBy} onChange={(event) => props.actions.setGroupBy(event.target.value as ModelUsageGroupBy)}>
            {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
      </div>
      <ModelUsageTrend items={props.dailyTrendItems} isLoading={props.isDailyTrendLoading} />
      {props.isBreakdownLoading && !props.items ? (
        <div className="model-usage-breakdown-loading" role="status">正在加载细分数据。</div>
      ) : props.items?.length ? (
        <ul className="model-usage-breakdown-list">
          {props.items.map((item) => (
            <li key={`${item.label}-${item.local_day ?? ''}`}>
              <div>
                <strong className="model-usage-provider-name">{breakdownLabel(item)}</strong>
                {item.meter && item.meter_total ? (
                  <small>{formatModelUsageQuantity(item.meter_total)} {MODEL_USAGE_METER_OPTIONS[item.meter].label}</small>
                ) : null}
              </div>
              <span className="model-usage-number">{costDisplay(item)}</span>
            </li>
          ))}
        </ul>
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
  const trackingStartedAt = formatModelUsageTrackingStartedAt(overview.tracking_started_at);
  return (
    <main className="model-usage-workspace model-usage-desktop" aria-busy={props.model.isRefreshing || undefined}>
      <UsageHeader {...props} />
      {props.model.isRefreshing ? <p className="model-usage-refresh-status" role="status">正在刷新本账期数据。</p> : null}
      {props.model.refreshError ? (
        <p className="model-usage-refresh-error" role="status">
          {props.isOffline ? '当前离线，正在显示已缓存的数据。' : `刷新失败，正在显示上次成功的数据：${props.model.refreshError}`}
        </p>
      ) : null}
      {overview.is_partial_period ? (
        <div className="model-usage-partial-period" role="status">
          <StatusBadge tone="warning">部分账期</StatusBadge>
          <p>
            {trackingStartedAt
              ? `统计从 ${trackingStartedAt}开始，本月数据不包含此前调用。`
              : `${formatPeriod(overview.period)}的数据不包含开始统计前的调用。`}
          </p>
        </div>
      ) : null}
      <BudgetSummary overview={overview} cost={props.model.cost} />
      <Attention alerts={props.alerts} scope={props.scope} overview={overview} />
      {props.model.state === 'empty' ? (
        <StateBlock status="empty" title="这个账期暂无模型用量" description="后续使用模型功能后，会在这里显示费用、计量状态和细分记录。" />
      ) : (
        <>
          <CapabilityGrid overview={overview} items={breakdown?.group_by === 'capability' ? breakdown.items : null} />
          <Breakdown
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
      <ModelUsageHealth health={overview.measurement_health} />
    </main>
  );
}
