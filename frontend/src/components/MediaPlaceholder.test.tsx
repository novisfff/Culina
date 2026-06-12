// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MediaWithPlaceholder } from './MediaPlaceholder';

describe('MediaWithPlaceholder', () => {
  let container: HTMLDivElement | null = null;
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  });

  afterEach(() => {
    container?.remove();
    container = null;
  });

  it('keeps the placeholder visible when the image URL fails', () => {
    container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    act(() => {
      root.render(<MediaWithPlaceholder src="/missing-image.jpg" alt="测试菜品" />);
    });

    expect(container.querySelector('.media-placeholder svg')).not.toBeNull();
    const image = container.querySelector('img');
    expect(image).not.toBeNull();

    act(() => {
      image?.dispatchEvent(new Event('error'));
    });

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.media-placeholder svg')).not.toBeNull();

    act(() => root.unmount());
  });

  it('removes the placeholder after the image loads', () => {
    container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    act(() => {
      root.render(<MediaWithPlaceholder src="/loaded-image.jpg" alt="测试菜品" />);
    });

    const image = container.querySelector('img');
    expect(image).not.toBeNull();
    expect(container.querySelector('.media-placeholder')).not.toBeNull();

    act(() => {
      image?.dispatchEvent(new Event('load'));
    });

    expect(container.querySelector('img')).not.toBeNull();
    expect(container.querySelector('.media-placeholder')).toBeNull();

    act(() => root.unmount());
  });
});
