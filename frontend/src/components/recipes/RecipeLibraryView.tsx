import type { CompositionEventHandler, Dispatch, ReactNode, Ref, SetStateAction } from 'react';
import type { FoodPlanItem } from '../../api/types';
import { formatDate, MEAL_TYPE_LABELS } from '../../lib/ui';
import { ActionButton, EmptyState, PageHeader } from '../ui-kit';
import { SHOW_RECIPE_PLAN_MANAGEMENT } from './RecipeWorkspaceOptions';
import { RecipeMobileLibraryView } from './RecipeMobileLibraryView';
import {
  DiscoveryRecipeCard,
  RecipeCover,
  RecipeMiniPlaceholder,
  RecipeMiniThumb,
  RecipeSideIcon,
  RecipeTopItem,
  RecipeTopPlaceholder,
  RecipeUiIcon,
} from './RecipeWorkspaceCards';
import type { RecipeCardViewModel, RecipePlanDayViewModel, RecipeQuickFilter, RecipeSortMode } from './workspaceModel';
import type { RecipeSceneCard } from './RecipeWorkspaceModel';

type DiscoveryCopy = {
  title: string;
  description: string;
  emptyTitle: string;
  emptyDescription: string;
};

type RecipeLibraryViewProps = {
  recipes: unknown[];
  search: string;
  quickFilter: RecipeQuickFilter;
  sceneFilter: string;
  visibleCards: RecipeCardViewModel[];
  mobileFeaturedCards: RecipeCardViewModel[];
  mobileSceneCards: Array<{ scene: RecipeSceneCard; coverUrl?: string }>;
  mobileLibraryCards: RecipeCardViewModel[];
  hasMobileRecipeAlerts: boolean;
  notificationCenter?: ReactNode;
  favoriteRecipeIds: Set<string>;
  isUpdatingFavorite?: boolean;
  isSearchFetching?: boolean;
  activeDiscoveryCopy: DiscoveryCopy;
  renderFilters: () => ReactNode;
  displayCards: RecipeCardViewModel[];
  shouldPageRecommendations: boolean;
  shouldScrollDiscoveryCards: boolean;
  discoveryScrollState: { canLeft: boolean; canRight: boolean };
  recommendationSlots: RecipeCardViewModel[];
  hasMoreRecommendationSlots: boolean;
  onLoadMoreRecommendationSlots: () => void;
  recommendationLoadMoreRef: Ref<HTMLDivElement>;
  discoverySectionRef: Ref<HTMLElement>;
  discoveryScrollRef: Ref<HTMLDivElement>;
  recentPreviewSlots: Array<RecipeCardViewModel | null>;
  topPreviewSlots: Array<{ card: RecipeCardViewModel; count: number } | null>;
  quickPreviewSlots: Array<RecipeCardViewModel | null>;
  favoriteSidebarCards: RecipeCardViewModel[];
  planSectionRef: Ref<HTMLElement>;
  visiblePlanDays: RecipePlanDayViewModel[];
  expandedPlanDates: Set<string>;
  hiddenPlanDayCount: number;
  planWeekLabel: string;
  recipePlanWeekRange: { start: string; end: string };
  plannedDayCount: number;
  isCurrentPlanWeek: boolean;
  isUpdatingPlan?: boolean;
  isCookingRecipe?: boolean;
  cardsLength: number;
  onOpenCreate: () => void;
  onOpenDetail: (card: RecipeCardViewModel) => void;
  onOpenCook: (card: RecipeCardViewModel) => void;
  onOpenShopping: (card: RecipeCardViewModel) => void;
  onOpenPlanDialog: (card?: RecipeCardViewModel) => void;
  onToggleRecipeFavorite: (card: RecipeCardViewModel) => Promise<void> | void;
  onOpenSceneManager: () => void;
  onSearchChange: (value: string) => void;
  onSearchCompositionStart?: CompositionEventHandler<HTMLInputElement>;
  onSearchCompositionEnd?: CompositionEventHandler<HTMLInputElement>;
  onShowMobileRecipeFilter: (filter: RecipeQuickFilter) => void;
  onShowMobileRecipeScene: (sceneName: string) => void;
  onShowDiscoveryFilter: (filter: RecipeQuickFilter, options?: { sort?: RecipeSortMode }) => void;
  onSetRecommendationPage: Dispatch<SetStateAction<number>>;
  onScrollDiscoveryCards: (direction: 'left' | 'right') => void;
  onUpdateDiscoveryScrollState: () => void;
  onShowPlanSection: () => void;
  onRecipePlanPreviousWeek: () => void;
  onRecipePlanCurrentWeek: () => void;
  onRecipePlanNextWeek: () => void;
  onTogglePlanDay: (date: string) => void;
  onOpenPlanDetail: (item: FoodPlanItem) => void;
  onStartPlanDetailCook: (item: FoodPlanItem) => void;
};

export function RecipeLibraryView({
  recipes,
  search,
  quickFilter,
  sceneFilter,
  visibleCards,
  mobileFeaturedCards,
  mobileSceneCards,
  mobileLibraryCards,
  hasMobileRecipeAlerts,
  notificationCenter,
  favoriteRecipeIds,
  isUpdatingFavorite,
  isSearchFetching,
  activeDiscoveryCopy,
  renderFilters,
  displayCards,
  shouldPageRecommendations,
  shouldScrollDiscoveryCards,
  discoveryScrollState,
  recommendationSlots,
  hasMoreRecommendationSlots,
  onLoadMoreRecommendationSlots,
  recommendationLoadMoreRef,
  discoverySectionRef,
  discoveryScrollRef,
  recentPreviewSlots,
  topPreviewSlots,
  quickPreviewSlots,
  favoriteSidebarCards,
  planSectionRef,
  visiblePlanDays,
  expandedPlanDates,
  hiddenPlanDayCount,
  planWeekLabel,
  recipePlanWeekRange,
  plannedDayCount,
  isCurrentPlanWeek,
  isUpdatingPlan,
  isCookingRecipe,
  cardsLength,
  onOpenCreate,
  onOpenDetail,
  onOpenCook,
  onOpenShopping,
  onOpenPlanDialog,
  onToggleRecipeFavorite,
  onOpenSceneManager,
  onSearchChange,
  onSearchCompositionStart,
  onSearchCompositionEnd,
  onShowMobileRecipeFilter,
  onShowMobileRecipeScene,
  onShowDiscoveryFilter,
  onSetRecommendationPage,
  onScrollDiscoveryCards,
  onUpdateDiscoveryScrollState,
  onShowPlanSection,
  onRecipePlanPreviousWeek,
  onRecipePlanCurrentWeek,
  onRecipePlanNextWeek,
  onTogglePlanDay,
  onOpenPlanDetail,
  onStartPlanDetailCook,
}: RecipeLibraryViewProps) {
  const quickSidebarCards = quickPreviewSlots.filter((slot): slot is RecipeCardViewModel => slot !== null);

  return (
        <>
        <RecipeMobileLibraryView
          recipes={recipes}
          search={search}
          quickFilter={quickFilter}
          sceneFilter={sceneFilter}
          mobileFeaturedCards={mobileFeaturedCards}
          mobileSceneCards={mobileSceneCards}
          mobileLibraryCards={mobileLibraryCards}
          hasMobileRecipeAlerts={hasMobileRecipeAlerts}
          notificationCenter={notificationCenter}
          favoriteRecipeIds={favoriteRecipeIds}
          isUpdatingFavorite={isUpdatingFavorite}
          isSearchFetching={isSearchFetching}
          activeDiscoveryCopy={activeDiscoveryCopy}
          visibleCards={visibleCards}
          onOpenCreate={onOpenCreate}
          onOpenDetail={onOpenDetail}
          onOpenCook={onOpenCook}
          onOpenShopping={onOpenShopping}
          onToggleRecipeFavorite={onToggleRecipeFavorite}
          onOpenSceneManager={onOpenSceneManager}
          onSearchChange={onSearchChange}
          onSearchCompositionStart={onSearchCompositionStart}
          onSearchCompositionEnd={onSearchCompositionEnd}
          onShowMobileRecipeFilter={onShowMobileRecipeFilter}
          onShowMobileRecipeScene={onShowMobileRecipeScene}
          onSetRecommendationPage={onSetRecommendationPage}
        />

        <div className="recipe-discovery-page">
          <PageHeader
            title="菜谱"
            description="发现灵感，轻松做出美味每一餐。"
            actions={
              <ActionButton tone="primary" type="button" onClick={onOpenCreate} className="recipe-create-button">
                <RecipeUiIcon name="plus" />
                新建菜谱
              </ActionButton>
            }
          />

          <section className="recipe-discovery-shell">
            <div className="recipe-inspiration-grid">
              <article className="recipe-inspiration-card">
                <div className="recipe-inspiration-head">
                  <h3 className="recipe-inspiration-title"><RecipeUiIcon name="clock" />最近做过</h3>
                  <button type="button" onClick={() => onShowDiscoveryFilter('common', { sort: 'updated' })}>查看全部</button>
                </div>
                <div className="recipe-mini-gallery">
                  {recentPreviewSlots.map((card, index) => (
                    card ? (
                      <RecipeMiniThumb key={`${card.recipe.id}-${index}`} card={card} onClick={() => onOpenDetail(card)} />
                    ) : (
                      <RecipeMiniPlaceholder key={`recent-empty-${index}`} />
                    )
                  ))}
                </div>
              </article>
              <article className="recipe-inspiration-card">
                <div className="recipe-inspiration-head">
                  <h3 className="recipe-inspiration-title"><RecipeUiIcon name="flame" />本周常做 <span>TOP3</span></h3>
                </div>
                <div className="recipe-top-list">
                  {topPreviewSlots.map((item, index) => (
                    item ? (
                      <RecipeTopItem key={`${item.card.recipe.id}-${index}`} card={item.card} rank={index + 1} count={item.count} onClick={() => onOpenDetail(item.card)} />
                    ) : (
                      <RecipeTopPlaceholder key={`top-empty-${index}`} rank={index + 1} />
                    )
                  ))}
                </div>
              </article>
              <article className="recipe-inspiration-card recipe-quick-inspiration">
                <div className="recipe-inspiration-head">
                  <h3 className="recipe-inspiration-title"><RecipeUiIcon name="zap" />快手菜 <span>10-20 分钟搞定</span></h3>
                  <button
                    type="button"
                    onClick={() => onShowDiscoveryFilter('quick', { sort: 'time' })}
                  >
                    更多 <RecipeUiIcon name="chevronRight" />
                  </button>
                </div>
                <div className="recipe-mini-gallery quick">
                  {quickPreviewSlots.map((card, index) => (
                    card ? (
                      <RecipeMiniThumb key={`${card.recipe.id}-${index}`} card={card} onClick={() => onOpenDetail(card)} />
                    ) : (
                      <RecipeMiniPlaceholder key={`quick-empty-${index}`} />
                    )
                  ))}
                </div>
              </article>
              <article className="recipe-inspiration-card recipe-inspiration-favorites">
                <div className="recipe-inspiration-head">
                  <h3 className="recipe-inspiration-title"><RecipeSideIcon name="heart" />我的收藏</h3>
                  <button type="button" onClick={() => onShowDiscoveryFilter('favorite', { sort: 'updated' })}>查看全部</button>
                </div>
                <div className="recipe-inspiration-favorite-list">
                  {favoriteSidebarCards.length > 0 ? (
                    favoriteSidebarCards.map((card) => (
                      <button key={card.recipe.id} type="button" onClick={() => onOpenDetail(card)}>
                        <RecipeCover card={card} className="recipe-inspiration-favorite-thumb" />
                        <span>
                          <strong>{card.recipe.title}</strong>
                          <small>{favoriteRecipeIds.has(card.recipe.id) ? '已收藏' : '推荐收藏'}</small>
                        </span>
                      </button>
                    ))
                  ) : (
                    <p className="subtle">还没有收藏菜谱。</p>
                  )}
                </div>
              </article>
            </div>
          </section>

          <div className="recipe-discovery-layout">
            <main className="recipe-discovery-main">
              {renderFilters()}
              <section className="recipe-discovery-section recipe-recommendation-section" ref={discoverySectionRef}>
                <div className="recipe-discovery-section-head">
                  <div>
                    <h3>{activeDiscoveryCopy.title}<RecipeUiIcon name="sparkle" className="recipe-heading-icon" /></h3>
                    <p className="subtle">{activeDiscoveryCopy.description}</p>
                  </div>
                  <div className="recipe-discovery-section-actions">
                    {shouldPageRecommendations && (
                      <ActionButton tone="secondary" size="compact" type="button" onClick={() => onSetRecommendationPage((current) => current + 1)}>
                        换一换
                      </ActionButton>
                    )}
                  </div>
                </div>
                {displayCards.length > 0 ? (
                  <div
                    className={[
                      'recipe-discovery-card-scroll-shell',
                      'is-paged',
                      discoveryScrollState.canLeft ? 'can-left' : '',
                      discoveryScrollState.canRight ? 'can-right' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    {shouldScrollDiscoveryCards && discoveryScrollState.canLeft && (
                      <button className="recipe-discovery-scroll-cue left" type="button" aria-label="向左滑动菜谱" onClick={() => onScrollDiscoveryCards('left')}>
                        <RecipeUiIcon name="chevronLeft" />
                      </button>
                    )}
                    <div className="recipe-discovery-card-grid" ref={discoveryScrollRef} onScroll={onUpdateDiscoveryScrollState}>
                      {recommendationSlots.map((card, index) => (
                        <DiscoveryRecipeCard
                          key={`${card.recipe.id}-${index}`}
                          card={card}
                          isFavorite={favoriteRecipeIds.has(card.recipe.id)}
                          isFavoritePending={isUpdatingFavorite}
                          onDetail={() => onOpenDetail(card)}
                          onFavorite={() => void onToggleRecipeFavorite(card)}
                          onCook={() => onOpenCook(card)}
                          onPlan={() => onOpenPlanDialog(card)}
                        />
                      ))}
                      <div className="paged-list-status recipe-paged-list-status" ref={recommendationLoadMoreRef}>
                        {hasMoreRecommendationSlots ? (
                          <button className="paged-list-load-more" type="button" onClick={onLoadMoreRecommendationSlots}>
                            继续加载菜谱
                          </button>
                        ) : (
                          <span>已加载全部菜谱</span>
                        )}
                      </div>
                    </div>
                    {shouldScrollDiscoveryCards && discoveryScrollState.canRight && (
                      <button className="recipe-discovery-scroll-cue right" type="button" aria-label="向右滑动菜谱" onClick={() => onScrollDiscoveryCards('right')}>
                        <RecipeUiIcon name="chevronRight" />
                      </button>
                    )}
                  </div>
                ) : (
                  <EmptyState
                    title={recipes.length === 0 ? '还没有菜谱' : activeDiscoveryCopy.emptyTitle}
                    description={recipes.length === 0 ? '先新增几份常做菜，之后会按库存和记录推荐。' : activeDiscoveryCopy.emptyDescription}
                    action={
                      <ActionButton tone="primary" type="button" onClick={onOpenCreate}>
                        新增菜谱
                      </ActionButton>
                    }
                  />
                )}
              </section>

            </main>

            <aside className="recipe-discovery-side">
              <section className="recipe-side-panel recipe-favorite-side-panel">
                <div className="recipe-side-panel-head">
                  <h3><RecipeSideIcon name="heart" />我的收藏</h3>
                  <button type="button" aria-label="查看收藏" onClick={() => onShowDiscoveryFilter('favorite', { sort: 'updated' })}>
                    <RecipeUiIcon name="chevronRight" />
                  </button>
                </div>
                <div className="recipe-side-list">
                  {favoriteSidebarCards.length > 0 ? (
                    favoriteSidebarCards.map((card) => (
                      <button key={card.recipe.id} className="recipe-side-list-item" type="button" onClick={() => onOpenDetail(card)}>
                        <RecipeCover card={card} className="recipe-side-thumb" />
                        <span>
                          <strong>{card.recipe.title}</strong>
                          <small>{favoriteRecipeIds.has(card.recipe.id) ? '已收藏' : '推荐收藏'}</small>
                        </span>
                      </button>
                    ))
                  ) : (
                    <p className="subtle">还没有收藏菜谱。</p>
                  )}
                </div>
              </section>

              <section className="recipe-side-panel recipe-quick-side-panel">
                <div className="recipe-side-panel-head">
                  <h3><RecipeUiIcon name="zap" />快手菜</h3>
                  <button type="button" aria-label="查看更多快手菜" onClick={() => onShowDiscoveryFilter('quick', { sort: 'time' })}>
                    <RecipeUiIcon name="chevronRight" />
                  </button>
                </div>
                <div className="recipe-side-list">
                  {quickSidebarCards.length > 0 ? (
                    quickSidebarCards.map((card) => (
                      <button key={card.recipe.id} className="recipe-side-list-item" type="button" onClick={() => onOpenDetail(card)}>
                        <RecipeCover card={card} className="recipe-side-thumb" />
                        <span>
                          <strong>{card.recipe.title}</strong>
                          <small>{card.recipe.prep_minutes ? `用时 ${card.recipe.prep_minutes}分钟` : '10-20 分钟搞定'}</small>
                        </span>
                      </button>
                    ))
                  ) : (
                    <p className="subtle">没有快手菜推荐。</p>
                  )}
                </div>
              </section>

              {SHOW_RECIPE_PLAN_MANAGEMENT && (
              <section className="recipe-side-panel" ref={planSectionRef}>
                <div className="recipe-side-panel-head">
                  <h3><RecipeSideIcon name="calendar" />我的菜单计划</h3>
                  <button type="button" onClick={onShowPlanSection}>查看全部</button>
                </div>
                <div className="recipe-plan-switcher" aria-label="切换菜单周">
                  <button type="button" onClick={onRecipePlanPreviousWeek}>
                    <RecipeUiIcon name="chevronLeft" />
                    上一周
                  </button>
                  <button type="button" onClick={onRecipePlanCurrentWeek} className={isCurrentPlanWeek ? 'active' : ''}>
                    本周
                  </button>
                  <button type="button" onClick={onRecipePlanNextWeek}>
                    下一周
                    <RecipeUiIcon name="chevronRight" />
                  </button>
                </div>
                <div className="recipe-plan-range">
                  <span>{planWeekLabel}</span>
                  <strong>{recipePlanWeekRange.start.slice(5).replace('-', '/')} - {recipePlanWeekRange.end.slice(5).replace('-', '/')}</strong>
                  <small>{plannedDayCount} 天已安排</small>
                </div>
                <ActionButton
                  tone="primary"
                  type="button"
                  className="recipe-plan-add-button"
                  onClick={() => onOpenPlanDialog()}
                  disabled={isUpdatingPlan || cardsLength === 0}
                >
                  加菜
                </ActionButton>
                <div className="recipe-plan-week">
                  {visiblePlanDays.map((day) => {
                    const isExpanded = expandedPlanDates.has(day.date);
                    return (
                      <div key={day.date} className={isExpanded ? 'recipe-plan-day expanded' : 'recipe-plan-day collapsed'}>
                        <button className="recipe-plan-day-head" type="button" onClick={() => onTogglePlanDay(day.date)} aria-expanded={isExpanded}>
                          <strong>{day.label}</strong>
                          <span>{formatDate(day.date).replace('周', '')}</span>
                        </button>
                        {isExpanded ? (
                          day.items.length > 0 ? (
                            day.items.map((item) => (
                              <article
                                key={item.id}
                                className="recipe-plan-item"
                                role="button"
                                tabIndex={0}
                                onClick={() => onOpenPlanDetail(item)}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter' || event.key === ' ') {
                                    event.preventDefault();
                                    onOpenPlanDetail(item);
                                  }
                                }}
                              >
                                <div className="recipe-plan-item-summary">
                                  <strong>{item.recipe_title}</strong>
                                  <span>
                                    {MEAL_TYPE_LABELS[item.meal_type]}
                                    {item.status === 'cooked' ? ' · 已完成' : ''}
                                  </span>
                                </div>
                                <button
                                  className="recipe-plan-item-detail-button"
                                  type="button"
                                  aria-label={`开始做：${item.recipe_title}`}
                                  disabled={isCookingRecipe || item.status === 'cooked'}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    onStartPlanDetailCook(item);
                                  }}
                                >
                                  <RecipeUiIcon name="utensils" />
                                </button>
                              </article>
                            ))
                          ) : (
                            <div className="recipe-plan-empty-row">未安排</div>
                          )
                        ) : (
                          <button className="recipe-plan-day-summary" type="button" onClick={() => onTogglePlanDay(day.date)}>
                            <strong>{day.items.length > 0 ? `${day.items.length} 项计划` : '未安排'}</strong>
                            {day.items.length > 0 && <span>{day.items.map((item) => MEAL_TYPE_LABELS[item.meal_type]).join('、')}</span>}
                          </button>
                        )}
                      </div>
                    );
                  })}
                  {hiddenPlanDayCount > 0 && <div className="recipe-plan-collapsed-note">其余 {hiddenPlanDayCount} 天已收起</div>}
                </div>
              </section>
              )}
            </aside>
          </div>
        </div>
        </>

  );
}
