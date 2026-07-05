// @vitest-environment jsdom

import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ResourcePickerField } from './ResourcePickerField';

describe('ResourcePickerField', () => {
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

  function renderPicker(element: ReactElement) {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root?.render(element);
    });
    return container;
  }

  it('requires selecting an existing resource id', () => {
    const onChange = vi.fn();
    const view = renderPicker(
      <ResourcePickerField
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
});
