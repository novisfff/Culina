import type { CSSProperties, ReactNode } from 'react';
import { ActionButton } from './ActionButton';

type TouchValueMark = number | { value: number; label: string };

function clampTouchValue(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function formatTouchNumber(value: number) {
  return Number(value.toFixed(2)).toString();
}

function resolveTouchMark(mark: TouchValueMark) {
  return typeof mark === 'number' ? { value: mark, label: formatTouchNumber(mark) } : mark;
}

export function TouchRangeField(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  formatValue?: (value: number) => string;
  helper?: ReactNode;
  marks?: TouchValueMark[];
  className?: string;
  disabled?: boolean;
}) {
  const step = props.step ?? 1;
  const marks = props.marks ?? [];
  const formattedValue = props.formatValue ? props.formatValue(props.value) : formatTouchNumber(props.value);
  const className = props.className ? `touch-field touch-range-field ${props.className}` : 'touch-field touch-range-field';
  const rangeProgress =
    props.max > props.min ? ((props.value - props.min) / (props.max - props.min)) * 100 : 0;
  const rangeStyle = {
    '--touch-range-progress': `${clampTouchValue(rangeProgress, 0, 100)}%`,
  } as CSSProperties;

  function updateValue(nextValue: number) {
    props.onChange(clampTouchValue(nextValue, props.min, props.max));
  }

  return (
    <div className={className}>
      <div className="touch-field-head">
        <span>{props.label}</span>
        <strong>{formattedValue}</strong>
      </div>
      {props.helper && <div className="touch-field-helper">{props.helper}</div>}
      <div className="touch-range-main">
        <ActionButton
          tone="secondary"
          size="compact"
          type="button"
          className="touch-stepper-button"
          aria-label={`${props.label}减少`}
          disabled={props.disabled}
          onClick={() => updateValue(props.value - step)}
        >
          -
        </ActionButton>
        <input
          className="touch-range-input"
          type="range"
          min={props.min}
          max={props.max}
          step={step}
          value={props.value}
          style={rangeStyle}
          disabled={props.disabled}
          aria-valuetext={formattedValue}
          onChange={(event) => updateValue(Number(event.target.value))}
        />
        <ActionButton
          tone="secondary"
          size="compact"
          type="button"
          className="touch-stepper-button"
          aria-label={`${props.label}增加`}
          disabled={props.disabled}
          onClick={() => updateValue(props.value + step)}
        >
          +
        </ActionButton>
      </div>
      {marks.length > 0 && (
        <div className="touch-field-chip-row">
          {marks.map((mark) => {
            const resolved = resolveTouchMark(mark);
            return (
              <button
                key={`${props.label}-${resolved.value}`}
                className={
                  Math.abs(props.value - resolved.value) < 0.001
                    ? 'touch-value-chip active'
                    : 'touch-value-chip'
                }
                type="button"
                disabled={props.disabled}
                onClick={() => updateValue(resolved.value)}
              >
                {resolved.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function TouchStepperField(props: {
  label: string;
  value: number;
  step?: number;
  min?: number;
  max?: number;
  onChange: (value: number) => void;
  formatValue?: (value: number) => string;
  helper?: ReactNode;
  quickValues?: TouchValueMark[];
  className?: string;
  disabled?: boolean;
  allowCustomInput?: boolean;
  customInputLabel?: string;
  customInputMode?: 'details' | 'inline';
  inputStep?: number;
  inputMin?: number;
  inputMax?: number;
}) {
  const step = props.step ?? 1;
  const min = props.min ?? 0;
  const max = props.max ?? Number.POSITIVE_INFINITY;
  const formattedValue = props.formatValue ? props.formatValue(props.value) : formatTouchNumber(props.value);
  const classes = ['touch-field', 'touch-stepper-field'];
  if (props.className) {
    classes.push(props.className);
  }
  const className = classes.join(' ');

  function updateValue(nextValue: number) {
    props.onChange(clampTouchValue(nextValue, min, max));
  }

  return (
    <div className={className}>
      <div className="touch-field-head">
        <span>{props.label}</span>
        <strong>{formattedValue}</strong>
      </div>
      {props.helper && <div className="touch-field-helper">{props.helper}</div>}
      <div className="touch-stepper-main">
        <ActionButton
          tone="secondary"
          size="compact"
          type="button"
          className="touch-stepper-button"
          aria-label={`${props.label}减少`}
          disabled={props.disabled}
          onClick={() => updateValue(props.value - step)}
        >
          -
        </ActionButton>
        <div className="touch-stepper-display">
          {props.allowCustomInput && props.customInputMode === 'inline' ? (
            <input
              className="touch-stepper-display-input"
              type="number"
              min={props.inputMin ?? props.min}
              max={props.inputMax ?? (Number.isFinite(max) ? max : undefined)}
              step={props.inputStep ?? step}
              value={formatTouchNumber(props.value)}
              disabled={props.disabled}
              aria-label={`${props.label}输入`}
              onChange={(event) => {
                const nextValue = Number(event.target.value);
                if (Number.isFinite(nextValue)) {
                  updateValue(nextValue);
                }
              }}
            />
          ) : (
            <strong>{formattedValue}</strong>
          )}
        </div>
        <ActionButton
          tone="secondary"
          size="compact"
          type="button"
          className="touch-stepper-button"
          aria-label={`${props.label}增加`}
          disabled={props.disabled}
          onClick={() => updateValue(props.value + step)}
        >
          +
        </ActionButton>
      </div>
      {props.quickValues && props.quickValues.length > 0 && (
        <div className="touch-field-chip-row">
          {props.quickValues.map((mark) => {
            const resolved = resolveTouchMark(mark);
            return (
              <button
                key={`${props.label}-${resolved.value}`}
                className={
                  Math.abs(props.value - resolved.value) < 0.001
                    ? 'touch-value-chip active'
                    : 'touch-value-chip'
                }
                type="button"
                disabled={props.disabled}
                onClick={() => updateValue(resolved.value)}
              >
                {resolved.label}
              </button>
            );
          })}
        </div>
      )}
      {props.allowCustomInput && props.customInputMode !== 'inline' ? (
        <details className="touch-field-custom">
          <summary>{props.customInputLabel ?? '自定义数值'}</summary>
          <div className="touch-field-custom-body">
            <input
              className="text-input"
              type="number"
              min={props.inputMin ?? props.min}
              max={props.inputMax ?? (Number.isFinite(max) ? max : undefined)}
              step={props.inputStep ?? step}
              value={formatTouchNumber(props.value)}
              disabled={props.disabled}
              onChange={(event) => {
                const nextValue = Number(event.target.value);
                if (Number.isFinite(nextValue)) {
                  updateValue(nextValue);
                }
              }}
            />
          </div>
        </details>
      ) : null}
    </div>
  );
}
