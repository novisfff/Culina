// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatePickerField } from './DatePickerField';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function setMobile(mobile: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === '(max-width: 767px)' ? mobile : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function renderDatePicker(props: Partial<React.ComponentProps<typeof DatePickerField>> = {}) {
  const onChange = vi.fn();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <DatePickerField
        ariaLabel="餐食日期"
        value="2026-07-28"
        onChange={onChange}
        {...props}
      />,
    );
  });
  return { onChange, trigger: container.querySelector<HTMLButtonElement>('.ui-date-picker-trigger') };
}

beforeEach(() => {
  setMobile(false);
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 6, 20, 12));
});

afterEach(() => {
  act(() => root?.unmount());
  document.querySelectorAll('.ui-date-picker-portal').forEach((node) => node.remove());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
});

describe('DatePickerField', () => {
  it('keeps the trailing calendar affordance inset while exposing the current date', () => {
    const { trigger } = renderDatePicker();

    expect(trigger?.textContent).toContain('2026年7月28日');
    expect(trigger?.getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger?.getAttribute('aria-label')).toContain('餐食日期');
    expect(trigger?.querySelector('.ui-date-picker-trailing-icon')).not.toBeNull();
  });

  it('opens a desktop calendar and selects a date immediately', () => {
    const { onChange, trigger } = renderDatePicker();

    act(() => trigger?.click());
    const dialog = document.querySelector<HTMLElement>('.ui-date-picker-popover[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');

    const nextDate = Array.from(dialog?.querySelectorAll<HTMLButtonElement>('.ui-date-picker-day') ?? [])
      .find((button) => button.getAttribute('data-date-key') === '2026-07-30');
    act(() => nextDate?.click());

    expect(onChange).toHaveBeenCalledWith('2026-07-30');
    expect(document.querySelector('.ui-date-picker-popover')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('only offers clearing for optional fields', () => {
    const optional = renderDatePicker({ allowClear: true });
    act(() => optional.trigger?.click());
    const clearButton = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === '清除');
    act(() => clearButton?.click());
    expect(optional.onChange).toHaveBeenCalledWith('');

    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;

    const required = renderDatePicker({ required: true, allowClear: true });
    act(() => required.trigger?.click());
    expect(Array.from(document.querySelectorAll('button')).some((button) => button.textContent === '清除')).toBe(false);
  });

  it('uses a modal bottom sheet on mobile and closes without changing the value', () => {
    setMobile(true);
    const { onChange, trigger } = renderDatePicker();

    act(() => trigger?.click());
    expect(document.querySelector('.ui-date-picker-sheet[role="dialog"]')).not.toBeNull();
    expect(document.querySelector('.ui-date-picker-backdrop')).not.toBeNull();

    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.querySelector('.ui-date-picker-sheet')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps keyboard focus inside the mobile sheet', () => {
    setMobile(true);
    const { trigger } = renderDatePicker();
    act(() => trigger?.click());

    const sheet = document.querySelector<HTMLElement>('.ui-date-picker-sheet');
    const closeButton = sheet?.querySelector<HTMLButtonElement>('.ui-date-picker-close');
    const todayButton = sheet?.querySelector<HTMLButtonElement>('.ui-date-picker-today');
    act(() => {
      todayButton?.focus();
      todayButton?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    });

    expect(document.activeElement).toBe(closeButton);
  });

  it('moves focus by keyboard and respects disabled range dates', () => {
    const { trigger } = renderDatePicker({ min: '2026-07-27', max: '2026-07-30' });
    act(() => trigger?.click());

    const selected = document.querySelector<HTMLButtonElement>('[data-date-key="2026-07-28"]');
    expect(selected?.tabIndex).toBe(0);
    expect(document.querySelector<HTMLButtonElement>('[data-date-key="2026-07-26"]')?.disabled).toBe(true);

    act(() => selected?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expect(document.activeElement?.getAttribute('data-date-key')).toBe('2026-07-29');
  });
});
