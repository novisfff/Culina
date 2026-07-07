// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceOverlayFrame } from './WorkspaceOverlayFrame';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function renderFrame(closeOnBackdrop = true) {
  const onClose = vi.fn();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <WorkspaceOverlayFrame
        rootClassName="home-dashboard-overlay-root"
        backdropClassName="custom-backdrop"
        closeOnBackdrop={closeOnBackdrop}
        onClose={onClose}
      >
        <div className="workspace-modal">内容</div>
      </WorkspaceOverlayFrame>,
    );
  });
  return { onClose, view: container };
}

describe('WorkspaceOverlayFrame', () => {
  it('keeps existing workspace overlay classes and closes from the backdrop', () => {
    const { onClose, view } = renderFrame();

    expect(view.querySelector('.workspace-overlay-root.home-dashboard-overlay-root')).not.toBeNull();
    const backdrop = view.querySelector<HTMLDivElement>('.workspace-overlay-backdrop.custom-backdrop');
    expect(backdrop).not.toBeNull();

    act(() => backdrop?.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('can keep the backdrop visible without closing', () => {
    const { onClose, view } = renderFrame(false);

    act(() => view.querySelector<HTMLDivElement>('.workspace-overlay-backdrop')?.click());
    expect(onClose).not.toHaveBeenCalled();
  });
});
