// @vitest-environment jsdom

import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { StateBlock } from './StateBlock';

describe('StateBlock', () => {
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

  function renderState(element: ReactElement) {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root?.render(element);
    });
    return container;
  }

  it('renders an action for empty state recovery', () => {
    const onAction = vi.fn();
    const view = renderState(<StateBlock status="empty" title="还没有内容" description="先添加一条记录。" actionLabel="去添加" onAction={onAction} />);
    act(() => view.querySelector<HTMLButtonElement>('button')?.click());
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('uses alert role for errors', () => {
    const view = renderState(<StateBlock status="error" title="加载失败" description="请稍后重试。" />);
    expect(view.querySelector('[role="alert"]')?.textContent).toContain('加载失败');
  });

  it('marks loading state as busy', () => {
    const view = renderState(<StateBlock status="loading" title="正在加载" description="请稍候。" />);
    expect(view.querySelector('[role="status"]')?.getAttribute('aria-busy')).toBe('true');
  });
});
