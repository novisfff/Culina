import type { FormEvent, ReactNode } from 'react';
import type { Food, FoodPlanItem, MealType, Recipe } from '../../api/types';
import { formatDate, formatDateTime, getFoodCover, MEAL_TYPE_LABELS, todayKey } from '../../lib/ui';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
import { ActionButton, FormActions, OperationLoadingOverlay, WorkspaceModal, WorkspaceOverlayFrame } from '../ui-kit';
import { getFoodPlanDetailFacts } from './FoodPlanDetailModel';
import { FoodUiIcon } from './FoodWorkspacePrimitives';

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
  actionError?: string | null;
  /** Optional slot for candidate confirmation on non-Recipe complete (Home). */
  completeExtras?: ReactNode;
  onClose: () => void;
  onChangeForm: (form: FoodPlanDetailFormState) => void;
  onEditingChange: (isEditing: boolean) => void;
  onResetEdit: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onComplete: () => void;
  onRecordEaten?: () => void;
  onOpenMealRecord?: () => void;
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

export function FoodPlanDetailModal(props: Props) {
  const todayDate = todayKey();
  const planDateOptions = Array.from({ length: 7 }, (_, index) => addDateDays(todayDate, index));
  const cover = props.food ? getFoodCover(props.food, props.recipes) : undefined;
  const planDetailFormId = 'food-plan-detail-form';
  const facts = getFoodPlanDetailFacts(props.food, todayDate);
  const isBusy = Boolean(props.isUpdatingPlan || props.isCompleting);
  const isRecorded = props.item.status === 'cooked';

  function closeIfAllowed() {
    if (!isBusy) {
      props.onClose();
    }
  }

  const footerActions = props.isEditing ? (
    <FormActions
      className="recipe-plan-detail-actions is-editing"
      primaryLabel="保存修改"
      primaryType="submit"
      primaryForm={planDetailFormId}
      primaryPlacement="before-extra"
      primaryDisabled={Boolean(isBusy || props.item.status === 'cooked')}
      isSubmitting={Boolean(props.isUpdatingPlan)}
    >
      <ActionButton tone="secondary" type="button" onClick={props.onResetEdit} disabled={isBusy}>
        取消修改
      </ActionButton>
      <ActionButton tone="tertiary" type="button" className="ui-form-actions-danger" onClick={props.onDelete} disabled={isBusy}>
        删除
      </ActionButton>
    </FormActions>
  ) : (
    <FormActions
      className={`recipe-plan-detail-actions ${isRecorded ? 'is-recorded' : props.item.recipe_id ? 'is-recipe' : 'is-standard'}`}
      primaryLabel={isRecorded ? '餐食记录' : props.item.recipe_id ? '开始做' : '记录已吃'}
      primaryPlacement="before-extra"
      primaryDisabled={Boolean(isBusy || (isRecorded && !props.item.meal_log_id))}
      isSubmitting={Boolean(props.isCompleting)}
      onPrimary={isRecorded ? props.onOpenMealRecord : props.onComplete}
    >
      {!isRecorded && props.item.recipe_id && props.onRecordEaten ? (
        <ActionButton tone="secondary" type="button" onClick={props.onRecordEaten} disabled={isBusy}>
          直接记录已吃
        </ActionButton>
      ) : null}
      {!isRecorded ? (
        <ActionButton tone="secondary" type="button" onClick={() => props.onEditingChange(true)} disabled={isBusy}>
          修改
        </ActionButton>
      ) : null}
      <ActionButton tone="tertiary" type="button" className="ui-form-actions-danger" onClick={props.onDelete} disabled={isBusy}>
        {isRecorded ? '删除计划' : '删除'}
      </ActionButton>
    </FormActions>
  );

  return (
    <WorkspaceOverlayFrame
      rootClassName={props.overlayRootClassName}
      onClose={closeIfAllowed}
      closeOnBackdrop={!isBusy}
      busy={isBusy}
    >
      <WorkspaceModal
        title="这餐计划"
        description={`${formatDate(props.item.plan_date)} · ${MEAL_TYPE_LABELS[props.item.meal_type]}${props.item.status === 'cooked' ? ' · 已完成' : ''}`}
        eyebrow="菜单计划详情"
        onClose={closeIfAllowed}
        busy={isBusy}
        className="recipe-plan-detail-modal food-plan-detail-modal"
        footerActions={footerActions}
      >
        <form
          id={planDetailFormId}
          className={[
            'recipe-plan-detail-form',
            'ui-operation-loading-host',
            isBusy ? 'is-busy' : '',
          ].filter(Boolean).join(' ')}
          aria-busy={isBusy}
          onSubmit={props.onSubmit}
        >
          <OperationLoadingOverlay
            active={isBusy}
            title={props.isCompleting ? '正在准备这餐' : '正在保存菜单变更'}
          />
          <section className="food-plan-detail-hero">
            <div className="recipe-plan-detail-cover">
              {cover ? (
                <MediaWithPlaceholder
                  src={props.resolveAssetUrl(cover)}
                  alt={props.item.food_name}
                  loading="eager"
                />
              ) : (
                <div className="food-plan-detail-cover-fallback" aria-hidden="true">
                  <FoodUiIcon name={props.item.recipe_id ? 'cloche' : 'bowl'} />
                </div>
              )}
            </div>
            <div className="recipe-plan-detail-summary">
              <span className={props.item.status === 'cooked' ? 'badge tone-ready' : 'badge'}>
                {props.item.status === 'cooked' ? '已完成' : '计划中'}
              </span>
              <strong>{props.item.food_name}</strong>
              <p>{(props.item.note ?? '').trim() || '暂无备注'}</p>
            </div>
          </section>

          {isRecorded && props.item.meal_log_id ? (
            <section className="food-plan-detail-record-summary">
              <div>
                <strong>已关联餐食记录</strong>
                <span>{props.item.completed_at ? `记录于 ${formatDateTime(props.item.completed_at)}` : '已经记录到这顿饭'}</span>
              </div>
              <span aria-hidden="true">✓</span>
            </section>
          ) : null}

          {facts.length > 0 && (
            <dl className="food-plan-detail-facts">
              {facts.map((fact) => (
                <div key={fact.label} className="food-plan-detail-fact">
                  <dt>{fact.label}</dt>
                  <dd>{fact.value}</dd>
                </div>
              ))}
            </dl>
          )}

          {props.actionError ? (
            <p className="food-plan-detail-action-error" role="alert">
              {props.actionError}
            </p>
          ) : null}

          {!props.isEditing && props.completeExtras ? props.completeExtras : null}

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
                          disabled={isBusy || props.item.status === 'cooked'}
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
                        disabled={isBusy || props.item.status === 'cooked'}
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
                  disabled={isBusy || props.item.status === 'cooked'}
                />
              </label>
            </>
          )}
        </form>
      </WorkspaceModal>
    </WorkspaceOverlayFrame>
  );
}
