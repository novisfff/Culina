// @vitest-environment jsdom

import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FormField } from './FormField';

describe('FormField', () => {
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

  function renderField(element: ReactElement) {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root?.render(element);
    });
    return container;
  }

  it('associates label, hint and error text with the control', () => {
    const view = renderField(
      <FormField label="食材名称" hint="使用家里常用叫法" error="请填写食材名称" required>
        <input />
      </FormField>,
    );

    expect(view.textContent).toContain('食材名称');
    expect(view.textContent).toContain('使用家里常用叫法');
    const error = view.querySelector('[role="alert"]');
    expect(error?.textContent).toBe('请填写食材名称');
  });
});
