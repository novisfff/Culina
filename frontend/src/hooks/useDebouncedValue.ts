import { useEffect, useState, type CompositionEventHandler } from 'react';

export function useDebouncedValue<T>(value: T, delayMs = 300) {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedValue(value);
    }, delayMs);

    return () => window.clearTimeout(timer);
  }, [delayMs, value]);

  return debouncedValue;
}

export function useSearchCompositionState() {
  const [isComposing, setIsComposing] = useState(false);

  const onCompositionStart: CompositionEventHandler<HTMLInputElement> = () => {
    setIsComposing(true);
  };

  const onCompositionEnd: CompositionEventHandler<HTMLInputElement> = () => {
    setIsComposing(false);
  };

  return {
    isComposing,
    onCompositionStart,
    onCompositionEnd,
  };
}

export function useDebouncedSearchValue(value: string, options: { delayMs?: number; isComposing?: boolean } = {}) {
  const normalizedValue = value.trim();
  const debouncedValue = useDebouncedValue(normalizedValue, options.delayMs ?? 300);

  if (!normalizedValue || options.isComposing || debouncedValue !== normalizedValue) {
    return '';
  }

  return debouncedValue;
}
