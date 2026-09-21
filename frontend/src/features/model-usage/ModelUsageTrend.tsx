import { useId } from 'react';
import type { ModelUsageBreakdownItem } from '../../api/types/modelUsage';
import { formatModelUsageCny } from './modelUsageModel';
import {
  buildModelUsageTrendPoints,
  modelUsageScaledIntegerToDecimal,
  type ModelUsageTrendWindow,
} from './modelUsageChartModel';

function monthDayLabel(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return match ? `${Number(match[2])} 月 ${Number(match[3])} 日` : date;
}

export interface ModelUsageTrendProps {
  items: ModelUsageBreakdownItem[];
  window: ModelUsageTrendWindow;
  isLoading?: boolean;
}

export function ModelUsageTrend(props: ModelUsageTrendProps) {
  const chartId = useId();
  const points = buildModelUsageTrendPoints(props.items, props.window);
  if (props.isLoading) {
    return <div className="model-usage-trend-empty" role="status">正在加载每日趋势。</div>;
  }

  const highest = points.reduce<(typeof points)[number] | undefined>(
    (current, point) => !current || point.amount > current.amount ? point : current, undefined,
  );
  const maximum = highest && highest.amount > 0n ? highest.amount : 1n;
  const hasCost = Boolean(highest && highest.amount > 0n);
  const recordedDayCount = points.filter((point) => point.hasRecord).length;
  const paidDayCount = points.filter((point) => point.amount > 0n).length;
  const highestCost = formatModelUsageCny(modelUsageScaledIntegerToDecimal(highest?.amount ?? 0n));
  const summary = hasCost && highest
    ? `最近 30 天中有 ${paidDayCount} 天产生了费用。最高单日费用出现在 ${monthDayLabel(highest.date)}，为 ${highestCost}。`
    : recordedDayCount ? '有用量记录不代表产生费用，实际用量可在下方查看。' : '有已计入费用的记录后，将在这里显示每日变化。';
  const chartWidth = 640;
  const chartHeight = 200;
  const padding = { top: 32, right: 28, bottom: 32, left: 60 };
  const plotHeight = chartHeight - padding.top - padding.bottom;
  const step = (chartWidth - padding.left - padding.right) / Math.max(1, points.length - 1);
  const plotted = points.map((point, index) => ({
    ...point,
    x: padding.left + step * index,
    y: padding.top + plotHeight - Number(point.amount * BigInt(plotHeight * 1000) / maximum) / 1000,
  }));
  const line = plotted.map((point) => `${point.x},${point.y}`).join(' ');
  const area = plotted.length
    ? `M ${plotted[0]!.x} ${padding.top + plotHeight} L ${line.replace(/,/g, ' ')} L ${plotted.at(-1)!.x} ${padding.top + plotHeight} Z`
    : '';

  return (
    <div className="model-usage-trend">
      <div className="model-usage-trend-chart-wrapper">
        <svg className="model-usage-trend-chart" role="img" aria-labelledby={`${chartId}-title`} aria-describedby={`${chartId}-desc`} viewBox={`0 0 ${chartWidth} ${chartHeight}`}>
          <title id={`${chartId}-title`}>最近 30 天每日模型费用趋势</title>
          <desc id={`${chartId}-desc`}>{summary}</desc>
          {[0, 0.5, 1].map((fraction) => {
            const y = padding.top + plotHeight * fraction;
            return (
              <g key={fraction}>
                <line className="model-usage-trend-gridline" x1={padding.left} x2={chartWidth - padding.right} y1={y} y2={y} />
                {hasCost && fraction === 1 ? <text className="model-usage-trend-axis-label" x={padding.left - 8} y={y + 4} textAnchor="end">¥0</text> : null}
              </g>
            );
          })}
          {hasCost ? <><path className="model-usage-trend-area" d={area} /><polyline className="model-usage-trend-line" points={line} /></> : null}
          {plotted.map((point, index) => {
            const isPeak = hasCost && point.date === highest?.date;
            const showDate = index === 0 || index === plotted.length - 1 || (index % 6 === 0 && index < plotted.length - 3);
            return (
              <g key={point.date}>
                <title>{monthDayLabel(point.date)}：{formatModelUsageCny(modelUsageScaledIntegerToDecimal(point.amount))}</title>
                {isPeak ? <><circle className="model-usage-trend-point" cx={point.x} cy={point.y} r="4" /><text className="model-usage-trend-val-badge" x={point.x} y={point.y - 12} textAnchor={index > plotted.length - 5 ? 'end' : index < 4 ? 'start' : 'middle'}>{highestCost}</text></> : null}
                {showDate ? <text className="model-usage-trend-label" x={point.x} y={chartHeight - 8} textAnchor="middle">{monthDayLabel(point.date).replace(' 月 ', '/').replace(' 日', '')}</text> : null}
              </g>
            );
          })}
        </svg>
        {!hasCost ? <div className="model-usage-trend-zero"><strong>{recordedDayCount ? '这 30 天已计入费用为 ¥0.00' : '这 30 天还没有已计入费用的记录'}</strong></div> : null}
      </div>
      <p className="model-usage-trend-summary">{summary}</p>
      <details className="model-usage-disclosure model-usage-daily-details">
        <summary>查看每日费用</summary>
        <div className="model-usage-daily-scroll" tabIndex={0} role="region" aria-label="每日费用明细，可纵向滚动">
          <table aria-label="每日费用明细">
            <thead><tr><th scope="col">日期</th><th scope="col">已计入费用</th></tr></thead>
            <tbody>{points.map((point) => <tr key={point.date}><th scope="row">{monthDayLabel(point.date)}</th><td>{formatModelUsageCny(modelUsageScaledIntegerToDecimal(point.amount))}</td></tr>)}</tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
