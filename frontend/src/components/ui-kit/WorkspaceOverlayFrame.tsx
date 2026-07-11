import {
  useEffect,
  useId,
  useRef,
  type ReactNode,
  type RefObject,
} from 'react';

export type WorkspaceOverlayFrameProps = {
  children: ReactNode;
  onClose: () => void;
  /** Preferred: id of the visible title element inside the panel. Optional for backward compatibility. */
  labelledBy?: string;
  busy?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  restoreFocusTo?: HTMLElement | null;
  closeOnBackdrop?: boolean;
  rootClassName?: string;
  backdropClassName?: string;
};

function getFocusableElements(root: HTMLElement): HTMLElement[] {
  const selector = [
    'a[href]',
    'button:not([disabled])',
    'textarea:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter((node) => {
    if (node.getAttribute('aria-hidden') === 'true') return false;
    if (node.hasAttribute('disabled')) return false;
    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    return true;
  });
}

export function WorkspaceOverlayFrame({
  children,
  onClose,
  labelledBy,
  busy = false,
  initialFocusRef,
  restoreFocusTo,
  closeOnBackdrop = true,
  rootClassName,
  backdropClassName,
}: WorkspaceOverlayFrameProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const restoreTargetRef = useRef<HTMLElement | null>(null);
  const generatedLabelId = useId();
  const resolvedLabelledBy = labelledBy ?? generatedLabelId;

  useEffect(() => {
    restoreTargetRef.current =
      restoreFocusTo ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  }, [restoreFocusTo]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    // Mark siblings inert so background content is removed from normal tab order.
    const inerted: HTMLElement[] = [];
    const parent = root.parentElement;
    if (parent) {
      Array.from(parent.children).forEach((child) => {
        if (child === root) return;
        if (!(child instanceof HTMLElement)) return;
        if (child.hasAttribute('inert')) return;
        child.setAttribute('inert', '');
        inerted.push(child);
      });
    }

    const panel =
      root.querySelector<HTMLElement>('[data-workspace-overlay-panel="true"]') ??
      root.querySelector<HTMLElement>('.workspace-overlay-panel');

    if (panel) {
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'true');
      if (!panel.getAttribute('aria-labelledby') && resolvedLabelledBy) {
        panel.setAttribute('aria-labelledby', resolvedLabelledBy);
      }
      panel.setAttribute('data-workspace-overlay-busy', busy ? 'true' : 'false');
    }

    const focusNow = () => {
      const focusTarget =
        initialFocusRef?.current ??
        (panel ? getFocusableElements(panel)[0] : null) ??
        panel;
      if (focusTarget && typeof focusTarget.focus === 'function') {
        try {
          focusTarget.focus({ preventScroll: true });
        } catch {
          focusTarget.focus();
        }
      }
    };
    // Focus immediately and again on the next frame so late-mounted children are covered.
    focusNow();
    const focusFrame = window.requestAnimationFrame(focusNow);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (busy) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', handleKeyDown);
      for (const node of inerted) {
        node.removeAttribute('inert');
      }
      const restoreTo = restoreTargetRef.current;
      if (restoreTo && typeof restoreTo.focus === 'function' && document.contains(restoreTo)) {
        try {
          restoreTo.focus({ preventScroll: true });
        } catch {
          restoreTo.focus();
        }
      }
    };
  }, [busy, initialFocusRef, onClose, resolvedLabelledBy]);

  // Keep busy attribute in sync without remounting inert/focus logic.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const panel =
      root.querySelector<HTMLElement>('[data-workspace-overlay-panel="true"]') ??
      root.querySelector<HTMLElement>('.workspace-overlay-panel');
    panel?.setAttribute('data-workspace-overlay-busy', busy ? 'true' : 'false');
  }, [busy]);

  const handleBackdropClick = () => {
    if (busy) return;
    if (!closeOnBackdrop) return;
    onClose();
  };

  return (
    <div
      ref={rootRef}
      className={['workspace-overlay-root', rootClassName].filter(Boolean).join(' ')}
      data-busy={busy ? 'true' : undefined}
    >
      <div
        className={['workspace-overlay-backdrop', backdropClassName].filter(Boolean).join(' ')}
        onClick={handleBackdropClick}
      />
      {children}
    </div>
  );
}
