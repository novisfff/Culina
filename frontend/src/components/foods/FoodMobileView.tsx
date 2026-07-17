import type { CompositionEventHandler, KeyboardEvent, ReactNode } from 'react';
import type { Food, MealLog, MealType, MediaAsset, Recipe } from '../../api/types';
import { buildMediaSizes, buildMediaSrcSet, resolveMediaUrl } from '../../lib/assets';
import { FOOD_TYPE_LABELS, MEAL_TYPE_LABELS, getFoodCoverAsset } from '../../lib/ui';
import { chunkMobilePagedItems, useMobilePagedScroller } from '../../hooks/useMobilePagedScroller';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
import { EmptyState, OptionChipGroup, SearchField, StateBlock, StatusBadge } from '../ui-kit';
import { focusMobileInput } from '../../lib/mobileFocus';
import { resolveMobileSceneCoverSource } from './FoodMobileSceneModel';
import { FoodUiIcon } from './FoodWorkspacePrimitives';
import type { FoodCookingSummary } from './FoodWorkspaceHelpers';

function focusMobileFoodSearch() {
  focusMobileInput('mobile-food-search', { containerSelector: '.mobile-food-library-filters' });
}

type MobileSceneCard = {
  key: string;
  title: string;
  count: number;
  imageFood?: Food;
  imageUrl?: string;
  imageAsset?: MediaAsset | null;
  onClick: () => void;
};

type MobileFilterTab = {
  label: string;
  active: boolean;
  onClick: () => void;
};

function countMealUsage(food: Food, mealLogs: MealLog[]) {
  return mealLogs.filter((log) => log.food_entries.some((entry) => entry.food_id === food.id)).length;
}

function openFoodDetailFromCard(event: KeyboardEvent<HTMLElement>, onOpenDetail: () => void) {
  if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
  event.preventDefault();
  onOpenDetail();
}

export function FoodMobileView(props: {
  recipes: Recipe[];
  mealLogs: MealLog[];
  managementIssueCount: number;
  mobileScenePages: MobileSceneCard[][];
  mobileLibraryFoods: Food[];
  mobileLibraryResetKey: string;
  hasFoodFilters: boolean;
  search: string;
  isSearchFetching?: boolean;
  emptyTitle: string;
  isQuickAdding?: boolean;
  isUpdatingFavorite?: boolean;
  notificationCenter?: ReactNode;
  weekPage?: ReactNode;
  resolveFoodAssetUrl: (url: string) => string;
  getFoodCardPrimaryActionLabel: (food: Food) => string;
  getDefaultMealType: (food: Food) => MealType;
  getFoodSceneTags: (food: Food) => string[];
  getFoodCookingSummary: (food: Food) => FoodCookingSummary | null;
  onSearchChange: (value: string) => void;
  onSearchCompositionStart?: CompositionEventHandler<HTMLInputElement>;
  onSearchCompositionEnd?: CompositionEventHandler<HTMLInputElement>;
  onOpenGovernanceIssue: () => void;
  onOpenSceneManager: () => void;
  onOpenDetail: (food: Food) => void;
  onOpenPlanDialog: (food: Food) => void;
  onHandleFoodCardPrimaryAction: (food: Food, mealType: MealType) => void;
  onToggleFavorite: (food: Food) => void;
  onOpenShopping: (food: Food) => void;
  onOpenCreate: () => void;
  onOpenLogs?: () => void;
  onClearFoodFilters: () => void;
  filterTabs: MobileFilterTab[];
}) {
  const libraryPager = useMobilePagedScroller({
    itemCount: props.mobileLibraryFoods.length,
    resetKey: props.mobileLibraryResetKey,
  });
  const mobileLibraryFoodPages = chunkMobilePagedItems(props.mobileLibraryFoods, libraryPager.visiblePageCount);

  if (props.weekPage) {
    return <>{props.weekPage}</>;
  }

  return (
    <section className="mobile-food-page" aria-label="手机食物页">
      <div className="mobile-food-topbar">
        <div className="mobile-food-brand">
          <span className="mobile-food-logo">
            <FoodUiIcon name="logo" />
          </span>
          <span>
            <strong>Culina</strong>
            <small>家庭厨房工作台</small>
          </span>
        </div>
        <div className="mobile-food-top-actions">
          <button type="button" aria-label="聚焦搜索" onClick={focusMobileFoodSearch}>
            <FoodUiIcon name="search" />
          </button>
          {props.notificationCenter ?? (
            <button type="button" aria-label="查看食物提醒" onClick={props.onOpenGovernanceIssue}>
              <FoodUiIcon name="bell" />
              {props.managementIssueCount > 0 && <i aria-hidden="true" />}
            </button>
          )}
        </div>
      </div>

      <section className="mobile-food-command-panel" aria-label="吃什么快捷操作">
        <div className="mobile-food-command-copy">
          <h1>吃什么</h1>
          <p>选一份，安排这餐。</p>
        </div>
        <div className="mobile-food-command-actions">
          <button className="mobile-food-command-primary" type="button" onClick={props.onOpenCreate}>
            <FoodUiIcon name="plus" />
            新增外卖/成品
          </button>
          <button className="mobile-food-command-secondary" type="button" onClick={() => props.onOpenLogs?.()}>
            <FoodUiIcon name="receipt" />
            吃过的
          </button>
        </div>
      </section>

      <section className="mobile-food-panel">
        <div className="mobile-food-section-head">
          <h2>按场景探索</h2>
          <button type="button" onClick={props.onOpenSceneManager}>
            查看更多
            <FoodUiIcon name="arrowRight" />
          </button>
        </div>
        <div className="mobile-food-scene-scroller" aria-label="按场景探索">
          {props.mobileScenePages.map((page, pageIndex) => (
            <div className="mobile-food-scene-grid" key={`scene-page-${pageIndex}`}>
              {page.map((item) => {
                const cover = resolveMobileSceneCoverSource(item, props.recipes, props.resolveFoodAssetUrl);
                return (
                  <button
                    key={item.key}
                    className={cover.source === 'fallback' ? 'is-fallback' : undefined}
                    type="button"
                    onClick={item.onClick}
                  >
                    <MediaWithPlaceholder
                      className="mobile-food-scene-media"
                      src={cover.url}
                      srcSet={buildMediaSrcSet(cover.asset)}
                      sizes={buildMediaSizes('card')}
                      alt=""
                      emptyLabel="暂无场景图"
                      loadingLabel="加载场景图"
                      errorLabel="场景图失败"
                    />
                    <span>
                      <strong>{item.title}</strong>
                      <small>{item.count} 份食物</small>
                    </span>
                    <b aria-hidden="true">
                      <FoodUiIcon name="arrowRight" />
                    </b>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </section>

      <section className="mobile-food-panel mobile-food-library">
        <div className="mobile-food-section-head">
          <h2>
            食物库
            {props.mobileLibraryFoods.length > 0 && (
              <span>{libraryPager.visibleCount}/{props.mobileLibraryFoods.length}</span>
            )}
          </h2>
          <button type="button" onClick={props.hasFoodFilters ? props.onClearFoodFilters : props.onOpenCreate}>
            {props.hasFoodFilters ? '查看全部' : '新增'}
            <FoodUiIcon name="arrowRight" />
          </button>
        </div>
        <div className="mobile-food-library-filters">
          <SearchField
            className="mobile-food-search"
            inputId="mobile-food-search"
            ariaLabel="搜索食物"
            placeholder="搜索食物、食材或菜谱"
            value={props.search}
            loading={Boolean(props.search.trim()) && Boolean(props.isSearchFetching)}
            leadingIcon={<FoodUiIcon name="search" />}
            onChange={props.onSearchChange}
            onClear={() => props.onSearchChange('')}
            onCompositionStart={props.onSearchCompositionStart}
            onCompositionEnd={props.onSearchCompositionEnd}
          />
          <OptionChipGroup
            ariaLabel="食物分类"
            value={props.filterTabs.find((item) => item.active)?.label ?? ''}
            options={props.filterTabs.map((item) => ({ value: item.label, label: item.label }))}
            size="large"
            className="mobile-food-chip-group"
            onChange={(nextValue) => props.filterTabs.find((item) => item.label === nextValue)?.onClick()}
          />
        </div>
        {props.mobileLibraryFoods.length > 0 ? (
          <>
            <div className="mobile-food-library-scroller" aria-label="食物库横向分页" onScroll={libraryPager.handleScroll}>
              {mobileLibraryFoodPages.map((page, pageIndex) => (
                <div className="mobile-food-library-grid" key={`food-library-page-${pageIndex}`}>
                  {page.map((food) => {
                    const coverAsset = getFoodCoverAsset(food, props.recipes);
                    const cover = resolveMediaUrl(coverAsset, 'card');
                    const usageCount = countMealUsage(food, props.mealLogs);
                    const tagLabels = props.getFoodSceneTags(food);
                    const cookingSummary = props.getFoodCookingSummary(food);
                    const labels = cookingSummary
                      ? [cookingSummary.availabilityLabel, `${cookingSummary.linkedRecipeCard?.recipe.ingredient_items.length ?? 0}原料`]
                      : tagLabels.length > 0 ? tagLabels : food.suitable_meal_types.map((meal) => MEAL_TYPE_LABELS[meal]);
                    return (
                      <article
                        key={food.id}
                        className="mobile-food-library-card"
                        role="button"
                        tabIndex={0}
                        aria-label={`查看详情：${food.name}`}
                        onClick={() => props.onOpenDetail(food)}
                        onKeyDown={(event) => openFoodDetailFromCard(event, () => props.onOpenDetail(food))}
                      >
                        <div className="mobile-food-library-media">
                          <div className="mobile-food-library-cover">
                            <MediaWithPlaceholder
                              src={cover}
                              srcSet={buildMediaSrcSet(coverAsset)}
                              sizes={buildMediaSizes('card')}
                              alt={food.name}
                            />
                          </div>
                          <button
                            className={food.favorite ? 'food-favorite-chip mobile-food-favorite active' : 'food-favorite-chip mobile-food-favorite'}
                            type="button"
                            aria-label={`${food.favorite ? '取消收藏' : '收藏'}：${food.name}`}
                            disabled={props.isUpdatingFavorite}
                            onClick={(event) => {
                              event.stopPropagation();
                              props.onToggleFavorite(food);
                            }}
                          >
                            <FoodUiIcon name={food.favorite ? 'heartFilled' : 'heart'} />
                          </button>
                        </div>
                        <div className="mobile-food-library-body">
                          <h3>{food.name}</h3>
                          <p>{cookingSummary ? ['家常菜谱', usageCount > 0 ? '最近做过' : cookingSummary.availabilityDetail].join(' · ') : [FOOD_TYPE_LABELS[food.type === 'packaged' ? 'readyMade' : food.type], usageCount > 0 ? '最近吃过' : '未记录'].join(' · ')}</p>
                          <div className="mobile-food-badge-row">
                            {labels.map((label) => (
                              <StatusBadge key={label} size="compact">{label}</StatusBadge>
                            ))}
                          </div>
                          <div className="mobile-food-card-actions">
                            <button
                              className="mobile-food-primary"
                              type="button"
                              disabled={props.isQuickAdding}
                              onClick={(event) => {
                                event.stopPropagation();
                                props.onHandleFoodCardPrimaryAction(food, props.getDefaultMealType(food));
                              }}
                            >
                              {props.getFoodCardPrimaryActionLabel(food)}
                            </button>
                            {(['readyMade', 'instant', 'packaged'].includes(food.type) || (food.type === 'selfMade' && Boolean(food.recipe_id))) ? (
                              <button
                                className="mobile-food-shopping-action"
                                type="button"
                                aria-label={`加入采购：${food.name}`}
                                title="加入采购"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  props.onOpenShopping(food);
                                }}
                              >
                                <FoodUiIcon name="clipboard" />
                              </button>
                            ) : null}
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              ))}
            </div>
          </>
        ) : (
          <StateBlock
            status="empty"
            title={props.emptyTitle}
            description="调整筛选条件，或先补充一条常吃食物。"
            actionLabel="清空筛选"
            onAction={props.onClearFoodFilters}
            className="mobile-food-empty"
          />
        )}
      </section>
    </section>
  );
}
