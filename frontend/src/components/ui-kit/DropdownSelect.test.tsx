// @vitest-environment jsdom

import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DropdownSelect } from './DropdownSelect';

describe('DropdownSelect', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  const options = [
    { value: 'breakfast', label: '早餐' },
    { value: 'lunch', label: '午餐' },
  ] as const;

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

  function renderDropdown(element: ReactElement) {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root?.render(element);
    });
    return container;
  }

  function findButtonByText(text: string) {
    return Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === text);
  }

  it('opens the listbox and emits the selected value', () => {
    const onChange = vi.fn();
    renderDropdown(
      <DropdownSelect
        ariaLabel="选择餐别"
        labelPrefix="餐别"
        placeholder="选择餐别"
        value="breakfast"
        options={options}
        onChange={onChange}
      />
    );

    act(() => findButtonByText('餐别: 早餐')?.click());
    expect(document.querySelector('[role="listbox"]')?.getAttribute('aria-label')).toBe('选择餐别');

    act(() => findButtonByText('午餐')?.click());
    expect(onChange).toHaveBeenCalledWith('lunch');
  });

  it('supports a clear option', () => {
    const onChange = vi.fn();
    renderDropdown(
      <DropdownSelect
        ariaLabel="筛选成员"
        labelPrefix="成员"
        placeholder="全部成员"
        value="user-1"
        options={[{ value: 'user-1', label: '妈妈' }]}
        clearOption={{ value: '', label: '全部成员' }}
        onChange={onChange}
      />
    );

    act(() => findButtonByText('成员: 妈妈')?.click());
    act(() => findButtonByText('全部成员')?.click());
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('closes with Escape without changing the value', () => {
    const onChange = vi.fn();
    renderDropdown(
      <DropdownSelect
        ariaLabel="选择餐别"
        placeholder="选择餐别"
        value="breakfast"
        options={options}
        onChange={onChange}
      />
    );

    act(() => findButtonByText('早餐')?.click());
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));

    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('renders trigger and option icons with stable wrapper classes', () => {
    renderDropdown(
      <DropdownSelect
        ariaLabel="选择难度"
        labelPrefix="难度"
        placeholder="难度"
        value="easy"
        options={[
          { value: 'easy', label: '简单', icon: <span data-testid="easy-option-icon">E</span> },
          { value: 'hard', label: '复杂', icon: <span data-testid="hard-option-icon">H</span> },
        ]}
        leadingIcon={<span data-testid="trigger-icon">T</span>}
        onChange={vi.fn()}
      />
    );

    const trigger = findButtonByText('T难度: 简单');
    expect(trigger?.querySelector('.ui-dropdown-select-leading-icon [data-testid="trigger-icon"]')).not.toBeNull();

    act(() => trigger?.click());

    const optionIcon = document.querySelector('[data-testid="hard-option-icon"]');
    expect(optionIcon?.closest('.ui-dropdown-select-option-icon')).not.toBeNull();
  });
});
