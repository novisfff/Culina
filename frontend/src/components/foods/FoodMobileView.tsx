import type { CompositionEventHandler, KeyboardEvent, ReactNode } from 'react';
import type { Food, FoodRecommendationItem, MealLog, MealType, MediaAsset, Recipe } from '../../api/types';
import { buildMediaSizes, buildMediaSrcSet, resolveMediaUrl } from '../../lib/assets';
import { FOOD_TYPE_LABELS, MEAL_TYPE_LABELS, getFoodCoverAsset } from '../../lib/ui';
import { chunkMobilePagedItems, useMobilePagedScroller } from '../../hooks/useMobilePagedScroller';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
import { Badge, EmptyState, SearchLoadingIndicator } from '../ui-kit';
import { focusMobileInput } from '../../lib/mobileFocus';
import { resolveMobileSceneCoverSource } from './FoodMobileSceneModel';
import { FoodUiIcon } from './FoodWorkspacePrimitives';
import type { FoodCookingSummary } from './FoodWorkspaceHelpers';

function focusMobileFoodSearch() {
  focusMobileInput('mobile-food-search', { containerSelector: '.mobile-food-library-filters' });
}

type MobileRecommendationItem = {
  food: Food;
  mealType: MealType;
  score: number;
  reasons: string[];
  primaryAction: 'cook_recipe' | 'quick_add_meal' | 'review_food';
  recipeAvailability?: FoodRecommendationItem['recipe_availability'];
};

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

export function FoodMobileView(props: {
  recipes: Recipe[];
  mealLogs: MealLog[];
  visibleRecommendations: MobileRecommendationItem[];
  recommendationCardCount: number;
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
  resolveFoodAssetUrl: (url: string) => string;
  getFoodCardPrimaryActionLabel: (food: Food) => string;
  getRecommendationPrimaryActionLabel: (item: MobileRecommendationItem) => string;
  getDefaultMealType: (food: Food) => MealType;
  getFoodSceneTags: (food: Food) => string[];
  getFoodCookingSummary: (food: Food) => FoodCookingSummary | null;
  onSearchChange: (value: string) => void;
  onSearchCompositionStart?: CompositionEventHandler<HTMLInputElement>;
  onSearchCompositionEnd?: CompositionEventHandler<HTMLInputElement>;
  onRotateRecommendation: () => void;
  onOpenGovernanceIssue: () => void;
  onOpenSceneManager: () => void;
  onOpenDetail: (food: Food) => void;
  onOpenPlanDialog: (food: Food) => void;
  onHandleRecommendationPrimaryAction: (item: MobileRecommendationItem) => void;
  onHandleFoodCardPrimaryAction: (food: Food, mealType: MealType) => void;
  onToggleFavorite: (food: Food) => void;
  onOpenCreate: () => void;
  onClearFoodFilters: () => void;
  filterTabs: MobileFilterTab[];
}) {
  const libraryPager = useMobilePagedScroller({
    itemCount: props.mobileLibraryFoods.length,
    resetKey: props.mobileLibraryResetKey,
  });
  const mobileLibraryFoodPages = chunkMobilePagedItems(props.mobileLibraryFoods, libraryPager.visiblePageCount);

  function handleRecommendationCardKeyDown(event: KeyboardEvent<HTMLElement>, food: Food) {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }
    event.preventDefault();
    props.onOpenDetail(food);
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

      <header className="mobile-food-hero">
        <h1>食物</h1>
        <p>从常吃、临期、外卖和记录里快速选一份今天想吃的。</p>
      </header>

      <section className="mobile-dashboard-panel mobile-dashboard-recommend">
        <div className="mobile-dashboard-section-head">
          <h2>今天吃什么 <span>✦</span></h2>
          <button type="button" onClick={props.onRotateRecommendation} disabled={props.recommendationCardCount <= 3}>
            换一换
          </button>
        </div>
        {props.visibleRecommendations.length > 0 ? (
          <div className="mobile-dashboard-food-scroller">
            {props.visibleRecommendations.map((item) => {
              const foodCoverAsset = getFoodCoverAsset(item.food, props.recipes);
              const foodCoverUrl = resolveMediaUrl(foodCoverAsset, 'card');
              const cookingSummary = props.getFoodCookingSummary(item.food);
              return (
                <article
                  key={item.food.id}
                  className="mobile-dashboard-food-card"
                  role="button"
                  tabIndex={0}
                  aria-label={`查看食物详情：${item.food.name}`}
                  onClick={() => props.onOpenDetail(item.food)}
                  onKeyDown={(event) => handleRecommendationCardKeyDown(event, item.food)}
                >
                  <div className="mobile-dashboard-food-cover">
                    <MediaWithPlaceholder src={foodCoverUrl} alt="" />
                  </div>
                  <div className="mobile-dashboard-food-body">
                    <h3>{item.food.name}</h3>
                    <div className="mobile-dashboard-chip-row">
                      <Badge>{FOOD_TYPE_LABELS[item.food.type === 'packaged' ? 'readyMade' : item.food.type]}</Badge>
                      <Badge>{cookingSummary?.availabilityLabel || item.food.routine_note || `${item.food.suitable_meal_types.length || 1} 餐适合`}</Badge>
                    </div>
                    <p>{cookingSummary?.shortagePreview.length ? `缺 ${cookingSummary.shortagePreview.join('、')}` : cookingSummary?.metaLabel || item.reasons[0] || item.food.notes || '适合今天安排'}</p>
                    <div className="mobile-dashboard-food-actions">
                      <button
                        className="mobile-dashboard-primary compact"
                        type="button"
                        disabled={props.isQuickAdding}
                        onClick={(event) => {
                          event.stopPropagation();
                          props.onHandleRecommendationPrimaryAction(item);
                        }}
                      >
                        {props.getRecommendationPrimaryActionLabel(item)}
                      </button>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          props.onOpenPlanDialog(item.food);
                        }}
                        aria-label={`加入菜单：${item.food.name}`}
                      >
                        <FoodUiIcon name="calendar" />
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <EmptyState title="暂无推荐" description="补充食物或家常菜谱后，这里会出现今日建议。" />
        )}
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
          <label className="mobile-food-search">
            <FoodUiIcon name="search" />
            <input
              id="mobile-food-search"
              value={props.search}
              placeholder="搜索食物、食材或菜谱"
              onChange={(event) => props.onSearchChange(event.target.value)}
              onCompositionStart={props.onSearchCompositionStart}
              onCompositionEnd={props.onSearchCompositionEnd}
            />
            <SearchLoadingIndicator active={Boolean(props.search.trim()) && Boolean(props.isSearchFetching)} />
          </label>
          <div className="mobile-food-tabs" aria-label="食物分类">
            {props.filterTabs.map((item) => (
              <button key={item.label} className={item.active ? 'active' : ''} type="button" onClick={item.onClick}>
                {item.label}
              </button>
            ))}
          </div>
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
                    const tagLabels = props.getFoodSceneTags(food).slice(0, 2);
                    const cookingSummary = props.getFoodCookingSummary(food);
                    const labels = cookingSummary
                      ? [cookingSummary.availabilityLabel, cookingSummary.metaLabel]
                      : tagLabels.length > 0 ? tagLabels : food.suitable_meal_types.slice(0, 2).map((meal) => MEAL_TYPE_LABELS[meal]);
                    return (
                      <article key={food.id} className="mobile-food-library-card">
                        <button className="mobile-food-library-cover" type="button" onClick={() => props.onOpenDetail(food)}>
                          <MediaWithPlaceholder
                            src={cover}
                            srcSet={buildMediaSrcSet(coverAsset)}
                            sizes={buildMediaSizes('card')}
                            alt={food.name}
                          />
                        </button>
                        <div className="mobile-food-library-body">
                          <h3>{food.name}</h3>
                          <p>{cookingSummary ? ['家常菜谱', usageCount > 0 ? '最近做过' : cookingSummary.availabilityDetail].join(' · ') : [FOOD_TYPE_LABELS[food.type === 'packaged' ? 'readyMade' : food.type], usageCount > 0 ? '最近吃过' : '未记录'].join(' · ')}</p>
                          <div className="mobile-food-chip-row">
                            {labels.map((label) => (
                              <span key={label}>{label}</span>
                            ))}
                          </div>
                          <div className="mobile-food-card-actions">
                            <button
                              className="mobile-food-primary"
                              type="button"
                              disabled={props.isQuickAdding}
                              onClick={() => props.onHandleFoodCardPrimaryAction(food, props.getDefaultMealType(food))}
                            >
                              {props.getFoodCardPrimaryActionLabel(food)}
                            </button>
                            <button
                              className={food.favorite ? 'active' : undefined}
                              type="button"
                              aria-label={`收藏：${food.name}`}
                              disabled={props.isUpdatingFavorite}
                              onClick={() => props.onToggleFavorite(food)}
                            >
                              <FoodUiIcon name={food.favorite ? 'heartFilled' : 'heart'} />
                            </button>
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
          <div className="mobile-food-empty">
            <strong>{props.emptyTitle}</strong>
            <button type="button" onClick={props.onClearFoodFilters}>清空筛选</button>
          </div>
        )}
      </section>
    </section>
  );
}
