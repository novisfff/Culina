import { afterEach, describe, expect, it, vi } from 'vitest';
import { addDateKeyDays, daysBetweenDateKeys, getWeekRange, parseDateKey, todayKey, toDateKey } from './date';

afterEach(() => {
  vi.useRealTimers();
});

describe('date helpers', () => {
  it('formats and parses local date keys without UTC shifting', () => {
    const parsed = parseDateKey('2026-06-08');

    expect(parsed.getFullYear()).toBe(2026);
    expect(parsed.getMonth()).toBe(5);
    expect(parsed.getDate()).toBe(8);
    expect(toDateKey(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  it('uses the current local calendar date for todayKey', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 28, 23, 30, 0));

    expect(todayKey()).toBe('2026-06-28');
  });

  it('adds days across month and year boundaries', () => {
    expect(addDateKeyDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDateKeyDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('returns Monday to Sunday week ranges', () => {
    expect(getWeekRange('2026-06-24')).toEqual({ start: '2026-06-22', end: '2026-06-28' });
    expect(getWeekRange('2026-06-28')).toEqual({ start: '2026-06-22', end: '2026-06-28' });
  });

  it('counts whole calendar days between date keys', () => {
    expect(daysBetweenDateKeys('2026-07-01', '2026-06-28')).toBe(3);
    expect(daysBetweenDateKeys('2026-06-27', '2026-06-28')).toBe(-1);
  });
});
