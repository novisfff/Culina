import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDebouncedSearchValue, useDebouncedValue } from './useDebouncedValue';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function Probe({ value, delayMs, onValue }: { value: string; delayMs: number; onValue: (value: string) => void }) {
  const debouncedValue = useDebouncedValue(value, delayMs);

  useEffect(() => {
    onValue(debouncedValue);
  }, [debouncedValue, onValue]);

  return <span>{debouncedValue}</span>;
}

function SearchProbe({
  value,
  isComposing,
  onValue,
}: {
  value: string;
  isComposing: boolean;
  onValue: (value: string) => void;
}) {
  const debouncedValue = useDebouncedSearchValue(value, { isComposing });

  useEffect(() => {
    onValue(debouncedValue);
  }, [debouncedValue, onValue]);

  return <span>{debouncedValue}</span>;
}

function renderProbe(value: string, onValue: (value: string) => void, delayMs = 300) {
  act(() => {
    root?.render(<Probe value={value} delayMs={delayMs} onValue={onValue} />);
  });
}

function renderSearchProbe(value: string, isComposing: boolean, onValue: (value: string) => void) {
  act(() => {
    root?.render(<SearchProbe value={value} isComposing={isComposing} onValue={onValue} />);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useDebouncedValue', () => {
  it('keeps the previous value until the delay passes', () => {
    const values: string[] = [];
    const recordValue = (value: string) => values.push(value);

    renderProbe('番茄', recordValue);
    expect(container?.textContent).toBe('番茄');

    renderProbe('西红柿', recordValue);
    expect(container?.textContent).toBe('番茄');

    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(container?.textContent).toBe('番茄');

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(container?.textContent).toBe('西红柿');
    expect(values).toEqual(['番茄', '西红柿']);
  });

  it('only publishes the latest value during rapid changes', () => {
    const values: string[] = [];
    const recordValue = (value: string) => values.push(value);

    renderProbe('番茄', recordValue);
    renderProbe('西红柿', recordValue);

    act(() => {
      vi.advanceTimersByTime(150);
    });
    renderProbe('小番茄', recordValue);

    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(container?.textContent).toBe('番茄');

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(container?.textContent).toBe('小番茄');
    expect(values).toEqual(['番茄', '小番茄']);
  });

  it('clears pending timers on unmount', () => {
    const values: string[] = [];
    const recordValue = (value: string) => values.push(value);

    renderProbe('番茄', recordValue);
    renderProbe('西红柿', recordValue);

    act(() => {
      root?.unmount();
    });

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(values).toEqual(['番茄']);
  });

  it('does not publish search query values while an IME composition is active', () => {
    const values: string[] = [];
    const recordValue = (value: string) => values.push(value);

    renderSearchProbe('', false, recordValue);
    renderSearchProbe('fan', true, recordValue);

    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(container?.textContent).toBe('');
    expect(values).toEqual(['']);

    renderSearchProbe('番茄', false, recordValue);
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(container?.textContent).toBe('');

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(container?.textContent).toBe('番茄');
    expect(values).toEqual(['', '番茄']);
  });
});
