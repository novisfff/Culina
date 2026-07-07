// @vitest-environment jsdom

import { act } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ComboboxField } from './ComboboxField';

describe('ComboboxField', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  const options = [
    { value: '冷藏', label: '冷藏', description: '冰箱冷藏层' },
    { value: '常温', label: '常温' },
  ];

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

  function renderCombobox(element: ReactElement) {
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

  function findOption(view: HTMLElement, text: string) {
    return Array.from(view.querySelectorAll<HTMLButtonElement>('[role="option"]')).find((option) => option.textContent?.includes(text));
  }

  it('filters options and selects a preset', () => {
    const onChange = vi.fn();
    const view = renderCombobox(<ComboboxField ariaLabel="保存位置" value="" options={options} onChange={onChange} placeholder="选择保存位置" />);
    const input = view.querySelector<HTMLInputElement>('input[role="combobox"]')!;

    act(() => input.focus());
    const listbox = view.querySelector<HTMLElement>('[role="listbox"]');
    expect(input.getAttribute('aria-controls')).toBe(listbox?.id);

    changeInput(input, '冷');
    act(() => findOption(view, '冷藏')?.click());

    expect(onChange).toHaveBeenCalledWith('冷藏');
  });

  it('allows custom values when enabled', () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn((event: FormEvent<HTMLFormElement>) => event.preventDefault());
    const view = renderCombobox(
      <form onSubmit={onSubmit}>
        <ComboboxField ariaLabel="单位" value="" options={[{ value: '个', label: '个' }]} allowCustom onChange={onChange} placeholder="输入单位" />
      </form>,
    );
    const input = view.querySelector<HTMLInputElement>('input[role="combobox"]')!;

    changeInput(input, '袋');
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));

    expect(onChange).toHaveBeenCalledWith('袋');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('closes options when clicking outside the field container', () => {
    const onChange = vi.fn();
    const view = renderCombobox(<ComboboxField ariaLabel="单位" value="" options={[{ value: '个', label: '个' }]} onChange={onChange} placeholder="输入单位" />);
    const input = view.querySelector<HTMLInputElement>('input[role="combobox"]')!;

    act(() => input.focus());
    expect(view.querySelector('[role="listbox"]')).not.toBeNull();

    act(() => {
      document.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    expect(view.querySelector('[role="listbox"]')).toBeNull();
  });
});
