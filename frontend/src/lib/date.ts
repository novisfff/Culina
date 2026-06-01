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
