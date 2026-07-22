// @vitest-environment jsdom

import { act, useState } from 'react';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AiResourceOption, AiResourceOptionLoader } from '../AiApprovalFields';
import { AiDraftField } from './AiDraftField';
import { AiDraftResourceField } from './AiDraftResourceField';
import { AiDraftTagInput } from './AiDraftTagInput';

describe('AI Draft field adapters', () => {
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

  function renderAdapter(element: ReactElement) {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root?.render(element);
    });
    return container;
  }

  function changeInput(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  it('groups a visible label, help, required marker, and error around its control', () => {
    const view = renderAdapter(
      <AiDraftField label="食材名称" helpText="请从食材库选择" error="必须选择食材" required>
        <input aria-label="食材名称输入" />
      </AiDraftField>,
    );

    const group = view.querySelector<HTMLElement>('[role="group"]');
    expect(group?.getAttribute('aria-labelledby')).toBeTruthy();
    expect(group?.textContent).toContain('食材名称');
    expect(group?.textContent).toContain('必填');
    expect(group?.textContent).toContain('请从食材库选择');
    expect(group?.querySelector('input')).not.toBeNull();
    expect(group?.querySelector('[role="alert"]')?.textContent).toBe('必须选择食材');
  });

  it('forwards resource search, selection, and loading-more state without owning a request', () => {
    const onQueryChange = vi.fn();
    const onChange = vi.fn();
    const view = renderAdapter(
      <AiDraftResourceField
        label="选择食材"
        value=""
        query=""
        options={[{ id: 'ingredient-tomato', label: '番茄', description: '蔬菜' }]}
        loadingMore
        hasMore
        onQueryChange={onQueryChange}
        onChange={onChange}
      />,
    );

    const search = view.querySelector<HTMLInputElement>('[role="searchbox"]');
    expect(search).not.toBeNull();
    changeInput(search as HTMLInputElement, '番');
    expect(onQueryChange).toHaveBeenCalledWith('番');
    const option = view.querySelector<HTMLButtonElement>('[role="option"]');
    act(() => option?.click());
    expect(onChange).toHaveBeenCalledWith('ingredient-tomato');
    expect(view.textContent).toContain('正在加载更多...');
  });

  it('keeps the selected resource label visible before a new search begins', () => {
    const view = renderAdapter(
      <AiDraftResourceField
        label="选择食材"
        value="ingredient-egg"
        selectedLabel="鸡蛋"
        query=""
        options={[]}
        listOpen={false}
        onQueryChange={vi.fn()}
        onChange={vi.fn()}
      />,
    );

    expect(view.querySelector<HTMLInputElement>('[role="searchbox"]')?.value).toBe('鸡蛋');
  });

  it('deduplicates delimiter-separated Draft tags and renders a read-only preview', () => {
    function TagHarness() {
      const [values, setValues] = useState<string[]>([]);
      return <AiDraftTagInput label="口味标签" values={values} disabled={false} placeholder="清淡、香辣" onChange={setValues} />;
    }

    const view = renderAdapter(<TagHarness />);
    const input = view.querySelector<HTMLInputElement>('input');
    changeInput(input as HTMLInputElement, '清淡、香辣、清淡');

    expect(input?.value).toBe('清淡、香辣');
    expect(view.querySelector('[aria-label="口味标签预览"]')?.textContent).toContain('清淡');
    expect(view.querySelector('[aria-label="口味标签预览"]')?.textContent).toContain('香辣');
  });

  it('keeps AI resource contracts typed for paged loading', async () => {
    const options: AiResourceOption[] = [{ id: 'ingredient-tomato', label: '番茄', unit: '个' }];
    const loadOptions: AiResourceOptionLoader = async (_kind, { offset }) => offset === 0 ? options : [];

    await expect(loadOptions('ingredient', { query: '', offset: 0, limit: 6 })).resolves.toEqual(options);
  });
});
