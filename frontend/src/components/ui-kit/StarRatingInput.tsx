import type { CSSProperties, PointerEvent } from 'react';

export type StarRatingInputProps = {
  value: string;
  onChange: (value: string) => void;
  ariaLabel?: string;
  clearAriaLabel?: string;
  emptyLabel?: string;
  disabled?: boolean;
  className?: string;
};

function parseRatingValue(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampRatingValue(value: number) {
  return Math.min(5, Math.max(0, value));
}

export function StarRatingInput(props: StarRatingInputProps) {
  const rating = clampRatingValue(parseRatingValue(props.value) ?? 0);
  const emptyLabel = props.emptyLabel ?? '未评分';
  const display = rating > 0 ? `${rating.toFixed(1).replace(/\.0$/, '')} 分` : emptyLabel;
  const ratingFillStyle = {
    '--rating-width': `${(rating / 5) * 100}%`,
  } as CSSProperties;
  const stars = Array.from({ length: 5 }, (_, index) => <span key={index}>★</span>);
  const className = props.className
    ? `ui-star-rating-input ${props.className}`
    : 'ui-star-rating-input';

  function updateRatingFromClientX(element: HTMLDivElement, clientX: number) {
    if (props.disabled) return;
    const rect = element.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const nextRating = Math.max(0.5, Math.round(ratio * 10) / 2);
    props.onChange(String(nextRating));
  }

  function updateRatingFromPointer(event: PointerEvent<HTMLDivElement>) {
    updateRatingFromClientX(event.currentTarget, event.clientX);
  }

  return (
    <div className={className}>
      <div
        className="ui-star-rating-stars"
        role="slider"
        aria-label={props.ariaLabel ?? '评分'}
        aria-valuemin={0}
        aria-valuemax={5}
        aria-valuenow={rating}
        aria-valuetext={display}
        aria-disabled={props.disabled ? true : undefined}
        tabIndex={props.disabled ? -1 : 0}
        style={ratingFillStyle}
        onPointerDown={(event) => {
          if (props.disabled) return;
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.setPointerCapture(event.pointerId);
          updateRatingFromPointer(event);
        }}
        onPointerMove={(event) => {
          if (!props.disabled && event.buttons === 1) {
            event.preventDefault();
            event.stopPropagation();
            updateRatingFromPointer(event);
          }
        }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onKeyDown={(event) => {
          if (props.disabled) return;
          if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
            event.preventDefault();
            props.onChange(String(Math.min(5, rating + 0.5 || 0.5)));
          }
          if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
            event.preventDefault();
            const nextRating = Math.max(0, rating - 0.5);
            props.onChange(nextRating > 0 ? String(nextRating) : '');
          }
        }}
      >
        <div className="ui-star-rating-layer" aria-hidden="true">
          {stars}
        </div>
        <div className="ui-star-rating-layer is-filled" aria-hidden="true">
          {stars}
        </div>
      </div>
      <strong>{display}</strong>
      <button
        className={rating > 0 ? 'ui-star-rating-clear' : 'ui-star-rating-clear is-hidden'}
        type="button"
        aria-label={props.clearAriaLabel ?? '清除评分'}
        disabled={props.disabled || rating <= 0}
        aria-hidden={rating <= 0}
        tabIndex={!props.disabled && rating > 0 ? 0 : -1}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!props.disabled && rating > 0) {
            props.onChange('');
          }
        }}
      >
        清除
      </button>
    </div>
  );
}
