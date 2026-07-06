import type { FormEvent } from 'react';
import type { Food, MealType, Recipe, MediaAsset } from '../../api/types';
import { FormActions, SearchableResourceSelect, WorkspaceModal } from '../ui-kit';
import { buildMediaSizes, buildMediaSrcSet, resolveMediaUrl } from '../../lib/assets';
import { useFoodResourceSearch } from '../../hooks/useFoodResourceSearch';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
import { FOOD_TYPE_LABELS, MEAL_TYPE_LABELS } from '../../lib/ui';
import { MEAL_OPTIONS } from './FoodWorkspaceOptions';
import { FoodUiIcon } from './FoodWorkspacePrimitives';

type FoodPlanDialogProps = {
  isOpen: boolean;
  selectedPlanFood: Food | null;
  foods: Food[];
  recipes: Recipe[];
  planFoodSearch: string;
  planForm: {
    foodId: string;
    planDate: string;
    mealType: MealType;
    note: string;
  };
  todayDate: string;
  planDateOptions: string[];
  isUpdatingPlan?: boolean;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onClearPlanFoodSelection: () => void;
  onPlanFoodSearchChange: (value: string) => void;
  onSelectPlanFood: (food: Food) => void;
  onPlanDateChange: (value: string) => void;
  onMealTypeChange: (value: MealType) => void;
  onPlanNoteChange: (value: string) => void;
  resolveFoodAssetUrl: (url: string) => string;
  getFoodCover: (food: Food, recipes: Recipe[]) => string | undefined;
  getFoodCoverAsset?: (food: Food, recipes: Recipe[]) => MediaAsset | undefined;
  getDefaultMealType: (food: Food) => MealType;
  getPlanDateParts: (dateKey: string) => { month: string | number; day: string | number; weekday: string };
  normalizeFoodType: (food: Food) => keyof typeof FOOD_TYPE_LABELS;
};

export function FoodPlanDialog(props: FoodPlanDialogProps) {
  const foodSearch = useFoodResourceSearch(props.planFoodSearch, {
    enabled: props.isOpen && !props.selectedPlanFood,
    fallbackFoods: props.foods,
  });
  const planFormId = 'food-plan-dialog-form';
  const selectedPlanFoodCoverAsset = props.selectedPlanFood
    ? props.getFoodCoverAsset?.(props.selectedPlanFood, props.recipes)
    : undefined;
  const selectedPlanFoodCoverUrl =
    resolveMediaUrl(selectedPlanFoodCoverAsset, 'card') ??
    (props.selectedPlanFood ? props.resolveFoodAssetUrl(props.getFoodCover(props.selectedPlanFood, props.recipes) ?? '') : undefined);

  if (!props.isOpen) {
    return null;
  }

  return (
    <div className="workspace-overlay-root food-workspace-overlay-root">
      <div className="workspace-overlay-backdrop" onClick={props.onClose} />
      <WorkspaceModal
        title="加食物到菜单"
        description="选择日期和餐次后加入菜单计划。"
        eyebrow="菜单计划"
        onClose={props.onClose}
        className="recipe-plan-modal food-plan-modal"
        footerActions={
          <FormActions
            className="recipe-plan-dialog-actions"
            primaryLabel="保存计划"
            primaryType="submit"
            primaryForm={planFormId}
            primaryDisabled={Boolean(props.isUpdatingPlan || !props.planForm.foodId)}
            isSubmitting={Boolean(props.isUpdatingPlan)}
            secondaryLabel="取消"
            onSecondary={props.onClose}
          />
        }
      >
        <form id={planFormId} className="recipe-plan-dialog-form" onSubmit={props.onSubmit}>
          {props.selectedPlanFood ? (
            <div className="recipe-plan-dialog-hero">
              <div className="recipe-plan-selected-cover">
                <MediaWithPlaceholder
                  src={selectedPlanFoodCoverUrl}
                  srcSet={buildMediaSrcSet(selectedPlanFoodCoverAsset)}
                  sizes={buildMediaSizes('card')}
                  alt={props.selectedPlanFood.name}
                />
              </div>
              <div className="recipe-plan-selected-copy">
                <span className="recipe-plan-dialog-kicker">即将加入</span>
                <strong>{props.selectedPlanFood.name}</strong>
                <div className="recipe-plan-selected-meta">
                  <span>
                    <FoodUiIcon name="home" />
                    {FOOD_TYPE_LABELS[props.normalizeFoodType(props.selectedPlanFood)]}
                  </span>
                  <span>
                    <FoodUiIcon name="cloche" />
                    {props.selectedPlanFood.source_name ||
                      props.selectedPlanFood.purchase_source ||
                      (props.normalizeFoodType(props.selectedPlanFood) === 'selfMade'
                        ? '家庭厨房'
                        : props.selectedPlanFood.category || '常吃食物')}
                  </span>
                  <span>
                    <FoodUiIcon name={props.selectedPlanFood.recipe_id ? 'bookOpen' : 'clipboard'} />
                    {props.selectedPlanFood.recipe_id ? '有菜谱' : '可直接记录'}
                  </span>
                </div>
              </div>
              <button className="recipe-plan-change-food" type="button" onClick={props.onClearPlanFoodSelection}>
                修改
              </button>
              <FoodUiIcon name="cloche" className="recipe-plan-selected-ornament" />
            </div>
          ) : (
            <div className="recipe-plan-picker">
              <label htmlFor="food-plan-search">选择食物</label>
              <SearchableResourceSelect
                searchInputId="food-plan-search"
                ariaLabel="选择食物"
                placeholder="搜索食物、来源、场景或备注"
                value={props.planForm.foodId}
                query={props.planFoodSearch}
                presentation="popover"
                loading={foodSearch.isSearching}
                loadingMore={foodSearch.isFetchingNextPage}
                hasMore={foodSearch.hasMore}
                loadMoreText="加载更多食物"
                loadingMoreText="正在加载更多食物..."
                options={foodSearch.foods.map((food) => {
                  const coverAsset = props.getFoodCoverAsset?.(food, props.recipes);
                  const cover = resolveMediaUrl(coverAsset, 'thumb') ?? props.resolveFoodAssetUrl(props.getFoodCover(food, props.recipes) ?? '');
                  return {
                    id: food.id,
                    label: food.name,
                    description: [
                      FOOD_TYPE_LABELS[props.normalizeFoodType(food)],
                      food.source_name || food.purchase_source || food.category,
                      food.recipe_id ? '可开始做' : '可记到今天',
                      MEAL_TYPE_LABELS[props.getDefaultMealType(food)],
                    ]
                      .filter(Boolean)
                      .join(' · '),
                    image: (
                      <MediaWithPlaceholder
                        src={cover}
                        srcSet={buildMediaSrcSet(coverAsset)}
                        sizes={buildMediaSizes('thumb')}
                        alt=""
                      />
                    ),
                  };
                })}
                emptyText={foodSearch.isSearching ? '正在搜索...' : '没有找到匹配的食物'}
                onSearchCompositionStart={foodSearch.onCompositionStart}
                onSearchCompositionEnd={foodSearch.onCompositionEnd}
                onQueryChange={props.onPlanFoodSearchChange}
                onLoadMore={() => {
                  if (foodSearch.hasMore && !foodSearch.isFetchingNextPage) {
                    void foodSearch.fetchNextPage();
                  }
                }}
                onChange={(foodId) => {
                  const food = foodSearch.findFoodById(foodId);
                  if (food) props.onSelectPlanFood(food);
                }}
              />
            </div>
          )}

          <div className="recipe-plan-form-row">
            <label className="recipe-plan-date-field">
              <span>计划日期</span>
              <div className="recipe-plan-date-strip" role="radiogroup" aria-label="计划日期">
                {props.planDateOptions.map((date) => {
                  const dateParts = props.getPlanDateParts(date);
                  return (
                    <button
                      key={date}
                      type="button"
                      className={props.planForm.planDate === date ? 'active' : ''}
                      aria-pressed={props.planForm.planDate === date}
                      onClick={() => props.onPlanDateChange(date)}
                    >
                      <span>{date === props.todayDate ? '今天' : dateParts.weekday}</span>
                      <strong>
                        {dateParts.month}/{dateParts.day}
                      </strong>
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
                    className={props.planForm.mealType === item.value ? 'active' : ''}
                    aria-pressed={props.planForm.mealType === item.value}
                    onClick={() => props.onMealTypeChange(item.value)}
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
              value={props.planForm.note}
              placeholder="比如：少油、常点套餐、提前解冻"
              onChange={(event) => props.onPlanNoteChange(event.target.value)}
            />
          </label>
        </form>
      </WorkspaceModal>
    </div>
  );
}
