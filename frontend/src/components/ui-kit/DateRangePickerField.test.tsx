// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DateRangePickerField } from './DateRangePickerField';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function renderRangePicker(mobile = false) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: mobile && query === '(max-width: 767px)',
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  const onChange = vi.fn();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(
    <DateRangePickerField
      ariaLabel="请求日期"
      startValue="2026-08-06"
      endValue=""
      onChange={onChange}
    />,
  ));
  return { onChange, trigger: container.querySelector<HTMLButtonElement>('.ui-date-range-picker-trigger') };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 7, 10, 12));
});

afterEach(() => {
  act(() => root?.unmount());
  document.querySelectorAll('.ui-date-range-picker-portal').forEach((node) => node.remove());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
});

describe('DateRangePickerField', () => {
  it('selects and confirms one coherent date range from a single control', () => {
    const { onChange, trigger } = renderRangePicker();
    act(() => trigger?.click());
    expect(document.querySelector('.ui-date-range-picker-popover[role="dialog"]')).not.toBeNull();
    act(() => document.querySelector<HTMLButtonElement>('[data-date-key="2026-08-08"]')?.click());
    act(() => document.querySelector<HTMLButtonElement>('[data-date-key="2026-08-10"]')?.click());
    act(() => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === '应用范围')?.click());
    expect(onChange).toHaveBeenCalledWith({ start: '2026-08-08', end: '2026-08-10' });
  });

  it('uses a bottom sheet on mobile and exposes clear range semantics', () => {
    const { trigger } = renderRangePicker(true);
    act(() => trigger?.click());
    expect(document.querySelector('.ui-date-range-picker-sheet[role="dialog"]')).not.toBeNull();
    expect(trigger?.getAttribute('aria-label')).toContain('请求日期');
    expect(document.body.textContent).toContain('开始日期');
    expect(document.body.textContent).toContain('结束日期');
  });

  it('offers the current month as a complete range instead of clearing a required filter', () => {
    const { onChange, trigger } = renderRangePicker();
    act(() => trigger?.click());
    act(() => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === '本月')?.click());
    act(() => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === '应用范围')?.click());
    expect(onChange).toHaveBeenCalledWith({ start: '2026-08-01', end: '2026-08-10' });
    expect(document.body.textContent).not.toContain('清除');
  });
});
