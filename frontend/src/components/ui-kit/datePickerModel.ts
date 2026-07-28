export type DateKeyParts = {
  year: number;
  month: number;
  day: number;
};

export type CalendarDay = {
  dateKey: string;
  day: number;
  inCurrentMonth: boolean;
  selected: boolean;
  today: boolean;
  disabled: boolean;
};

function pad(value: number) {
  return String(value).padStart(2, '0');
}

export function dateKeyFromParts(year: number, month: number, day: number) {
  return `${year}-${pad(month)}-${pad(day)}`;
}

export function parseValidDateKey(value: string): DateKeyParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

function utcDateFromKey(dateKey: string) {
  const parts = parseValidDateKey(dateKey);
  if (!parts) return null;
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
}

function keyFromUtcDate(date: Date) {
  return dateKeyFromParts(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

export function moveDateKeyByDays(dateKey: string, days: number) {
  const date = utcDateFromKey(dateKey);
  if (!date) return dateKey;
  date.setUTCDate(date.getUTCDate() + days);
  return keyFromUtcDate(date);
}

export function moveDateKeyByMonths(dateKey: string, months: number) {
  const parts = parseValidDateKey(dateKey);
  if (!parts) return dateKey;
  const monthStart = new Date(Date.UTC(parts.year, parts.month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(
    monthStart.getUTCFullYear(),
    monthStart.getUTCMonth() + 1,
    0,
  )).getUTCDate();
  return dateKeyFromParts(
    monthStart.getUTCFullYear(),
    monthStart.getUTCMonth() + 1,
    Math.min(parts.day, lastDay),
  );
}

export function isDateKeyDisabled(dateKey: string, min?: string, max?: string) {
  if (!parseValidDateKey(dateKey)) return true;
  if (min && parseValidDateKey(min) && dateKey < min) return true;
  if (max && parseValidDateKey(max) && dateKey > max) return true;
  return false;
}

export function buildCalendarMonth(
  viewDateKey: string,
  options: {
    selectedDateKey?: string;
    todayDateKey: string;
    min?: string;
    max?: string;
  },
): CalendarDay[] {
  const view = parseValidDateKey(viewDateKey) ?? parseValidDateKey(options.todayDateKey) ?? { year: 1970, month: 1, day: 1 };
  const firstOfMonth = dateKeyFromParts(view.year, view.month, 1);
  const firstDate = utcDateFromKey(firstOfMonth) as Date;
  const mondayIndex = (firstDate.getUTCDay() + 6) % 7;
  const gridStart = moveDateKeyByDays(firstOfMonth, -mondayIndex);

  return Array.from({ length: 42 }, (_, index) => {
    const dateKey = moveDateKeyByDays(gridStart, index);
    const parts = parseValidDateKey(dateKey) as DateKeyParts;
    return {
      dateKey,
      day: parts.day,
      inCurrentMonth: parts.year === view.year && parts.month === view.month,
      selected: dateKey === options.selectedDateKey,
      today: dateKey === options.todayDateKey,
      disabled: isDateKeyDisabled(dateKey, options.min, options.max),
    };
  });
}

export function weekdayMondayIndex(dateKey: string) {
  const date = utcDateFromKey(dateKey);
  return date ? (date.getUTCDay() + 6) % 7 : 0;
}
