import { useId } from 'react';
import type { ModelUsageBreakdownItem } from '../../api/types';
import { formatModelUsageCny } from './modelUsageModel';

type TrendPoint = {
  date: string;
  amount: bigint;
};

const DECIMAL_SCALE = 12;
const DECIMAL_FACTOR = 10n ** BigInt(DECIMAL_SCALE);

function decimalToScaledInteger(value: string | null | undefined): bigint | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return null;

  const integer = match[1] ?? '0';
  const fraction = (match[2] ?? '').slice(0, DECIMAL_SCALE).padEnd(DECIMAL_SCALE, '0');
  return BigInt(integer) * DECIMAL_FACTOR + BigInt(fraction);
}

function scaledIntegerToDecimal(value: bigint): string {
  const integer = value / DECIMAL_FACTOR;
  const fraction = String(value % DECIMAL_FACTOR).padStart(DECIMAL_SCALE, '0');
  return `${integer}.${fraction}`;
}

function monthDayLabel(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  return `${Number(match[2])} 月 ${Number(match[3])} 日`;
}

function trendPoints(items: ModelUsageBreakdownItem[]): TrendPoint[] {
  const amountsByDate = new Map<string, bigint>();
  for (const item of items) {
    if (!item.local_day) continue;
    const amount = decimalToScaledInteger(item.known_priced_cost_cny);
    if (amount === null) continue;
    amountsByDate.set(item.local_day, (amountsByDate.get(item.local_day) ?? 0n) + amount);
  }
  return [...amountsByDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, amount]) => ({ date, amount }));
}

export interface ModelUsageTrendProps {
  items: ModelUsageBreakdownItem[];
  isLoading?: boolean;
}

export function ModelUsageTrend(props: ModelUsageTrendProps) {
  const chartId = useId();
  const points = trendPoints(props.items);

  if (props.isLoading) {
    return (
      <div className="model-usage-trend-empty" role="status">
        正在加载每日趋势。
      </div>
    );
  }

  if (points.length === 0) {
    return (
      <div className="model-usage-trend-empty" role="status">
        本月暂无可绘制的已定价每日用量。
      </div>
    );
  }

  const highest = points.reduce((current, point) => point.amount > current.amount ? point : current, points[0]!);
  const maximum = highest.amount > 0n ? highest.amount : 1n;
  const highestAmountDec = formatModelUsageCny(scaledIntegerToDecimal(highest.amount));
  const summary = `共 ${points.length} 天有已记录费用。本月最高已记录费用出现在 ${monthDayLabel(highest.date)}，为 ${highestAmountDec}。`;

  const chartWidth = 640;
  const chartHeight = 200;
  const chartPadding = { top: 32, right: 24, bottom: 36, left: 54 };
  const plotWidth = chartWidth - chartPadding.left - chartPadding.right;
  const plotHeight = chartHeight - chartPadding.top - chartPadding.bottom;
  const step = plotWidth / Math.max(1, points.length);

  // If points are few, keep barWidth controlled and neat
  const barWidth = points.length === 1 ? 32 : Math.max(12, Math.min(36, step * 0.5));

  return (
    <div className="model-usage-trend">
      <div className="model-usage-trend-header-pills">
        <div className="model-usage-trend-pill">
          <span>最高单日费用</span>
          <strong>{highestAmountDec}</strong>
          <small>（{monthDayLabel(highest.date)}）</small>
        </div>
        <div className="model-usage-trend-pill">
          <span>有记录天数</span>
          <strong>{points.length} 天</strong>
        </div>
      </div>

      <div className="model-usage-trend-chart-wrapper">
        <svg
          className="model-usage-trend-chart"
          role="img"
          aria-labelledby={`${chartId}-title`}
          aria-describedby={`${chartId}-desc`}
          viewBox={`0 0 ${chartWidth} ${chartHeight}`}
        >
          <defs>
            <linearGradient id={`${chartId}-barGrad`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.95" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.65" />
            </linearGradient>
            <linearGradient id={`${chartId}-peakGrad`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent-strong)" stopOpacity="1" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.8" />
            </linearGradient>
          </defs>
          <title id={`${chartId}-title`}>本月每日模型费用趋势</title>
          <desc id={`${chartId}-desc`}>{summary}</desc>

          {/* Y-axis gridlines & labels */}
          <line
            className="model-usage-trend-gridline"
            x1={chartPadding.left}
            x2={chartWidth - chartPadding.right}
            y1={chartPadding.top}
            y2={chartPadding.top}
          />
          <text className="model-usage-trend-axis-label" x={chartPadding.left - 8} y={chartPadding.top + 4} textAnchor="end">
            {highestAmountDec}
          </text>

          <line
            className="model-usage-trend-gridline"
            x1={chartPadding.left}
            x2={chartWidth - chartPadding.right}
            y1={chartPadding.top + plotHeight / 2}
            y2={chartPadding.top + plotHeight / 2}
          />
          <text className="model-usage-trend-axis-label" x={chartPadding.left - 8} y={chartPadding.top + plotHeight / 2 + 4} textAnchor="end">
            {formatModelUsageCny(scaledIntegerToDecimal(highest.amount / 2n))}
          </text>

          <line
            className="model-usage-trend-baseline"
            x1={chartPadding.left}
            x2={chartWidth - chartPadding.right}
            y1={chartPadding.top + plotHeight}
            y2={chartPadding.top + plotHeight}
          />
          <text className="model-usage-trend-axis-label" x={chartPadding.left - 8} y={chartPadding.top + plotHeight + 4} textAnchor="end">
            ¥0.00
          </text>

          {/* Bar elements */}
          {points.map((point, index) => {
            const height = Math.max(6, Number((point.amount * BigInt(Math.round(plotHeight * 1000))) / maximum) / 1000);
            const x = chartPadding.left + step * index + (step - barWidth) / 2;
            const y = chartPadding.top + plotHeight - height;
            const isPeak = point.date === highest.date && highest.amount > 0n;
            const pointCostStr = formatModelUsageCny(scaledIntegerToDecimal(point.amount));

            return (
              <g key={point.date} className="model-usage-trend-group">
                <rect
                  className={`model-usage-trend-bar ${isPeak ? 'is-peak' : ''}`}
                  x={x}
                  y={y}
                  width={barWidth}
                  height={height}
                  rx="6"
                  fill={`url(#${chartId}-${isPeak ? 'peakGrad' : 'barGrad'})`}
                />
                {/* Value badge over top of bar */}
                <text
                  className="model-usage-trend-val-badge"
                  x={x + barWidth / 2}
                  y={Math.max(14, y - 8)}
                  textAnchor="middle"
                >
                  {pointCostStr}
                </text>
                <text
                  className={`model-usage-trend-label ${isPeak ? 'is-peak-label' : ''}`}
                  x={x + barWidth / 2}
                  y={chartHeight - 12}
                  textAnchor="middle"
                >
                  {monthDayLabel(point.date).replace(' 月 ', '/').replace(' 日', '')}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <p className="model-usage-trend-summary">{summary}</p>
    </div>
  );
}
