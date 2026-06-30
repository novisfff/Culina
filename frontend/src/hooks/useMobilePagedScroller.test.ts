import { describe, expect, it } from 'vitest';
import {
  chunkMobilePagedItems,
  MOBILE_PAGED_SCROLLER_INITIAL_PAGE_COUNT,
  getMobilePagedVisibleCount,
  getNextMobilePagedPageCount,
} from './useMobilePagedScroller';

describe('mobile paged scroller helpers', () => {
  it('preloads three mobile groups and chunks nine items into two-item pages', () => {
    const items = Array.from({ length: 9 }, (_, index) => `item-${index + 1}`);

    expect(getMobilePagedVisibleCount(items.length, MOBILE_PAGED_SCROLLER_INITIAL_PAGE_COUNT)).toBe(6);
    expect(chunkMobilePagedItems(items, MOBILE_PAGED_SCROLLER_INITIAL_PAGE_COUNT)).toEqual([
      items.slice(0, 2),
      items.slice(2, 4),
      items.slice(4, 6),
    ]);
    expect(chunkMobilePagedItems(items, 3)).toEqual([
      items.slice(0, 2),
      items.slice(2, 4),
      items.slice(4, 6),
    ]);
  });

  it('loads one extra mobile page at a time without exceeding the available items', () => {
    expect(getNextMobilePagedPageCount(9, MOBILE_PAGED_SCROLLER_INITIAL_PAGE_COUNT)).toBe(4);
    expect(getMobilePagedVisibleCount(9, 3)).toBe(6);
    expect(getNextMobilePagedPageCount(9, 3)).toBe(4);
  });

  it('returns to the preloaded first three groups when callers reset the visible page count', () => {
    const items = Array.from({ length: 9 }, (_, index) => `filtered-${index + 1}`);

    expect(chunkMobilePagedItems(items, 3).flat()).toHaveLength(6);
    expect(chunkMobilePagedItems(items, MOBILE_PAGED_SCROLLER_INITIAL_PAGE_COUNT).flat()).toHaveLength(6);
  });
});
