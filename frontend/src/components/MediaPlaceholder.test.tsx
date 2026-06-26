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

  it('shows an empty image state when no image URL is available', () => {
    container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    act(() => {
      root.render(<MediaWithPlaceholder src={undefined} alt="测试菜品" />);
    });

    expect(container.querySelector('.media-with-placeholder')?.getAttribute('data-state')).toBe('empty');
    expect(container.querySelector('.media-placeholder.state-empty')).not.toBeNull();
    expect(container.querySelector('.media-placeholder-label')?.textContent).toBe('暂无图片');
    expect(container.querySelector('img')).toBeNull();

    act(() => root.unmount());
  });

  it('shows a loading state while the image URL is pending', () => {
    container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    act(() => {
      root.render(<MediaWithPlaceholder src="/loading-image.jpg" alt="测试菜品" />);
    });

    expect(container.querySelector('.media-with-placeholder')?.getAttribute('data-state')).toBe('loading');
    expect(container.querySelector('.media-placeholder.state-loading')).not.toBeNull();
    expect(container.querySelector('.media-placeholder-loader')).not.toBeNull();
    expect(container.querySelector('.media-placeholder-label')?.textContent).toBe('图片加载中');
    expect(container.querySelector('img')).not.toBeNull();

    act(() => root.unmount());
  });

  it('keeps an error state visible when the image URL fails', () => {
    container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    act(() => {
      root.render(<MediaWithPlaceholder src="/missing-image.jpg" alt="测试菜品" errorLabel="加载失败" />);
    });

    const image = container.querySelector('img');
    expect(image).not.toBeNull();

    act(() => {
      image?.dispatchEvent(new Event('error'));
    });

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.media-with-placeholder')?.getAttribute('data-state')).toBe('error');
    expect(container.querySelector('.media-placeholder.state-error svg')).not.toBeNull();
    expect(container.querySelector('.media-placeholder-label')?.textContent).toBe('加载失败');

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
    expect(container.querySelector('.media-with-placeholder')?.getAttribute('data-state')).toBe('loading');
    expect(container.querySelector('.media-placeholder.state-loading')).not.toBeNull();

    act(() => {
      image?.dispatchEvent(new Event('load'));
    });

    expect(container.querySelector('.media-with-placeholder')?.getAttribute('data-state')).toBe('loaded');
    expect(container.querySelector('img')).not.toBeNull();
    expect(container.querySelector('.media-placeholder')).toBeNull();

    act(() => root.unmount());
  });
});
