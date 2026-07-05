import type { FormEvent } from 'react';
import type { MealType, RecipePlanItem } from '../../api/types';
import { formatDate, MEAL_TYPE_LABELS } from '../../lib/ui';
import { ActionButton, Badge, DropdownSelect, FormActions, WorkspaceModal } from '../ui-kit';
import { DIFFICULTY_LABELS, type RecipeCardViewModel } from './workspaceModel';
import { MEAL_TYPE_OPTIONS } from './RecipeWorkspaceOptions';
import { RecipeCover, RecipeUiIcon } from './RecipeWorkspaceCards';

export type RecipePlanFormState = {
  recipeId: string;
  planDate: string;
  mealType: MealType;
  note: string;
};

export type RecipePlanDetailFormState = {
  planDate: string;
  mealType: MealType;
  note: string;
};

type RecipePlanDialogProps = {
  card: RecipeCardViewModel | null;
  form: RecipePlanFormState;
  recipeOptions: RecipeCardViewModel[];
  recipeSearch: string;
  isRecipePickerOpen: boolean;
  weekRange: { start: string; end: string };
  isUpdatingPlan?: boolean;
  hasRecipes: boolean;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onChangeForm: (form: RecipePlanFormState) => void;
  onChangeRecipeSearch: (value: string) => void;
  onSetRecipePickerOpen: (open: boolean | ((current: boolean) => boolean)) => void;
  onSelectRecipe: (card: RecipeCardViewModel) => void;
};

export function RecipePlanDialog(props: RecipePlanDialogProps) {
  return (
    <div className="workspace-overlay-root">
      <div className="workspace-overlay-backdrop" onClick={props.onClose} />
      <WorkspaceModal
        title={props.card ? `加菜：${props.card.recipe.title}` : '加菜到菜单'}
        description="选择日期和餐次后加入当前周菜单。"
        eyebrow="菜单计划"
        onClose={props.onClose}
        className="recipe-plan-modal"
      >
        <form className="recipe-plan-dialog-form" onSubmit={props.onSubmit}>
          <div className="recipe-plan-dialog-hero">
            <div className="recipe-plan-selected-cover">
              {props.card ? (
                <RecipeCover card={props.card} />
              ) : (
                <div className="recipe-plan-cover-empty">
                  <RecipeUiIcon name="clipboard" />
                </div>
              )}
            </div>
            <div>
              <span className="recipe-plan-dialog-kicker">即将加入</span>
              <strong>{props.card?.recipe.title ?? '选择一道菜'}</strong>
              <p>{props.card ? `${props.card.recipe.prep_minutes} 分钟 · ${props.card.recipe.servings} 人份 · ${DIFFICULTY_LABELS[props.card.recipe.difficulty]}` : '搜索菜名、食材或场景标签，找到要安排的菜谱。'}</p>
            </div>
          </div>

          <div className="recipe-plan-picker">
            <label htmlFor="recipe-plan-search">选择菜谱</label>
            <div className="recipe-plan-combobox">
              <RecipeUiIcon name="search" />
              <input
                id="recipe-plan-search"
                className="recipe-plan-search-input"
                value={props.isRecipePickerOpen || props.recipeSearch ? props.recipeSearch : props.card?.recipe.title ?? ''}
                placeholder="搜索菜谱、食材或标签"
                onFocus={() => {
                  props.onChangeRecipeSearch('');
                  props.onSetRecipePickerOpen(true);
                }}
                onChange={(event) => {
                  props.onChangeRecipeSearch(event.target.value);
                  props.onSetRecipePickerOpen(true);
                }}
              />
              <button
                type="button"
                className="recipe-plan-picker-toggle"
                aria-label="展开菜谱列表"
                onClick={() => props.onSetRecipePickerOpen((current) => !current)}
              >
                <RecipeUiIcon name="chevronDown" className={props.isRecipePickerOpen ? 'is-open' : undefined} />
              </button>
            </div>
            {props.isRecipePickerOpen && (
              <div className="recipe-plan-option-panel">
                {props.recipeOptions.length > 0 ? (
                  props.recipeOptions.slice(0, 8).map((card) => (
                    <button
                      key={card.recipe.id}
                      type="button"
                      className={card.recipe.id === props.form.recipeId ? 'recipe-plan-option active' : 'recipe-plan-option'}
                      onClick={() => props.onSelectRecipe(card)}
                    >
                      <RecipeCover card={card} className="recipe-plan-option-cover" />
                      <span>
                        <strong>{card.recipe.title}</strong>
                        <small>{card.recipe.prep_minutes} 分钟 · {card.recipe.servings} 人份 · {card.ingredientPreview.slice(0, 3).join('、') || '暂无原料'}</small>
                      </span>
                      <Badge className={`recipe-plan-option-status tone-${card.availability}`}>{card.availabilityLabel}</Badge>
                    </button>
                  ))
                ) : (
                  <div className="recipe-plan-option-empty">没有找到匹配的菜谱</div>
                )}
              </div>
            )}
          </div>

          <div className="recipe-plan-form-row">
            <label>
              <span>计划日期</span>
              <input
                className="text-input"
                type="date"
                value={props.form.planDate}
                min={props.weekRange.start}
                max={props.weekRange.end}
                onChange={(event) => props.onChangeForm({ ...props.form, planDate: event.target.value })}
              />
            </label>
            <label>
              <span>餐次</span>
              <DropdownSelect
                ariaLabel="选择餐别"
                placeholder="选择餐别"
                value={props.form.mealType}
                options={MEAL_TYPE_OPTIONS}
                onChange={(mealType) => props.onChangeForm({ ...props.form, mealType: mealType as MealType })}
              />
            </label>
          </div>
          <label className="recipe-plan-note-field">
            <span>备注</span>
            <input
              className="text-input"
              value={props.form.note}
              placeholder="比如：少油、提前解冻、留一份便当"
              onChange={(event) => props.onChangeForm({ ...props.form, note: event.target.value })}
            />
          </label>
          <FormActions
            className="recipe-plan-dialog-actions"
            primaryLabel="加入菜单"
            primaryType="submit"
            primaryDisabled={Boolean(props.isUpdatingPlan || !props.hasRecipes || !props.form.recipeId)}
            isSubmitting={Boolean(props.isUpdatingPlan)}
            secondaryLabel="取消"
            onSecondary={props.onClose}
          />
        </form>
      </WorkspaceModal>
    </div>
  );
}

type RecipePlanDetailDialogProps = {
  item: RecipePlanItem;
  card: RecipeCardViewModel | null;
  form: RecipePlanDetailFormState;
  weekRange: { start: string; end: string };
  isUpdatingPlan?: boolean;
  isCookingRecipe?: boolean;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onChangeForm: (form: RecipePlanDetailFormState) => void;
  onStartCook: (item: RecipePlanItem) => void;
  onDelete: (item: RecipePlanItem) => void;
};

export function RecipePlanDetailDialog(props: RecipePlanDetailDialogProps) {
  const isCooked = props.item.status === 'cooked';
  return (
    <div className="workspace-overlay-root">
      <div className="workspace-overlay-backdrop" onClick={props.onClose} />
      <WorkspaceModal
        title={props.item.recipe_title}
        description={`${formatDate(props.item.plan_date)} · ${MEAL_TYPE_LABELS[props.item.meal_type]}${isCooked ? ' · 已完成' : ''}`}
        eyebrow="菜单计划详情"
        onClose={props.onClose}
        className="recipe-plan-detail-modal"
      >
        <form className="recipe-plan-detail-form" onSubmit={props.onSubmit}>
          <section className="recipe-plan-detail-card">
            <div className="recipe-plan-detail-cover">
              {props.card ? (
                <RecipeCover card={props.card} />
              ) : (
                <div className="recipe-plan-cover-empty">
                  <RecipeUiIcon name="calendar" />
                </div>
              )}
            </div>
            <div className="recipe-plan-detail-summary">
              <span className={isCooked ? 'badge tone-ready' : 'badge'}>
                {isCooked ? '已完成' : '计划中'}
              </span>
              <strong>{props.item.recipe_title}</strong>
              <p>{(props.item.note ?? '').trim() || '暂无备注'}</p>
            </div>
          </section>

          <div className="recipe-plan-form-row">
            <label>
              <span>计划日期</span>
              <input
                className="text-input"
                type="date"
                value={props.form.planDate}
                min={props.weekRange.start}
                max={props.weekRange.end}
                onChange={(event) => props.onChangeForm({ ...props.form, planDate: event.target.value })}
                disabled={props.isUpdatingPlan || isCooked}
              />
            </label>
            <label>
              <span>餐次</span>
              <DropdownSelect
                ariaLabel="选择餐别"
                placeholder="选择餐别"
                value={props.form.mealType}
                options={MEAL_TYPE_OPTIONS}
                disabled={props.isUpdatingPlan || isCooked}
                onChange={(mealType) => props.onChangeForm({ ...props.form, mealType: mealType as MealType })}
              />
            </label>
          </div>

          <label className="recipe-plan-note-field">
            <span>备注</span>
            <input
              className="text-input"
              value={props.form.note}
              placeholder="比如：少油、提前解冻、留一份便当"
              onChange={(event) => props.onChangeForm({ ...props.form, note: event.target.value })}
              disabled={props.isUpdatingPlan || isCooked}
            />
          </label>

          <div className="recipe-plan-detail-actions">
            <ActionButton
              tone="primary"
              type="button"
              onClick={() => props.onStartCook(props.item)}
              disabled={props.isCookingRecipe || isCooked}
            >
              <RecipeUiIcon name="utensils" />
              开始做
            </ActionButton>
            <ActionButton tone="secondary" type="submit" disabled={props.isUpdatingPlan || isCooked}>
              <RecipeUiIcon name="edit" />
              保存修改
            </ActionButton>
            <ActionButton tone="tertiary" type="button" onClick={() => props.onDelete(props.item)} disabled={props.isUpdatingPlan}>
              删除
            </ActionButton>
          </div>
        </form>
      </WorkspaceModal>
    </div>
  );
}
