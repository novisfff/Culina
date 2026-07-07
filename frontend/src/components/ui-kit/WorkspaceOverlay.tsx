import {
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { ActionButton } from './ActionButton';

type WorkspaceOverlayShellProps = {
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
};

function WorkspaceOverlayShell(props: WorkspaceOverlayShellProps) {
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

export type WorkspaceOverlayPanelProps = Omit<WorkspaceOverlayShellProps, 'kind'>;

export function WorkspaceDrawer(props: WorkspaceOverlayPanelProps) {
  return <WorkspaceOverlayShell {...props} kind="drawer" />;
}

export function WorkspaceModal(props: WorkspaceOverlayPanelProps) {
  return <WorkspaceOverlayShell {...props} kind="modal" />;
}
