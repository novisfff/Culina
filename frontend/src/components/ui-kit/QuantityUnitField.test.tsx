// @vitest-environment jsdom

import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { QuantityUnitField } from './QuantityUnitField';

describe('QuantityUnitField', () => {
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

  function renderField(element: ReactElement) {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root?.render(element);
    });
    return container;
  }

  function changeInput(input: HTMLInputElement, value: string) {
    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      valueSetter?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  function findButton(view: HTMLElement, label: string) {
    return Array.from(view.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === label);
  }

  it('edits quantity and unit', () => {
    const onQuantityChange = vi.fn();
    const onUnitChange = vi.fn();
    const view = renderField(
      <QuantityUnitField
        quantity="2"
        unit="个"
        unitOptions={[{ value: '个', label: '个' }, { value: '斤', label: '斤' }]}
        onQuantityChange={onQuantityChange}
        onUnitChange={onUnitChange}
      />,
    );

    changeInput(view.querySelector<HTMLInputElement>('input[aria-label="数量"]')!, '3');
    act(() => findButton(view, '个')?.click());
    act(() => findButton(view, '斤')?.click());

    expect(onQuantityChange).toHaveBeenCalledWith('3');
    expect(onUnitChange).toHaveBeenCalledWith('斤');
  });

  it('explains presence-only quantity mode', () => {
    const view = renderField(
      <QuantityUnitField
        quantity=""
        unit="份"
        quantityDisabled
        quantityDisabledReason="这个食材只记录是否需要补充"
        unitOptions={[{ value: '份', label: '份' }]}
        onQuantityChange={vi.fn()}
        onUnitChange={vi.fn()}
      />,
    );

    expect(view.textContent).toContain('这个食材只记录是否需要补充');
    expect(view.querySelector<HTMLInputElement>('input[aria-label="数量"]')?.disabled).toBe(true);
  });

  it('supports a domain-specific quantity step hint', () => {
    const view = renderField(
      <QuantityUnitField
        quantity="1"
        unit="份"
        quantityStep="0.1"
        unitOptions={[{ value: '份', label: '份' }]}
        onQuantityChange={vi.fn()}
        onUnitChange={vi.fn()}
      />,
    );

    expect(view.querySelector<HTMLInputElement>('input[aria-label="数量"]')?.step).toBe('0.1');
  });
});
