// @vitest-environment jsdom

import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog';

describe('ConfirmDialog', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  function renderDialog(element: ReactElement) {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root?.render(element);
    });
    return container;
  }

  function findButton(view: HTMLElement, label: string) {
    return Array.from(view.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === label);
  }

  it('confirms and cancels with readable labels', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const view = renderDialog(
      <ConfirmDialog
        open
        title="删除会话"
        description="删除后不可恢复。"
        confirmLabel="删除"
        cancelLabel="先保留"
        tone="danger"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    act(() => findButton(view, '删除')?.click());
    act(() => findButton(view, '先保留')?.click());
    expect(onConfirm).toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });

  it('renders nothing when closed', () => {
    const view = renderDialog(
      <ConfirmDialog
        open={false}
        title="删除"
        description="确认删除。"
        confirmLabel="删除"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(view.textContent).not.toContain('确认删除。');
  });
});
