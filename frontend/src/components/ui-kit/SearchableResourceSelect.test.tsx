// @vitest-environment jsdom

import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SearchableResourceSelect } from './SearchableResourceSelect';

describe('SearchableResourceSelect', () => {
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

  function renderSelect(element: ReactElement) {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root?.render(element);
    });
    return container;
  }

  it('selects an existing resource id from the unified option row', () => {
    const onChange = vi.fn();
    const view = renderSelect(
      <SearchableResourceSelect
        ariaLabel="选择食材"
        placeholder="搜索已有食材"
        value=""
        query=""
        onQueryChange={vi.fn()}
        onChange={onChange}
        options={[{ id: 'ingredient-1', label: '番茄', description: '蔬菜 · 默认 个' }]}
      />,
    );

    const option = Array.from(view.querySelectorAll<HTMLButtonElement>('[role="option"]')).find((button) => button.textContent?.includes('番茄'));
    act(() => option?.click());
    expect(onChange).toHaveBeenCalledWith('ingredient-1');
  });

  it('wraps option media and copy in stable ui-kit slots', () => {
    const view = renderSelect(
      <SearchableResourceSelect
        ariaLabel="选择食材"
        placeholder="搜索已有食材"
        value=""
        query=""
        onQueryChange={vi.fn()}
        onChange={vi.fn()}
        options={[{
          id: 'ingredient-1',
          label: '番茄',
          description: '蔬菜 · 默认 个',
          image: <span data-testid="tomato-thumb" />,
        }]}
      />,
    );

    expect(view.querySelector('.ui-searchable-resource-select')).not.toBeNull();
    expect(view.querySelector('.ui-searchable-resource-select-option-media [data-testid="tomato-thumb"]')).not.toBeNull();
    expect(view.querySelector('.ui-searchable-resource-select-option-copy strong')?.textContent).toBe('番茄');
    expect(view.querySelector('.ui-searchable-resource-select-option-copy small')?.textContent).toBe('蔬菜 · 默认 个');
  });

  it('can render only the resource list when search is controlled by an external input', () => {
    const onChange = vi.fn();
    const view = renderSelect(
      <SearchableResourceSelect
        ariaLabel="选择食材"
        placeholder="搜索已有食材"
        value=""
        query="番茄"
        showSearch={false}
        onQueryChange={vi.fn()}
        onChange={onChange}
        options={[{ id: 'ingredient-1', label: '番茄' }]}
      />,
    );

    expect(view.querySelector('[role="searchbox"]')).toBeNull();
    const option = view.querySelector<HTMLButtonElement>('[role="option"]');
    act(() => option?.click());
    expect(onChange).toHaveBeenCalledWith('ingredient-1');
  });

  it('marks the list as a popover when the resource selector is used as a dropdown', () => {
    const view = renderSelect(
      <SearchableResourceSelect
        ariaLabel="选择食材"
        placeholder="搜索已有食材"
        value=""
        query=""
        presentation="popover"
        onQueryChange={vi.fn()}
        onChange={vi.fn()}
        options={[{ id: 'ingredient-1', label: '番茄' }]}
      />,
    );

    expect(view.querySelector('.ui-searchable-resource-select-list')?.classList.contains('is-popover')).toBe(true);
  });

  it('can keep the search input mounted while the popover list is closed', () => {
    const view = renderSelect(
      <SearchableResourceSelect
        ariaLabel="选择食材"
        placeholder="搜索已有食材"
        value=""
        query="番茄"
        presentation="popover"
        listOpen={false}
        onQueryChange={vi.fn()}
        onChange={vi.fn()}
        options={[{ id: 'ingredient-1', label: '番茄' }]}
      />,
    );

    expect(view.querySelector('[role="searchbox"]')).not.toBeNull();
    expect(view.querySelector('.ui-searchable-resource-select-list')).toBeNull();
  });

  it('requests more options when the list is scrolled near the bottom', () => {
    const onLoadMore = vi.fn();
    const view = renderSelect(
      <SearchableResourceSelect
        ariaLabel="选择食材"
        placeholder="搜索已有食材"
        value=""
        query=""
        hasMore
        onLoadMore={onLoadMore}
        onQueryChange={vi.fn()}
        onChange={vi.fn()}
        options={[{ id: 'ingredient-1', label: '番茄' }]}
      />,
    );

    const list = view.querySelector<HTMLDivElement>('.ui-searchable-resource-select-list');
    expect(list).not.toBeNull();
    Object.defineProperty(list, 'scrollHeight', { value: 100, configurable: true });
    Object.defineProperty(list, 'clientHeight', { value: 50, configurable: true });
    Object.defineProperty(list, 'scrollTop', { value: 46, configurable: true });

    act(() => {
      list?.dispatchEvent(new Event('scroll', { bubbles: true }));
    });

    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });
});
