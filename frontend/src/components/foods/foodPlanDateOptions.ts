import { addDateKeyDays } from '../../lib/date';

const FOOD_PLAN_DATE_OPTION_COUNT = 7;

export function createFoodPlanDateOptions(todayDate: string) {
  const startDate = addDateKeyDays(todayDate, -1);
  return Array.from(
    { length: FOOD_PLAN_DATE_OPTION_COUNT },
    (_, index) => addDateKeyDays(startDate, index),
  );
}

export function resolveFoodPlanDate(candidate: string | undefined, todayDate: string) {
  const options = createFoodPlanDateOptions(todayDate);
  return candidate && options.includes(candidate) ? candidate : todayDate;
}
