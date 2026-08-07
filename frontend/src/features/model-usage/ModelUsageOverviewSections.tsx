import type {
  ModelUsageAlert,
  ModelUsageFamilyOverview,
  ModelUsagePersonalOverview,
} from '../../api/types';
import { DashboardIcon } from '../../app/shellIcons';
import { StatusBadge } from '../../components/ui-kit';
import {
  MODEL_USAGE_MEMBER_BUDGET_STATE_OPTIONS,
} from './modelUsageOptions';
import {
  actionableModelUsageHealthNotices,
  formatModelUsageCny,
  formatModelUsageTrackingStartedAt,
} from './modelUsageModel';
import { ModelUsageHealth } from './ModelUsageHealth';

type ModelUsageOverview = ModelUsagePersonalOverview | ModelUsageFamilyOverview;

const PERSONAL_BUDGET_MESSAGES: Record<ModelUsagePersonalOverview['family_budget_state'], string> = {
  sufficient: '当前使用不会受到限制',
  approaching_limit: '本月可用额度已经不多',
  alert_threshold_reached: '本月用量已达到家庭提醒线',
  capability_degraded: '部分模型功能可能改用基础方式处理',
  measurement_unavailable: '暂时无法完整确认家庭可用额度',
};

function isFamilyOverview(overview: ModelUsageOverview): overview is ModelUsageFamilyOverview {
  return overview.scope === 'family';
}

function periodMonth(period: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  return match ? `${Number(match[2])} 月` : period;
}

function trackingCopy(overview: ModelUsageOverview): string | null {
  if (!overview.is_partial_period) return null;
  const trackingStartedAt = formatModelUsageTrackingStartedAt(overview.tracking_started_at);
  return trackingStartedAt ? `从 ${trackingStartedAt}开始记录` : '本账期从启用统计后开始记录';
}

export function ModelUsageSummary(props: { overview: ModelUsageOverview }) {
  const month = periodMonth(props.overview.period);
  const startedAt = trackingCopy(props.overview);
  const recordedCost = formatModelUsageCny(props.overview.known_priced_cost_cny);

  if (!isFamilyOverview(props.overview)) {
    const budgetState = MODEL_USAGE_MEMBER_BUDGET_STATE_OPTIONS[props.overview.family_budget_state];
    const tone = props.overview.family_budget_state === 'sufficient' ? 'success' : 'warning';
    return (
      <section className="model-usage-summary model-usage-summary-personal" aria-labelledby="model-usage-summary-heading">
        <div className="model-usage-summary-primary">
          <p id="model-usage-summary-heading">{month}已记录费用</p>
          <strong className="model-usage-number">{recordedCost}</strong>
          {startedAt ? <small>{startedAt}</small> : null}
        </div>
        <div className={`model-usage-summary-state is-${tone}`}>
          <StatusBadge tone={tone}>{budgetState.label}</StatusBadge>
          <strong>{PERSONAL_BUDGET_MESSAGES[props.overview.family_budget_state]}</strong>
        </div>
      </section>
    );
  }

  const budgetNum = props.overview.monthly_budget_cny ? Number(props.overview.monthly_budget_cny) : null;
  const effectiveNum = Number(props.overview.effective_spend_cny || '0');
  const usageRatio = budgetNum && budgetNum > 0 ? Math.min(Math.max((effectiveNum / budgetNum) * 100, 0), 100) : null;

  return (
    <section className="model-usage-summary model-usage-summary-family" aria-labelledby="model-usage-summary-heading">
      <div className="model-usage-summary-primary">
        <p id="model-usage-summary-heading">{month}已记录费用</p>
        <strong className="model-usage-number">{recordedCost}</strong>
        {startedAt ? <small>{startedAt}</small> : null}
      </div>
      <div className="model-usage-summary-budget">
        <div className="model-usage-summary-budget-head">
          <div className="model-usage-summary-budget-title">
            <span>家庭额度</span>
            {usageRatio !== null ? (
              <small className="model-usage-budget-percent">
                已用 {usageRatio < 0.1 && usageRatio > 0 ? '<0.1' : usageRatio.toFixed(1)}%
              </small>
            ) : null}
          </div>
          <StatusBadge tone={props.overview.hard_limit_enabled ? 'info' : 'neutral'}>
            {props.overview.hard_limit_enabled ? '硬限制已开启' : '仅提醒'}
          </StatusBadge>
        </div>
        {usageRatio !== null ? (
          <div className="model-usage-budget-progress" aria-hidden="true">
            <div
              className={`model-usage-budget-progress-fill ${usageRatio >= 100 ? 'is-danger' : usageRatio >= 80 ? 'is-warning' : ''}`}
              style={{ width: `${Math.max(usageRatio, usageRatio > 0 ? 2 : 0)}%` }}
            />
          </div>
        ) : null}
        <dl className="model-usage-summary-metrics">
          <div className="model-usage-summary-metric">
            <dt>月预算</dt>
            <dd className="model-usage-number">
              {props.overview.monthly_budget_cny === null ? '未设置' : formatModelUsageCny(props.overview.monthly_budget_cny)}
            </dd>
          </div>
          <div className="model-usage-summary-metric">
            <dt>当前预留</dt>
            <dd className="model-usage-number">{formatModelUsageCny(props.overview.reserved_cost_cny)}</dd>
          </div>
          <div className="model-usage-summary-metric">
            <dt>额度判断</dt>
            <dd className="model-usage-number">{formatModelUsageCny(props.overview.effective_spend_cny)}</dd>
          </div>
        </dl>
      </div>
    </section>
  );
}

function thresholdPercent(value: string): string {
  const threshold = Number(value);
  if (!Number.isFinite(threshold) || threshold < 0) return '提醒线';
  return `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(threshold * 100)}%`;
}

function highestCurrentAlert(alerts: ModelUsageAlert[], period: string): ModelUsageAlert | null {
  return alerts
    .filter((alert) => alert.period === period && alert.dismissed_at === null)
    .reduce<ModelUsageAlert | null>((highest, alert) => {
      if (!highest) return alert;
      return Number(alert.threshold) > Number(highest.threshold) ? alert : highest;
    }, null);
}

export function ModelUsageAttention(props: { overview: ModelUsageOverview; alerts: ModelUsageAlert[] }) {
  const alert = highestCurrentAlert(props.alerts, props.overview.period);
  const hasHealthNotices = actionableModelUsageHealthNotices(props.overview.measurement_health).length > 0;

  if (!alert) {
    return hasHealthNotices ? <ModelUsageHealth health={props.overview.measurement_health} /> : null;
  }

  const title = alert
    ? `家庭预算已达到 ${thresholdPercent(alert.threshold)}`
    : '家庭预算需要留意';
  const description = Number(alert.threshold) >= 1
    ? '本月额度已经达到或超过预算，后续模型功能可能受到限制。'
    : '本月用量已达到家庭设置的预算提醒线。';

  return (
    <section className="model-usage-attention" aria-labelledby="model-usage-attention-heading">
      <div className="model-usage-attention-head">
        <StatusBadge tone={alert?.severity === 'critical' ? 'danger' : 'warning'}>需要留意</StatusBadge>
        <div>
          <h2 id="model-usage-attention-heading">{title}</h2>
          <p>{description}</p>
        </div>
      </div>
      {alert ? (
        <dl className="model-usage-alert-facts">
          <div><dt>额度判断</dt><dd className="model-usage-number">{formatModelUsageCny(alert.effective_spend_cny)}</dd></div>
          <div><dt>月预算</dt><dd className="model-usage-number">{formatModelUsageCny(alert.budget_cny)}</dd></div>
          <div><dt>提醒线</dt><dd className="model-usage-number">{thresholdPercent(alert.threshold)}</dd></div>
        </dl>
      ) : null}
      {hasHealthNotices ? <ModelUsageHealth health={props.overview.measurement_health} compact hideHeading /> : null}
    </section>
  );
}

export function ModelUsageEmptyState() {
  return (
    <section className="model-usage-empty" role="status" aria-labelledby="model-usage-empty-heading">
      <span className="model-usage-empty-icon"><DashboardIcon name="bar-chart" /></span>
      <div>
        <h2 id="model-usage-empty-heading">本月还没有模型调用</h2>
        <p>使用菜谱生成、图片识别等功能后，用量会自动记录在这里。</p>
      </div>
    </section>
  );
}
