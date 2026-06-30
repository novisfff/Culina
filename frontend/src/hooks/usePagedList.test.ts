import { describe, expect, it } from 'vitest';
import {
  PAGED_LIST_INITIAL_COUNT,
  getNextPagedListVisibleCount,
  getPagedListVisibleCount,
} from './usePagedList';

describe('paged list helpers', () => {
  it('limits the requested count to the available item count', () => {
    expect(getPagedListVisibleCount(3, PAGED_LIST_INITIAL_COUNT)).toBe(3);
    expect(getPagedListVisibleCount(30, PAGED_LIST_INITIAL_COUNT)).toBe(12);
  });

  it('loads one additional page without exceeding the available items', () => {
    expect(getNextPagedListVisibleCount(30, 12, 8)).toBe(20);
    expect(getNextPagedListVisibleCount(18, 12, 8)).toBe(18);
  });
});
