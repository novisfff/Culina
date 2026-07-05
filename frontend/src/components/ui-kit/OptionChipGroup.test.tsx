// @vitest-environment jsdom

import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { OptionChipGroup } from './OptionChipGroup';

describe('OptionChipGroup', () => {
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

  function renderGroup(element: ReactElement) {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root?.render(element);
    });
    return container;
  }

  it('changes a single selected chip', () => {
    const onChange = vi.fn();
    const view = renderGroup(
      <OptionChipGroup
        ariaLabel="库存筛选"
        value="all"
        options={[{ value: 'all', label: '全部' }, { value: 'low', label: '低库存' }]}
        onChange={onChange}
      />,
    );

    const low = Array.from(view.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find((button) => button.textContent === '低库存');
    act(() => low?.click());
    expect(onChange).toHaveBeenCalledWith('low');
  });
});
