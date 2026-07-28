import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { todayKey } from '../../lib/date';
import {
  buildCalendarMonth,
  dateKeyFromParts,
  isDateKeyDisabled,
  moveDateKeyByDays,
  moveDateKeyByMonths,
  parseValidDateKey,
  weekdayMondayIndex,
} from './datePickerModel';

export type DatePickerFieldProps = {
  ariaLabel: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  required?: boolean;
  allowClear?: boolean;
  min?: string;
  max?: string;
  placeholder?: string;
  leadingIcon?: ReactNode;
  className?: string;
  triggerFieldKey?: string;
};

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];
const MOBILE_QUERY = '(max-width: 767px)';

function displayDate(dateKey: string) {
  const parts = parseValidDateKey(dateKey);
  return parts ? `${parts.year}年${parts.month}月${parts.day}日` : dateKey;
}

function monthLabel(dateKey: string) {
  const parts = parseValidDateKey(dateKey);
  return parts ? `${parts.year}年${parts.month}月` : '';
}

function fullDateLabel(dateKey: string, selected: boolean, today: boolean) {
  const parts = parseValidDateKey(dateKey);
  if (!parts) return dateKey;
  const weekday = new Intl.DateTimeFormat('zh-CN', {
    weekday: 'long',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(parts.year, parts.month - 1, parts.day)));
  return [displayDate(dateKey), weekday, today ? '今天' : '', selected ? '已选择' : ''].filter(Boolean).join('，');
}

function CalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" focusable="false">
      <rect x="4.5" y="5.5" width="15" height="14" rx="3" />
      <path d="M8 3.8v3.4M16 3.8v3.4M4.8 10h14.4" />
    </svg>
  );
}

export function DatePickerField({
  ariaLabel,
  value,
  onChange,
  disabled = false,
  required = false,
  allowClear = false,
  min,
  max,
  placeholder = '选择日期',
  leadingIcon,
  className,
  triggerFieldKey,
}: DatePickerFieldProps) {
  const [open, setOpen] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [viewDateKey, setViewDateKey] = useState('');
  const [focusDateKey, setFocusDateKey] = useState('');
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>({});
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const titleId = useId();
  const currentTodayKey = todayKey();
  const selectedIsValid = Boolean(parseValidDateKey(value));
  const invalidRange = Boolean(min && max && parseValidDateKey(min) && parseValidDateKey(max) && min > max);
  const canClear = allowClear && !required && Boolean(value);

  const days = useMemo(() => buildCalendarMonth(viewDateKey || currentTodayKey, {
    selectedDateKey: selectedIsValid ? value : undefined,
    todayDateKey: currentTodayKey,
    min: invalidRange ? '9999-12-31' : min,
    max: invalidRange ? '0001-01-01' : max,
  }), [currentTodayKey, invalidRange, max, min, selectedIsValid, value, viewDateKey]);

  function restoreTriggerFocus() {
    triggerRef.current?.focus({ preventScroll: true });
  }

  function closePicker(restoreFocus = true) {
    setOpen(false);
    if (restoreFocus) restoreTriggerFocus();
  }

  function openPicker() {
    if (disabled) return;
    const isMobile = typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia(MOBILE_QUERY).matches;
    const initialDate = selectedIsValid ? value : currentTodayKey;
    setMobile(isMobile);
    setViewDateKey(initialDate);
    setFocusDateKey(initialDate);
    setOpen(true);
  }

  function selectDate(dateKey: string) {
    if (invalidRange || isDateKeyDisabled(dateKey, min, max)) return;
    onChange(dateKey);
    closePicker();
  }

  function clearDate() {
    if (!canClear) return;
    onChange('');
    closePicker();
  }

  function moveFocus(nextDateKey: string) {
    if (isDateKeyDisabled(nextDateKey, min, max) || invalidRange) return;
    setFocusDateKey(nextDateKey);
    setViewDateKey(nextDateKey);
  }

  function handleDayKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, dateKey: string) {
    let nextDateKey = '';
    if (event.key === 'ArrowLeft') nextDateKey = moveDateKeyByDays(dateKey, -1);
    if (event.key === 'ArrowRight') nextDateKey = moveDateKeyByDays(dateKey, 1);
    if (event.key === 'ArrowUp') nextDateKey = moveDateKeyByDays(dateKey, -7);
    if (event.key === 'ArrowDown') nextDateKey = moveDateKeyByDays(dateKey, 7);
    if (event.key === 'Home') nextDateKey = moveDateKeyByDays(dateKey, -weekdayMondayIndex(dateKey));
    if (event.key === 'End') nextDateKey = moveDateKeyByDays(dateKey, 6 - weekdayMondayIndex(dateKey));
    if (event.key === 'PageUp') nextDateKey = moveDateKeyByMonths(dateKey, event.shiftKey ? -12 : -1);
    if (event.key === 'PageDown') nextDateKey = moveDateKeyByMonths(dateKey, event.shiftKey ? 12 : 1);
    if (!nextDateKey) return;
    event.preventDefault();
    moveFocus(nextDateKey);
  }

  useEffect(() => {
    if (disabled && open) setOpen(false);
  }, [disabled, open]);

  useEffect(() => {
    if (!open) return undefined;
    const previousOverflow = document.body.style.overflow;
    if (mobile) document.body.style.overflow = 'hidden';

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closePicker();
        return;
      }
      if (event.key !== 'Tab' || !panelRef.current) return;
      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex="-1"])',
      )).filter((element) => element.tabIndex >= 0);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    function handlePointerDown(event: PointerEvent) {
      if (mobile) return;
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !triggerRef.current?.contains(target)) closePicker(false);
    }

    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('pointerdown', handlePointerDown);
      if (mobile) document.body.style.overflow = previousOverflow;
    };
  }, [mobile, open]);

  useLayoutEffect(() => {
    if (!open) return;
    const target = panelRef.current?.querySelector<HTMLButtonElement>(`[data-date-key="${focusDateKey}"]:not(:disabled)`)
      ?? panelRef.current?.querySelector<HTMLButtonElement>('.ui-date-picker-day:not(:disabled)');
    target?.focus({ preventScroll: true });
  }, [days, focusDateKey, open]);

  useLayoutEffect(() => {
    if (!open || mobile) return undefined;
    function positionPopover() {
      const trigger = triggerRef.current;
      const panel = panelRef.current;
      if (!trigger || !panel) return;
      const triggerRect = trigger.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      const gap = 8;
      const viewportInset = 12;
      const below = triggerRect.bottom + gap;
      const above = triggerRect.top - panelRect.height - gap;
      const top = below + panelRect.height <= window.innerHeight - viewportInset
        ? below
        : Math.max(viewportInset, above);
      const left = Math.min(
        Math.max(viewportInset, triggerRect.left),
        Math.max(viewportInset, window.innerWidth - panelRect.width - viewportInset),
      );
      setPopoverStyle({ position: 'fixed', top, left });
    }
    positionPopover();
    window.addEventListener('resize', positionPopover);
    window.addEventListener('scroll', positionPopover, true);
    return () => {
      window.removeEventListener('resize', positionPopover);
      window.removeEventListener('scroll', positionPopover, true);
    };
  }, [mobile, open]);

  const viewParts = parseValidDateKey(viewDateKey || currentTodayKey) ?? { year: 1970, month: 1, day: 1 };
  const viewMonthKey = dateKeyFromParts(viewParts.year, viewParts.month, 1);

  const calendar = open ? (
    <div className="ui-date-picker-portal">
      {mobile ? <button type="button" className="ui-date-picker-backdrop" aria-label="关闭日期选择器" onClick={() => closePicker()} /> : null}
      <div
        ref={panelRef}
        id={panelId}
        role="dialog"
        aria-modal={mobile ? 'true' : undefined}
        aria-labelledby={titleId}
        className={mobile ? 'ui-date-picker-sheet' : 'ui-date-picker-popover'}
        style={mobile ? undefined : popoverStyle}
      >
        {mobile ? (
          <div className="ui-date-picker-sheet-head">
            <span className="ui-date-picker-drag-handle" aria-hidden="true" />
            <h3 id={titleId}>选择日期</h3>
            <button type="button" className="ui-date-picker-close" aria-label="关闭日期选择器" onClick={() => closePicker()}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6.5 6.5 11 11m0-11-11 11" /></svg>
            </button>
          </div>
        ) : <h3 id={titleId} className="ui-date-picker-dialog-title">选择日期</h3>}
        <div className="ui-date-picker-body">
          <div className="ui-date-picker-month-head">
            <button type="button" aria-label="上个月" onClick={() => {
              const next = moveDateKeyByMonths(viewMonthKey, -1);
              setViewDateKey(next);
              setFocusDateKey(next);
            }}>‹</button>
            <strong aria-live="polite">{monthLabel(viewMonthKey)}</strong>
            <button type="button" aria-label="下个月" onClick={() => {
              const next = moveDateKeyByMonths(viewMonthKey, 1);
              setViewDateKey(next);
              setFocusDateKey(next);
            }}>›</button>
          </div>
          <div className="ui-date-picker-weekdays" aria-hidden="true">
            {WEEKDAYS.map((weekday) => <span key={weekday}>{weekday}</span>)}
          </div>
          <div className="ui-date-picker-grid" role="grid" aria-label={monthLabel(viewMonthKey)}>
            {days.map((day) => (
              <button
                key={day.dateKey}
                type="button"
                role="gridcell"
                data-date-key={day.dateKey}
                className={[
                  'ui-date-picker-day',
                  day.inCurrentMonth ? '' : 'is-adjacent',
                  day.today ? 'is-today' : '',
                  day.selected ? 'is-selected' : '',
                ].filter(Boolean).join(' ')}
                aria-label={fullDateLabel(day.dateKey, day.selected, day.today)}
                aria-selected={day.selected}
                disabled={day.disabled || invalidRange}
                tabIndex={day.dateKey === focusDateKey ? 0 : -1}
                onKeyDown={(event) => handleDayKeyDown(event, day.dateKey)}
                onClick={() => selectDate(day.dateKey)}
              >
                <span>{day.day}</span>
              </button>
            ))}
          </div>
          {invalidRange ? <p className="ui-date-picker-range-note">当前范围内没有可选日期</p> : null}
          <div className="ui-date-picker-actions">
            {canClear ? <button type="button" className="ui-date-picker-clear" onClick={clearDate}>清除</button> : <span />}
            <button
              type="button"
              className="ui-date-picker-today"
              disabled={invalidRange || isDateKeyDisabled(currentTodayKey, min, max)}
              onClick={() => selectDate(currentTodayKey)}
            >今天</button>
          </div>
        </div>
      </div>
    </div>
  ) : null;

  const triggerText = value ? displayDate(value) : placeholder;
  return (
    <div className={['ui-date-picker', open ? 'is-open' : '', disabled ? 'is-disabled' : '', className].filter(Boolean).join(' ')}>
      <button
        ref={triggerRef}
        type="button"
        className="ui-date-picker-trigger"
        aria-label={`${ariaLabel}，${value ? `当前为${triggerText}` : placeholder}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        data-field-key={triggerFieldKey}
        disabled={disabled}
        onClick={() => open ? closePicker(false) : openPicker()}
      >
        {leadingIcon ? <span className="ui-date-picker-leading-icon" aria-hidden="true">{leadingIcon}</span> : null}
        <span className={['ui-date-picker-value', value ? '' : 'is-placeholder'].filter(Boolean).join(' ')}>{triggerText}</span>
        <span className="ui-date-picker-trailing-icon" aria-hidden="true"><CalendarIcon /></span>
      </button>
      {calendar && typeof document !== 'undefined' ? createPortal(calendar, document.body) : null}
    </div>
  );
}
