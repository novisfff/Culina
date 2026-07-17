import { useState, type ReactNode, type Ref } from 'react';
import type { FoodPlanItem, MealType, MediaAsset } from '../../api/types';
import { buildMediaSizes, buildMediaSrcSet, resolveMediaUrl } from '../../lib/assets';
import { todayKey } from '../../lib/date';
import { MEAL_TYPE_LABELS } from '../../lib/ui';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
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
  onCreatePlan: (defaults?: Partial<{ planDate: string; mealType: MealType }>) => void;
  onOpenPlanItem: (item: FoodPlanItem) => void;
  onStartPlanItem: (item: FoodPlanItem) => void;
  getPlanItemCoverAsset?: (item: FoodPlanItem) => MediaAsset | null | undefined;
};

const TABLET_MEAL_TYPES: MealType[] = ['breakfast', 'lunch', 'dinner'];
const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const SIDEBAR_VISIBLE_PLAN_ITEMS = 3;

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

function getSidebarDateLabel(day: FoodPlanDayView) {
  const [year, month, date] = day.date.split('-').map(Number);
  return {
    weekday: WEEKDAY_LABELS[new Date(year, month - 1, date).getDay()],
    shortDate: `${String(month).padStart(2, '0')}/${String(date).padStart(2, '0')}`,
  };
}

function TabletMealGroup(props: {
  date: string;
  mealType: MealType;
  items: FoodPlanItem[];
  onCreatePlan: FoodPlanSurfaceProps['onCreatePlan'];
  onOpenPlanItem: FoodPlanSurfaceProps['onOpenPlanItem'];
  getPlanItemCoverAsset?: FoodPlanSurfaceProps['getPlanItemCoverAsset'];
}) {
  const visibleItems = props.items.slice(0, 2);
  const hiddenItemCount = props.items.length - visibleItems.length;
  return (
    <section className="food-tablet-plan-meal">
      <div className="food-tablet-plan-meal-head">
        <strong>{MEAL_TYPE_LABELS[props.mealType]}</strong>
        <span>{props.items.length > 0 ? `${props.items.length} 项` : '未安排'}</span>
      </div>
      {visibleItems.map((item) => {
        const coverAsset = props.getPlanItemCoverAsset?.(item);
        return (
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
            <span className="food-tablet-plan-item-media">
              <MediaWithPlaceholder
                src={resolveMediaUrl(coverAsset, 'thumb')}
                srcSet={buildMediaSrcSet(coverAsset)}
                sizes={buildMediaSizes('thumb')}
                alt=""
                ariaHidden
                showLabel={false}
                loading="lazy"
                decoding="async"
              />
            </span>
            <span className="food-tablet-plan-item-copy">
              <strong>{item.food_name}</strong>
              <small>{item.status === 'cooked' ? '已完成' : item.recipe_id ? '家常菜' : '待记录'}</small>
            </span>
          </article>
        );
      })}
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
              onCreatePlan={props.onCreatePlan}
              onOpenPlanItem={props.onOpenPlanItem}
              getPlanItemCoverAsset={props.getPlanItemCoverAsset}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function FoodSidebarPlanSurface(props: FoodPlanSurfaceProps) {
  const currentDate = props.todayDate ?? todayKey();
  const weekKey = `${props.weekRange.start}:${props.weekRange.end}`;
  const defaultExpandedDate = props.days.find((day) => day.date === currentDate && day.items.length > 0)?.date
    ?? props.days.find((day) => day.items.length > 0)?.date
    ?? null;
  const [selection, setSelection] = useState<{ weekKey: string; date: string | null }>({
    weekKey,
    date: defaultExpandedDate,
  });
  const [revealedItems, setRevealedItems] = useState<{ weekKey: string; date: string | null }>({
    weekKey,
    date: null,
  });
  const expandedDate = selection.weekKey === weekKey ? selection.date : defaultExpandedDate;
  const revealedDate = revealedItems.weekKey === weekKey ? revealedItems.date : null;
  const itemCount = props.days.reduce((total, day) => total + day.items.length, 0);

  return (
    <section
      className="eat-plan-surface food-sidebar-section food-sidebar-plan-section"
      aria-label="菜单"
    >
      <div className="food-sidebar-plan-heading">
        <div className="food-sidebar-plan-title">
          <strong>菜单计划</strong>
          <span>
            {props.weekRange.start.slice(5).replace('-', '/')} - {props.weekRange.end.slice(5).replace('-', '/')}
            {' · '}
            共 {itemCount} 项
          </span>
        </div>
        <ActionButton
          tone="secondary"
          type="button"
          size="compact"
          className="food-sidebar-plan-add"
          onClick={() => props.onCreatePlan()}
          disabled={props.isUpdatingPlan || props.canCreatePlan === false}
        >
          <FoodUiIcon name="plus" />
          加食物
        </ActionButton>
      </div>
      <div className="food-sidebar-plan-switcher" aria-label="切换菜单周">
        <button type="button" aria-label="上一周" onClick={props.onPreviousWeek}>
          <FoodUiIcon name="arrowLeft" />
        </button>
        <button type="button" onClick={props.onCurrentWeek}>本周</button>
        <button type="button" aria-label="下一周" onClick={props.onNextWeek}>
          <FoodUiIcon name="arrowRight" />
        </button>
      </div>
      <div
        className="food-sidebar-plan-week"
        ref={props.weekSectionRef}
        tabIndex={-1}
        data-testid="food-plan-week-section"
      >
        {props.days.map((day) => {
          const label = getSidebarDateLabel(day);
          const isEmpty = day.items.length === 0;
          const isExpanded = !isEmpty && day.date === expandedDate;
          const showAllItems = day.date === revealedDate;
          const visibleItems = showAllItems ? day.items : day.items.slice(0, SIDEBAR_VISIBLE_PLAN_ITEMS);
          const hiddenItemCount = day.items.length - visibleItems.length;
          return (
            <div
              key={day.date}
              data-date={day.date}
              className={`food-sidebar-plan-day ${isExpanded ? 'expanded' : 'collapsed'}${isEmpty ? ' is-empty' : ''}${day.date === currentDate ? ' is-today' : ''}`}
            >
              <button
                className="food-sidebar-plan-day-head"
                type="button"
                aria-expanded={isEmpty ? undefined : isExpanded}
                aria-label={isEmpty ? `添加${label.weekday} ${label.shortDate}的菜单` : undefined}
                onClick={() => {
                  if (isEmpty) {
                    props.onCreatePlan({ planDate: day.date });
                    return;
                  }
                  setSelection({ weekKey, date: isExpanded ? null : day.date });
                }}
              >
                <span className="food-sidebar-plan-day-label">
                  <strong>{label.weekday} · {label.shortDate}</strong>
                  {day.date === currentDate && <small>今天</small>}
                </span>
                <span className={`food-sidebar-plan-day-count${isEmpty ? '' : ' has-items'}`}>
                  {isEmpty ? '未安排' : `${day.items.length} 项`}
                </span>
                <FoodUiIcon name={isEmpty ? 'plus' : 'arrowRight'} />
              </button>
              {isExpanded && (
                <div className="food-sidebar-plan-day-items">
                  {visibleItems.map((item) => {
                    const coverAsset = props.getPlanItemCoverAsset?.(item);
                    const isCompleted = item.status === 'cooked';
                    const mealLabel = MEAL_TYPE_LABELS[item.meal_type];
                    return (
                      <article
                        key={item.id}
                        className={`food-sidebar-plan-item${isCompleted ? ' is-completed' : ''}`}
                        role="button"
                        tabIndex={0}
                        aria-label={`${item.food_name}，${mealLabel}${isCompleted ? '，已完成' : ''}`}
                        onClick={() => props.onOpenPlanItem(item)}
                        onKeyDown={(event) => {
                          if (event.key !== 'Enter' && event.key !== ' ') return;
                          event.preventDefault();
                          props.onOpenPlanItem(item);
                        }}
                      >
                        <span className="food-sidebar-plan-item-media">
                          <MediaWithPlaceholder
                            src={resolveMediaUrl(coverAsset, 'thumb')}
                            srcSet={buildMediaSrcSet(coverAsset)}
                            sizes={buildMediaSizes('thumb')}
                            alt=""
                            ariaHidden
                            showLabel={false}
                            loading="lazy"
                            decoding="async"
                          />
                        </span>
                        <div className="food-sidebar-plan-item-summary">
                          <strong>{item.food_name}</strong>
                          <span>{mealLabel}</span>
                        </div>
                        {isCompleted ? (
                          <span className="food-sidebar-plan-item-complete-mark" aria-hidden="true">
                            <FoodUiIcon name="check" />
                          </span>
                        ) : (
                          <button
                            className="food-sidebar-plan-item-action"
                            type="button"
                            aria-label={`${item.recipe_id ? '开始做' : '记到今天'}：${item.food_name}`}
                            disabled={props.isStartingPlanItem}
                            onClick={(event) => {
                              event.stopPropagation();
                              props.onStartPlanItem(item);
                            }}
                          >
                            <FoodUiIcon name={item.recipe_id ? 'bowl' : 'check'} />
                          </button>
                        )}
                      </article>
                    );
                  })}
                  {hiddenItemCount > 0 && (
                    <button
                      className="food-plan-more-items"
                      type="button"
                      onClick={() => setRevealedItems({ weekKey, date: day.date })}
                    >
                      查看另外 {hiddenItemCount} 项
                      <FoodUiIcon name="arrowRight" />
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
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

  return <FoodSidebarPlanSurface {...props} />;
}
