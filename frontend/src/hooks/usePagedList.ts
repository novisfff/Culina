import { useCallback, useEffect, useRef, useState } from 'react';

export const PAGED_LIST_INITIAL_COUNT = 12;
export const PAGED_LIST_PAGE_SIZE = 8;

export function getPagedListVisibleCount(itemCount: number, requestedCount: number) {
  return Math.min(Math.max(0, itemCount), Math.max(0, requestedCount));
}

export function getNextPagedListVisibleCount(
  itemCount: number,
  requestedCount: number,
  pageSize = PAGED_LIST_PAGE_SIZE
) {
  return getPagedListVisibleCount(itemCount, Math.max(0, requestedCount) + Math.max(1, pageSize));
}

export function usePagedList(args: {
  itemCount: number;
  resetKey: string;
  initialCount?: number;
  pageSize?: number;
  rootMargin?: string;
}) {
  const initialCount = args.initialCount ?? PAGED_LIST_INITIAL_COUNT;
  const pageSize = args.pageSize ?? PAGED_LIST_PAGE_SIZE;
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const [requestedCount, setRequestedCount] = useState(initialCount);
  const visibleCount = getPagedListVisibleCount(args.itemCount, requestedCount);
  const hasMore = visibleCount < args.itemCount;

  useEffect(() => {
    setRequestedCount(initialCount);
  }, [args.resetKey, initialCount]);

  const loadMore = useCallback(() => {
    setRequestedCount((current) => getNextPagedListVisibleCount(args.itemCount, current, pageSize));
  }, [args.itemCount, pageSize]);

  useEffect(() => {
    const target = sentinelRef.current;
    if (!target || !hasMore || typeof IntersectionObserver === 'undefined') {
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          loadMore();
        }
      },
      { rootMargin: args.rootMargin ?? '640px 0px' }
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [args.rootMargin, hasMore, loadMore]);

  return {
    visibleCount,
    hasMore,
    loadMore,
    sentinelRef,
  };
}
