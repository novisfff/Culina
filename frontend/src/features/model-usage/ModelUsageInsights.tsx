import type { CSSProperties } from 'react';
import { DashboardIcon } from '../../app/shellIcons';
import type {
  ModelUsageBreakdownItem,
  ModelUsageFamilyOverview,
  ModelUsagePersonalOverview,
} from '../../api/types/modelUsage';
import { formatModelUsageCny } from './modelUsageModel';
import {
  buildCapabilityCostDistribution,
  buildModelUsageMeterGroups,
} from './modelUsageChartModel';
import { ModelUsageTrend } from './ModelUsageTrend';
import type { ModelUsageTrendWindow } from './modelUsageChartModel';

type ModelUsageOverview = ModelUsagePersonalOverview | ModelUsageFamilyOverview;

function CapabilityDistribution(props: {
  items: ModelUsageBreakdownItem[];
  isLoading: boolean;
}) {
  const distribution = buildCapabilityCostDistribution(props.items);

  if (props.isLoading && props.items.length === 0) {
    return <div className="model-usage-insight-empty" role="status">正在加载功能费用分布。</div>;
  }

  if (distribution.entries.length === 0) {
    return (
      <div className="model-usage-distribution-empty">
        <DashboardIcon name="bar-chart" />
        <strong>{props.items.length ? '暂无可分配的费用' : '暂无功能费用记录'}</strong>
        <p>有已计入的功能费用后，会在这里显示占比。用量记录仍可在下方查看。</p>
      </div>
    );
  }

  return (
    <div className="model-usage-capability-distribution">
      <ol className="model-usage-capability-ranking">
        {distribution.entries.map((entry) => {
          const value = entry.sharePercent > 0
            ? formatModelUsageCny(entry.costCny)
            : entry.pricingComplete ? formatModelUsageCny(entry.costCny) : '未定价';
          return (
            <li key={entry.capability}>
              <span className={`model-usage-capability-dot capability-tone-${entry.capability}`} aria-hidden="true" />
              <div className="model-usage-capability-rank-body">
                <span className="model-usage-capability-rank-head">
                  <strong>{entry.label}</strong>
                  <strong>{value}</strong>
                </span>
                <span className="model-usage-capability-share-track" aria-hidden="true">
                  <span
                    className={`capability-tone-${entry.capability}`}
                    style={{ '--model-usage-share': `${entry.sharePercent}%` } as CSSProperties}
                  />
                </span>
                <small className="model-usage-capability-rank-meta">
                  {entry.sharePercent > 0 ? `${entry.sharePercent}%` : '暂不计入占比'}
                  {!entry.pricingComplete && entry.unpricedEventCount > 0
                    ? ` · 另有 ${entry.unpricedEventCount} 次未定价`
                    : ''}
                </small>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function MeterOverview(props: { overview: ModelUsageOverview }) {
  const groups = buildModelUsageMeterGroups(props.overview.meter_totals);
  return groups.length ? (
    <div className="model-usage-meter-groups">
      {groups.map((group) => (
        <section
          key={group.unit}
          className={`model-usage-meter-group is-${group.unit}`}
        >
          <h4>{group.label}</h4>
          <dl>
            {group.items.map((item) => (
              <div key={item.meter} className={item.meter === 'total_tokens' ? 'is-total' : undefined}>
                <dt>{item.label}</dt>
                <dd className="model-usage-number">{item.quantityText}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  ) : (
    <div className="model-usage-insight-empty">本统计周期还没有可展示的用量类型。</div>
  );
}

export function ModelUsageInsights(props: {
  overview: ModelUsageOverview;
  trendWindow: ModelUsageTrendWindow;
  dailyTrendItems: ModelUsageBreakdownItem[];
  capabilityItems: ModelUsageBreakdownItem[];
  isDailyTrendLoading: boolean;
  isCapabilityBreakdownLoading: boolean;
}) {
  return (
    <section className="model-usage-insights" aria-labelledby="model-usage-insights-heading">
      <div className="model-usage-insights-head">
        <div>
          <h2 id="model-usage-insights-heading">费用趋势与用量构成</h2>
        </div>
        <p>功能费用与用量 · {props.overview.period}</p>
      </div>

      <div className="model-usage-insights-grid">
        <article className="model-usage-insight-card model-usage-trend-panel" aria-labelledby="model-usage-trend-heading">
          <div className="model-usage-insight-card-head">
            <div>
              <h3 id="model-usage-trend-heading">每日费用趋势</h3>
              <p>{props.trendWindow.startDate} 至 {props.trendWindow.endDate}</p>
            </div>
            <span>近 30 天</span>
          </div>
          <ModelUsageTrend
            items={props.dailyTrendItems}
            window={props.trendWindow}
            isLoading={props.isDailyTrendLoading}
          />
        </article>

        <article className="model-usage-insight-card model-usage-capability-panel" aria-labelledby="model-usage-capability-heading">
          <div className="model-usage-insight-card-head">
            <div>
              <h3 id="model-usage-capability-heading">功能费用分布</h3>
              <p>看清费用主要来自哪些功能</p>
            </div>
          </div>
          <CapabilityDistribution
            items={props.capabilityItems}
            isLoading={props.isCapabilityBreakdownLoading}
          />
        </article>

        <article className="model-usage-insight-card model-usage-meter-panel" aria-labelledby="model-usage-meter-heading">
          <div className="model-usage-insight-card-head">
            <div>
              <h3 id="model-usage-meter-heading">用量明细</h3>
              <p>按原始单位记录，缓存用量是输入的一部分，不重复相加</p>
            </div>
          </div>
          <MeterOverview overview={props.overview} />
        </article>
      </div>
    </section>
  );
}
