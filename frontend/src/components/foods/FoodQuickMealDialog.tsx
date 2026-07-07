import type { FormEvent } from 'react';
import type { Food, MealType, Recipe } from '../../api/types';
import { buildMediaSizes, buildMediaSrcSet, resolveMediaUrl } from '../../lib/assets';
import { FOOD_TYPE_LABELS, getFoodCoverAsset } from '../../lib/ui';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
import { FormActions, WorkspaceModal, WorkspaceOverlayFrame } from '../ui-kit';
import { MEAL_OPTIONS } from './FoodWorkspaceOptions';
import { getPrimaryFoodActionLabel, isReadyLikeFood, normalizeFoodType } from './FoodWorkspaceHelpers';

export type FoodQuickMealDialogState = {
  action: 'cook' | 'eat';
  date: string;
  food: Food;
  mealType: MealType;
  recipeId?: string;
  deductStock?: boolean;
  stockQuantity?: string;
};

type FoodQuickMealDialogProps = {
  dialog: FoodQuickMealDialogState;
  dateOptions: string[];
  isSubmitting?: boolean;
  recipes: Recipe[];
  overlayRootClassName?: string;
  onChange: (patch: Partial<Pick<FoodQuickMealDialogState, 'date' | 'mealType' | 'deductStock' | 'stockQuantity'>>) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

function getQuickMealDateParts(dateKey: string) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(year, (month || 1) - 1, day || 1);
  return {
    day: String(day || 1),
    month: String(month || 1),
    weekday: new Intl.DateTimeFormat('zh-CN', { weekday: 'short' }).format(date),
  };
}

export function FoodQuickMealDialog(props: FoodQuickMealDialogProps) {
  const coverAsset = getFoodCoverAsset(props.dialog.food, props.recipes);
  const cover = resolveMediaUrl(coverAsset, 'card');
  const isCookAction = props.dialog.action === 'cook' && props.dialog.recipeId;
  const title = isCookAction ? '开始做这道菜' : getPrimaryFoodActionLabel(props.dialog.food);
  const isSubmitting = Boolean(props.isSubmitting);
  const quickMealFormId = 'food-workspace-quick-meal-form';

  function closeIfAllowed() {
    if (!isSubmitting) {
      props.onClose();
    }
  }

  return (
    <WorkspaceOverlayFrame
      rootClassName={props.overlayRootClassName ?? 'food-workspace-overlay-root'}
      onClose={closeIfAllowed}
      closeOnBackdrop={!isSubmitting}
    >
      <WorkspaceModal
        title={title}
        description="确认日期和餐次，点一下就完成。"
        eyebrow="快速操作"
        className="food-quick-meal-modal"
        onClose={closeIfAllowed}
        footerActions={
          <FormActions
            className="food-quick-meal-actions"
            primaryLabel={isCookAction ? '开始做' : '记录这一餐'}
            primaryType="submit"
            primaryForm={quickMealFormId}
            isSubmitting={isSubmitting}
            secondaryLabel="取消"
            onSecondary={closeIfAllowed}
          />
        }
      >
        <form id={quickMealFormId} className="food-quick-meal-form" onSubmit={props.onSubmit}>
          <div className="food-quick-meal-hero">
            <span className="food-quick-meal-cover">
              <MediaWithPlaceholder
                src={cover}
                srcSet={buildMediaSrcSet(coverAsset)}
                sizes={buildMediaSizes('thumb')}
                alt=""
              />
            </span>
            <span className="food-quick-meal-copy">
              <strong>{props.dialog.food.name}</strong>
              <small>
                {FOOD_TYPE_LABELS[normalizeFoodType(props.dialog.food)]}
                {props.dialog.food.source_name || props.dialog.food.purchase_source ? ` · ${props.dialog.food.source_name || props.dialog.food.purchase_source}` : ''}
              </small>
            </span>
          </div>

          <div className="food-quick-meal-field">
            <span>日期</span>
            <div className="food-quick-meal-date-strip" role="listbox" aria-label="选择日期">
              {props.dateOptions.map((dateKey, index) => {
                const parts = getQuickMealDateParts(dateKey);
                const label = index === 0 ? '今天' : index === 1 ? '明天' : parts.weekday;
                return (
                  <button
                    key={dateKey}
                    type="button"
                    className={props.dialog.date === dateKey ? 'active' : ''}
                    disabled={isSubmitting}
                    onClick={() => props.onChange({ date: dateKey })}
                  >
                    <span>{label}</span>
                    <strong>{parts.month}/{parts.day}</strong>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="food-quick-meal-field">
            <span>餐次</span>
            <div className="food-quick-meal-segments" role="radiogroup" aria-label="选择餐次">
              {MEAL_OPTIONS.map((meal) => (
                <button
                  key={meal.value}
                  type="button"
                  className={props.dialog.mealType === meal.value ? 'active' : ''}
                  disabled={isSubmitting}
                  onClick={() => props.onChange({ mealType: meal.value })}
                >
                  {meal.label}
                </button>
              ))}
            </div>
          </div>

          {!isCookAction && isReadyLikeFood(props.dialog.food) && props.dialog.food.stock_quantity != null && props.dialog.food.stock_quantity > 0 && (
            <div className="food-quick-meal-stock-box">
              <label className="food-quick-meal-stock-toggle">
                <input
                  type="checkbox"
                  checked={props.dialog.deductStock ?? true}
                  disabled={isSubmitting}
                  onChange={(event) => props.onChange({ deductStock: event.target.checked })}
                />
                <span>
                  <strong>同步扣减库存</strong>
                  <small>当前剩余 {props.dialog.food.stock_quantity}{props.dialog.food.stock_unit || '份'}</small>
                </span>
              </label>
              {(props.dialog.deductStock ?? true) && (
                <label className="food-quick-meal-stock-quantity">
                  <span>扣减数量</span>
                  <input
                    className="text-input"
                    type="number"
                    min="0.1"
                    step="0.5"
                    value={props.dialog.stockQuantity ?? '1'}
                    disabled={isSubmitting}
                    onChange={(event) => props.onChange({ stockQuantity: event.target.value })}
                  />
                  <em>{props.dialog.food.stock_unit || '份'}</em>
                </label>
              )}
            </div>
          )}
        </form>
      </WorkspaceModal>
    </WorkspaceOverlayFrame>
  );
}
