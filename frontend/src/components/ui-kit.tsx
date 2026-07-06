import {
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { resolveAssetUrl } from '../lib/assets';
import { avatarColor, initials } from '../lib/ui';

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

export function SectionHeading(props: { title: string; description: string; actions?: ReactNode }) {
  return (
    <div className="section-heading">
      <div>
        <h2>{props.title}</h2>
        <p className="subtle">{props.description}</p>
      </div>
      {props.actions}
    </div>
  );
}

export function PageHeader(props: {
  eyebrow?: string;
  title: string;
  description: string;
  actions?: ReactNode;
  meta?: ReactNode;
  variant?: 'compact' | 'workspace';
}) {
  return (
    <section
      className={
        props.variant === 'workspace'
          ? 'page-header page-header-workspace card'
          : 'page-header page-header-compact card'
      }
    >
      <div className="page-header-copy">
        {props.eyebrow && <p className="eyebrow">{props.eyebrow}</p>}
        <h2>{props.title}</h2>
        <p className="subtle">{props.description}</p>
      </div>
      {(props.meta || props.actions) && (
        <div className="page-header-side">
          {props.meta}
          {props.actions}
        </div>
      )}
    </section>
  );
}

export function Badge(props: { children: ReactNode; className?: string }) {
  return <span className={props.className ? `badge ${props.className}` : 'badge'}>{props.children}</span>;
}

export function ActionButton(
  props: {
    tone?: 'primary' | 'secondary' | 'tertiary';
    size?: 'default' | 'compact';
    className?: string;
    children: ReactNode;
  } & ButtonHTMLAttributes<HTMLButtonElement>
) {
  const { tone = 'secondary', size = 'default', className, children, ...buttonProps } = props;
  const classes = [
    tone === 'primary' ? 'solid-button' : tone === 'tertiary' ? 'tertiary-button' : 'ghost-button',
  ];
  if (size === 'compact') {
    classes.push('button-compact');
  }
  if (className) {
    classes.push(className);
  }
  return (
    <button {...buttonProps} className={classes.join(' ')}>
      {children}
    </button>
  );
}

export function WorkspaceSubnav<T extends string>(props: {
  items: Array<{ value: T; label: string; icon?: ReactNode }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="workspace-subnav" role="tablist" aria-label="工作区子导航">
      {props.items.map((item) => (
        <button
          key={item.value}
          className={props.value === item.value ? 'workspace-subnav-item active' : 'workspace-subnav-item'}
          type="button"
          onClick={() => props.onChange(item.value)}
        >
          {item.icon && <span className="workspace-subnav-item-icon">{item.icon}</span>}
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function WorkspaceSubpageHeader(props: {
  eyebrow: string;
  title: string;
  description: string;
  backLabel: string;
  onBack: () => void;
  meta?: ReactNode;
  actions?: ReactNode;
  variant?: 'default' | 'compact';
}) {
  return (
    <section
      className={
        props.variant === 'compact'
          ? 'workspace-subpage-header workspace-subpage-header-compact'
          : 'workspace-subpage-header'
      }
    >
      <div className="workspace-subpage-breadcrumb">
        <button className="workspace-back-link" type="button" onClick={props.onBack}>
          {props.backLabel}
        </button>
        {props.meta}
      </div>
      <div className="workspace-subpage-body">
        <div className="workspace-subpage-copy">
          <p className="eyebrow">{props.eyebrow}</p>
          <h2>{props.title}</h2>
          <p className="subtle">{props.description}</p>
        </div>
        {props.actions && <div className="workspace-subpage-actions">{props.actions}</div>}
      </div>
    </section>
  );
}

export function WorkspaceSubpageShell(props: { children: ReactNode; className?: string }) {
  return (
    <section className={props.className ? `workspace-subpage workspace-subpage-shell card ${props.className}` : 'workspace-subpage workspace-subpage-shell card'}>
      {props.children}
    </section>
  );
}

function WorkspaceOverlayShell(props: {
  kind: 'drawer' | 'modal';
  title: string;
  description?: string;
  eyebrow?: string;
  closeLabel?: ReactNode;
  closeAriaLabel?: string;
  footer?: ReactNode;
  footerInfo?: ReactNode;
  footerActions?: ReactNode;
  className?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const shellClassName = props.kind === 'drawer' ? 'workspace-drawer' : 'workspace-modal';
  const sheetClassName = props.kind === 'drawer' ? 'workspace-drawer-sheet' : 'workspace-modal-sheet';
  const hasFooter = Boolean(props.footer || props.footerInfo || props.footerActions);
  const panelRef = useRef<HTMLElement>(null);
  const dragRef = useRef({ pointerId: -1, startY: 0, startTime: 0, distance: 0 });
  const closeTimerRef = useRef<number | null>(null);
  const removeDragListenersRef = useRef<(() => void) | null>(null);

  useEffect(() => () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
    }
    removeDragListenersRef.current?.();
  }, []);

  function resetDragPosition() {
    const panel = panelRef.current;
    if (!panel) {
      return;
    }
    panel.style.transition = 'transform 220ms cubic-bezier(0.22, 1, 0.36, 1)';
    panel.style.transform = 'translateY(0)';
    window.setTimeout(() => {
      panel.style.removeProperty('transition');
      panel.style.removeProperty('transform');
      panel.style.removeProperty('animation');
    }, 230);
  }

  function updateDragPosition(event: PointerEvent) {
    const panel = panelRef.current;
    if (!panel || dragRef.current.pointerId !== event.pointerId) {
      return;
    }
    event.preventDefault();
    const distance = Math.max(0, event.clientY - dragRef.current.startY);
    dragRef.current.distance = distance;
    panel.style.transform = `translateY(${distance}px)`;
  }

  function finishDrag(event: PointerEvent) {
    const panel = panelRef.current;
    if (!panel || dragRef.current.pointerId !== event.pointerId) {
      return;
    }
    removeDragListenersRef.current?.();
    removeDragListenersRef.current = null;
    const elapsed = Math.max(1, performance.now() - dragRef.current.startTime);
    const velocity = dragRef.current.distance / elapsed;
    const closeDistance = Math.min(120, panel.getBoundingClientRect().height * 0.22);
    const shouldClose = dragRef.current.distance >= closeDistance
      || (dragRef.current.distance >= 36 && velocity >= 0.65);
    dragRef.current.pointerId = -1;

    if (!shouldClose) {
      resetDragPosition();
      return;
    }

    panel.style.transition = 'transform 180ms cubic-bezier(0.4, 0, 1, 1)';
    panel.style.transform = 'translateY(100%)';
    closeTimerRef.current = window.setTimeout(props.onClose, 180);
  }

  function handleDragStart(event: ReactPointerEvent<HTMLDivElement>) {
    const panel = panelRef.current;
    const root = panel?.closest('.workspace-overlay-root');
    if (!panel || !root || !window.matchMedia('(max-width: 767px)').matches) {
      return;
    }
    removeDragListenersRef.current?.();
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startTime: performance.now(),
      distance: 0,
    };
    panel.style.animation = 'none';
    panel.style.transition = 'none';
    event.currentTarget.setPointerCapture(event.pointerId);

    const handlePointerMove = (pointerEvent: PointerEvent) => updateDragPosition(pointerEvent);
    const handlePointerEnd = (pointerEvent: PointerEvent) => finishDrag(pointerEvent);
    window.addEventListener('pointermove', handlePointerMove, { passive: false });
    window.addEventListener('pointerup', handlePointerEnd);
    window.addEventListener('pointercancel', handlePointerEnd);
    removeDragListenersRef.current = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerEnd);
      window.removeEventListener('pointercancel', handlePointerEnd);
    };
  }

  return (
    <section
      ref={panelRef}
      className={props.className ? `${shellClassName} workspace-overlay-panel ${sheetClassName} ${props.className}` : `${shellClassName} workspace-overlay-panel ${sheetClassName}`}
      onClick={(event) => event.stopPropagation()}
    >
      <div
        className="workspace-overlay-drag-zone"
        aria-hidden="true"
        onPointerDown={handleDragStart}
      >
        <span className="workspace-overlay-drag-handle" />
      </div>
      <div className="workspace-overlay-head">
        <div className="workspace-overlay-titleblock">
          {props.eyebrow && <p className="eyebrow">{props.eyebrow}</p>}
          <h3>{props.title}</h3>
          {props.description && <p className="subtle">{props.description}</p>}
        </div>
        <ActionButton
          tone="secondary"
          size="compact"
          type="button"
          className="workspace-overlay-close"
          aria-label={props.closeAriaLabel ?? (typeof props.closeLabel === 'string' ? props.closeLabel : '关闭弹窗')}
          onClick={props.onClose}
        >
          <span className="workspace-overlay-close-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" focusable="false">
              <path d="M6.5 6.5 17.5 17.5" />
              <path d="M17.5 6.5 6.5 17.5" />
            </svg>
          </span>
          <span className="workspace-overlay-close-label">{props.closeLabel ?? '关闭'}</span>
        </ActionButton>
      </div>
      <div className="workspace-overlay-body">{props.children}</div>
      {hasFooter ? (
        <footer className="workspace-overlay-footer">
          {props.footer ?? (
            <>
              {props.footerInfo ? <div className="workspace-overlay-footer-info">{props.footerInfo}</div> : null}
              {props.footerActions ? <div className="workspace-overlay-footer-actions">{props.footerActions}</div> : null}
            </>
          )}
        </footer>
      ) : null}
    </section>
  );
}

export function WorkspaceDrawer(props: {
  title: string;
  description?: string;
  eyebrow?: string;
  closeLabel?: ReactNode;
  closeAriaLabel?: string;
  footer?: ReactNode;
  footerInfo?: ReactNode;
  footerActions?: ReactNode;
  className?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return <WorkspaceOverlayShell {...props} kind="drawer" />;
}

export function WorkspaceModal(props: {
  title: string;
  description?: string;
  eyebrow?: string;
  closeLabel?: ReactNode;
  closeAriaLabel?: string;
  footer?: ReactNode;
  footerInfo?: ReactNode;
  footerActions?: ReactNode;
  className?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return <WorkspaceOverlayShell {...props} kind="modal" />;
}

export function Avatar(props: { label: string; seed: string; large?: boolean; imageUrl?: string | null }) {
  const imageUrl = props.imageUrl ? (resolveAssetUrl(props.imageUrl) ?? props.imageUrl) : undefined;
  const className = [
    'avatar',
    props.large ? 'large' : '',
    imageUrl ? 'avatar-has-image' : '',
  ].filter(Boolean).join(' ');
  return (
    <div className={className} style={imageUrl ? undefined : { backgroundColor: avatarColor(props.seed) }}>
      {imageUrl ? <img src={imageUrl} alt={props.label} /> : initials(props.label)}
    </div>
  );
}

export function EmptyState(props: { title: string; description: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <h3>{props.title}</h3>
      <p>{props.description}</p>
      {props.action}
    </div>
  );
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

export * from './ui-kit/index';
