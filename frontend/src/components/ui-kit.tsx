import {
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import type { ImageInputValue } from '../api/types';
import { resolveAssetUrl } from '../lib/assets';
import { MediaWithPlaceholder } from './MediaPlaceholder';
import { avatarColor, getImagePreview, initials } from '../lib/ui';

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

export function StatCard(props: { title: string; value: string; detail: string }) {
  return (
    <article className="stat-card">
      <p className="eyebrow">{props.title}</p>
      <h3>{props.value}</h3>
      <p>{props.detail}</p>
    </article>
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

export function SegmentedTabs<T extends string>(props: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented-tabs" role="tablist" aria-label="页面分段">
      {props.options.map((item) => (
        <button
          key={item.value}
          className={props.value === item.value ? 'segmented-tab active' : 'segmented-tab'}
          type="button"
          onClick={() => props.onChange(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
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

export function WorkspaceToolbar(props: {
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={props.className ? `workspace-toolbar ${props.className}` : 'workspace-toolbar'}>
      <div className="workspace-toolbar-main">{props.children}</div>
      {props.actions && <div className="workspace-toolbar-actions">{props.actions}</div>}
    </div>
  );
}

export function CompactMetric(props: { label: string; value: string; detail?: string }) {
  return (
    <article className="compact-metric">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
      {props.detail && <p>{props.detail}</p>}
    </article>
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
  className?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const shellClassName = props.kind === 'drawer' ? 'workspace-drawer' : 'workspace-modal';
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
    const root = panel?.closest(
      '.home-dashboard-overlay-root, .food-workspace-overlay-root, .ingredient-workspace-overlay-root, .family-settings-overlay-root, .meal-log-overlay-root'
    );
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
      className={props.className ? `${shellClassName} workspace-overlay-panel ${props.className}` : `${shellClassName} workspace-overlay-panel`}
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
        <ActionButton tone="secondary" size="compact" type="button" className="workspace-overlay-close" onClick={props.onClose}>
          <span aria-hidden={props.closeAriaLabel ? 'true' : undefined}>{props.closeLabel ?? '关闭'}</span>
          {props.closeAriaLabel ? <span className="sr-only">{props.closeAriaLabel}</span> : null}
        </ActionButton>
      </div>
      <div className="workspace-overlay-body">{props.children}</div>
    </section>
  );
}

export function WorkspaceDrawer(props: {
  title: string;
  description?: string;
  eyebrow?: string;
  closeLabel?: ReactNode;
  closeAriaLabel?: string;
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
  className?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return <WorkspaceOverlayShell {...props} kind="modal" />;
}

export function DenseListRow(props: {
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  footer?: ReactNode;
  tone?: 'default' | 'warning' | 'danger';
  className?: string;
}) {
  const classes = ['dense-list-row'];
  if (props.tone && props.tone !== 'default') {
    classes.push(`dense-list-row-${props.tone}`);
  }
  if (props.className) {
    classes.push(props.className);
  }
  return (
    <article className={classes.join(' ')}>
      <div className="dense-list-row-main">
        {props.leading && <div className="dense-list-row-leading">{props.leading}</div>}
        <div className="dense-list-row-copy">
          <div className="dense-list-row-head">
            <h3>{props.title}</h3>
            {props.meta && <div className="dense-list-row-meta">{props.meta}</div>}
          </div>
          {props.description && <p>{props.description}</p>}
        </div>
        {props.trailing && <div className="dense-list-row-trailing">{props.trailing}</div>}
      </div>
      {props.footer && <div className="dense-list-row-footer">{props.footer}</div>}
    </article>
  );
}

export function Avatar(props: { label: string; seed: string; large?: boolean; imageUrl?: string | null }) {
  return (
    <div className={props.large ? 'avatar large' : 'avatar'} style={{ backgroundColor: avatarColor(props.seed) }}>
      {props.imageUrl ? <img src={resolveAssetUrl(props.imageUrl)} alt={props.label} /> : initials(props.label)}
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

export function ImageComposer(props: {
  title: string;
  value: ImageInputValue;
  previewLabel: string;
  onUpload: (files: FileList | null) => void;
  onGenerate: (mode: 'reference' | 'text') => void;
  onReset: () => void;
  isGenerating?: boolean;
  errorMessage?: string | null;
  variant?: 'default' | 'workspace-inline';
  uploadTitle?: string;
  uploadHint?: string;
  generatedTitle?: string;
  generateLabel?: string;
  clearLabel?: string;
}) {
  const preview = getImagePreview(props.value);
  const hasReference = Boolean(props.value.referenceAsset);
  const hasGenerated = Boolean(props.value.generatedAsset);
  const generateLabel = props.generateLabel ?? (hasReference
    ? hasGenerated
      ? '重新生成主图'
      : '重试生成主图'
    : '基于信息生成主图');
  const ContainerTag = props.variant === 'workspace-inline' ? 'section' : 'div';
  const rootClassName =
    props.variant === 'workspace-inline'
      ? 'media-panel form-panel-section image-composer image-composer-workspace-inline'
      : 'span-two media-panel form-panel-section image-composer';
  const showResults = hasReference || hasGenerated || Boolean(props.isGenerating);
  const aiStatusLabel = hasGenerated ? '已生成' : props.isGenerating ? '后台生成中' : props.errorMessage ? '可重试' : '未生成';
  const aiPlaceholderTitle = props.isGenerating ? 'AI 主图已排队' : props.errorMessage ? '主图生成失败' : '还没有 AI 主图';
  const aiPlaceholderNote = props.isGenerating ? '可以先保存，生成完成后会自动更新图片。' : props.errorMessage ? '点击右上角按钮重试即可。' : '可以先上传参考图，或直接基于信息生成。';

  return (
    <ContainerTag className={rootClassName}>
      <div className="section-mini-title">
        <span>{props.title}</span>
      </div>
      <div className="image-composer-stage">
        {!showResults ? (
          props.variant === 'workspace-inline' ? (
            <div className="image-composer-intro-grid">
              <div className="image-composer-intro-card">
                <div className="intro-card-header">
                  <div className="intro-card-icon-badge">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364-6.364l-.707.707M6.343 17.657l-.707.707m0-12.728l.707.707m10.607 10.607l.707.707N12 8a4 4 0 100 8 4 4 0 000-8z" />
                    </svg>
                  </div>
                  <strong>AI 主图美化</strong>
                </div>
                <p className="intro-card-desc">
                  上传您的日常实拍作为<b>参考图</b>，AI 将自动将其美化为温馨的手绘插画主图。
                </p>
                <div className="intro-card-tips">
                  <div className="intro-tip-item">
                    <span className="tip-dot">✦</span>
                    <span>支持拍照或相册上传参考图，效果更佳</span>
                  </div>
                  <div className="intro-tip-item">
                    <span className="tip-dot">✦</span>
                    <span>若无参考图，也可直接基于食物名称一键生成</span>
                  </div>
                </div>
              </div>
              <label className="upload-dropzone image-composer-primary-dropzone">
                <input
                  type="file"
                  accept="image/*,.svg"
                  capture="environment"
                  disabled={props.isGenerating}
                  onChange={(event) => {
                    props.onUpload(event.target.files);
                    event.currentTarget.value = '';
                  }}
                />
                <div className="image-composer-dropzone-copy">
                  <strong>{props.uploadTitle ?? '上传参考图'}</strong>
                  <span>{props.uploadHint ?? '上传后自动生成统一风格主图'}</span>
                </div>
              </label>
            </div>
          ) : (
            <label className="upload-dropzone image-composer-primary-dropzone">
              <input
                type="file"
                accept="image/*,.svg"
                capture="environment"
                disabled={props.isGenerating}
                onChange={(event) => {
                  props.onUpload(event.target.files);
                  event.currentTarget.value = '';
                }}
              />
              <div className="image-composer-dropzone-copy">
                <strong>{props.uploadTitle ?? '上传参考图'}</strong>
                <span>{props.uploadHint ?? '上传后自动生成统一风格主图'}</span>
              </div>
            </label>
          )
        ) : (
          <div className={hasReference ? 'image-composer-result-grid has-reference' : 'image-composer-result-grid'}>
            {hasReference && (
              <label className="image-composer-result-card image-composer-result-card-upload">
                <input
                  type="file"
                  accept="image/*,.svg"
                  capture="environment"
                  disabled={props.isGenerating}
                  onChange={(event) => {
                    props.onUpload(event.target.files);
                    event.currentTarget.value = '';
                  }}
                />
                <div className="image-composer-result-head">
                  <span>参考图</span>
                  <small>{props.isGenerating ? '后台生成中' : '点按更换'}</small>
                </div>
                <div className="image-composer-result-media">
                  <MediaWithPlaceholder
                    src={resolveAssetUrl(props.value.referenceAsset?.url ?? preview?.url ?? '')}
                    alt={`${props.previewLabel}参考图`}
                  />
                </div>
              </label>
            )}

            <article className="image-composer-result-card">
              <div className="image-composer-result-head">
                <span>{props.generatedTitle ?? 'AI 主图'}</span>
                <small>{aiStatusLabel}</small>
              </div>
              {hasGenerated ? (
                <div className="image-composer-result-media">
                  <MediaWithPlaceholder
                    src={resolveAssetUrl(props.value.generatedAsset?.url ?? preview?.url ?? '')}
                    alt={props.previewLabel}
                  />
                </div>
              ) : (
                <div className="image-composer-result-placeholder">
                  {props.isGenerating && <div className="image-composer-loading-surface" aria-hidden="true" />}
                  <strong>{aiPlaceholderTitle}</strong>
                  <span>{aiPlaceholderNote}</span>
                </div>
              )}
            </article>
          </div>
        )}
      </div>
      <div className="image-composer-actions">
        <button
          className="ghost-button ai-action"
          type="button"
          onClick={() => props.onGenerate(hasReference ? 'reference' : 'text')}
          disabled={props.isGenerating}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 3.8 14 9l5.2 2-5.2 2-2 5.2-2-5.2-5.2-2 5.2-2L12 3.8Z" />
          </svg>
          {props.isGenerating ? '正在生成...' : generateLabel}
        </button>
        {(hasReference || hasGenerated) && (
          <button className="ghost-button" type="button" onClick={props.onReset} disabled={props.isGenerating}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5.1 8.5A7.2 7.2 0 1 1 4.8 16" />
              <path d="M5 4.8v3.7h3.7" />
            </svg>
            {props.clearLabel ?? '清空图片'}
          </button>
        )}
      </div>
      {props.errorMessage && <span className="image-composer-error">{props.errorMessage}</span>}
    </ContainerTag>
  );
}
