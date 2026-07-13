import type { FoodPlanItem } from '../../api/types';
import { DashboardIcon } from '../../app/shellIcons';
import { MEAL_TYPE_LABELS } from '../../lib/ui';

export function FoodPlanWeekMobilePage(props: {
  weekRange: { start: string; end: string };
  days: Array<{ date: string; label: string; items: FoodPlanItem[] }>;
  selectedDate: string;
  onSelectDate: (date: string) => void;
  onOpenItem: (item: FoodPlanItem) => void;
  onBack: () => void;
}) {
  const selectedDay = props.days.find((day) => day.date === props.selectedDate);

  return (
    <main className="food-plan-week-mobile-page" aria-label="手机周菜单">
      <header className="food-plan-week-mobile-head">
        <button type="button" aria-label="返回食物页" onClick={props.onBack}>
          <DashboardIcon name="chevron" />
        </button>
        <div>
          <span>完整周菜单</span>
          <h1>
            {props.weekRange.start} 至 {props.weekRange.end}
          </h1>
        </div>
      </header>
      <div className="food-plan-week-mobile-days" aria-label="选择日期">
        {props.days.map((day) => (
          <button
            key={day.date}
            type="button"
            aria-pressed={day.date === props.selectedDate}
            onClick={() => props.onSelectDate(day.date)}
          >
            <span>{day.label}</span>
            <strong>{day.items.length} 项</strong>
          </button>
        ))}
      </div>
      <section aria-label="所选日期菜单">
        {selectedDay?.items.length ? (
          selectedDay.items.map((item) => (
            <button key={item.id} type="button" onClick={() => props.onOpenItem(item)}>
              <strong>{item.food_name}</strong>
              <span>{MEAL_TYPE_LABELS[item.meal_type]}</span>
            </button>
          ))
        ) : (
          <p className="food-plan-week-mobile-empty">这一天还没有菜单安排</p>
        )}
      </section>
    </main>
  );
}
