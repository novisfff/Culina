// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StarRatingInput } from './StarRatingInput';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function renderRating(value: string, onChange = vi.fn(), disabled = false) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(<StarRatingInput value={value} onChange={onChange} disabled={disabled} />);
  });
  return {
    onChange,
    slider: container.querySelector<HTMLElement>('.ui-star-rating-stars'),
  };
}

describe('StarRatingInput', () => {
  it('bounds persisted rating values before exposing slider state', () => {
    const highRating = renderRating('9').slider;

    expect(highRating?.getAttribute('aria-valuenow')).toBe('5');
    expect(highRating?.getAttribute('aria-valuetext')).toBe('5 分');
    expect(highRating?.style.getPropertyValue('--rating-width')).toBe('100%');

    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;

    const lowRating = renderRating('-2').slider;
    expect(lowRating?.getAttribute('aria-valuenow')).toBe('0');
    expect(lowRating?.getAttribute('aria-valuetext')).toBe('未评分');
    expect(lowRating?.style.getPropertyValue('--rating-width')).toBe('0%');
  });

  it('supports half-star keyboard changes and clearing', () => {
    const { onChange, slider } = renderRating('2.5');

    act(() => {
      slider?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith('3');

    act(() => {
      container?.querySelector<HTMLButtonElement>('.ui-star-rating-clear')?.click();
    });
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('removes disabled sliders and reset actions from the tab order', () => {
    const { onChange, slider } = renderRating('2.5', vi.fn(), true);

    expect(slider?.getAttribute('aria-disabled')).toBe('true');
    expect(slider?.getAttribute('tabindex')).toBe('-1');
    expect(container?.querySelector<HTMLButtonElement>('.ui-star-rating-clear')?.disabled).toBe(true);

    act(() => {
      slider?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(onChange).not.toHaveBeenCalled();
  });
});
