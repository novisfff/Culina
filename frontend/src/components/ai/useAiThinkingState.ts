import { useCallback, useEffect, useRef, useState } from 'react';

const THINKING_CUE_DELAY_MS = 300;

type ThinkingTimer = ReturnType<typeof setTimeout>;

export function useAiThinkingState() {
  const [thinkingRunIds, setThinkingRunIds] = useState<Set<string>>(() => new Set());
  const thinkingTimersRef = useRef<Record<string, ThinkingTimer>>({});

  const stopThinking = useCallback((runId: string | null | undefined) => {
    if (!runId) return;
    const timer = thinkingTimersRef.current[runId];
    if (timer) {
      clearTimeout(timer);
      const { [runId]: _removedTimer, ...remainingTimers } = thinkingTimersRef.current;
      thinkingTimersRef.current = remainingTimers;
    }
    setThinkingRunIds((current) => {
      if (!current.has(runId)) return current;
      const next = new Set(current);
      next.delete(runId);
      return next;
    });
  }, []);

  const startThinking = useCallback((runId: string | null | undefined) => {
    if (!runId) return;
    stopThinking(runId);
    const timer = setTimeout(() => {
      setThinkingRunIds((current) => {
        if (current.has(runId)) return current;
        const next = new Set(current);
        next.add(runId);
        return next;
      });
      const { [runId]: _removedTimer, ...remainingTimers } = thinkingTimersRef.current;
      thinkingTimersRef.current = remainingTimers;
    }, THINKING_CUE_DELAY_MS);
    thinkingTimersRef.current = { ...thinkingTimersRef.current, [runId]: timer };
  }, [stopThinking]);

  useEffect(() => () => {
    Object.values(thinkingTimersRef.current).forEach((timer) => clearTimeout(timer));
    thinkingTimersRef.current = {};
  }, []);

  return { thinkingRunIds, startThinking, stopThinking };
}
