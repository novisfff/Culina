import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export type ScrollableChipRailProps = {
  ariaLabel: string;
  railClassName: string;
  children: ReactNode;
};

/** Keyboard- and touch-friendly horizontal chip rail shared by ingredient panels. */
export function ScrollableChipRail(props: ScrollableChipRailProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [hasOverflow, setHasOverflow] = useState(false);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    let frame = 0;
    const updateScrollState = () => {
      cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const overflow = viewport.scrollWidth > viewport.clientWidth + 4;
        const nextCanScrollLeft = viewport.scrollLeft > 4;
        const nextCanScrollRight = viewport.scrollLeft + viewport.clientWidth < viewport.scrollWidth - 4;
        setHasOverflow((current) => current === overflow ? current : overflow);
        setCanScrollLeft((current) => current === nextCanScrollLeft ? current : nextCanScrollLeft);
        setCanScrollRight((current) => current === nextCanScrollRight ? current : nextCanScrollRight);
      });
    };
    updateScrollState();
    viewport.addEventListener('scroll', updateScrollState, { passive: true });
    const observer = new ResizeObserver(updateScrollState);
    observer.observe(viewport);
    if (contentRef.current) observer.observe(contentRef.current);
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener('scroll', updateScrollState);
      observer.disconnect();
    };
  }, [props.children]);

  function scrollByDirection(direction: -1 | 1) {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollBy({ left: direction * Math.max(180, viewport.clientWidth * 0.72), behavior: 'smooth' });
  }

  function handleViewportKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!hasOverflow) return;
    if (event.key === 'ArrowLeft') { event.preventDefault(); scrollByDirection(-1); return; }
    if (event.key === 'ArrowRight') { event.preventDefault(); scrollByDirection(1); return; }
    if (event.key === 'Home') { event.preventDefault(); viewportRef.current?.scrollTo({ left: 0, behavior: 'smooth' }); return; }
    if (event.key === 'End') { event.preventDefault(); viewportRef.current?.scrollTo({ left: viewportRef.current.scrollWidth, behavior: 'smooth' }); }
  }

  const shellClassName = [
    'ingredients-chip-rail-shell',
    hasOverflow ? 'has-overflow' : '',
    canScrollLeft ? 'can-scroll-left' : '',
    canScrollRight ? 'can-scroll-right' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={shellClassName}>
      <button className="ingredients-chip-rail-button ingredients-chip-rail-button-left" type="button" aria-label="向左查看更多分类" onClick={() => scrollByDirection(-1)} disabled={!hasOverflow || !canScrollLeft}>
        <span aria-hidden="true">‹</span>
      </button>
      <div ref={viewportRef} className="ingredients-chip-rail-viewport" aria-label={props.ariaLabel} onKeyDown={handleViewportKeyDown} tabIndex={hasOverflow ? 0 : -1}>
        <div ref={contentRef} className={props.railClassName}>{props.children}</div>
      </div>
      <button className="ingredients-chip-rail-button ingredients-chip-rail-button-right" type="button" aria-label="向右查看更多分类" onClick={() => scrollByDirection(1)} disabled={!hasOverflow || !canScrollRight}>
        <span aria-hidden="true">›</span>
      </button>
    </div>
  );
}
