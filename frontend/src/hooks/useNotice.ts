import { useEffect, useRef, useState } from 'react';

export type NoticeTone = 'success' | 'warning' | 'danger';

export type NoticeState = {
  tone: NoticeTone;
  title: string;
  message: string;
};

export function useNotice(timeoutMs = 4200) {
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const timerRef = useRef<number | null>(null);

  function clearNotice() {
    setNotice(null);
  }

  function showNotice(next: NoticeState) {
    setNotice(next);
  }

  useEffect(() => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!notice || timeoutMs <= 0) {
      return undefined;
    }
    timerRef.current = window.setTimeout(() => {
      setNotice(null);
      timerRef.current = null;
    }, timeoutMs);
    return () => {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [notice, timeoutMs]);

  return { notice, showNotice, clearNotice };
}
