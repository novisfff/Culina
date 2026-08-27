import { useEffect, useId, useRef, type CSSProperties } from 'react';
import type { ModelUsageBreakdownItem } from '../../api/types';
import { formatModelUsageCny } from './modelUsageModel';
import {
  buildModelUsageTrendPoints,
  MODEL_USAGE_TREND_VISIBLE_DAY_COUNT,
  modelUsageScaledIntegerToDecimal,
  type ModelUsageTrendWindow,
} from './modelUsageChartModel';

function monthDayLabel(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  return `${Number(match[2])} 月 ${Number(match[3])} 日`;
}

export interface ModelUsageTrendProps {
  items: ModelUsageBreakdownItem[];
  window: ModelUsageTrendWindow;
  isLoading?: boolean;
}

export function ModelUsageTrend(props: ModelUsageTrendProps) {
  const chartId = useId();
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const points = buildModelUsageTrendPoints(props.items, props.window);
  const isScrollable = points.length > MODEL_USAGE_TREND_VISIBLE_DAY_COUNT;

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || !isScrollable || props.isLoading) return;
    container.scrollLeft = Math.max(0, container.scrollWidth - container.clientWidth);
  }, [isScrollable, props.isLoading, props.window.endDate, props.window.startDate]);

  if (props.isLoading) {
    return (
      <div className="model-usage-trend-empty" role="status">
        正在加载每日趋势。
      </div>
    );
  }

  const highest = points.reduce((current, point) => point.amount > current.amount ? point : current, points[0]!);
  const maximum = highest.amount > 0n ? highest.amount : 1n;
  const highestAmountDec = formatModelUsageCny(modelUsageScaledIntegerToDecimal(highest.amount));
  const recordedDayCount = points.filter((point) => point.hasRecord).length;
  const summary = highest.amount > 0n
    ? `最近 30 天中有 ${recordedDayCount} 天产生了费用。最高单日费用出现在 ${monthDayLabel(highest.date)}，为 ${highestAmountDec}。`
    : `最近 30 天中有 ${recordedDayCount} 天产生了费用，最高单日为 ${highestAmountDec}。未产生费用的日期也已显示。`;

  const chartWidth = isScrollable
    ? Math.round(640 * points.length / MODEL_USAGE_TREND_VISIBLE_DAY_COUNT)
    : 640;
  const chartHeight = 200;
  const chartPadding = { top: 32, right: 24, bottom: 36, left: 54 };
  const plotWidth = chartWidth - chartPadding.left - chartPadding.right;
  const plotHeight = chartHeight - chartPadding.top - chartPadding.bottom;
  const step = plotWidth / Math.max(1, points.length);

  // If points are few, keep barWidth controlled and neat
  const barWidth = points.length === 1 ? 32 : Math.max(12, Math.min(36, step * 0.5));
  const plottedPoints = points.map((point, index) => {
    const height = point.amount === 0n
      ? 0
      : Math.max(6, Number((point.amount * BigInt(Math.round(plotHeight * 1000))) / maximum) / 1000);
    return {
      ...point,
      height,
      x: chartPadding.left + step * index + step / 2,
      y: chartPadding.top + plotHeight - height,
    };
  });
  const linePoints = plottedPoints.map((point) => `${point.x},${point.y}`).join(' ');
  const areaPath = plottedPoints.length
    ? `M ${plottedPoints[0]!.x} ${chartPadding.top + plotHeight} L ${linePoints.replace(/,/g, ' ')} L ${plottedPoints.at(-1)!.x} ${chartPadding.top + plotHeight} Z`
    : '';

  return (
    <div className="model-usage-trend">
      {isScrollable ? <p className="model-usage-trend-scroll-hint">左右滑动查看全部 30 天</p> : null}
      <div
        ref={scrollContainerRef}
        className={`model-usage-trend-chart-wrapper ${isScrollable ? 'is-scrollable' : ''}`}
        role={isScrollable ? 'region' : undefined}
        aria-label={isScrollable ? '最近 30 天每日费用，可横向滚动' : undefined}
        tabIndex={isScrollable ? 0 : undefined}
      >
        <div
          className="model-usage-trend-chart-track"
          style={{
            '--model-usage-trend-track-width': `${Math.max(100, points.length / MODEL_USAGE_TREND_VISIBLE_DAY_COUNT * 100)}%`,
          } as CSSProperties}
        >
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
            <title id={`${chartId}-title`}>最近 30 天每日模型费用趋势</title>
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
            {formatModelUsageCny(modelUsageScaledIntegerToDecimal(highest.amount / 2n))}
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

          <path className="model-usage-trend-area" d={areaPath} />

          {/* Bar elements */}
          {plottedPoints.map((point, index) => {
            const height = point.height;
            const x = chartPadding.left + step * index + (step - barWidth) / 2;
            const y = point.y;
            const isPeak = point.date === highest.date && highest.amount > 0n;
            const pointCostStr = formatModelUsageCny(modelUsageScaledIntegerToDecimal(point.amount));

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
          <polyline className="model-usage-trend-line" points={linePoints} />
          {plottedPoints.map((point) => (
            <circle key={`${point.date}-point`} className="model-usage-trend-point" cx={point.x} cy={point.y} r="3" />
          ))}
          </svg>
        </div>
      </div>
      <p className="model-usage-trend-summary">{summary}</p>
    </div>
  );
}
