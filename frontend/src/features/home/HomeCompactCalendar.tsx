import { useId, useState } from 'react';
import { DashboardIcon } from '../../app/shellIcons';
import type { FoodPlanItem, MealType } from '../../api/types';
import { MediaWithPlaceholder } from '../../components/MediaPlaceholder';
import { MEAL_TYPE_LABELS } from '../../lib/ui';
import { formatDashboardPlanRange, getDashboardPlanProgress, type DashboardPlanDay } from './homeDashboardModel';

const MEAL_TYPE_ARTWORK: Record<MealType, string> = {
  breakfast: '/assets/home-meal-breakfast.webp',
  lunch: '/assets/home-meal-lunch.webp',
  dinner: '/assets/home-meal-dinner.webp',
  snack: '/assets/home-meal-snack.webp',
};

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
  const selectedDayProgress = getDashboardPlanProgress(
    selectedDay?.mealItems.flatMap((meal) => meal.items) ?? [],
  );
  const isSelectedDayEmpty = Boolean(selectedDay && selectedDayProgress.totalCount === 0);
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
  const selectedDayPlanSummary = isSelectedDayEmpty
    ? '当日还没有安排餐食'
    : selectedDayProgress.totalCount
      ? `${selectedDay?.plannedMealCount ?? 0} 个餐次 · ${selectedDayProgress.totalCount} 项餐食安排 · 已记录 ${selectedDayProgress.recordedCount} 项`
      : '当天还没有安排餐食';

  return (
    <section
      className={props.mobile ? 'home-compact-calendar is-mobile-calendar' : 'home-compact-calendar'}
      aria-label="七天餐食计划"
      data-testid={props.mobile ? 'mobile-week-plan' : 'home-week-plan'}
      data-state={isSelectedDayEmpty ? 'empty' : 'ready'}
    >
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
          const progress = getDashboardPlanProgress(day.mealItems.flatMap((meal) => meal.items));
          const dateLabel = day.dayLabel.endsWith(day.weekday)
            ? day.dayLabel.slice(0, -day.weekday.length)
            : day.dayLabel;
          return (
            <button
              key={day.date}
              type="button"
              aria-label={`选择 ${day.date}，${day.totalCount} 项餐食安排`}
              aria-pressed={day.date === props.selectedDate}
              className={[
                day.date === props.selectedDate ? 'is-selected' : '',
                day.isToday ? 'is-today' : '',
                progress.totalCount > 0 ? 'has-plan' : '',
                progress.state === 'partial' ? 'is-partial' : '',
                progress.state === 'complete' ? 'is-complete' : '',
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
                {progress.totalCount > 0 && progress.label}
              </span>
            </button>
          );
        })}
      </div>
      {props.mobile && (
        <button
          className={
            isSelectedDayEmpty ? 'home-compact-day-toggle is-empty-day' : 'home-compact-day-toggle'
          }
          type="button"
          aria-label={isMobileDetailExpanded ? '收起当天安排' : '展开当天安排'}
          aria-expanded={isMobileDetailExpanded}
          aria-controls={mobileDetailId}
          onClick={() => setIsMobileDetailExpanded((expanded) => !expanded)}
        >
          {isSelectedDayEmpty && (
            <img
              className="home-compact-day-toggle-art"
              src="/assets/home-week-day-empty.webp"
              alt=""
              aria-hidden="true"
              loading="lazy"
              decoding="async"
              draggable={false}
            />
          )}
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
        {isSelectedDayEmpty ? (
          <div className="home-compact-week-empty" data-testid="home-day-empty">
            <div className="home-compact-week-empty-visual" aria-hidden="true">
              <img
                className="home-compact-week-empty-art"
                src="/assets/home-week-plan-empty.webp"
                alt=""
                loading="lazy"
                decoding="async"
                draggable={false}
              />
            </div>
            <div className="home-compact-week-empty-copy">
              <strong>当日还没有安排餐食</strong>
              <p>从任意餐次开始安排，让当天吃什么更清楚。</p>
            </div>
            <div className="home-compact-week-empty-actions" aria-label="餐次安排入口">
              {selectedDay?.mealItems.map((meal) => (
                <button
                  key={meal.mealType}
                  type="button"
                  aria-label={`为${selectedDateLabel}${MEAL_TYPE_LABELS[meal.mealType]}安排餐食`}
                  onClick={() => props.onAddMeal(selectedDay.date, meal.mealType)}
                >
                  <img
                    className="home-compact-week-empty-action-art"
                    src={MEAL_TYPE_ARTWORK[meal.mealType]}
                    width="320"
                    height="320"
                    alt=""
                    aria-hidden="true"
                    loading="lazy"
                    decoding="async"
                    draggable={false}
                  />
                  <span className="home-compact-week-empty-action-copy">
                    <span className="home-compact-week-empty-action-label">
                      {MEAL_TYPE_LABELS[meal.mealType]}
                    </span>
                    <strong>
                      <DashboardIcon name="plus" />
                      安排
                    </strong>
                  </span>
                </button>
              ))}
            </div>
            <button
              className={
                props.mobile
                  ? 'home-compact-full-week-button is-mobile-button is-empty-day-button'
                  : 'home-compact-full-week-button is-empty-day-button'
              }
              type="button"
              aria-label="整周餐食计划"
              onClick={() => props.onOpenFullWeek(props.selectedDate)}
            >
                  <span>整周餐食计划</span>
              <DashboardIcon name="arrow-right" />
            </button>
          </div>
        ) : (
          <>
        {!props.mobile && (
          <div className="home-compact-day-detail-head">
            <div className="home-compact-day-summary-copy">
              <span>{selectedDay?.isToday ? '今天' : selectedDay ? `周${selectedDay.weekday}` : '已选日期'}</span>
              <strong>{selectedDateLabel}</strong>
              <small>
                {selectedDayProgress.totalCount
                  ? `${selectedDay?.plannedMealCount ?? 0} 个餐次 · ${selectedDayProgress.totalCount} 项餐食安排 · 已记录 ${selectedDayProgress.recordedCount} 项`
                  : '当天还没有安排餐食'}
              </small>
            </div>
            <button
              className="home-compact-full-week-button"
              type="button"
              aria-label="整周餐食计划"
              onClick={() => props.onOpenFullWeek(props.selectedDate)}
            >
              <span>整周餐食计划</span>
              <DashboardIcon name="arrow-right" />
            </button>
          </div>
        )}
        <div
          className={props.mobile ? 'home-compact-meal-grid is-mobile-list' : 'home-compact-meal-grid'}
          aria-label={`${selectedDateLabel}餐次安排`}
        >
          {selectedDay?.mealItems.map((meal) => {
            const progress = getDashboardPlanProgress(meal.items);
            const visibleItems = meal.items.slice(0, 2);
            const hiddenItemCount = meal.items.length - visibleItems.length;
            return (
              <section
                key={meal.mealType}
                className={[
                  'home-compact-meal-slot',
                  meal.items.length > 0 ? 'has-items' : '',
                  meal.items.length === 0 ? 'is-empty' : '',
                  hiddenItemCount > 0 ? 'has-overflow' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                {meal.items.length === 0 && (
                  <img
                    className="home-compact-meal-empty-art"
                    src={MEAL_TYPE_ARTWORK[meal.mealType]}
                    width="320"
                    height="320"
                    alt=""
                    aria-hidden="true"
                    loading="lazy"
                    decoding="async"
                    draggable={false}
                  />
                )}
                <div className="home-compact-meal-slot-head">
                  <strong>{MEAL_TYPE_LABELS[meal.mealType]}</strong>
                  {progress.totalCount > 0 && (
                    <>
                      <span className="home-compact-meal-status-long">
                        {progress.totalCount} 项餐食安排 · 已记录 {progress.recordedCount} 项
                      </span>
                      <span className="home-compact-meal-status-tablet">
                        已记 {progress.recordedCount}/{progress.totalCount}
                      </span>
                    </>
                  )}
                </div>
                <div className="home-compact-meal-items">
                  <div className="home-compact-meal-foods">
                    {visibleItems.map((item) => {
                      const title = item.recipe_title || item.food_name || '未命名餐食';
                      const coverUrl = props.resolvePlanItemCoverUrl?.(item);
                      return (
                        <button
                          key={item.id}
                          className={[
                            'home-compact-meal-item',
                            item.status === 'cooked' ? 'is-cooked' : '',
                            'has-media',
                            coverUrl ? 'has-cover' : '',
                          ]
                            .filter(Boolean)
                            .join(' ')}
                          type="button"
                          title={title}
                          aria-label={`${title}，${item.status === 'cooked' ? '已记录' : '还未记录'}`}
                          onClick={() => props.onOpenPlanDetail(item)}
                        >
                          <MediaWithPlaceholder
                            src={coverUrl}
                            alt=""
                            className="home-compact-meal-item-media"
                            imageClassName="home-compact-meal-item-image"
                            loading="lazy"
                            decoding="async"
                            showLabel={false}
                            ariaHidden
                          />
                          <span className="home-compact-meal-item-label">{title}</span>
                        </button>
                      );
                    })}
                  </div>
                  <div className="home-compact-meal-actions">
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
                      <span>{meal.items.length === 0 ? '安排' : '加餐'}</span>
                    </button>
                  </div>
                </div>
              </section>
            );
          })}
        </div>
        {props.mobile && (
          <button
            className="home-compact-full-week-button is-mobile-button"
            type="button"
            aria-label="整周餐食计划"
            onClick={() => props.onOpenFullWeek(props.selectedDate)}
          >
            <span>整周餐食计划</span>
            <DashboardIcon name="arrow-right" />
          </button>
        )}
          </>
        )}
      </div>
    </section>
  );
}
