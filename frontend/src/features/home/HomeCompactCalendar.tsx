import { useId, useState } from 'react';
import { DashboardIcon } from '../../app/shellIcons';
import type { FoodPlanItem, MealType } from '../../api/types';
import { MEAL_TYPE_LABELS } from '../../lib/ui';
import { formatDashboardPlanRange, type DashboardPlanDay } from './homeDashboardModel';

export function HomeCompactCalendar(props: {
  days: DashboardPlanDay[];
  selectedDate: string;
  selectedSummary: string;
  onSelectDate: (date: string) => void;
  onPreviousWeek: () => void;
  onCurrentWeek: () => void;
  onNextWeek: () => void;
  onOpenFullWeek: (planDate: string) => void;
  onAddMeal: (planDate: string, mealType: MealType) => void;
  onOpenPlanDetail: (item: FoodPlanItem) => void;
  onOpenMealPlans: (planDate: string, mealType: MealType, items: FoodPlanItem[]) => void;
  resolvePlanItemCoverUrl?: (item: FoodPlanItem) => string | undefined;
  mobile?: boolean;
}) {
  const [isMobileDetailExpanded, setIsMobileDetailExpanded] = useState(false);
  const mobileDetailId = useId();
  const selectedDay = props.days.find((day) => day.date === props.selectedDate);
  const isCurrentWeek = props.days.some((day) => day.isToday);
  const selectedDateLabel = selectedDay
    ? selectedDay.dayLabel.endsWith(selectedDay.weekday)
      ? selectedDay.dayLabel.slice(0, -selectedDay.weekday.length)
      : selectedDay.dayLabel
    : props.selectedSummary;
  const weekDateRange =
    props.days.length > 0
      ? formatDashboardPlanRange({ start: props.days[0].date, end: props.days[props.days.length - 1].date })
      : '';
  const selectedDayTitle = selectedDay
    ? `${selectedDay.isToday ? '今天' : `周${selectedDay.weekday}`} · ${selectedDateLabel}`
    : '已选日期';
  const selectedDayPlanSummary = selectedDay?.totalCount
    ? `已安排 ${selectedDay.plannedMealCount} 个餐次 · 共 ${selectedDay.totalCount} 项`
    : '当天还没有安排';

  return (
    <section className="home-compact-calendar" aria-label="七天菜单">
      <header className="home-compact-calendar-head">
        <div className="home-compact-calendar-title">
          <span className="home-compact-calendar-title-icon" aria-hidden="true">
            <DashboardIcon name="calendar" />
          </span>
          <div>
            <h3>这周怎么吃</h3>
            <p>快速看看每天的餐食安排</p>
          </div>
        </div>
        {weekDateRange && <span className="home-compact-week-range">{weekDateRange}</span>}
        {props.mobile ? (
          <>
            <div className="home-compact-week-controls is-mobile-controls">
              <button type="button" aria-label="上一周" onClick={props.onPreviousWeek}>
                <DashboardIcon name="arrow-left" />
              </button>
              <button type="button" aria-label="下一周" onClick={props.onNextWeek}>
                <DashboardIcon name="arrow-right" />
              </button>
            </div>
            {!isCurrentWeek && (
              <button className="home-compact-mobile-current-week" type="button" onClick={props.onCurrentWeek}>
                回到本周
              </button>
            )}
          </>
        ) : (
          <div className="home-compact-week-controls">
            <button type="button" aria-label="上一周" onClick={props.onPreviousWeek}>
              <DashboardIcon name="arrow-left" />
            </button>
            <button className="home-compact-current-week" type="button" onClick={props.onCurrentWeek}>
              本周
            </button>
            <button type="button" aria-label="下一周" onClick={props.onNextWeek}>
              <DashboardIcon name="arrow-right" />
            </button>
          </div>
        )}
      </header>
      <div
        className={props.mobile ? 'home-compact-days is-mobile-grid' : 'home-compact-days'}
        data-testid={props.mobile ? 'mobile-home-calendar-days' : undefined}
      >
        {props.days.map((day) => {
          const dateLabel = day.dayLabel.endsWith(day.weekday)
            ? day.dayLabel.slice(0, -day.weekday.length)
            : day.dayLabel;
          return (
            <button
              key={day.date}
              type="button"
              aria-label={`选择 ${day.date}，${day.totalCount} 项菜单`}
              aria-pressed={day.date === props.selectedDate}
              className={[
                day.date === props.selectedDate ? 'is-selected' : '',
                day.isToday ? 'is-today' : '',
                day.totalCount > 0 ? 'has-plan' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => props.onSelectDate(day.date)}
            >
              <span className="home-compact-day-date">
                <span className="home-compact-day-weekday">{day.isToday ? '今天' : `周${day.weekday}`}</span>
                <strong>
                  {props.mobile ? (
                    <span className="home-compact-mobile-day-number">{Number.parseInt(day.date.slice(-2), 10)}</span>
                  ) : (
                    dateLabel
                  )}
                </strong>
              </span>
              <span className="home-compact-day-status">
                <i aria-hidden="true" />
                {day.totalCount > 0 ? `${day.totalCount} 项安排` : '待安排'}
              </span>
            </button>
          );
        })}
      </div>
      {props.mobile && (
        <button
          className="home-compact-day-toggle"
          type="button"
          aria-label={isMobileDetailExpanded ? '收起当天安排' : '展开当天安排'}
          aria-expanded={isMobileDetailExpanded}
          aria-controls={mobileDetailId}
          onClick={() => setIsMobileDetailExpanded((expanded) => !expanded)}
        >
          <span className="home-compact-day-toggle-copy">
            <strong>{selectedDayTitle}</strong>
            <small>{selectedDayPlanSummary}</small>
          </span>
          <span className="home-compact-day-toggle-action">
            <span>{isMobileDetailExpanded ? '收起' : '展开安排'}</span>
            <DashboardIcon name="arrow-right" />
          </span>
        </button>
      )}
      <div
        id={props.mobile ? mobileDetailId : undefined}
        className={props.mobile ? 'home-compact-day-detail is-mobile-collapsible' : 'home-compact-day-detail'}
        hidden={Boolean(props.mobile && !isMobileDetailExpanded)}
      >
        {!props.mobile && (
          <div className="home-compact-day-detail-head">
            <div className="home-compact-day-summary-copy">
              <span>{selectedDay?.isToday ? '今天' : selectedDay ? `周${selectedDay.weekday}` : '已选日期'}</span>
              <strong>{selectedDateLabel}</strong>
              <small>
                {selectedDay?.totalCount
                  ? `${selectedDay.plannedMealCount} 个餐次 · ${selectedDay.totalCount} 项`
                  : '当天还没有安排'}
              </small>
            </div>
            <button
              className="home-compact-full-week-button"
              type="button"
              aria-label="完整周菜单"
              onClick={() => props.onOpenFullWeek(props.selectedDate)}
            >
              <span>完整周菜单</span>
              <DashboardIcon name="arrow-right" />
            </button>
          </div>
        )}
        <div
          className={props.mobile ? 'home-compact-meal-grid is-mobile-list' : 'home-compact-meal-grid'}
          aria-label={`${selectedDateLabel}餐次安排`}
        >
          {selectedDay?.mealItems.map((meal) => {
            const visibleItems = meal.items.slice(0, props.mobile ? 1 : 2);
            const hiddenItemCount = meal.items.length - visibleItems.length;
            return (
              <section
                key={meal.mealType}
                className={meal.items.length > 0 ? 'home-compact-meal-slot has-items' : 'home-compact-meal-slot'}
              >
                <div className="home-compact-meal-slot-head">
                  <strong>{MEAL_TYPE_LABELS[meal.mealType]}</strong>
                  <span>{meal.items.length > 0 ? `${meal.items.length} 项` : '未安排'}</span>
                </div>
                <div className="home-compact-meal-items">
                  {visibleItems.map((item) => {
                    const title = item.recipe_title || item.food_name || '未命名餐食';
                    const coverUrl = props.mobile ? props.resolvePlanItemCoverUrl?.(item) : undefined;
                    return (
                      <button
                        key={item.id}
                        className={[
                          'home-compact-meal-item',
                          item.status === 'cooked' ? 'is-cooked' : '',
                          coverUrl ? 'has-image' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        type="button"
                        title={title}
                        onClick={() => props.onOpenPlanDetail(item)}
                      >
                        {coverUrl && (
                          <img
                            className="home-compact-meal-item-image"
                            src={coverUrl}
                            alt=""
                            loading="lazy"
                            decoding="async"
                          />
                        )}
                        <span className="home-compact-meal-item-label">{title}</span>
                      </button>
                    );
                  })}
                  {hiddenItemCount > 0 && (
                    <button
                      className="home-compact-meal-more"
                      type="button"
                      aria-label={`查看${MEAL_TYPE_LABELS[meal.mealType]}全部 ${meal.items.length} 项安排`}
                      onClick={() => props.onOpenMealPlans(selectedDay.date, meal.mealType, meal.items)}
                    >
                      +{hiddenItemCount}
                    </button>
                  )}
                  <button
                    className="home-compact-meal-add"
                    type="button"
                    aria-label={`为${selectedDateLabel}${MEAL_TYPE_LABELS[meal.mealType]}安排餐食`}
                    onClick={() => props.onAddMeal(selectedDay.date, meal.mealType)}
                  >
                    <DashboardIcon name="plus" />
                    {meal.items.length === 0 && <span>安排</span>}
                  </button>
                </div>
              </section>
            );
          })}
        </div>
        {props.mobile && (
          <button
            className="home-compact-full-week-button is-mobile-button"
            type="button"
            aria-label="完整周菜单"
            onClick={() => props.onOpenFullWeek(props.selectedDate)}
          >
            <span>完整周菜单</span>
            <DashboardIcon name="arrow-right" />
          </button>
        )}
      </div>
    </section>
  );
}
