// @vitest-environment jsdom

import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FormActions } from './FormActions';

describe('FormActions', () => {
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

  function renderActions(element: ReactElement) {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root?.render(element);
    });
    return container;
  }

  it('renders secondary before primary and exposes disabled reason', () => {
    const view = renderActions(
      <FormActions
        primaryLabel="保存"
        secondaryLabel="取消"
        primaryDisabled
        primaryDisabledReason="请先选择食材"
        onPrimary={vi.fn()}
        onSecondary={vi.fn()}
      />,
    );

    expect(view.textContent).toContain('请先选择食材');
    const buttons = Array.from(view.querySelectorAll<HTMLButtonElement>('button'));
    expect(buttons.map((button) => button.textContent)).toEqual(['取消', '保存']);
    expect(buttons[1].disabled).toBe(true);
  });

  it('calls the primary action', () => {
    const onPrimary = vi.fn();
    const view = renderActions(<FormActions primaryLabel="确认" onPrimary={onPrimary} />);
    act(() => view.querySelector<HTMLButtonElement>('button')?.click());
    expect(onPrimary).toHaveBeenCalled();
  });

  it('renders extra actions before the primary action', () => {
    const view = renderActions(
      <FormActions primaryLabel="下一步">
        <button type="button">上一步</button>
        <button type="button">跳过此步</button>
      </FormActions>,
    );

    const buttons = Array.from(view.querySelectorAll<HTMLButtonElement>('button'));
    expect(buttons.map((button) => button.textContent)).toEqual(['上一步', '跳过此步', '下一步']);
  });
});
