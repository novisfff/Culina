import { useState, type ReactNode, type Ref } from 'react';
import type { FoodPlanItem, MealType } from '../../api/types';
import { todayKey } from '../../lib/date';
import { MEAL_TYPE_LABELS } from '../../lib/ui';
import { ActionButton } from '../ui-kit';
import { FoodUiIcon } from './FoodWorkspacePrimitives';

export type FoodPlanDayView = {
  date: string;
  label: string;
  items: FoodPlanItem[];
};

export type FoodPlanSurfaceProps = {
  weekRange: { start: string; end: string };
  days: FoodPlanDayView[];
  presentation?: 'sidebar' | 'tabletLandscape';
  todayDate?: string;
  weekSectionRef?: Ref<HTMLDivElement>;
  isUpdatingPlan?: boolean;
  isStartingPlanItem?: boolean;
  canCreatePlan?: boolean;
  mobileWeekPage?: ReactNode;
  onPreviousWeek: () => void;
  onCurrentWeek: () => void;
  onNextWeek: () => void;
  onCreatePlan: (defaults?: { planDate: string; mealType: MealType }) => void;
  onOpenPlanItem: (item: FoodPlanItem) => void;
  onStartPlanItem: (item: FoodPlanItem) => void;
};

const TABLET_MEAL_TYPES: MealType[] = ['breakfast', 'lunch', 'dinner'];
const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function resolveTabletPlanSelectedDate(days: FoodPlanDayView[], currentDate: string) {
  return days.find((day) => day.date === currentDate)?.date
    ?? days.find((day) => day.items.length > 0)?.date
    ?? days[0]?.date
    ?? currentDate;
}

function getTabletDateLabel(day: FoodPlanDayView, currentDate: string) {
  const [year, month, date] = day.date.split('-').map(Number);
  return {
    date: String(date),
    meta: day.items.length > 0
      ? `${day.items.length} 项`
      : day.date === currentDate
        ? '今天'
        : WEEKDAY_LABELS[new Date(year, month - 1, date).getDay()],
  };
}

function TabletMealGroup(props: {
  date: string;
  mealType: MealType;
  items: FoodPlanItem[];
  isStartingPlanItem?: boolean;
  onCreatePlan: FoodPlanSurfaceProps['onCreatePlan'];
  onOpenPlanItem: FoodPlanSurfaceProps['onOpenPlanItem'];
  onStartPlanItem: FoodPlanSurfaceProps['onStartPlanItem'];
}) {
  const visibleItems = props.items.slice(0, 2);
  const hiddenItemCount = props.items.length - visibleItems.length;
  return (
    <section className="food-tablet-plan-meal">
      <div className="food-tablet-plan-meal-head">
        <strong>{MEAL_TYPE_LABELS[props.mealType]}</strong>
        <span>{props.items.length > 0 ? `${props.items.length} 项` : '未安排'}</span>
      </div>
      {visibleItems.map((item) => (
        <article
          key={item.id}
          className="food-tablet-plan-item"
          role="button"
          tabIndex={0}
          onClick={() => props.onOpenPlanItem(item)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            props.onOpenPlanItem(item);
          }}
        >
          <span>
            <strong>{item.food_name}</strong>
            <small>{item.status === 'cooked' ? '已完成' : item.recipe_id ? '家常菜' : '待记录'}</small>
          </span>
          <button
            type="button"
            disabled={props.isStartingPlanItem || item.status === 'cooked'}
            onClick={(event) => {
              event.stopPropagation();
              props.onStartPlanItem(item);
            }}
          >
            {item.recipe_id ? '开始做' : '记到今天'}
          </button>
        </article>
      ))}
      {hiddenItemCount > 0 && (
        <button
          className="food-tablet-plan-more"
          type="button"
          onClick={() => props.onOpenPlanItem(props.items[2])}
        >
          另有 {hiddenItemCount} 项
        </button>
      )}
      {props.items.length === 0 && (
        <button
          className="food-tablet-plan-empty-meal"
          type="button"
          aria-label={`添加${MEAL_TYPE_LABELS[props.mealType]}`}
          onClick={() => props.onCreatePlan({ planDate: props.date, mealType: props.mealType })}
        >
          <FoodUiIcon name="plus" />
          未安排
        </button>
      )}
    </section>
  );
}

function FoodTabletPlanSurface(props: FoodPlanSurfaceProps) {
  const currentDate = props.todayDate ?? todayKey();
  const weekKey = `${props.weekRange.start}:${props.weekRange.end}`;
  const defaultDate = resolveTabletPlanSelectedDate(props.days, currentDate);
  const [selection, setSelection] = useState({ weekKey, date: defaultDate });
  const selectedDate = selection.weekKey === weekKey && props.days.some((day) => day.date === selection.date)
    ? selection.date
    : defaultDate;
  const selectedDay = props.days.find((day) => day.date === selectedDate) ?? props.days[0];
  const mealTypes = selectedDay?.items.some((item) => item.meal_type === 'snack')
    ? [...TABLET_MEAL_TYPES, 'snack' as const]
    : TABLET_MEAL_TYPES;

  return (
    <section className="food-tablet-plan-section" aria-label="菜单">
      <div className="food-tablet-plan-toolbar">
        <div className="food-tablet-plan-title">
          <strong>本周菜单</strong>
          <span>{props.weekRange.start.slice(5).replace('-', '/')} - {props.weekRange.end.slice(5).replace('-', '/')}</span>
        </div>
        <div className="recipe-plan-switcher food-tablet-plan-switcher" aria-label="切换菜单周">
          <button type="button" onClick={props.onPreviousWeek}><FoodUiIcon name="arrowLeft" />上一周</button>
          <button type="button" onClick={props.onCurrentWeek}>本周</button>
          <button type="button" onClick={props.onNextWeek}>下一周<FoodUiIcon name="arrowRight" /></button>
        </div>
        <ActionButton
          tone="secondary"
          type="button"
          className="food-tablet-plan-add"
          onClick={() => props.onCreatePlan()}
          disabled={props.isUpdatingPlan || props.canCreatePlan === false}
        >
          <FoodUiIcon name="plus" />
          加食物
        </ActionButton>
      </div>
      <div className="food-tablet-plan-date-rail" aria-label="选择菜单日期">
        {props.days.map((day) => {
          const label = getTabletDateLabel(day, currentDate);
          return (
            <button
              key={day.date}
              type="button"
              data-date={day.date}
              aria-pressed={day.date === selectedDate}
              onClick={() => setSelection({ weekKey, date: day.date })}
            >
              <strong>{label.date}</strong>
              <span>{label.meta}</span>
            </button>
          );
        })}
      </div>
      {selectedDay && (
        <div
          className={`food-tablet-plan-day-summary${mealTypes.length > 3 ? ' has-snack' : ''}`}
          ref={props.weekSectionRef}
          tabIndex={-1}
          data-testid="food-tablet-plan-day-summary"
        >
          {mealTypes.map((mealType) => (
            <TabletMealGroup
              key={mealType}
              date={selectedDay.date}
              mealType={mealType}
              items={selectedDay.items.filter((item) => item.meal_type === mealType)}
              isStartingPlanItem={props.isStartingPlanItem}
              onCreatePlan={props.onCreatePlan}
              onOpenPlanItem={props.onOpenPlanItem}
              onStartPlanItem={props.onStartPlanItem}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export function FoodPlanSurface(props: FoodPlanSurfaceProps) {
  if (props.mobileWeekPage) {
    return <>{props.mobileWeekPage}</>;
  }

  if (props.presentation === 'tabletLandscape') {
    return <FoodTabletPlanSurface {...props} />;
  }

  return (
    <section
      className="eat-plan-surface food-sidebar-section food-sidebar-plan-section"
      aria-label="菜单"
    >
      <div className="food-sidebar-section-head">
        <strong>菜单计划</strong>
        <span>
          {props.weekRange.start.slice(5).replace('-', '/')} - {props.weekRange.end.slice(5).replace('-', '/')}
        </span>
      </div>
      <div className="recipe-plan-switcher food-plan-switcher" aria-label="切换菜单周">
        <button type="button" onClick={props.onPreviousWeek}>
          <FoodUiIcon name="arrowLeft" />
          上一周
        </button>
        <button type="button" onClick={props.onCurrentWeek}>
          本周
        </button>
        <button type="button" onClick={props.onNextWeek}>
          下一周
          <FoodUiIcon name="arrowRight" />
        </button>
      </div>
      <ActionButton
        tone="primary"
        type="button"
        size="compact"
        className="recipe-plan-add-button food-plan-add-button"
        onClick={() => props.onCreatePlan()}
        disabled={props.isUpdatingPlan || props.canCreatePlan === false}
      >
        <FoodUiIcon name="plus" />
        加食物
      </ActionButton>
      <div
        className="recipe-plan-week food-plan-week"
        ref={props.weekSectionRef}
        tabIndex={-1}
        data-testid="food-plan-week-section"
      >
        {props.days.map((day) => (
          <div key={day.date} className="recipe-plan-day expanded">
            <button className="recipe-plan-day-head" type="button">
              <strong>{day.label}</strong>
              <span>{day.items.length > 0 ? `${day.items.length} 项` : '未安排'}</span>
            </button>
            {day.items.length > 0 ? (
              day.items.map((item) => (
                <article
                  key={item.id}
                  className="recipe-plan-item"
                  role="button"
                  tabIndex={0}
                  onClick={() => props.onOpenPlanItem(item)}
                >
                  <div className="recipe-plan-item-summary">
                    <strong>{item.food_name}</strong>
                    <span>
                      {MEAL_TYPE_LABELS[item.meal_type]}
                      {item.status === 'cooked' ? ' · 已完成' : ''}
                    </span>
                  </div>
                  <button
                    className="recipe-plan-item-detail-button"
                    type="button"
                    aria-label={`${item.recipe_id ? '开始做' : '记到今天'}：${item.food_name}`}
                    disabled={props.isStartingPlanItem || item.status === 'cooked'}
                    onClick={(event) => {
                      event.stopPropagation();
                      props.onStartPlanItem(item);
                    }}
                  >
                    <FoodUiIcon name={item.recipe_id ? 'bowl' : 'check'} />
                  </button>
                </article>
              ))
            ) : (
              <div className="recipe-plan-empty-row">未安排</div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
