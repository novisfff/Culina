import { afterEach, describe, expect, it, vi } from 'vitest';
import { todayKey } from './ui';

afterEach(() => {
  vi.useRealTimers();
});

describe('ui todayKey', () => {
  it('formats the current local calendar day', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 1, 30, 0));

    expect(todayKey()).toBe('2026-01-01');
  });
});
