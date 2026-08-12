import { useCallback, useEffect, useRef, useState, useTransition } from 'react';

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

export function createPagedListAutoLoadGate() {
  let armed = true;

  return {
    shouldLoad(isIntersecting: boolean) {
      if (!isIntersecting) {
        armed = true;
        return false;
      }
      if (!armed) return false;
      armed = false;
      return true;
    },
    reset() {
      armed = true;
    },
  };
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
  const autoLoadGateRef = useRef(createPagedListAutoLoadGate());
  const [requestedCount, setRequestedCount] = useState(initialCount);
  const [isLoadingMore, startLoadingMoreTransition] = useTransition();
  const visibleCount = getPagedListVisibleCount(args.itemCount, requestedCount);
  const hasMore = visibleCount < args.itemCount;

  useEffect(() => {
    autoLoadGateRef.current.reset();
    setRequestedCount(initialCount);
  }, [args.resetKey, initialCount]);

  const loadMore = useCallback(() => {
    startLoadingMoreTransition(() => {
      setRequestedCount((current) => getNextPagedListVisibleCount(args.itemCount, current, pageSize));
    });
  }, [args.itemCount, pageSize]);

  useEffect(() => {
    const target = sentinelRef.current;
    if (!target || !hasMore || typeof IntersectionObserver === 'undefined') {
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const latestEntry = entries.at(-1);
        if (latestEntry && autoLoadGateRef.current.shouldLoad(latestEntry.isIntersecting)) {
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
    isLoadingMore,
    loadMore,
    sentinelRef,
  };
}
