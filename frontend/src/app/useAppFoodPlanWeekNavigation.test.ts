import { renderHook, act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useAppFoodPlanWeekNavigation } from './useAppFoodPlanWeekNavigation';

describe('useAppFoodPlanWeekNavigation', () => {
  it('projects adjacent and current week actions', () => {
    const setSelectedDate = vi.fn();
    const { result } = renderHook(() => useAppFoodPlanWeekNavigation({
      weekRange: { start: '2026-08-24', end: '2026-08-30' },
      today: '2026-08-30',
      setSelectedDate,
    }));
    act(() => result.current.previousWeek());
    act(() => result.current.currentWeek());
    act(() => result.current.nextWeek());
    expect(setSelectedDate.mock.calls.map(([date]) => date)).toEqual(['2026-08-17', '2026-08-30', '2026-08-31']);
  });
});
