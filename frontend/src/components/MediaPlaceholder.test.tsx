// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mediaApi } from '../api/mediaApi';
import { MediaWithPlaceholder } from './MediaPlaceholder';

vi.mock('../api/mediaApi', () => ({
  mediaApi: {
    getMediaAccess: vi.fn(),
  },
}));

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
    vi.mocked(mediaApi.getMediaAccess).mockReset();
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
    expect(container.querySelector('.media-placeholder-empty-icon')).not.toBeNull();
    expect(container.querySelector('.media-placeholder-glow')).toBeNull();
    expect(container.querySelector('.media-placeholder-spark')).toBeNull();
    expect(container.querySelector('.media-placeholder-label')?.textContent).toBe('还没有图片');
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
    expect(container.querySelector('.media-placeholder-loading-icon')).not.toBeNull();
    expect(container.querySelector('.media-placeholder-glow')).not.toBeNull();
    expect(container.querySelector('.media-placeholder-loader')).toBeNull();
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
    expect(container.querySelector('.media-placeholder-error-icon')).not.toBeNull();
    expect(container.querySelector('.media-placeholder-glow')).toBeNull();
    expect(container.querySelector('.media-placeholder-spark')).toBeNull();
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

  it('renews an expired capability before a lazy image loads', async () => {
    vi.mocked(mediaApi.getMediaAccess).mockResolvedValue({
      id: 'photo-renew',
      name: 'renew.jpg',
      url: '/api/media/photo-renew/content?variant=original&ticket=fresh&expires_at=2026-06-11T00%3A10%3A00Z',
      source: 'upload',
      alt: '续签图片',
      created_at: '2026-06-11T00:00:00Z',
    });
    container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MediaWithPlaceholder
          src="/api/media/photo-renew/content?variant=original&ticket=expired&expires_at=2020-01-01T00%3A00%3A00Z"
          alt="续签图片"
          loading="lazy"
        />
      );
      await Promise.resolve();
    });

    expect(mediaApi.getMediaAccess).toHaveBeenCalledWith('photo-renew');
    expect(container.querySelector('img')?.getAttribute('src')).toContain('ticket=fresh');
    act(() => root.unmount());
  });

  it('retries a failed capability once with a fresh signed URL', async () => {
    vi.mocked(mediaApi.getMediaAccess).mockResolvedValue({
      id: 'photo-retry',
      name: 'retry.jpg',
      url: '/api/media/photo-retry/content?variant=original&ticket=fresh&expires_at=2026-06-11T00%3A10%3A00Z',
      source: 'upload',
      alt: '重试图片',
      created_at: '2026-06-11T00:00:00Z',
    });
    container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <MediaWithPlaceholder
          src="/api/media/photo-retry/content?variant=original&ticket=stale&expires_at=2099-01-01T00%3A00%3A00Z"
          alt="重试图片"
        />
      );
    });

    await act(async () => {
      container?.querySelector('img')?.dispatchEvent(new Event('error'));
      await Promise.resolve();
    });

    expect(mediaApi.getMediaAccess).toHaveBeenCalledTimes(1);
    expect(container.querySelector('img')?.getAttribute('src')).toContain('ticket=fresh');
    expect(container.querySelector('.media-with-placeholder')?.getAttribute('data-state')).toBe('loading');
    act(() => root.unmount());
  });

  it('does not let an older renewal response replace a newer source', async () => {
    let resolveRenewal: ((asset: Awaited<ReturnType<typeof mediaApi.getMediaAccess>>) => void) | undefined;
    vi.mocked(mediaApi.getMediaAccess).mockReturnValue(
      new Promise((resolve) => {
        resolveRenewal = resolve;
      }),
    );
    container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <MediaWithPlaceholder
          src="/api/media/photo-old/content?variant=original&ticket=expired&expires_at=2020-01-01T00%3A00%3A00Z"
          alt="旧图片"
        />
      );
    });
    act(() => {
      root.render(<MediaWithPlaceholder src="/new-image.jpg" alt="新图片" />);
    });
    await act(async () => {
      resolveRenewal?.({
        id: 'photo-old',
        name: 'old.jpg',
        url: '/api/media/photo-old/content?variant=original&ticket=fresh-old&expires_at=2099-01-01T00%3A00%3A00Z',
        source: 'upload',
        alt: '旧图片',
        created_at: '2026-06-11T00:00:00Z',
      });
      await Promise.resolve();
    });

    expect(container.querySelector('img')?.getAttribute('src')).toBe('/new-image.jpg');
    act(() => root.unmount());
  });
});
