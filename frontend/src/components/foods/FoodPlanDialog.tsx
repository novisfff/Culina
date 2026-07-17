import type { FormEvent } from 'react';
import type { Food, MealType, Recipe, MediaAsset } from '../../api/types';
import { FormActions, OperationLoadingOverlay, WorkspaceModal, WorkspaceOverlayFrame } from '../ui-kit';
import { buildMediaSizes, buildMediaSrcSet, resolveMediaUrl } from '../../lib/assets';
import { useFoodResourceSearch } from '../../hooks/useFoodResourceSearch';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
import { FOOD_TYPE_LABELS, MEAL_TYPE_LABELS } from '../../lib/ui';
import { MEAL_OPTIONS } from './FoodWorkspaceOptions';
import {
  FoodPlanDateMealNoteFields,
  FoodPlanFoodPicker,
  FoodPlanSelectedHero,
} from './FoodPlanDialogParts';
import { createFoodPlanDateOptions } from './foodPlanDateOptions';

type FoodPlanDialogProps = {
  isOpen: boolean;
  selectedPlanFood: Food | null;
  foods: Food[];
  recipes: Recipe[];
  planFoodSearch: string;
  planForm: {
    foodId?: string;
    planDate: string;
    mealType: MealType;
    note: string;
  };
  todayDate: string;
  isUpdatingPlan?: boolean;
  overlayRootClassName?: string;
  modalClassName?: string;
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
  const isUpdatingPlan = Boolean(props.isUpdatingPlan);
  const selectedPlanFoodCoverAsset = props.selectedPlanFood
    ? props.getFoodCoverAsset?.(props.selectedPlanFood, props.recipes)
    : undefined;
  const selectedPlanFoodCoverUrl =
    resolveMediaUrl(selectedPlanFoodCoverAsset, 'card') ??
    (props.selectedPlanFood ? props.resolveFoodAssetUrl(props.getFoodCover(props.selectedPlanFood, props.recipes) ?? '') : undefined);
  const selectedFoodId = props.planForm.foodId ?? props.selectedPlanFood?.id ?? '';
  const planDateOptions = createFoodPlanDateOptions(props.todayDate);
  const yesterdayDate = planDateOptions[0];

  if (!props.isOpen) {
    return null;
  }

  function closeIfAllowed() {
    if (!isUpdatingPlan) {
      props.onClose();
    }
  }

  return (
    <WorkspaceOverlayFrame
      rootClassName={props.overlayRootClassName ?? 'food-workspace-overlay-root'}
      onClose={closeIfAllowed}
      closeOnBackdrop={!isUpdatingPlan}
      busy={isUpdatingPlan}
    >
      <WorkspaceModal
        title="加食物到菜单"
        description="选择日期和餐次后加入菜单。"
        eyebrow="菜单计划"
        onClose={closeIfAllowed}
        busy={isUpdatingPlan}
        className={['recipe-plan-modal', 'food-plan-modal', props.modalClassName].filter(Boolean).join(' ')}
        footerActions={
          <FormActions
            className="recipe-plan-dialog-actions"
            primaryLabel="加入菜单"
            primaryType="submit"
            primaryForm={planFormId}
            primaryDisabled={Boolean(isUpdatingPlan || !selectedFoodId)}
            isSubmitting={isUpdatingPlan}
            secondaryLabel="取消"
            onSecondary={closeIfAllowed}
          />
        }
      >
        <form
          id={planFormId}
          className={['recipe-plan-dialog-form', 'ui-operation-loading-host', isUpdatingPlan ? 'is-busy' : ''].filter(Boolean).join(' ')}
          aria-busy={isUpdatingPlan}
          onSubmit={props.onSubmit}
        >
          <OperationLoadingOverlay active={isUpdatingPlan} title="正在加入菜单" />
          {props.selectedPlanFood ? (
            <FoodPlanSelectedHero
              food={props.selectedPlanFood}
              coverUrl={selectedPlanFoodCoverUrl}
              coverSrcSet={buildMediaSrcSet(selectedPlanFoodCoverAsset)}
              coverSizes={buildMediaSizes('card')}
              typeLabel={FOOD_TYPE_LABELS[props.normalizeFoodType(props.selectedPlanFood)]}
              sourceLabel={
                props.selectedPlanFood.source_name ||
                props.selectedPlanFood.purchase_source ||
                (props.normalizeFoodType(props.selectedPlanFood) === 'selfMade'
                  ? '家庭厨房'
                  : props.selectedPlanFood.category || '常吃食物')
              }
              capabilityLabel={props.selectedPlanFood.recipe_id ? '有菜谱' : '可直接记录'}
              iconKind={props.selectedPlanFood.recipe_id ? 'bookOpen' : 'clipboard'}
              disabled={isUpdatingPlan}
              onClear={props.onClearPlanFoodSelection}
            />
          ) : (
            <FoodPlanFoodPicker
              searchInputId="food-plan-search"
              value={selectedFoodId}
              query={props.planFoodSearch}
              loading={foodSearch.isSearching}
              loadingMore={foodSearch.isFetchingNextPage}
              hasMore={foodSearch.hasMore}
              disabled={isUpdatingPlan}
              options={foodSearch.foods.map((food) => {
                const coverAsset = props.getFoodCoverAsset?.(food, props.recipes);
                const cover = resolveMediaUrl(coverAsset, 'thumb') ?? props.resolveFoodAssetUrl(props.getFoodCover(food, props.recipes) ?? '');
                return {
                  id: food.id,
                  label: food.name,
                  description: [
                    FOOD_TYPE_LABELS[props.normalizeFoodType(food)],
                    food.source_name || food.purchase_source || food.category,
                    food.recipe_id ? '可开始做' : '可加入计划',
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
              onCompositionStart={foodSearch.onCompositionStart}
              onCompositionEnd={foodSearch.onCompositionEnd}
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
          )}

          <FoodPlanDateMealNoteFields
            planDate={props.planForm.planDate}
            mealType={props.planForm.mealType}
            note={props.planForm.note}
            todayDate={props.todayDate}
            planDateOptions={planDateOptions.map((date) => {
              const dateParts = props.getPlanDateParts(date);
              return {
                value: date,
                label: date === yesterdayDate ? '昨天' : dateParts.weekday,
                display: `${dateParts.month}/${dateParts.day}`,
              };
            })}
            mealOptions={MEAL_OPTIONS}
            notePlaceholder="比如：少油、常点套餐、提前解冻"
            disabled={isUpdatingPlan}
            onPlanDateChange={props.onPlanDateChange}
            onMealTypeChange={props.onMealTypeChange}
            onPlanNoteChange={props.onPlanNoteChange}
          />
        </form>
      </WorkspaceModal>
    </WorkspaceOverlayFrame>
  );
}
