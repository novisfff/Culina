import { useEffect, useRef, type RefObject } from 'react';

/** Mounted overlay roots; topmost is resolved by DOM nesting + mount order. */
const overlayStack: HTMLElement[] = [];
let bodyLockCount = 0;
let originalBodyOverflow = '';

function getTopmostOverlay(): HTMLElement | undefined {
  let top: HTMLElement | undefined;
  for (const node of overlayStack) {
    if (!top) {
      top = node;
    } else if (top.contains(node)) {
      top = node;
    } else if (!node.contains(top)) {
      top = node;
    }
  }
  return top;
}

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
    if (node.hasAttribute('disabled') || node.tabIndex < 0) return false;
    const style = window.getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden';
  });
}

export function useOverlayFocusLifecycle(options: {
  rootRef: RefObject<HTMLElement | null>;
  focusScopeRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
  busy?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  restoreFocusTo?: HTMLElement | null;
}) {
  const { rootRef, focusScopeRef, initialFocusRef, restoreFocusTo } = options;
  const onCloseRef = useRef(options.onClose);
  const busyRef = useRef(Boolean(options.busy));
  const restoreTargetRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    onCloseRef.current = options.onClose;
  }, [options.onClose]);

  useEffect(() => {
    busyRef.current = Boolean(options.busy);
  }, [options.busy]);

  useEffect(() => {
    restoreTargetRef.current =
      restoreFocusTo ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  }, [restoreFocusTo]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const focusScope = focusScopeRef?.current ?? root;
    overlayStack.push(root);
    if (bodyLockCount === 0) {
      originalBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    bodyLockCount += 1;

    const inerted: HTMLElement[] = [];
    const parent = root.parentElement;
    if (parent) {
      Array.from(parent.children).forEach((child) => {
        if (child === root || !(child instanceof HTMLElement) || child.hasAttribute('inert')) return;
        child.setAttribute('inert', '');
        inerted.push(child);
      });
    }

    const focusNow = () => {
      const focusTarget = initialFocusRef?.current ?? getFocusableElements(focusScope)[0] ?? focusScope;
      if (typeof focusTarget.focus !== 'function') return;
      try {
        focusTarget.focus({ preventScroll: true });
      } catch {
        focusTarget.focus();
      }
    };
    focusNow();
    const focusFrame = window.requestAnimationFrame(focusNow);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (getTopmostOverlay() !== root) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (!busyRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = getFocusableElements(focusScope);
      if (focusable.length === 0) {
        event.preventDefault();
        focusScope.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !focusScope.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !focusScope.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', handleKeyDown);
      const stackIndex = overlayStack.lastIndexOf(root);
      if (stackIndex >= 0) overlayStack.splice(stackIndex, 1);
      bodyLockCount = Math.max(0, bodyLockCount - 1);
      if (bodyLockCount === 0) {
        document.body.style.overflow = originalBodyOverflow;
      }
      inerted.forEach((node) => node.removeAttribute('inert'));
      const restoreTarget = restoreTargetRef.current;
      if (restoreTarget && document.contains(restoreTarget)) {
        try {
          restoreTarget.focus({ preventScroll: true });
        } catch {
          restoreTarget.focus();
        }
      }
    };
  }, [focusScopeRef, initialFocusRef, rootRef]);
}
