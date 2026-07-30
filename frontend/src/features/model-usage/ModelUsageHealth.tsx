import type { ModelUsageMeasurementHealth } from '../../api/types';
import { StatusBadge } from '../../components/ui-kit';
import { modelUsageHealthNotices } from './modelUsageModel';

const HEALTH_TONES = {
  exact: 'success',
  estimated: 'warning',
  unpriced: 'warning',
  uncertain: 'warning',
  pending: 'info',
  conservative_unknown_execution: 'warning',
  known_unmeasured: 'warning',
  measurement_gap: 'danger',
} as const;

function formatGapIntervals(health: ModelUsageMeasurementHealth): string | null {
  if (!health.gap_intervals.length) return null;
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return health.gap_intervals.map((interval) => {
    const startedAt = new Date(interval.started_at);
    const endedAt = new Date(interval.ended_at);
    if (Number.isNaN(startedAt.getTime()) || Number.isNaN(endedAt.getTime())) {
      return '一段时间';
    }
    return `${formatter.format(startedAt)} 至 ${formatter.format(endedAt)}`;
  }).join('；');
}

export interface ModelUsageHealthProps {
  health: ModelUsageMeasurementHealth;
  compact?: boolean;
}

export function ModelUsageHealth(props: ModelUsageHealthProps) {
  const notices = modelUsageHealthNotices(props.health);
  const gapIntervals = formatGapIntervals(props.health);

  return (
    <section
      className={['model-usage-health', props.compact ? 'is-compact' : ''].filter(Boolean).join(' ')}
      aria-labelledby="model-usage-health-heading"
    >
      <div className="model-usage-section-head">
        <div>
          <h2 id="model-usage-health-heading">计量完整度</h2>
          <p>费用、估算和待核对状态会分别保留，避免把未知情况伪装成精确数据。</p>
        </div>
      </div>
      {notices.length === 0 ? (
        <p className="model-usage-health-clear">本账期暂无需要额外说明的计量状态。</p>
      ) : (
        <ul className="model-usage-health-list">
          {notices.map((notice) => (
            <li key={notice.kind}>
              <StatusBadge tone={HEALTH_TONES[notice.kind]}>{notice.title}</StatusBadge>
              <p>{notice.description}</p>
              {notice.kind === 'measurement_gap' && gapIntervals ? (
                <small>受影响时段：{gapIntervals}</small>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
