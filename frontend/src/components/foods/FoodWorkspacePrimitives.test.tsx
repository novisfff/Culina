// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FoodRatingInput } from './FoodWorkspacePrimitives';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function renderRating(value: string) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(<FoodRatingInput value={value} onChange={vi.fn()} />);
  });
  return container.querySelector<HTMLElement>('.food-rating-stars');
}

describe('FoodRatingInput', () => {
  it('bounds persisted rating values before exposing slider state', () => {
    const highRating = renderRating('9');

    expect(highRating?.getAttribute('aria-valuenow')).toBe('5');
    expect(highRating?.getAttribute('aria-valuetext')).toBe('5 分');
    expect(highRating?.style.getPropertyValue('--rating-width')).toBe('100%');

    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;

    const lowRating = renderRating('-2');
    expect(lowRating?.getAttribute('aria-valuenow')).toBe('0');
    expect(lowRating?.getAttribute('aria-valuetext')).toBe('未评分');
    expect(lowRating?.style.getPropertyValue('--rating-width')).toBe('0%');
  });
});
