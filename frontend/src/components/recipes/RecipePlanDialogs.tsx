import type { FormEvent } from 'react';
import type { MealType, RecipePlanItem } from '../../api/types';
import { formatDate, MEAL_TYPE_LABELS } from '../../lib/ui';
import { ActionButton, Badge, DropdownSelect, FormActions, SearchableResourceSelect, WorkspaceModal, WorkspaceOverlayFrame } from '../ui-kit';
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
  isRecipeSearchLoading?: boolean;
  isRecipeSearchLoadingMore?: boolean;
  hasMoreRecipeOptions?: boolean;
  weekRange: { start: string; end: string };
  isUpdatingPlan?: boolean;
  hasRecipes: boolean;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onChangeForm: (form: RecipePlanFormState) => void;
  onChangeRecipeSearch: (value: string) => void;
  onSetRecipePickerOpen: (open: boolean | ((current: boolean) => boolean)) => void;
  onLoadMoreRecipeOptions: () => void;
  onSelectRecipe: (card: RecipeCardViewModel) => void;
};

export function RecipePlanDialog(props: RecipePlanDialogProps) {
  const recipePlanFormId = 'recipe-plan-dialog-form';

  return (
    <WorkspaceOverlayFrame onClose={props.onClose}>
      <WorkspaceModal
        title={props.card ? `加菜：${props.card.recipe.title}` : '加菜到菜单'}
        description="选择日期和餐次后加入当前周菜单。"
        eyebrow="菜单计划"
        onClose={props.onClose}
        className="recipe-plan-modal"
        footerActions={
          <FormActions
            className="recipe-plan-dialog-actions"
            primaryLabel="加入菜单"
            primaryType="submit"
            primaryForm={recipePlanFormId}
            primaryDisabled={Boolean(props.isUpdatingPlan || !props.hasRecipes || !props.form.recipeId)}
            isSubmitting={Boolean(props.isUpdatingPlan)}
            secondaryLabel="取消"
            onSecondary={props.onClose}
          />
        }
      >
        <form id={recipePlanFormId} className="recipe-plan-dialog-form" onSubmit={props.onSubmit}>
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
            <SearchableResourceSelect
              searchInputId="recipe-plan-search"
              ariaLabel="选择菜谱"
              placeholder="搜索菜谱、食材或标签"
              value={props.form.recipeId}
              query={props.isRecipePickerOpen || props.recipeSearch ? props.recipeSearch : props.card?.recipe.title ?? ''}
              presentation="popover"
              listOpen={props.isRecipePickerOpen}
              loading={Boolean(props.isRecipeSearchLoading)}
              loadingMore={Boolean(props.isRecipeSearchLoadingMore)}
              hasMore={Boolean(props.hasMoreRecipeOptions)}
              loadMoreText="加载更多菜谱"
              loadingMoreText="正在加载更多菜谱..."
              options={props.recipeOptions.map((card) => ({
                id: card.recipe.id,
                label: card.recipe.title,
                description: `${card.recipe.prep_minutes} 分钟 · ${card.recipe.servings} 人份 · ${card.ingredientPreview.slice(0, 3).join('、') || '暂无原料'} · ${card.availabilityLabel}`,
                image: <RecipeCover card={card} />,
              }))}
              emptyText={props.isRecipeSearchLoading ? '正在搜索...' : '没有找到匹配的菜谱'}
              onSearchFocus={() => {
                props.onChangeRecipeSearch('');
                props.onSetRecipePickerOpen(true);
              }}
              onQueryChange={(value) => {
                props.onChangeRecipeSearch(value);
                props.onSetRecipePickerOpen(true);
              }}
              onLoadMore={props.onLoadMoreRecipeOptions}
              onChange={(recipeId) => {
                const card = props.recipeOptions.find((item) => item.recipe.id === recipeId);
                if (card) props.onSelectRecipe(card);
              }}
            />
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
        </form>
      </WorkspaceModal>
    </WorkspaceOverlayFrame>
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
  const recipePlanDetailFormId = 'recipe-plan-detail-dialog-form';

  return (
    <WorkspaceOverlayFrame onClose={props.onClose}>
      <WorkspaceModal
        title={props.item.recipe_title}
        description={`${formatDate(props.item.plan_date)} · ${MEAL_TYPE_LABELS[props.item.meal_type]}${isCooked ? ' · 已完成' : ''}`}
        eyebrow="菜单计划详情"
        onClose={props.onClose}
        className="recipe-plan-detail-modal"
        footerActions={
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
            <ActionButton
              tone="secondary"
              type="submit"
              form={recipePlanDetailFormId}
              disabled={props.isUpdatingPlan || isCooked}
            >
              <RecipeUiIcon name="edit" />
              保存修改
            </ActionButton>
            <ActionButton tone="tertiary" type="button" onClick={() => props.onDelete(props.item)} disabled={props.isUpdatingPlan}>
              删除
            </ActionButton>
          </div>
        }
      >
        <form id={recipePlanDetailFormId} className="recipe-plan-detail-form" onSubmit={props.onSubmit}>
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

        </form>
      </WorkspaceModal>
    </WorkspaceOverlayFrame>
  );
}
