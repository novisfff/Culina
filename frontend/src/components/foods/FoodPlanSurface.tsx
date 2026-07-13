import type { ReactNode, Ref } from 'react';
import type { FoodPlanItem } from '../../api/types';
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
  weekSectionRef?: Ref<HTMLDivElement>;
  isUpdatingPlan?: boolean;
  isStartingPlanItem?: boolean;
  canCreatePlan?: boolean;
  mobileWeekPage?: ReactNode;
  onPreviousWeek: () => void;
  onCurrentWeek: () => void;
  onNextWeek: () => void;
  onCreatePlan: () => void;
  onOpenPlanItem: (item: FoodPlanItem) => void;
  onStartPlanItem: (item: FoodPlanItem) => void;
};

export function FoodPlanSurface(props: FoodPlanSurfaceProps) {
  if (props.mobileWeekPage) {
    return <>{props.mobileWeekPage}</>;
  }

  return (
    <section className="eat-plan-surface" aria-label="菜单">
      <div className="food-sidebar-section food-sidebar-plan-section eat-plan-surface-panel">
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
          onClick={props.onCreatePlan}
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
      </div>
    </section>
  );
}
