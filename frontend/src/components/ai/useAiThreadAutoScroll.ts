import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AiMessage, AiMessagePart, AiRunEvent } from '../../api/types';

const BOTTOM_FOLLOW_THRESHOLD = 96;

function isNearThreadBottom(node: HTMLElement) {
  return node.scrollHeight - node.scrollTop - node.clientHeight <= BOTTOM_FOLLOW_THRESHOLD;
}

function partScrollKey(part: AiMessagePart) {
  if (part.type === 'text') return `${part.id}:text:${part.text?.length ?? 0}`;
  if (part.type === 'run_activity' && part.activity) {
    return `${part.id}:activity:${part.activity.id}:${part.activity.status}:${part.activity.user_message.length}`;
  }
  if (part.type === 'approval_request' && part.approval) {
    return `${part.id}:approval:${part.approval.id}:${part.approval.status}:${part.approval.resolved_at ?? ''}`;
  }
  if (part.type === 'human_input_request' && part.request) {
    return `${part.id}:human:${part.request.id}:${part.status ?? ''}:${part.responded_at ?? ''}:${part.response?.summary?.length ?? 0}`;
  }
  if (part.type === 'result_card' && part.card) return `${part.id}:card:${part.card.id}:${part.card.type}`;
  if (part.type === 'image' && part.image) return `${part.id}:image:${part.image.media_id}`;
  return `${part.id}:${part.type}:${part.status ?? ''}`;
}

export function aiThreadAutoScrollKey(messages: AiMessage[], runEvents: AiRunEvent[] = [], thinkingRunIds: Set<string> = new Set()) {
  const messageKey = messages
    .map((message) => `${message.id}:${message.status}:${message.content.length}:${message.parts.map(partScrollKey).join(',')}`)
    .join('|');
  const eventKey = runEvents
    .map((event) => `${event.id}:${event.run_id}:${event.status}:${event.user_message.length}`)
    .join('|');
  const thinkingKey = Array.from(thinkingRunIds).sort().join(',');
  return `${messageKey}::${eventKey}::${thinkingKey}`;
}

export function latestUserMessageScrollKey(messages: AiMessage[]) {
  return [...messages].reverse().find((message) => message.role === 'user')?.id ?? null;
}

type UseAiThreadAutoScrollArgs = {
  contentKey: string;
  resetKey: string | null;
  activeOutputKey: string | null;
  forceScrollKey?: string | null;
};

export function useAiThreadAutoScroll({
  contentKey,
  resetKey,
  activeOutputKey,
  forceScrollKey = null,
}: UseAiThreadAutoScrollArgs) {
  const threadScrollRef = useRef<HTMLDivElement | null>(null);
  const isPinnedToBottomRef = useRef(true);
  const frameIdsRef = useRef<number[]>([]);
  const lastTouchYRef = useRef<number | null>(null);
  const [isPinnedToBottom, setIsPinnedToBottomState] = useState(true);

  const setIsPinnedToBottom = useCallback((nextValue: boolean) => {
    isPinnedToBottomRef.current = nextValue;
    setIsPinnedToBottomState((current) => (current === nextValue ? current : nextValue));
  }, []);

  const cancelScheduledScrolls = useCallback(() => {
    for (const frameId of frameIdsRef.current) {
      if (window.cancelAnimationFrame) {
        window.cancelAnimationFrame(frameId);
      } else {
        window.clearTimeout(frameId);
      }
    }
    frameIdsRef.current = [];
  }, []);

  const scrollToThreadBottom = useCallback(() => {
    const node = threadScrollRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
    setIsPinnedToBottom(true);
  }, [setIsPinnedToBottom]);

  const scheduleScrollToThreadBottom = useCallback(() => {
    cancelScheduledScrolls();
    scrollToThreadBottom();
    const requestFrame = window.requestAnimationFrame
      ?? ((callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 16));
    const firstFrame = requestFrame(() => {
      scrollToThreadBottom();
      const secondFrame = requestFrame(scrollToThreadBottom);
      frameIdsRef.current = [secondFrame];
    });
    frameIdsRef.current = [firstFrame];
  }, [cancelScheduledScrolls, scrollToThreadBottom]);

  const resumeAutoScroll = useCallback(() => {
    scheduleScrollToThreadBottom();
  }, [scheduleScrollToThreadBottom]);

  const pauseAutoScroll = useCallback(() => {
    cancelScheduledScrolls();
    setIsPinnedToBottom(false);
  }, [cancelScheduledScrolls, setIsPinnedToBottom]);

  useEffect(() => cancelScheduledScrolls, [cancelScheduledScrolls]);

  useEffect(() => {
    const node = threadScrollRef.current;
    if (!node) return undefined;
    const handleScroll = () => {
      const isNearBottom = isNearThreadBottom(node);
      if (!isNearBottom) {
        cancelScheduledScrolls();
      }
      setIsPinnedToBottom(isNearBottom);
    };
    const handleWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) {
        pauseAutoScroll();
      }
    };
    const handleTouchStart = (event: TouchEvent) => {
      lastTouchYRef.current = event.touches[0]?.clientY ?? null;
    };
    const handleTouchMove = (event: TouchEvent) => {
      const currentY = event.touches[0]?.clientY ?? null;
      const previousY = lastTouchYRef.current;
      if (currentY !== null && previousY !== null && currentY > previousY + 2) {
        pauseAutoScroll();
      }
      lastTouchYRef.current = currentY;
    };
    const handleTouchEnd = () => {
      lastTouchYRef.current = null;
    };
    node.addEventListener('scroll', handleScroll, { passive: true });
    node.addEventListener('wheel', handleWheel, { passive: true });
    node.addEventListener('touchstart', handleTouchStart, { passive: true });
    node.addEventListener('touchmove', handleTouchMove, { passive: true });
    node.addEventListener('touchend', handleTouchEnd, { passive: true });
    node.addEventListener('touchcancel', handleTouchEnd, { passive: true });
    handleScroll();
    return () => {
      node.removeEventListener('scroll', handleScroll);
      node.removeEventListener('wheel', handleWheel);
      node.removeEventListener('touchstart', handleTouchStart);
      node.removeEventListener('touchmove', handleTouchMove);
      node.removeEventListener('touchend', handleTouchEnd);
      node.removeEventListener('touchcancel', handleTouchEnd);
    };
  }, [cancelScheduledScrolls, pauseAutoScroll, resetKey, setIsPinnedToBottom]);

  useLayoutEffect(() => {
    scheduleScrollToThreadBottom();
  }, [resetKey, scheduleScrollToThreadBottom]);

  useLayoutEffect(() => {
    if (!activeOutputKey || !isPinnedToBottomRef.current) return;
    scheduleScrollToThreadBottom();
  }, [activeOutputKey, contentKey, scheduleScrollToThreadBottom]);

  useLayoutEffect(() => {
    if (!forceScrollKey) return;
    scheduleScrollToThreadBottom();
  }, [forceScrollKey, scheduleScrollToThreadBottom]);

  const isAutoScrollPaused = useMemo(
    () => Boolean(activeOutputKey && !isPinnedToBottom),
    [activeOutputKey, isPinnedToBottom],
  );

  return {
    threadScrollRef,
    isAutoScrollPaused,
    resumeAutoScroll,
  };
}
