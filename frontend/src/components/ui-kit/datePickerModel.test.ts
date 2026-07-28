import { describe, expect, it } from 'vitest';
import {
  buildCalendarMonth,
  isDateKeyDisabled,
  moveDateKeyByDays,
  moveDateKeyByMonths,
  parseValidDateKey,
} from './datePickerModel';

describe('datePickerModel', () => {
  it('builds a stable six-week month that starts on Monday', () => {
    const days = buildCalendarMonth('2026-07-15', {
      selectedDateKey: '2026-07-28',
      todayDateKey: '2026-07-20',
    });

    expect(days).toHaveLength(42);
    expect(days[0]).toMatchObject({ dateKey: '2026-06-29', inCurrentMonth: false });
    expect(days[41]).toMatchObject({ dateKey: '2026-08-09', inCurrentMonth: false });
    expect(days.find((day) => day.dateKey === '2026-07-28')).toMatchObject({ selected: true });
    expect(days.find((day) => day.dateKey === '2026-07-20')).toMatchObject({ today: true });
  });

  it('keeps leap-day arithmetic in calendar-date space', () => {
    expect(moveDateKeyByDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(moveDateKeyByDays('2024-02-29', 1)).toBe('2024-03-01');
    expect(moveDateKeyByMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(moveDateKeyByMonths('2024-01-31', 1)).toBe('2024-02-29');
  });

  it('validates real ISO date keys and inclusive range boundaries', () => {
    expect(parseValidDateKey('2026-02-29')).toBeNull();
    expect(parseValidDateKey('2024-02-29')).toEqual({ year: 2024, month: 2, day: 29 });
    expect(isDateKeyDisabled('2026-07-10', '2026-07-10', '2026-07-20')).toBe(false);
    expect(isDateKeyDisabled('2026-07-20', '2026-07-10', '2026-07-20')).toBe(false);
    expect(isDateKeyDisabled('2026-07-09', '2026-07-10', '2026-07-20')).toBe(true);
    expect(isDateKeyDisabled('2026-07-21', '2026-07-10', '2026-07-20')).toBe(true);
  });
});
