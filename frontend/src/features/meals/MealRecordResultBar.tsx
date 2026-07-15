import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { MediaWithPlaceholder } from '../../components/MediaPlaceholder';
import { ActionButton } from '../../components/ui-kit';
import { buildMediaSizes, buildMediaSrcSet, resolveMediaUrl } from '../../lib/assets';
import type { MealRecordResult } from './useMealRecordResultState';

export type MealRecordResultBarProps = {
  result: MealRecordResult | null;
  isReverting?: boolean;
  revertError?: string | null;
  rateError?: string | null;
  onRevert?: () => void | Promise<void>;
  onView?: () => void;
  onRate?: (rating: number | null | undefined) => void | Promise<void>;
  /** Quiet dismiss (manual close or after revert window). */
  onDismiss?: () => void;
  /** Injectable clock for countdown tests. */
  now?: Date;
  className?: string;
};

function formatCountdown(ms: number): string {
  if (ms <= 0) return '0 分';
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds} 秒`;
  if (seconds === 0) return `${minutes} 分`;
  return `${minutes} 分 ${seconds} 秒`;
}

function clampRating(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(5, Math.max(0, Math.round(value * 2) / 2));
}

function CompactStarRating(props: {
  value: number | null;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  const rating = props.value ?? 0;
  const fill = `${(rating / 5) * 100}%`;

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (props.disabled) return;
    let next: number | null = null;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        next = clampRating(rating + 0.5);
        break;
      case 'ArrowLeft':
      case 'ArrowDown':
        next = clampRating(rating - 0.5);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = 5;
        break;
      default:
        return;
    }
    event.preventDefault();
    if (next !== rating) {
      props.onChange(next);
    }
  }

  return (
    <div
      className="meal-record-result-rating"
      role="slider"
      aria-label="评分"
      aria-valuemin={0}
      aria-valuemax={5}
      aria-valuenow={rating}
      aria-valuetext={rating > 0 ? `${rating} 分` : '尚未评分'}
      aria-disabled={props.disabled ? true : undefined}
      tabIndex={props.disabled ? -1 : 0}
      style={{ ['--rating-width' as string]: fill }}
      onKeyDown={handleKeyDown}
      onPointerDown={(event) => {
        if (props.disabled) return;
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
        props.onChange(Math.max(0.5, Math.round(ratio * 10) / 2));
      }}
    >
      <span aria-hidden="true">★★★★★</span>
      <span className="meal-record-result-rating-fill" aria-hidden="true">★★★★★</span>
    </div>
  );
}

/**
 * Shared ordinary-record result bar. Mutation ownership stays with Task 11 state;
 * this component only renders and delegates.
 */
export function MealRecordResultBar(props: MealRecordResultBarProps) {
  const result = props.result;
  const [nowMs, setNowMs] = useState(() => (props.now ?? new Date()).getTime());
  const [compactRating, setCompactRating] = useState<number | null>(null);

  useEffect(() => {
    if (props.now) {
      setNowMs(props.now.getTime());
      return;
    }
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [props.now, result?.operationId, result?.revertibleUntil]);

  useEffect(() => {
    setCompactRating(null);
  }, [result?.operationId]);

  const remainingMs = useMemo(() => {
    if (!result) return 0;
    return new Date(result.revertibleUntil).getTime() - nowMs;
  }, [nowMs, result]);

  if (!result) return null;

  const primaryFood = result.foods[0] ?? null;
  const foodNames = result.foods.map((food) => food.name).filter(Boolean).join('、') || '这顿饭';
  const preview = result.previewMedia ?? primaryFood?.cover ?? null;
  const previewUrl = resolveMediaUrl(preview, 'thumb');
  const canUndo = result.canRevert && remainingMs > 0;
  const showRating = result.canRate && result.mealLog != null && result.rowVersion != null;

  return (
    <aside
      className={['meal-record-result-bar', props.className].filter(Boolean).join(' ')}
      data-meal-log-id={result.mealLogId}
      data-operation-id={result.operationId}
      aria-label="记录结果"
    >
      <div className="meal-record-result-media">
        <MediaWithPlaceholder
          src={previewUrl}
          srcSet={buildMediaSrcSet(preview)}
          sizes={buildMediaSizes('thumb')}
          alt={preview?.alt || primaryFood?.name || foodNames}
          showLabel={false}
        />
      </div>
      <div className="meal-record-result-copy">
        <strong>已记下</strong>
        <span>{foodNames}</span>
        {canUndo ? (
          <small>还可撤销 {formatCountdown(remainingMs)}</small>
        ) : (
          <small>已过撤销时限</small>
        )}
      </div>
      <div className="meal-record-result-actions">
        {showRating ? (
          <CompactStarRating
            value={compactRating}
            disabled={props.isReverting}
            onChange={(value) => {
              setCompactRating(value);
              void props.onRate?.(value);
            }}
          />
        ) : null}
        {canUndo ? (
          <ActionButton
            tone="secondary"
            size="compact"
            type="button"
            disabled={props.isReverting}
            onClick={() => {
              void props.onRevert?.();
            }}
          >
            撤销
          </ActionButton>
        ) : null}
        <ActionButton
          tone="secondary"
          size="compact"
          type="button"
          disabled={props.isReverting}
          onClick={() => props.onView?.()}
        >
          查看记录
        </ActionButton>
        {props.onDismiss ? (
          <ActionButton
            tone="tertiary"
            size="compact"
            type="button"
            disabled={props.isReverting}
            onClick={() => props.onDismiss?.()}
          >
            关闭
          </ActionButton>
        ) : null}
      </div>
      {props.revertError ? <p className="meal-record-result-error">{props.revertError}</p> : null}
      {props.rateError ? <p className="meal-record-result-error">{props.rateError}</p> : null}
    </aside>
  );
}
