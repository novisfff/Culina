import { DashboardIcon } from '../../app/shellIcons';
import type { DashboardPlanDay } from './homeDashboardModel';

export function HomeCompactCalendar(props: {
  days: DashboardPlanDay[];
  selectedDate: string;
  selectedSummary: string;
  onSelectDate: (date: string) => void;
  onPreviousWeek: () => void;
  onCurrentWeek: () => void;
  onNextWeek: () => void;
  onOpenFullWeek: (planDate: string) => void;
  mobile?: boolean;
}) {
  return (
    <section className="home-compact-calendar" aria-label="七天菜单">
      <header className="home-compact-calendar-head">
        <h3>这周怎么吃</h3>
        <div className="home-compact-week-controls">
          <button type="button" aria-label="上一周" onClick={props.onPreviousWeek}>
            <DashboardIcon name="chevron" />
          </button>
          <button type="button" onClick={props.onCurrentWeek}>
            回到本周
          </button>
          <button type="button" aria-label="下一周" onClick={props.onNextWeek}>
            <DashboardIcon name="chevron" />
          </button>
        </div>
      </header>
      <div
        className={props.mobile ? 'home-compact-days is-mobile-scroll' : 'home-compact-days'}
        data-testid={props.mobile ? 'mobile-home-calendar-scroll' : undefined}
      >
        {props.days.map((day) => (
          <button
            key={day.date}
            type="button"
            aria-label={`选择 ${day.date}`}
            aria-pressed={day.date === props.selectedDate}
            className={[
              day.date === props.selectedDate ? 'is-selected' : '',
              day.isToday ? 'is-today' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            onClick={() => props.onSelectDate(day.date)}
          >
            <span>{day.weekday}</span>
            <strong>{day.dayLabel}</strong>
            <i aria-label={`${day.totalCount} 项菜单`}>{day.totalCount}</i>
          </button>
        ))}
      </div>
      <div className="home-compact-day-summary">
        <p>{props.selectedSummary}</p>
        <button type="button" onClick={() => props.onOpenFullWeek(props.selectedDate)}>
          查看完整周菜单
        </button>
      </div>
    </section>
  );
}
