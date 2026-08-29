import { useCallback } from 'react';
import { addDateKeyDays } from '../lib/date';

export function useAppFoodPlanWeekNavigation(args: {
  weekRange: { start: string; end: string };
  today: string;
  setSelectedDate: (date: string) => void;
}) {
  const previousWeek = useCallback(() => args.setSelectedDate(addDateKeyDays(args.weekRange.start, -7)), [args.setSelectedDate, args.weekRange.start]);
  const currentWeek = useCallback(() => args.setSelectedDate(args.today), [args.setSelectedDate, args.today]);
  const nextWeek = useCallback(() => args.setSelectedDate(addDateKeyDays(args.weekRange.end, 1)), [args.setSelectedDate, args.weekRange.end]);
  return { previousWeek, currentWeek, nextWeek };
}
