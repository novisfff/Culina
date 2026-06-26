import { describe, expect, it } from 'vitest';
import {
  chunkMobilePagedItems,
  MOBILE_PAGED_SCROLLER_INITIAL_PAGE_COUNT,
  getMobilePagedVisibleCount,
  getNextMobilePagedPageCount,
} from './useMobilePagedScroller';

describe('mobile paged scroller helpers', () => {
  it('preloads two mobile pages and chunks nine items into three pages', () => {
    const items = Array.from({ length: 9 }, (_, index) => `item-${index + 1}`);

    expect(getMobilePagedVisibleCount(items.length, MOBILE_PAGED_SCROLLER_INITIAL_PAGE_COUNT)).toBe(8);
    expect(chunkMobilePagedItems(items, MOBILE_PAGED_SCROLLER_INITIAL_PAGE_COUNT)).toEqual([
      items.slice(0, 4),
      items.slice(4, 8),
    ]);
    expect(chunkMobilePagedItems(items, 3)).toEqual([
      items.slice(0, 4),
      items.slice(4, 8),
      items.slice(8, 9),
    ]);
  });

  it('loads one extra mobile page at a time without exceeding the available items', () => {
    expect(getNextMobilePagedPageCount(9, MOBILE_PAGED_SCROLLER_INITIAL_PAGE_COUNT)).toBe(3);
    expect(getMobilePagedVisibleCount(9, 3)).toBe(9);
    expect(getNextMobilePagedPageCount(9, 3)).toBe(3);
  });

  it('returns to the preloaded first two pages when callers reset the visible page count', () => {
    const items = Array.from({ length: 9 }, (_, index) => `filtered-${index + 1}`);

    expect(chunkMobilePagedItems(items, 3).flat()).toHaveLength(9);
    expect(chunkMobilePagedItems(items, MOBILE_PAGED_SCROLLER_INITIAL_PAGE_COUNT).flat()).toHaveLength(8);
  });
});
