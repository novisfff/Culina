export function todayKey(): string {
  const today = new Date();
  return toDateKey(today);
}

export function parseDateKey(dateKey: string): Date {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(year, (month ?? 1) - 1, day ?? 1);
}

export function toDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function parseDateKeyParts(dateKey: string): { year: number; month: number; day: number } {
  const [year, month, day] = dateKey.slice(0, 10).split('-').map(Number);
  return {
    year: year || 1970,
    month: month || 1,
    day: day || 1,
  };
}

export function dateKeyFromUtcParts(year: number, month: number, day: number): string {
  const utc = new Date(Date.UTC(year, month - 1, day));
  const y = utc.getUTCFullYear();
  const m = `${utc.getUTCMonth() + 1}`.padStart(2, '0');
  const d = `${utc.getUTCDate()}`.padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addCalendarDaysToDateKey(dateKey: string, days: number): string {
  const { year, month, day } = parseDateKeyParts(dateKey);
  return dateKeyFromUtcParts(year, month, day + days);
}

export function calendarDaysBetweenDateKeys(laterDateKey: string, earlierDateKey: string): number {
  const later = parseDateKeyParts(laterDateKey);
  const earlier = parseDateKeyParts(earlierDateKey);
  const laterUtc = Date.UTC(later.year, later.month - 1, later.day);
  const earlierUtc = Date.UTC(earlier.year, earlier.month - 1, earlier.day);
  return Math.round((laterUtc - earlierUtc) / (24 * 60 * 60 * 1000));
}

export function businessDateKey(
  instant: Date = new Date(),
  timeZone = 'Asia/Shanghai'
): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const year = parts.find((part) => part.type === 'year')?.value ?? '1970';
  const month = parts.find((part) => part.type === 'month')?.value ?? '01';
  const day = parts.find((part) => part.type === 'day')?.value ?? '01';
  return `${year}-${month}-${day}`;
}

export function addDateKeyDays(dateKey: string, days: number): string {
  const date = parseDateKey(dateKey);
  date.setDate(date.getDate() + days);
  return toDateKey(date);
}

export function getWeekRange(dateKey = todayKey()): { start: string; end: string } {
  const date = parseDateKey(dateKey);
  const day = date.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const start = addDateKeyDays(dateKey, mondayOffset);
  return { start, end: addDateKeyDays(start, 6) };
}

export function daysBetweenDateKeys(laterDateKey: string, earlierDateKey: string): number {
  const millisecondsPerDay = 24 * 60 * 60 * 1000;
  return Math.floor((parseDateKey(laterDateKey).getTime() - parseDateKey(earlierDateKey).getTime()) / millisecondsPerDay);
}

/** Elapsed hours between two ISO instants. Pure — does not call todayKey(). */
export function hoursBetweenInstants(laterIso: string, earlierIso: string): number {
  const later = Date.parse(laterIso);
  const earlier = Date.parse(earlierIso);
  if (!Number.isFinite(later) || !Number.isFinite(earlier)) {
    return Number.POSITIVE_INFINITY;
  }
  return (later - earlier) / (60 * 60 * 1000);
}

/** True when laterIso is within `hours` of earlierIso (inclusive of boundary). */
export function isWithinHours(earlierIso: string, laterIso: string, hours: number): boolean {
  return hoursBetweenInstants(laterIso, earlierIso) <= hours;
}

