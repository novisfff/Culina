import { useId, type CSSProperties } from 'react';
import type {
  ModelUsageBreakdownItem,
  ModelUsageFamilyOverview,
  ModelUsagePersonalOverview,
} from '../../api/types';
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
  const chartId = useId();
  const distribution = buildCapabilityCostDistribution(props.items);
  const pricedEntries = distribution.entries.filter((entry) => entry.sharePercent > 0);
  let segmentOffset = 0;

  if (props.isLoading && props.items.length === 0) {
    return <div className="model-usage-insight-empty" role="status">正在加载功能费用分布。</div>;
  }

  return (
    <div className="model-usage-capability-distribution">
      <div className="model-usage-donut-wrap">
        <svg
          className="model-usage-donut"
          viewBox="0 0 120 120"
          role="img"
          aria-labelledby={`${chartId}-title`}
          aria-describedby={`${chartId}-desc`}
        >
          <title id={`${chartId}-title`}>功能费用分布图</title>
          <desc id={`${chartId}-desc`}>
            本统计周期已计入费用合计 {formatModelUsageCny(distribution.totalCostCny)}，按模型功能展示费用占比。
          </desc>
          <circle className="model-usage-donut-track" cx="60" cy="60" r="45" pathLength="100" />
          {pricedEntries.map((entry) => {
            const offset = segmentOffset;
            segmentOffset += entry.sharePercent;
            return (
              <circle
                key={entry.capability}
                className={`model-usage-donut-segment capability-tone-${entry.capability}`}
                cx="60"
                cy="60"
                r="45"
                pathLength="100"
                strokeDasharray={`${Math.max(0, entry.sharePercent - 0.8)} ${100 - Math.max(0, entry.sharePercent - 0.8)}`}
                strokeDashoffset={-offset}
              />
            );
          })}
        </svg>
        <span className="model-usage-donut-center" aria-hidden="true">
          <small>已计入</small>
          <strong>{formatModelUsageCny(distribution.totalCostCny)}</strong>
        </span>
      </div>

      {distribution.entries.length ? (
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
      ) : (
        <div className="model-usage-insight-empty">本统计周期还没有可绘制的已定价功能费用。</div>
      )}
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
          style={{
            '--model-usage-meter-weight': Math.min(group.items.length, 5),
          } as CSSProperties}
        >
          <h4>{group.label}</h4>
          <dl>
            {group.items.map((item) => (
              <div key={item.meter}>
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
          <p className="model-usage-eyebrow">用量洞察</p>
          <h2 id="model-usage-insights-heading">费用趋势与用量构成</h2>
        </div>
        <p>趋势显示截至所选统计周期的最近 30 天；功能费用和用量明细仍按所选统计周期统计。</p>
      </div>

      <div className="model-usage-insights-grid">
        <article className="model-usage-insight-card model-usage-trend-panel" aria-labelledby="model-usage-trend-heading">
          <div className="model-usage-insight-card-head">
            <div>
              <h3 id="model-usage-trend-heading">每日费用趋势</h3>
              <p>最近 30 天每日费用，包含零值日期</p>
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
            <span>按费用</span>
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
              <p>核对本统计周期实际记录的模型用量</p>
            </div>
            <span>按用量单位</span>
          </div>
          <MeterOverview overview={props.overview} />
        </article>
      </div>
    </section>
  );
}
