import {
  useEffect,
  useId,
  useRef,
  type ReactNode,
  type RefObject,
} from 'react';
import { useOverlayFocusLifecycle } from './useOverlayFocusLifecycle';

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
  // Keep latest callbacks/flags in refs so the mount effect does not re-run (and re-steal
  // focus) when parents pass a new onClose identity on every render.
  const onCloseRef = useRef(onClose);
  const busyRef = useRef(busy);
  const generatedLabelId = useId();
  const resolvedLabelledBy = labelledBy ?? generatedLabelId;

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useOverlayFocusLifecycle({
    rootRef,
    onClose,
    busy,
    initialFocusRef,
    restoreFocusTo,
  });

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const panel =
      root.querySelector<HTMLElement>('[data-workspace-overlay-panel="true"]') ??
      root.querySelector<HTMLElement>('.workspace-overlay-panel');

    if (panel) {
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'true');
      if (!panel.getAttribute('aria-labelledby') && resolvedLabelledBy) {
        panel.setAttribute('aria-labelledby', resolvedLabelledBy);
      }
      panel.setAttribute('data-workspace-overlay-busy', busyRef.current ? 'true' : 'false');
    }

  }, [resolvedLabelledBy]);

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
    if (busyRef.current) return;
    if (!closeOnBackdrop) return;
    onCloseRef.current();
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
