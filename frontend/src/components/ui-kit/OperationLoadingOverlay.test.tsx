// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { OperationLoadingOverlay } from './OperationLoadingOverlay';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function renderOverlay(active: boolean) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <OperationLoadingOverlay
        active={active}
        title="正在保存"
        description="完成前请不要重复操作。"
      />,
    );
  });
  return container;
}

describe('OperationLoadingOverlay', () => {
  it('renders an accessible busy status only while active', () => {
    const view = renderOverlay(true);
    const overlay = view.querySelector('.ui-operation-loading-overlay');

    expect(overlay?.getAttribute('role')).toBe('status');
    expect(overlay?.getAttribute('aria-live')).toBe('polite');
    expect(overlay?.getAttribute('aria-busy')).toBe('true');
    expect(overlay?.textContent).toContain('正在保存');
    expect(overlay?.querySelector('.ui-operation-loading-spinner')).not.toBeNull();
  });

  it('renders nothing while inactive', () => {
    expect(renderOverlay(false).textContent).toBe('');
  });
});
