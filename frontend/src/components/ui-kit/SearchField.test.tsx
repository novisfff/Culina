// @vitest-environment jsdom

import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SearchField } from './SearchField';

describe('SearchField', () => {
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

  function renderSearch(element: ReactElement) {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root?.render(element);
    });
    return container;
  }

  it('emits changes and clears the value', () => {
    const onChange = vi.fn();
    const onClear = vi.fn();
    const view = renderSearch(
      <SearchField
        ariaLabel="搜索食材"
        placeholder="搜索食材"
        value="番茄"
        onChange={onChange}
        onClear={onClear}
      />,
    );

    const input = view.querySelector<HTMLInputElement>('input[role="searchbox"]');
    act(() => {
      if (!input) return;
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      valueSetter?.call(input, '鸡蛋');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => view.querySelector<HTMLButtonElement>('button[aria-label="清空搜索"]')?.click());

    expect(onChange).toHaveBeenCalledWith('鸡蛋');
    expect(onClear).toHaveBeenCalled();
    expect(view.querySelector('button[aria-label="清空搜索"] > span')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('shows loading status while searching', () => {
    const view = renderSearch(
      <SearchField
        ariaLabel="搜索"
        placeholder="搜索"
        value="面条"
        loading
        onChange={vi.fn()}
      />,
    );

    expect(view.querySelector('[aria-label="正在检索"]')).not.toBeNull();
  });
});
