import { afterEach, describe, expect, it, vi } from 'vitest';
import { splitTags, todayKey } from './ui';

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

describe('splitTags', () => {
  it('splits Chinese and Western tag separators', () => {
    expect(splitTags('家常菜、快手菜，晚餐/午餐; 清淡；下饭\n孩子也能吃')).toEqual([
      '家常菜',
      '快手菜',
      '晚餐',
      '午餐',
      '清淡',
      '下饭',
      '孩子也能吃',
    ]);
  });
});
