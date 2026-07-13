// @vitest-environment jsdom

import { act, createRef, type RefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceModal } from './WorkspaceOverlay';
import { WorkspaceOverlayFrame } from './WorkspaceOverlayFrame';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  // jsdom does not implement matchMedia by default.
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('max-width: 767px'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function renderOverlay(options: {
  closeOnBackdrop?: boolean;
  busy?: boolean;
  labelledBy?: string;
  titleId?: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
  restoreFocusTo?: HTMLElement | null;
  backgroundButton?: boolean;
} = {}) {
  const onClose = vi.fn();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);

  const titleId = options.titleId ?? 'overlay-title';
  const initialFocusRef = options.initialFocusRef;

  act(() => {
    root?.render(
      <>
        {options.backgroundButton ? (
          <button type="button" id="background-action">
            背景按钮
          </button>
        ) : null}
        <WorkspaceOverlayFrame
          rootClassName="home-dashboard-overlay-root"
          backdropClassName="custom-backdrop"
          closeOnBackdrop={options.closeOnBackdrop}
          busy={options.busy}
          labelledBy={options.labelledBy ?? titleId}
          initialFocusRef={initialFocusRef as RefObject<HTMLElement> | undefined}
          restoreFocusTo={options.restoreFocusTo}
          onClose={onClose}
        >
          <WorkspaceModal
            title="盘点弹窗"
            titleId={titleId}
            description="测试描述"
            closeLabel="关闭"
            closeAriaLabel="关闭弹窗"
            onClose={onClose}
            busy={options.busy}
          >
            <button type="button" id="inside-action">
              弹窗内按钮
            </button>
            <p className="inventory-maintenance-live" aria-live="polite">
              错误提示
            </p>
          </WorkspaceModal>
        </WorkspaceOverlayFrame>
      </>,
    );
  });

  return { onClose, view: container };
}

describe('WorkspaceOverlayFrame', () => {
  it('keeps existing workspace overlay classes and closes from the backdrop', () => {
    const { onClose, view } = renderOverlay();

    expect(view.querySelector('.workspace-overlay-root.home-dashboard-overlay-root')).not.toBeNull();
    const backdrop = view.querySelector<HTMLDivElement>('.workspace-overlay-backdrop.custom-backdrop');
    expect(backdrop).not.toBeNull();

    act(() => backdrop?.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('can keep the backdrop visible without closing', () => {
    const { onClose, view } = renderOverlay({ closeOnBackdrop: false });

    act(() => view.querySelector<HTMLDivElement>('.workspace-overlay-backdrop')?.click());
    expect(onClose).not.toHaveBeenCalled();
  });

  it('exposes dialog semantics on the panel', () => {
    const { view } = renderOverlay({ labelledBy: 'overlay-title' });

    const panel = view.querySelector<HTMLElement>('.workspace-overlay-panel');
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute('role')).toBe('dialog');
    expect(panel?.getAttribute('aria-modal')).toBe('true');
    expect(panel?.getAttribute('aria-labelledby')).toBe('overlay-title');
    expect(view.querySelector('#overlay-title')?.textContent).toContain('盘点弹窗');
  });

  it('moves initial focus into the dialog and restores focus on unmount', async () => {
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.textContent = '打开';
    document.body.append(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const initialFocusRef = createRef<HTMLElement>();
    const { view } = renderOverlay({
      initialFocusRef,
      restoreFocusTo: trigger,
    });

    const inside = view.querySelector<HTMLButtonElement>('#inside-action');
    expect(inside).not.toBeNull();
    // Flush rAF focus scheduling used by the frame.
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    });
    // When no explicit ref target is set, focus the first focusable control in the panel.
    const panel = view.querySelector('.workspace-overlay-panel');
    expect(
      document.activeElement === inside ||
        document.activeElement === panel ||
        Boolean(panel?.contains(document.activeElement)),
    ).toBe(true);

    act(() => root?.unmount());
    root = null;
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('closes on Escape unless busy', () => {
    const idle = renderOverlay();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(idle.onClose).toHaveBeenCalledTimes(1);

    act(() => root?.unmount());
    container?.remove();
    const busy = renderOverlay({ busy: true });
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(busy.onClose).not.toHaveBeenCalled();
  });

  it('closes only the topmost nested overlay on Escape', () => {
    const outerOnClose = vi.fn();
    const innerOnClose = vi.fn();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <WorkspaceOverlayFrame labelledBy="outer-title" onClose={outerOnClose}>
          <WorkspaceModal
            title="外层弹窗"
            titleId="outer-title"
            description="外层"
            closeLabel="关闭外层"
            closeAriaLabel="关闭外层弹窗"
            onClose={outerOnClose}
          >
            <button type="button" id="outer-action">
              外层按钮
            </button>
            <WorkspaceOverlayFrame labelledBy="inner-title" onClose={innerOnClose}>
              <WorkspaceModal
                title="内层弹窗"
                titleId="inner-title"
                description="内层"
                closeLabel="关闭内层"
                closeAriaLabel="关闭内层弹窗"
                onClose={innerOnClose}
              >
                <button type="button" id="inner-action">
                  内层按钮
                </button>
              </WorkspaceModal>
            </WorkspaceOverlayFrame>
          </WorkspaceModal>
        </WorkspaceOverlayFrame>,
      );
    });

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(innerOnClose).toHaveBeenCalledTimes(1);
    expect(outerOnClose).not.toHaveBeenCalled();

    // Simulate the parent closing the inner overlay after the first Escape.
    act(() => {
      root?.render(
        <WorkspaceOverlayFrame labelledBy="outer-title" onClose={outerOnClose}>
          <WorkspaceModal
            title="外层弹窗"
            titleId="outer-title"
            description="外层"
            closeLabel="关闭外层"
            closeAriaLabel="关闭外层弹窗"
            onClose={outerOnClose}
          >
            <button type="button" id="outer-action">
              外层按钮
            </button>
          </WorkspaceModal>
        </WorkspaceOverlayFrame>,
      );
    });

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(outerOnClose).toHaveBeenCalledTimes(1);
    expect(innerOnClose).toHaveBeenCalledTimes(1);
  });

  it('blocks Escape when the topmost nested overlay is busy', () => {
    const outerOnClose = vi.fn();
    const innerOnClose = vi.fn();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <WorkspaceOverlayFrame labelledBy="outer-title" onClose={outerOnClose}>
          <WorkspaceModal
            title="外层弹窗"
            titleId="outer-title"
            description="外层"
            closeLabel="关闭外层"
            closeAriaLabel="关闭外层弹窗"
            onClose={outerOnClose}
          >
            <WorkspaceOverlayFrame labelledBy="inner-title" onClose={innerOnClose} busy>
              <WorkspaceModal
                title="内层弹窗"
                titleId="inner-title"
                description="内层"
                closeLabel="关闭内层"
                closeAriaLabel="关闭内层弹窗"
                onClose={innerOnClose}
                busy
              >
                <button type="button" id="inner-action">
                  内层按钮
                </button>
              </WorkspaceModal>
            </WorkspaceOverlayFrame>
          </WorkspaceModal>
        </WorkspaceOverlayFrame>,
      );
    });

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(innerOnClose).not.toHaveBeenCalled();
    expect(outerOnClose).not.toHaveBeenCalled();
  });

  it('prevents backdrop close and drag close while busy', () => {
    const { onClose, view } = renderOverlay({ busy: true });

    act(() => view.querySelector<HTMLDivElement>('.workspace-overlay-backdrop')?.click());
    expect(onClose).not.toHaveBeenCalled();

    const dragZone = view.querySelector<HTMLDivElement>('.workspace-overlay-drag-zone');
    expect(dragZone).not.toBeNull();
    const makePointerEvent = (type: string, clientY: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true }) as Event & {
        pointerId: number;
        clientY: number;
      };
      Object.defineProperty(event, 'pointerId', { value: 1 });
      Object.defineProperty(event, 'clientY', { value: clientY });
      return event;
    };
    act(() => {
      dragZone?.dispatchEvent(makePointerEvent('pointerdown', 10));
      window.dispatchEvent(makePointerEvent('pointerup', 240));
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps background content out of normal tab order while open', () => {
    const { view } = renderOverlay({ backgroundButton: true });
    const background = view.querySelector<HTMLButtonElement>('#background-action');
    const panel = view.querySelector<HTMLElement>('.workspace-overlay-panel');
    expect(background).not.toBeNull();
    expect(panel).not.toBeNull();

    // Assert real inert/non-tabbable background — not merely aria-modal on the panel.
    const backgroundOrAncestorInert =
      background?.hasAttribute('inert') === true || background?.closest('[inert]') != null;
    expect(backgroundOrAncestorInert).toBe(true);
    // aria-modal alone is insufficient proof of tab-order isolation.
    expect(panel?.getAttribute('aria-modal')).toBe('true');
  });

  it('does not re-steal focus when re-rendered with a new onClose identity', async () => {
    const firstOnClose = vi.fn();
    const secondOnClose = vi.fn();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <WorkspaceOverlayFrame labelledBy="overlay-title" onClose={firstOnClose}>
          <WorkspaceModal
            title="盘点弹窗"
            titleId="overlay-title"
            description="测试描述"
            closeLabel="关闭"
            closeAriaLabel="关闭弹窗"
            onClose={firstOnClose}
          >
            <button type="button" id="inside-action">
              弹窗内按钮
            </button>
            <input id="draft-input" type="text" defaultValue="草稿" />
          </WorkspaceModal>
        </WorkspaceOverlayFrame>,
      );
    });

    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    });

    const draftInput = container.querySelector<HTMLInputElement>('#draft-input');
    expect(draftInput).not.toBeNull();
    act(() => {
      draftInput?.focus();
    });
    expect(document.activeElement).toBe(draftInput);

    // Parent re-render with a fresh onClose identity must not re-run mount focus logic.
    act(() => {
      root?.render(
        <WorkspaceOverlayFrame labelledBy="overlay-title" onClose={secondOnClose}>
          <WorkspaceModal
            title="盘点弹窗"
            titleId="overlay-title"
            description="测试描述"
            closeLabel="关闭"
            closeAriaLabel="关闭弹窗"
            onClose={secondOnClose}
          >
            <button type="button" id="inside-action">
              弹窗内按钮
            </button>
            <input id="draft-input" type="text" defaultValue="草稿" />
          </WorkspaceModal>
        </WorkspaceOverlayFrame>,
      );
    });

    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    });

    expect(document.activeElement).toBe(container.querySelector('#draft-input'));

    // Latest onClose must still be used for Escape.
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(firstOnClose).not.toHaveBeenCalled();
    expect(secondOnClose).toHaveBeenCalledTimes(1);
  });

  it('exposes aria-live region content used by inventory dialogs', () => {
    const { view } = renderOverlay();
    const live = view.querySelector('[aria-live="polite"]');
    expect(live).not.toBeNull();
    expect(live?.textContent).toContain('错误提示');
  });
});
