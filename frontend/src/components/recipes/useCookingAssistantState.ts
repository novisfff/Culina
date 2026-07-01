import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import type { AiUiActionsCardData } from '../../api/types';

type DragState = {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  width: number;
  height: number;
  moved: boolean;
};

type MobileSheetDragState = {
  pointerId: number;
  startY: number;
  startTime: number;
  distance: number;
};

const FLOATING_MIN_WIDTH_QUERY = '(min-width: 768px)';
const MOBILE_SHEET_QUERY = '(max-width: 767px)';
const FLOATING_MARGIN = 16;
const DRAG_THRESHOLD = 5;
const PANEL_CLOSE_ANIMATION_MS = 280;
const MOBILE_SHEET_DISMISS_MS = 180;

function isFloatingViewport() {
  return typeof window !== 'undefined' && window.matchMedia(FLOATING_MIN_WIDTH_QUERY).matches;
}

function isMobileSheetViewport() {
  return typeof window !== 'undefined' && window.matchMedia(MOBILE_SHEET_QUERY).matches;
}

function clampFloatingPosition(x: number, y: number, width: number, height: number) {
  if (typeof window === 'undefined') return { x, y };
  const maxX = Math.max(FLOATING_MARGIN, window.innerWidth - width - FLOATING_MARGIN);
  const maxY = Math.max(FLOATING_MARGIN, window.innerHeight - height - FLOATING_MARGIN);
  return {
    x: Math.min(Math.max(FLOATING_MARGIN, x), maxX),
    y: Math.min(Math.max(FLOATING_MARGIN, y), maxY),
  };
}

function readFloatingLayoutPosition(node: HTMLElement, fallbackX: number, fallbackY: number) {
  const rawX = Number.parseFloat(node.style.getPropertyValue('--recipe-cook-ai-left'));
  const rawY = Number.parseFloat(node.style.getPropertyValue('--recipe-cook-ai-top'));
  return {
    x: Number.isFinite(rawX) ? rawX : fallbackX,
    y: Number.isFinite(rawY) ? rawY : fallbackY,
  };
}

function readFloatingLayoutSize(node: HTMLElement, fallbackWidth: number, fallbackHeight: number) {
  return {
    width: node.offsetWidth || fallbackWidth,
    height: node.offsetHeight || fallbackHeight,
  };
}

export function useCookingAssistantState() {
  const floatingRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const mobileSheetDragRef = useRef<MobileSheetDragState | null>(null);
  const removeMobileSheetDragListenersRef = useRef<(() => void) | null>(null);
  const floatingAnchorRef = useRef<{ right: number; bottom: number } | null>(null);
  const suppressNextClickRef = useRef(false);
  const closeTimerRef = useRef<number | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [isFloatingPositioned, setIsFloatingPositioned] = useState(false);
  const [isFloatingDragging, setIsFloatingDragging] = useState(false);
  const [draftMessage, setDraftMessage] = useState('');
  const [pendingActionCard, setPendingActionCard] = useState<AiUiActionsCardData | null>(null);
  const [confirmationNotice, setConfirmationNotice] = useState('');

  const applyFloatingPosition = useCallback((x: number, y: number) => {
    const node = floatingRef.current;
    if (!node) return;
    node.style.setProperty('--recipe-cook-ai-left', `${Math.round(x)}px`);
    node.style.setProperty('--recipe-cook-ai-top', `${Math.round(y)}px`);
  }, []);

  const rememberFloatingAnchor = useCallback(() => {
    if (!isFloatingViewport()) return;
    const node = floatingRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const position = isFloatingPositioned
      ? readFloatingLayoutPosition(node, rect.left, rect.top)
      : { x: rect.left, y: rect.top };
    const size = isFloatingPositioned
      ? readFloatingLayoutSize(node, rect.width, rect.height)
      : { width: rect.width, height: rect.height };
    floatingAnchorRef.current = {
      right: position.x + size.width,
      bottom: position.y + size.height,
    };
  }, [isFloatingPositioned]);

  const startFloatingDrag = useCallback((event: PointerEvent<HTMLElement>) => {
    if (!isFloatingViewport()) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const node = floatingRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const origin = clampFloatingPosition(rect.left, rect.top, rect.width, rect.height);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: origin.x,
      originY: origin.y,
      width: rect.width,
      height: rect.height,
      moved: false,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }, [applyFloatingPosition]);

  const moveFloatingDrag = useCallback((event: PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (Math.hypot(deltaX, deltaY) >= DRAG_THRESHOLD) {
      drag.moved = true;
      setIsFloatingPositioned(true);
      setIsFloatingDragging(true);
    }
    if (!drag.moved) return;
    const next = clampFloatingPosition(drag.originX + deltaX, drag.originY + deltaY, drag.width, drag.height);
    applyFloatingPosition(next.x, next.y);
  }, [applyFloatingPosition]);

  const endFloatingDrag = useCallback((event: PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.moved) {
      suppressNextClickRef.current = true;
    }
    dragRef.current = null;
    setIsFloatingDragging(false);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }, []);

  const consumeFloatingDragClick = useCallback(() => {
    if (!suppressNextClickRef.current) return false;
    suppressNextClickRef.current = false;
    return true;
  }, []);

  const clampCurrentFloatingPosition = useCallback(() => {
    if (!isFloatingPositioned || !isFloatingViewport()) return;
    const node = floatingRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const position = readFloatingLayoutPosition(node, rect.left, rect.top);
    const size = readFloatingLayoutSize(node, rect.width, rect.height);
    const next = clampFloatingPosition(position.x, position.y, size.width, size.height);
    applyFloatingPosition(next.x, next.y);
  }, [applyFloatingPosition, isFloatingPositioned]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(clampCurrentFloatingPosition);
    return () => window.cancelAnimationFrame(frame);
  }, [clampCurrentFloatingPosition, isOpen]);

  useEffect(() => {
    if (!isFloatingPositioned || isClosing || !isFloatingViewport()) return;
    const anchor = floatingAnchorRef.current;
    if (!anchor) return;
    const frame = window.requestAnimationFrame(() => {
      const node = floatingRef.current;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      const size = readFloatingLayoutSize(node, rect.width, rect.height);
      const next = clampFloatingPosition(anchor.right - size.width, anchor.bottom - size.height, size.width, size.height);
      applyFloatingPosition(next.x, next.y);
      floatingAnchorRef.current = null;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [applyFloatingPosition, isClosing, isFloatingPositioned, isOpen]);

  useEffect(() => {
    window.addEventListener('resize', clampCurrentFloatingPosition);
    return () => window.removeEventListener('resize', clampCurrentFloatingPosition);
  }, [clampCurrentFloatingPosition]);

  useEffect(() => () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
    }
    removeMobileSheetDragListenersRef.current?.();
  }, []);

  const openPanel = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (isFloatingPositioned) {
      rememberFloatingAnchor();
    }
    setIsClosing(false);
    setIsOpen(true);
  }, [isFloatingPositioned, rememberFloatingAnchor]);

  const closePanel = useCallback(() => {
    if (!isOpen || isClosing) return;
    if (isFloatingPositioned) {
      rememberFloatingAnchor();
    }
    setIsClosing(true);
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setIsOpen(false);
      setIsClosing(false);
    }, PANEL_CLOSE_ANIMATION_MS);
  }, [isClosing, isFloatingPositioned, isOpen, rememberFloatingAnchor]);

  const togglePanel = useCallback(() => {
    if (isOpen && !isClosing) {
      closePanel();
      return;
    }
    openPanel();
  }, [closePanel, isClosing, isOpen, openPanel]);

  const resetMobileSheetDragPosition = useCallback(() => {
    const node = floatingRef.current;
    if (!node) return;
    node.style.transition = 'transform 220ms cubic-bezier(0.22, 1, 0.36, 1)';
    node.style.transform = 'translateY(0)';
    window.setTimeout(() => {
      node.style.removeProperty('transition');
      node.style.removeProperty('transform');
      node.style.removeProperty('animation');
    }, 230);
  }, []);

  const dismissMobileSheet = useCallback(() => {
    const node = floatingRef.current;
    if (!node) {
      setIsOpen(false);
      setIsClosing(false);
      return;
    }
    node.style.transition = 'transform 180ms cubic-bezier(0.4, 0, 1, 1)';
    node.style.transform = 'translateY(110%)';
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      node.style.removeProperty('transition');
      node.style.removeProperty('transform');
      node.style.removeProperty('animation');
      setIsOpen(false);
      setIsClosing(false);
    }, MOBILE_SHEET_DISMISS_MS);
  }, []);

  const updateMobileSheetDragPosition = useCallback((event: globalThis.PointerEvent) => {
    const drag = mobileSheetDragRef.current;
    const node = floatingRef.current;
    if (!drag || !node || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const distance = Math.max(0, event.clientY - drag.startY);
    drag.distance = distance;
    node.style.transform = `translateY(${Math.round(distance)}px)`;
  }, []);

  const finishMobileSheetDrag = useCallback((event: globalThis.PointerEvent) => {
    const drag = mobileSheetDragRef.current;
    const node = floatingRef.current;
    if (!drag || !node || drag.pointerId !== event.pointerId) return;
    removeMobileSheetDragListenersRef.current?.();
    removeMobileSheetDragListenersRef.current = null;
    const elapsed = Math.max(1, performance.now() - drag.startTime);
    const velocity = drag.distance / elapsed;
    const closeDistance = Math.min(120, node.getBoundingClientRect().height * 0.22);
    const shouldClose = drag.distance >= closeDistance || (drag.distance >= 36 && velocity >= 0.65);
    mobileSheetDragRef.current = null;

    if (shouldClose) {
      dismissMobileSheet();
      return;
    }
    resetMobileSheetDragPosition();
  }, [dismissMobileSheet, resetMobileSheetDragPosition]);

  const startMobileSheetDrag = useCallback((event: PointerEvent<HTMLElement>) => {
    if (!isOpen || isClosing || !isMobileSheetViewport()) return;
    const node = floatingRef.current;
    if (!node) return;
    removeMobileSheetDragListenersRef.current?.();
    mobileSheetDragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startTime: performance.now(),
      distance: 0,
    };
    node.style.animation = 'none';
    node.style.transition = 'none';
    event.currentTarget.setPointerCapture?.(event.pointerId);

    const handlePointerMove = (pointerEvent: globalThis.PointerEvent) => updateMobileSheetDragPosition(pointerEvent);
    const handlePointerEnd = (pointerEvent: globalThis.PointerEvent) => finishMobileSheetDrag(pointerEvent);
    window.addEventListener('pointermove', handlePointerMove, { passive: false });
    window.addEventListener('pointerup', handlePointerEnd);
    window.addEventListener('pointercancel', handlePointerEnd);
    removeMobileSheetDragListenersRef.current = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerEnd);
      window.removeEventListener('pointercancel', handlePointerEnd);
    };
  }, [finishMobileSheetDrag, isClosing, isOpen, updateMobileSheetDragPosition]);

  const clearTransientNotice = useCallback(() => setConfirmationNotice(''), []);

  return {
    floatingRef,
    isOpen,
    isClosing,
    isFloatingPositioned,
    isFloatingDragging,
    draftMessage,
    pendingActionCard,
    confirmationNotice,
    setDraftMessage,
    setPendingActionCard,
    setConfirmationNotice,
    openPanel,
    closePanel,
    togglePanel,
    startFloatingDrag,
    moveFloatingDrag,
    endFloatingDrag,
    startMobileSheetDrag,
    consumeFloatingDragClick,
    clearTransientNotice,
  };
}
