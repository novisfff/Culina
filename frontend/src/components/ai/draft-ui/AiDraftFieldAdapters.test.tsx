// @vitest-environment jsdom

import { act, useState } from 'react';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApprovalSelectField } from '../AiApprovalFields';
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
    expect(view.querySelector('.ai-draft-resource-list.is-popover')).not.toBeNull();
    expect(view.querySelector('.ai-draft-resource-list.is-inline')).toBeNull();
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
    expect(view.textContent).not.toContain('已选：鸡蛋');
    expect(view.querySelector('.ai-draft-resource-search.has-selected-resource')).not.toBeNull();
    expect(view.querySelector('.ui-search-field-clear')).toBeNull();
  });

  it('shows the compact clear action only while searching for a replacement resource', () => {
    const view = renderAdapter(
      <AiDraftResourceField
        label="选择食材"
        value="ingredient-egg"
        selectedLabel="鸡蛋"
        query="番茄"
        options={[]}
        listOpen
        onQueryChange={vi.fn()}
        onChange={vi.fn()}
      />,
    );

    expect(view.querySelector('.ai-draft-resource-search.has-selected-resource')).toBeNull();
    expect(view.querySelector<HTMLButtonElement>('.ui-search-field-clear')?.getAttribute('aria-label')).toBe('清空搜索');
  });

  it('renders Draft values as removable tags and adds normalized tags through a compact affordance', () => {
    function TagHarness() {
      const [values, setValues] = useState<string[]>(['快手晚餐', '一人食']);
      return <AiDraftTagInput label="场景标签" values={values} disabled={false} placeholder="家常菜、快手菜" onChange={setValues} />;
    }

    const view = renderAdapter(<TagHarness />);
    expect(view.querySelector('input')).toBeNull();
    expect(view.textContent).toContain('快手晚餐');
    expect(view.textContent).toContain('一人食');

    const addButton = Array.from(view.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent?.includes('添加标签'));
    act(() => addButton?.click());
    const input = view.querySelector<HTMLInputElement>('input[aria-label="添加场景标签"]');
    changeInput(input as HTMLInputElement, '周末聚餐、快手晚餐');
    act(() => input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));

    expect(view.textContent).toContain('周末聚餐');
    expect(view.querySelectorAll('[data-draft-tag="快手晚餐"]')).toHaveLength(1);

    const removeButton = view.querySelector<HTMLButtonElement>('[aria-label="删除场景标签：一人食"]');
    act(() => removeButton?.click());
    expect(view.textContent).not.toContain('一人食');
  });

  it('uses option icons in the menu and follows the selected option in the trigger', () => {
    function SelectHarness() {
      const [value, setValue] = useState('pan');
      return (
        <ApprovalSelectField
          label="步骤图标"
          value={value}
          disabled={false}
          options={[
            { value: 'pan', label: '炒锅', icon: <span data-test-icon="pan" /> },
            { value: 'timer', label: '计时', icon: <span data-test-icon="timer" /> },
          ]}
          useSelectedOptionIcon
          onChange={setValue}
        />
      );
    }

    const view = renderAdapter(<SelectHarness />);
    const trigger = view.querySelector<HTMLButtonElement>('.ui-dropdown-select-trigger');
    expect(trigger?.querySelector('[data-test-icon="pan"]')).not.toBeNull();

    act(() => trigger?.click());
    const timerOption = Array.from(view.querySelectorAll<HTMLButtonElement>('[role="option"]'))
      .find((option) => option.textContent?.includes('计时'));
    expect(timerOption?.querySelector('[data-test-icon="timer"]')).not.toBeNull();

    act(() => timerOption?.click());
    expect(trigger?.querySelector('[data-test-icon="timer"]')).not.toBeNull();
    expect(trigger?.querySelector('[data-test-icon="pan"]')).toBeNull();
  });

  it('keeps AI resource contracts typed for paged loading', async () => {
    const options: AiResourceOption[] = [{ id: 'ingredient-tomato', label: '番茄', unit: '个' }];
    const loadOptions: AiResourceOptionLoader = async (_kind, { offset }) => offset === 0 ? options : [];

    await expect(loadOptions('ingredient', { query: '', offset: 0, limit: 6 })).resolves.toEqual(options);
  });
});
