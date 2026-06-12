import type { FormEvent } from 'react';
import type { Food, FoodPlanItem, MealType, Recipe } from '../../api/types';
import { formatDate, getFoodCover, MEAL_TYPE_LABELS, todayKey } from '../../lib/ui';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
import { ActionButton, WorkspaceModal } from '../ui-kit';

export type FoodPlanDetailFormState = {
  planDate: string;
  mealType: MealType;
  note: string;
};

type Props = {
  item: FoodPlanItem;
  food: Food | null;
  recipes: Recipe[];
  form: FoodPlanDetailFormState;
  isEditing: boolean;
  isUpdatingPlan?: boolean;
  isCompleting?: boolean;
  isSupplementing?: boolean;
  onClose: () => void;
  onChangeForm: (form: FoodPlanDetailFormState) => void;
  onEditingChange: (isEditing: boolean) => void;
  onResetEdit: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onComplete: () => void;
  onSupplementRecord?: () => void;
  onDelete: () => void;
  resolveAssetUrl: (url: string) => string;
  overlayRootClassName?: string;
};

const MEAL_OPTIONS: Array<{ value: MealType; label: string }> = [
  { value: 'breakfast', label: '早餐' },
  { value: 'lunch', label: '午餐' },
  { value: 'dinner', label: '晚餐' },
  { value: 'snack', label: '加餐' },
];

function addDateDays(dateKey: string, days: number) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(year, (month || 1) - 1, day || 1);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function getDateParts(dateKey: string) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(year, (month || 1) - 1, day || 1);
  return {
    day: String(day || 1),
    month: String(month || 1),
    weekday: new Intl.DateTimeFormat('zh-CN', { weekday: 'short' }).format(date),
  };
}

function PlanIcon(props: { name: 'bowl' | 'bookOpen' | 'calendar' | 'clipboard' }) {
  const common = {
    width: 20,
    height: 20,
    viewBox: '0 0 24 24',
    fill: 'none',
    xmlns: 'http://www.w3.org/2000/svg',
    'aria-hidden': true,
  };
  const strokeProps = {
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  return (
    <svg {...common}>
      {props.name === 'bowl' && (
        <>
          <path {...strokeProps} d="M5 12h14a7 7 0 0 1-14 0Z" />
          <path {...strokeProps} d="M8 19h8" />
          <path {...strokeProps} d="M8 8c-.7-.8-.7-1.6 0-2.4" />
          <path {...strokeProps} d="M12 8c-.7-.8-.7-1.6 0-2.4" />
          <path {...strokeProps} d="M16 8c-.7-.8-.7-1.6 0-2.4" />
        </>
      )}
      {props.name === 'bookOpen' && (
        <>
          <path {...strokeProps} d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v17H6.5A2.5 2.5 0 0 0 4 22V5.5Z" />
          <path {...strokeProps} d="M20 5.5A2.5 2.5 0 0 0 17.5 3H13v17h4.5A2.5 2.5 0 0 1 20 22V5.5Z" />
        </>
      )}
      {props.name === 'calendar' && (
        <>
          <path {...strokeProps} d="M7 3v4M17 3v4M4 9h16" />
          <rect {...strokeProps} x="4" y="5" width="16" height="16" rx="2.5" />
        </>
      )}
      {props.name === 'clipboard' && (
        <>
          <path {...strokeProps} d="M9 4h6l1 2h2a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2l1-2Z" />
          <path {...strokeProps} d="M9 4h6v4H9z" />
          <path {...strokeProps} d="M9 13h6M9 17h4" />
        </>
      )}
    </svg>
  );
}

export function FoodPlanDetailModal(props: Props) {
  const todayDate = todayKey();
  const planDateOptions = Array.from({ length: 7 }, (_, index) => addDateDays(todayDate, index));
  const cover = props.food ? getFoodCover(props.food, props.recipes) : undefined;

  return (
    <div className={props.overlayRootClassName ? `workspace-overlay-root ${props.overlayRootClassName}` : 'workspace-overlay-root'}>
      <div className="workspace-overlay-backdrop" onClick={props.onClose} />
      <WorkspaceModal
        title={props.item.food_name}
        description={`${formatDate(props.item.plan_date)} · ${MEAL_TYPE_LABELS[props.item.meal_type]}${props.item.status === 'cooked' ? ' · 已完成' : ''}`}
        eyebrow="菜单计划详情"
        onClose={props.onClose}
        className="recipe-plan-detail-modal food-plan-detail-modal"
      >
        <form className="recipe-plan-detail-form" onSubmit={props.onSubmit}>
          <section className="recipe-plan-detail-card">
            <div className="recipe-plan-detail-cover">
              <MediaWithPlaceholder
                src={cover ? props.resolveAssetUrl(cover) : undefined}
                alt={props.item.food_name}
              />
            </div>
            <div className="recipe-plan-detail-summary">
              <span className={props.item.status === 'cooked' ? 'badge tone-ready' : 'badge'}>
                {props.item.status === 'cooked' ? '已完成' : '计划中'}
              </span>
              <strong>{props.item.food_name}</strong>
              <div className="recipe-plan-detail-meta">
                <span>
                  <PlanIcon name="calendar" />
                  {formatDate(props.item.plan_date)}
                </span>
                <span>
                  <PlanIcon name="bowl" />
                  {MEAL_TYPE_LABELS[props.item.meal_type]}
                </span>
                <span>
                  <PlanIcon name={props.item.recipe_id ? 'bookOpen' : 'clipboard'} />
                  {props.item.recipe_id ? '可开始做' : '可记到今天'}
                </span>
              </div>
              <p>{(props.item.note ?? '').trim() || '暂无备注'}</p>
            </div>
          </section>

          {props.isEditing && (
            <>
              <div className="recipe-plan-form-row">
                <label className="recipe-plan-date-field">
                  <span>计划日期</span>
                  <div className="recipe-plan-date-strip" role="radiogroup" aria-label="计划日期">
                    {planDateOptions.map((date) => {
                      const dateParts = getDateParts(date);
                      return (
                        <button
                          key={date}
                          type="button"
                          className={props.form.planDate === date ? 'active' : ''}
                          aria-pressed={props.form.planDate === date}
                          disabled={props.isUpdatingPlan || props.item.status === 'cooked'}
                          onClick={() => props.onChangeForm({ ...props.form, planDate: date })}
                        >
                          <span>{date === todayDate ? '今天' : dateParts.weekday}</span>
                          <strong>{dateParts.month}/{dateParts.day}</strong>
                        </button>
                      );
                    })}
                  </div>
                </label>
                <label className="recipe-plan-meal-field">
                  <span>餐次</span>
                  <div className="recipe-plan-meal-segment" role="radiogroup" aria-label="餐次">
                    {MEAL_OPTIONS.map((item) => (
                      <button
                        key={item.value}
                        type="button"
                        className={props.form.mealType === item.value ? 'active' : ''}
                        aria-pressed={props.form.mealType === item.value}
                        disabled={props.isUpdatingPlan || props.item.status === 'cooked'}
                        onClick={() => props.onChangeForm({ ...props.form, mealType: item.value })}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                </label>
              </div>
              <label className="recipe-plan-note-field">
                <span>备注</span>
                <input
                  className="text-input"
                  value={props.form.note}
                  placeholder="比如：少油、提前解冻、留一份便当"
                  onChange={(event) => props.onChangeForm({ ...props.form, note: event.target.value })}
                  disabled={props.isUpdatingPlan || props.item.status === 'cooked'}
                />
              </label>
            </>
          )}

          <div className="recipe-plan-detail-actions">
            {props.isEditing ? (
              <>
                <ActionButton tone="primary" type="submit" disabled={props.isUpdatingPlan || props.item.status === 'cooked'}>
                  保存修改
                </ActionButton>
                <ActionButton tone="secondary" type="button" onClick={props.onResetEdit} disabled={props.isUpdatingPlan}>
                  取消修改
                </ActionButton>
              </>
            ) : (
              <>
                <ActionButton tone="primary" type="button" onClick={props.onComplete} disabled={props.isCompleting || props.item.status === 'cooked'}>
                  {props.item.recipe_id ? '开始做' : '记到今天'}
                </ActionButton>
                {props.onSupplementRecord && (
                  <ActionButton tone="secondary" type="button" onClick={props.onSupplementRecord} disabled={props.isSupplementing}>
                    {props.isSupplementing ? '打开中...' : '补充记录'}
                  </ActionButton>
                )}
                <ActionButton tone="secondary" type="button" onClick={() => props.onEditingChange(true)} disabled={props.isUpdatingPlan || props.item.status === 'cooked'}>
                  修改
                </ActionButton>
              </>
            )}
            <ActionButton tone="tertiary" type="button" onClick={props.onDelete} disabled={props.isUpdatingPlan}>
              删除
            </ActionButton>
          </div>
        </form>
      </WorkspaceModal>
    </div>
  );
}
