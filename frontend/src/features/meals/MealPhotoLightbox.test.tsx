// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MediaAsset } from '../../api/types';
import { MealPhotoLightbox } from './MealLogEnrichment';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const photo: MediaAsset = {
  id: 'photo-1',
  name: '晚餐.jpg',
  url: '/media/dinner.jpg',
  source: 'upload',
  alt: '家庭晚餐',
  created_at: '2026-07-15T10:00:00Z',
};

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  document.querySelectorAll('.meal-photo-lightbox').forEach((node) => node.remove());
  root = null;
  container = null;
});

function renderLightbox(onClose = vi.fn()) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(<MealPhotoLightbox photo={photo} title="家庭晚餐" onClose={onClose} />);
  });
  return { onClose };
}

describe('MealPhotoLightbox', () => {
  it('moves initial focus to the close action and closes on Escape', async () => {
    const { onClose } = renderLightbox();

    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    });

    expect(document.activeElement).toBe(document.querySelector('.meal-photo-lightbox-close'));
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps background content inert and traps Tab inside the viewer', async () => {
    renderLightbox();
    const dialog = document.querySelector<HTMLElement>('.meal-photo-lightbox');
    const first = dialog?.querySelector<HTMLElement>('.meal-photo-lightbox-download');
    const focusable = Array.from(dialog?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]):not([tabindex="-1"])') ?? []);
    const last = focusable[focusable.length - 1];
    expect(container?.hasAttribute('inert')).toBe(true);
    expect(first).not.toBeNull();
    expect(last).not.toBeNull();

    act(() => last?.focus());
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(first);

    act(() => first?.focus());
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }));
    });
    expect(document.activeElement).toBe(last);
  });

  it('restores focus to the opener after closing', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" id="open-lightbox" onClick={() => setOpen(true)}>查看照片</button>
          {open ? <MealPhotoLightbox photo={photo} title="家庭晚餐" onClose={() => setOpen(false)} /> : null}
        </>
      );
    }

    act(() => root?.render(<Harness />));
    const opener = document.querySelector<HTMLButtonElement>('#open-lightbox');
    act(() => opener?.focus());
    act(() => opener?.click());
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    });
    act(() => document.querySelector<HTMLButtonElement>('.meal-photo-lightbox-close')?.click());
    expect(document.activeElement).toBe(opener);
  });
});
