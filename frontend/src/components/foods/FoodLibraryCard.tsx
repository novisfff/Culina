import { memo, type KeyboardEvent, type RefObject } from 'react';
import type { Food, MealLog, MealType, MediaAsset, Recipe } from '../../api/types';
import { buildMediaSizes, buildMediaSrcSet, resolveMediaUrl } from '../../lib/assets';
import { FOOD_TYPE_LABELS, MEAL_TYPE_LABELS, getFoodCoverAsset } from '../../lib/ui';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
import { ActionButton } from '../ui-kit';
import { usePagedList } from '../../hooks/usePagedList';
import {
  describeExpiry,
  getDefaultMealType,
  getFoodGovernanceIssueLabels,
  getFoodSceneTags,
  getFoodStatus,
  getMealUsage,
  getPrimaryFoodActionLabel,
  isReadyLikeFood,
  normalizeFoodType,
  chunkFoodCardPages,
} from './FoodWorkspaceHelpers';
import { FoodUiIcon } from './FoodWorkspacePrimitives';

export type FoodLibraryCardViewModel = {
  food: Food;
  usageCount: number;
  coverAsset?: MediaAsset;
  cover?: string;
  normalizedType: ReturnType<typeof normalizeFoodType>;
  defaultMealType: MealType;
  status: ReturnType<typeof getFoodStatus>;
  compactLabels: string[];
  primaryActionLabel: string;
  shoppingEligible: boolean;
};

export type FoodLibraryCardActions = {
  onOpenDetail: (food: Food) => void;
  onToggleFavorite: (food: Food) => void;
  onPrimaryAction: (food: Food, mealType: MealType) => void;
  onAddShopping: (food: Food) => void;
  onAddPlan: (food: Food) => void;
};

export function buildFoodLibraryCardViewModel(
  food: Food,
  recipes: Recipe[],
  mealLogs: MealLog[],
): FoodLibraryCardViewModel {
  const usage = getMealUsage(food, mealLogs);
  const coverAsset = getFoodCoverAsset(food, recipes);
  const governanceIssueLabels = getFoodGovernanceIssueLabels(food, recipes);
  const normalizedType = normalizeFoodType(food);
  return {
    food,
    usageCount: usage.count,
    coverAsset,
    cover: resolveMediaUrl(coverAsset, 'card'),
    normalizedType,
    defaultMealType: getDefaultMealType(food),
    status: getFoodStatus(food, usage, describeExpiry(food), recipes),
    compactLabels: governanceIssueLabels.length > 0
      ? governanceIssueLabels
      : [...getFoodSceneTags(food), food.rating != null ? `${food.rating} 分` : null]
          .filter((item): item is string => Boolean(item)),
    primaryActionLabel: normalizedType === 'selfMade' && food.recipe_id
      ? '开始做'
      : getPrimaryFoodActionLabel(food),
    shoppingEligible: isReadyLikeFood(food) || (normalizedType === 'selfMade' && Boolean(food.recipe_id)),
  };
}

function openFromKeyboard(
  event: KeyboardEvent<HTMLElement>,
  onOpen: () => void,
) {
  if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
  event.preventDefault();
  onOpen();
}

export const FoodLibraryCard = memo(function FoodLibraryCard({
  model,
  actionsRef,
  isUpdatingFavorite,
  isQuickAdding,
}: {
  model: FoodLibraryCardViewModel;
  actionsRef: RefObject<FoodLibraryCardActions>;
  isUpdatingFavorite: boolean;
  isQuickAdding: boolean;
}) {
  const { food } = model;
  const actions = () => actionsRef.current;

  return (
    <article
      className={`food-work-card tone-${model.normalizedType}`}
      role="button"
      tabIndex={0}
      aria-label={`查看详情：${food.name}`}
      onClick={() => actions()?.onOpenDetail(food)}
      onKeyDown={(event) => openFromKeyboard(event, () => actions()?.onOpenDetail(food))}
    >
      <div className="food-work-card-media">
        <MediaWithPlaceholder
          src={model.cover}
          srcSet={buildMediaSrcSet(model.coverAsset)}
          sizes={buildMediaSizes('card')}
          alt={food.name}
          decodeBeforeReveal
        />
        <span className="food-type-overlay">{FOOD_TYPE_LABELS[model.normalizedType]}</span>
        <button
          className={food.favorite ? 'food-favorite-chip active' : 'food-favorite-chip'}
          type="button"
          aria-label={food.favorite ? '取消收藏' : '收藏食物'}
          disabled={isUpdatingFavorite}
          onClick={(event) => {
            event.stopPropagation();
            actions()?.onToggleFavorite(food);
          }}
        >
          <FoodUiIcon name={food.favorite ? 'heartFilled' : 'heart'} />
        </button>
      </div>
      <div className="food-work-card-body">
        <div className="food-card-title-row">
          <div><h3>{food.name}</h3></div>
          {food.price != null && <strong className="food-price">¥{food.price}</strong>}
        </div>
        <p className="food-card-meta">
          {[food.source_name || food.purchase_source, food.category, model.usageCount > 0 ? `吃过 ${model.usageCount} 次` : '还未记录'].filter(Boolean).join(' · ')}
        </p>
        <div className="food-card-status-row">
          <span className={`food-card-status tone-${model.status.tone}`}>
            <strong>{model.status.label}</strong>
            <small>{model.status.detail}</small>
          </span>
          {food.suitable_meal_types.length > 0 && (
            <span className="food-card-meal-summary">
              {food.suitable_meal_types.map((meal) => MEAL_TYPE_LABELS[meal]).join(' / ')}
            </span>
          )}
        </div>
        {model.compactLabels.length > 0 && (
          <div className="food-card-issue-row" aria-label="待完善项目">
            {model.compactLabels.map((label) => <span key={label}>{label}</span>)}
          </div>
        )}
        <div className={`food-card-actions${model.shoppingEligible ? ' has-shopping-action' : ''}`}>
          <ActionButton
            tone="primary"
            size="compact"
            className="food-card-primary-action"
            type="button"
            disabled={isQuickAdding}
            onClick={(event) => {
              event.stopPropagation();
              actions()?.onPrimaryAction(food, model.defaultMealType);
            }}
          >
            <FoodUiIcon name="plus" />
            <span>{model.primaryActionLabel}</span>
          </ActionButton>
          {model.shoppingEligible && (
            <button
              className="food-card-icon-button"
              type="button"
              aria-label={`加入采购：${food.name}`}
              title="加入采购"
              onClick={(event) => {
                event.stopPropagation();
                actions()?.onAddShopping(food);
              }}
            >
              <FoodUiIcon name="clipboard" />
            </button>
          )}
          <button
            className="food-card-icon-button"
            type="button"
            aria-label={`加入菜单：${food.name}`}
            title="加入菜单"
            onClick={(event) => {
              event.stopPropagation();
              actions()?.onAddPlan(food);
            }}
          >
            <FoodUiIcon name="calendar" />
          </button>
        </div>
      </div>
    </article>
  );
});

export function FoodCardLibrary({
  models,
  resetKey,
  actionsRef,
  isUpdatingFavorite,
  isQuickAdding,
}: {
  models: FoodLibraryCardViewModel[];
  resetKey: string;
  actionsRef: RefObject<FoodLibraryCardActions>;
  isUpdatingFavorite: boolean;
  isQuickAdding: boolean;
}) {
  const pager = usePagedList({ itemCount: models.length, resetKey, pageSize: 6 });
  const pages = chunkFoodCardPages(models.slice(0, pager.visibleCount));

  return (
    <div className="food-card-library">
      <section className="food-card-grid" aria-label="食物卡片分页">
        {pages.map((page, pageIndex) => (
          <div className="food-card-page" key={page[0]?.food.id ?? `food-card-page-${pageIndex}`}>
            {page.map((model) => (
              <FoodLibraryCard
                key={model.food.id}
                model={model}
                actionsRef={actionsRef}
                isUpdatingFavorite={isUpdatingFavorite}
                isQuickAdding={isQuickAdding}
              />
            ))}
          </div>
        ))}
      </section>
      <div className="paged-list-status" ref={pager.sentinelRef}>
        {pager.isLoadingMore ? (
          <span role="status">正在加载更多食物…</span>
        ) : pager.hasMore ? (
          <button className="paged-list-load-more" type="button" onClick={pager.loadMore}>
            继续加载食物
          </button>
        ) : (
          <span>已加载全部食物</span>
        )}
      </div>
    </div>
  );
}
