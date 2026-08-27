import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { createPortal } from 'react-dom';
import { todayKey } from '../../lib/date';
import { buildCalendarMonth, dateKeyFromParts, moveDateKeyByMonths, parseValidDateKey } from './datePickerModel';

export type DateRangeValue = { start: string; end: string };

export type DateRangePickerFieldProps = {
  ariaLabel: string;
  startValue: string;
  endValue: string;
  onChange: (value: DateRangeValue) => void;
  min?: string;
  max?: string;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
};

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];
const MOBILE_QUERY = '(max-width: 767px)';

function displayDate(value: string): string {
  const parts = parseValidDateKey(value);
  return parts ? `${parts.year}年${parts.month}月${parts.day}日` : value;
}

function monthLabel(value: string): string {
  const parts = parseValidDateKey(value);
  return parts ? `${parts.year}年${parts.month}月` : '';
}

function currentMonthRange(today: string, min?: string, max?: string): DateRangeValue | null {
  const parts = parseValidDateKey(today);
  if (!parts) return null;
  const monthStart = dateKeyFromParts(parts.year, parts.month, 1);
  const start = min && min > monthStart ? min : monthStart;
  const end = max && max < today ? max : today;
  return start <= end ? { start, end } : null;
}

function CalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" focusable="false">
      <rect x="4.5" y="5.5" width="15" height="14" rx="3" />
      <path d="M8 3.8v3.4M16 3.8v3.4M4.8 10h14.4" />
    </svg>
  );
}

export function DateRangePickerField({
  ariaLabel,
  startValue,
  endValue,
  onChange,
  min,
  max,
  disabled = false,
  placeholder = '选择日期范围',
  className,
}: DateRangePickerFieldProps) {
  const [open, setOpen] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [viewDateKey, setViewDateKey] = useState('');
  const [pendingStart, setPendingStart] = useState('');
  const [pendingEnd, setPendingEnd] = useState('');
  const [selecting, setSelecting] = useState<'start' | 'end'>('start');
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>({});
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const titleId = useId();
  const currentTodayKey = todayKey();

  const days = useMemo(() => buildCalendarMonth(viewDateKey || currentTodayKey, {
    todayDateKey: currentTodayKey,
    min,
    max,
  }), [currentTodayKey, max, min, viewDateKey]);

  function closePicker(restoreFocus = true) {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  }

  function openPicker() {
    if (disabled) return;
    setMobile(typeof window !== 'undefined' && window.matchMedia?.(MOBILE_QUERY).matches);
    setPendingStart(startValue);
    setPendingEnd(endValue);
    setSelecting('start');
    setViewDateKey(startValue || endValue || currentTodayKey);
    setOpen(true);
  }

  function selectDate(dateKey: string) {
    if (selecting === 'start') {
      setPendingStart(dateKey);
      setPendingEnd('');
      setSelecting('end');
      return;
    }
    if (!pendingStart || dateKey < pendingStart) {
      setPendingStart(dateKey);
      setPendingEnd('');
      setSelecting('end');
      return;
    }
    setPendingEnd(dateKey);
    setSelecting('start');
  }

  function applyRange() {
    if (!pendingStart || !pendingEnd) return;
    onChange({ start: pendingStart, end: pendingEnd });
    closePicker();
  }

  function selectCurrentMonth() {
    const range = currentMonthRange(currentTodayKey, min, max);
    if (!range) return;
    setPendingStart(range.start);
    setPendingEnd(range.end);
    setSelecting('start');
    setViewDateKey(range.start);
  }

  useEffect(() => {
    if (!open) return undefined;
    const previousOverflow = document.body.style.overflow;
    if (mobile) document.body.style.overflow = 'hidden';
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') closePicker();
    }
    function onPointerDown(event: PointerEvent) {
      if (mobile) return;
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !triggerRef.current?.contains(target)) closePicker(false);
    }
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
      if (mobile) document.body.style.overflow = previousOverflow;
    };
  }, [mobile, open]);

  useLayoutEffect(() => {
    if (!open || mobile) return undefined;
    function positionPopover() {
      const trigger = triggerRef.current;
      const panel = panelRef.current;
      if (!trigger || !panel) return;
      const triggerRect = trigger.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      const gap = 8;
      const inset = 12;
      const below = triggerRect.bottom + gap;
      const above = triggerRect.top - panelRect.height - gap;
      const top = below + panelRect.height <= window.innerHeight - inset ? below : Math.max(inset, above);
      const left = Math.min(Math.max(inset, triggerRect.left), Math.max(inset, window.innerWidth - panelRect.width - inset));
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
  const complete = Boolean(pendingStart && pendingEnd);
  const triggerText = startValue && endValue ? `${displayDate(startValue)} 至 ${displayDate(endValue)}` : placeholder;

  const panel = open ? (
    <div className="ui-date-range-picker-portal">
      {mobile ? <button type="button" className="ui-date-range-picker-backdrop" aria-label="关闭日期范围选择器" onClick={() => closePicker()} /> : null}
      <div
        ref={panelRef}
        id={panelId}
        role="dialog"
        aria-modal={mobile ? 'true' : undefined}
        aria-labelledby={titleId}
        className={mobile ? 'ui-date-range-picker-sheet' : 'ui-date-range-picker-popover'}
        style={mobile ? undefined : popoverStyle}
      >
        <div className="ui-date-range-picker-head">
          <div><p>日期筛选</p><h3 id={titleId}>选择日期范围</h3></div>
          <button type="button" aria-label="关闭日期范围选择器" onClick={() => closePicker()}>×</button>
        </div>
        <div className="ui-date-range-picker-selection" aria-live="polite">
          <button type="button" className={selecting === 'start' ? 'is-active' : ''} onClick={() => setSelecting('start')}><small>开始日期</small><strong>{pendingStart ? displayDate(pendingStart) : '请选择'}</strong></button>
          <span aria-hidden="true">—</span>
          <button type="button" className={selecting === 'end' ? 'is-active' : ''} onClick={() => pendingStart && setSelecting('end')}><small>结束日期</small><strong>{pendingEnd ? displayDate(pendingEnd) : '请选择'}</strong></button>
        </div>
        <div className="ui-date-range-picker-month-head">
          <button type="button" aria-label="上个月" onClick={() => setViewDateKey(moveDateKeyByMonths(viewMonthKey, -1))}>‹</button>
          <strong>{monthLabel(viewMonthKey)}</strong>
          <button type="button" aria-label="下个月" onClick={() => setViewDateKey(moveDateKeyByMonths(viewMonthKey, 1))}>›</button>
        </div>
        <div className="ui-date-range-picker-weekdays" aria-hidden="true">{WEEKDAYS.map((day) => <span key={day}>{day}</span>)}</div>
        <div className="ui-date-range-picker-grid" role="grid" aria-label={monthLabel(viewMonthKey)}>
          {days.map((day) => {
            const inRange = Boolean(pendingStart && pendingEnd && day.dateKey > pendingStart && day.dateKey < pendingEnd);
            const edge = day.dateKey === pendingStart || day.dateKey === pendingEnd;
            return <button key={day.dateKey} type="button" role="gridcell" data-date-key={day.dateKey} aria-label={displayDate(day.dateKey)} aria-selected={edge || inRange} disabled={day.disabled} className={[day.inCurrentMonth ? '' : 'is-adjacent', day.today ? 'is-today' : '', inRange ? 'is-in-range' : '', edge ? 'is-range-edge' : ''].filter(Boolean).join(' ')} onClick={() => selectDate(day.dateKey)}><span>{day.day}</span></button>;
          })}
        </div>
        <div className="ui-date-range-picker-actions">
          <button type="button" onClick={selectCurrentMonth}>本月</button>
          <button type="button" disabled={!complete} onClick={applyRange}>应用范围</button>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <div className={['ui-date-range-picker', open ? 'is-open' : '', className].filter(Boolean).join(' ')}>
      <button ref={triggerRef} type="button" className="ui-date-range-picker-trigger" aria-label={`${ariaLabel}，${triggerText}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined} disabled={disabled} onClick={() => open ? closePicker(false) : openPicker()}>
        <span className={startValue && endValue ? '' : 'is-placeholder'}>{triggerText}</span>
        <span aria-hidden="true"><CalendarIcon /></span>
      </button>
      {panel && typeof document !== 'undefined' ? createPortal(panel, document.body) : null}
    </div>
  );
}
