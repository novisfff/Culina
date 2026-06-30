import { useCallback, useEffect, useState, type UIEvent } from 'react';

export const MOBILE_PAGED_SCROLLER_PAGE_SIZE = 2;
export const MOBILE_PAGED_SCROLLER_INITIAL_PAGE_COUNT = 3;

export function getMobilePagedVisibleCount(
  itemCount: number,
  visiblePageCount: number,
  pageSize = MOBILE_PAGED_SCROLLER_PAGE_SIZE
) {
  return Math.min(itemCount, Math.max(1, visiblePageCount) * pageSize);
}

export function getNextMobilePagedPageCount(
  itemCount: number,
  visiblePageCount: number,
  pageSize = MOBILE_PAGED_SCROLLER_PAGE_SIZE
) {
  const totalPageCount = Math.max(1, Math.ceil(itemCount / pageSize));
  return Math.min(totalPageCount, Math.max(1, visiblePageCount) + 1);
}

export function chunkMobilePagedItems<T>(
  items: T[],
  visiblePageCount: number,
  pageSize = MOBILE_PAGED_SCROLLER_PAGE_SIZE
) {
  const visibleItems = items.slice(0, getMobilePagedVisibleCount(items.length, visiblePageCount, pageSize));
  return Array.from({ length: Math.ceil(visibleItems.length / pageSize) }, (_, index) =>
    visibleItems.slice(index * pageSize, index * pageSize + pageSize)
  );
}

export function useMobilePagedScroller(args: {
  itemCount: number;
  resetKey: string;
  pageSize?: number;
}) {
  const pageSize = args.pageSize ?? MOBILE_PAGED_SCROLLER_PAGE_SIZE;
  const [visiblePageCount, setVisiblePageCount] = useState(MOBILE_PAGED_SCROLLER_INITIAL_PAGE_COUNT);
  const totalPageCount = Math.max(1, Math.ceil(args.itemCount / pageSize));
  const normalizedVisiblePageCount = Math.min(visiblePageCount, totalPageCount);
  const visibleCount = getMobilePagedVisibleCount(args.itemCount, normalizedVisiblePageCount, pageSize);
  const hasMore = visibleCount < args.itemCount;

  useEffect(() => {
    setVisiblePageCount(MOBILE_PAGED_SCROLLER_INITIAL_PAGE_COUNT);
  }, [args.resetKey]);

  const loadNextPage = useCallback(() => {
    setVisiblePageCount((current) => getNextMobilePagedPageCount(args.itemCount, current, pageSize));
  }, [args.itemCount, pageSize]);

  const handleScroll = useCallback(
    (event: UIEvent<HTMLElement>) => {
      if (!hasMore) return;
      const node = event.currentTarget;
      const remaining = node.scrollWidth - node.clientWidth - node.scrollLeft;
      const threshold = Math.max(160, node.clientWidth * 0.9);
      if (remaining <= threshold) {
        loadNextPage();
      }
    },
    [hasMore, loadNextPage]
  );

  return {
    visiblePageCount: normalizedVisiblePageCount,
    visibleCount,
    totalPageCount,
    hasMore,
    loadNextPage,
    handleScroll,
  };
}
