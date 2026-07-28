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

  it('shows a loading status instead of the empty state before initial options arrive', () => {
    const view = renderSelect(
      <SearchableResourceSelect
        ariaLabel="选择食材"
        placeholder="搜索已有食材"
        value=""
        query="番茄"
        loading
        hasMore
        emptyText="没有匹配项"
        onQueryChange={vi.fn()}
        onChange={vi.fn()}
        options={[]}
      />,
    );

    expect(view.textContent).toContain('正在加载候选项…');
    expect(view.textContent).not.toContain('没有匹配项');
    expect(view.textContent).not.toContain('加载更多');
  });

  it('can suppress the clear action when the visible query represents a selected resource', () => {
    const view = renderSelect(
      <SearchableResourceSelect
        ariaLabel="选择食材"
        placeholder="搜索已有食材"
        value="ingredient-1"
        query="番茄"
        options={[]}
        listOpen={false}
        showClear={false}
        onQueryChange={vi.fn()}
        onChange={vi.fn()}
      />,
    );

    expect(view.querySelector<HTMLInputElement>('[role="searchbox"]')?.value).toBe('番茄');
    expect(view.querySelector('.ui-search-field-clear')).toBeNull();
  });

  it('keeps inline initial loading compact instead of mounting an empty result list', () => {
    const view = renderSelect(
      <SearchableResourceSelect
        ariaLabel="选择食材"
        placeholder="搜索已有食材"
        value=""
        query="番茄"
        loading
        presentation="inline"
        onQueryChange={vi.fn()}
        onChange={vi.fn()}
        options={[]}
      />,
    );

    expect(view.querySelector('[role="listbox"]')).toBeNull();
    expect(view.querySelector('.ui-searchable-resource-select-loading[role="status"]')?.textContent).toBe('正在加载候选项…');
    expect(view.querySelectorAll('[role="status"]')).toHaveLength(1);
  });

  it('only reports search blur after focus leaves the whole resource control', () => {
    const onSearchBlur = vi.fn();
    const view = renderSelect(
      <>
        <SearchableResourceSelect
          ariaLabel="选择食材"
          placeholder="搜索已有食材"
          value=""
          query=""
          onQueryChange={vi.fn()}
          onChange={vi.fn()}
          onSearchBlur={onSearchBlur}
          options={[{ id: 'ingredient-1', label: '番茄' }]}
        />
        <button type="button">下一字段</button>
      </>,
    );

    const search = view.querySelector<HTMLInputElement>('[role="searchbox"]');
    const option = view.querySelector<HTMLButtonElement>('[role="option"]');
    const nextField = Array.from(view.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === '下一字段');

    act(() => {
      search?.focus();
      option?.focus();
    });
    expect(onSearchBlur).not.toHaveBeenCalled();

    act(() => nextField?.focus());
    expect(onSearchBlur).toHaveBeenCalledTimes(1);
  });

  it('reports an external pointer down while resource candidates are open', () => {
    const onSearchBlur = vi.fn();
    const view = renderSelect(
      <>
        <SearchableResourceSelect
          ariaLabel="选择食材"
          placeholder="搜索已有食材"
          value=""
          query=""
          onQueryChange={vi.fn()}
          onChange={vi.fn()}
          onSearchBlur={onSearchBlur}
          options={[{ id: 'ingredient-1', label: '番茄' }]}
        />
        <button type="button">下一字段</button>
      </>,
    );

    const nextField = Array.from(view.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === '下一字段');
    act(() => nextField?.dispatchEvent(new Event('pointerdown', { bubbles: true })));

    expect(onSearchBlur).toHaveBeenCalledTimes(1);
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
