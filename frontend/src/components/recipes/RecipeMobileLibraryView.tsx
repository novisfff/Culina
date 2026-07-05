import type { CompositionEventHandler, Dispatch, ReactNode, SetStateAction } from 'react';
import { EmptyState, SearchField } from '../ui-kit';
import {
  MobileRecipeCard,
  MobileRecipeSceneCard,
  RecipeUiIcon,
} from './RecipeWorkspaceCards';
import type { RecipeQuickFilter } from './workspaceModel';
import type { RecipeCardViewModel } from './workspaceModel';
import type { RecipeSceneCard } from './RecipeWorkspaceModel';

type DiscoveryCopy = {
  title: string;
  description: string;
  emptyTitle: string;
  emptyDescription: string;
};

export function RecipeMobileLibraryView(props: {
  recipes: unknown[];
  search: string;
  quickFilter: RecipeQuickFilter;
  sceneFilter: string;
  mobileFeaturedCards: RecipeCardViewModel[];
  mobileSceneCards: Array<{ scene: RecipeSceneCard; coverUrl?: string }>;
  mobileLibraryCards: RecipeCardViewModel[];
  hasMobileRecipeAlerts: boolean;
  notificationCenter?: ReactNode;
  favoriteRecipeIds: Set<string>;
  isUpdatingFavorite?: boolean;
  isSearchFetching?: boolean;
  activeDiscoveryCopy: DiscoveryCopy;
  visibleCards: RecipeCardViewModel[];
  onOpenCreate: () => void;
  onOpenDetail: (card: RecipeCardViewModel) => void;
  onOpenCook: (card: RecipeCardViewModel) => void;
  onOpenShopping: (card: RecipeCardViewModel) => void;
  onToggleRecipeFavorite: (card: RecipeCardViewModel) => Promise<void> | void;
  onOpenSceneManager: () => void;
  onSearchChange: (value: string) => void;
  onSearchCompositionStart?: CompositionEventHandler<HTMLInputElement>;
  onSearchCompositionEnd?: CompositionEventHandler<HTMLInputElement>;
  onShowMobileRecipeFilter: (filter: RecipeQuickFilter) => void;
  onShowMobileRecipeScene: (sceneName: string) => void;
  onSetRecommendationPage: Dispatch<SetStateAction<number>>;
}) {
  return (
    <section className="mobile-recipe-page" aria-label="手机菜谱页">
      <div className="mobile-recipe-topbar">
        <div className="mobile-recipe-brand">
          <span className="mobile-recipe-logo">
            <RecipeUiIcon name="logo" />
          </span>
          <span>
            <strong>Culina</strong>
            <small>家庭厨房工作台</small>
          </span>
        </div>
        <div className="mobile-recipe-top-actions">
          <button type="button" aria-label="聚焦搜索" onClick={() => document.getElementById('mobile-recipe-search')?.focus()}>
            <RecipeUiIcon name="search" />
          </button>
          {props.notificationCenter ?? (
            <button type="button" aria-label="查看提醒" onClick={() => props.onShowMobileRecipeFilter('missing')}>
              <RecipeUiIcon name="bell" />
              {props.hasMobileRecipeAlerts && <i aria-hidden="true" />}
            </button>
          )}
        </div>
      </div>

      <header className="mobile-recipe-hero">
        <h1>菜谱</h1>
        <p>按库存、常做和快手程度，快速决定下一餐要做什么。</p>
      </header>

      <section className="mobile-recipe-panel mobile-recipe-featured-panel">
        <div className="mobile-recipe-section-head">
          <h2>今天可以做 <span>✦</span></h2>
          <button
            type="button"
            onClick={() => props.onSetRecommendationPage((current) => current + 1)}
            disabled={props.visibleCards.length <= 3}
          >
            换一换
          </button>
        </div>
        {props.mobileFeaturedCards.length > 0 ? (
          <div className="mobile-recipe-featured-scroller">
            {props.mobileFeaturedCards.map((card) => (
              <MobileRecipeCard
                key={card.recipe.id}
                card={card}
                featured
                isFavorite={props.favoriteRecipeIds.has(card.recipe.id)}
                isFavoritePending={props.isUpdatingFavorite}
                onDetail={() => props.onOpenDetail(card)}
                onFavorite={() => void props.onToggleRecipeFavorite(card)}
                onCook={() => props.onOpenCook(card)}
                onShopping={() => props.onOpenShopping(card)}
              />
            ))}
          </div>
        ) : (
          <EmptyState title="暂无推荐" description="新增几份常做菜后，这里会按库存和记录推荐。" />
        )}
      </section>

      <section className="mobile-recipe-panel">
        <div className="mobile-recipe-section-head">
          <h2>按场景探索</h2>
          <button type="button" onClick={props.onOpenSceneManager}>
            管理
            <RecipeUiIcon name="chevronRight" />
          </button>
        </div>
        <div className="mobile-recipe-scene-scroller" aria-label="按场景探索">
          <div className="mobile-recipe-scene-grid">
            {props.mobileSceneCards.map((item) => (
              <MobileRecipeSceneCard
                key={item.scene.name}
                scene={item.scene}
                coverUrl={item.coverUrl}
                onClick={() => props.onShowMobileRecipeScene(item.scene.name)}
              />
            ))}
          </div>
        </div>
      </section>

      <section className="mobile-recipe-panel mobile-recipe-library" id="mobile-recipe-library">
        <div className="mobile-recipe-section-head">
          <h2>{props.sceneFilter === 'all' ? '菜谱库' : props.sceneFilter}</h2>
          <button type="button" onClick={props.onOpenCreate}>
            新增
            <RecipeUiIcon name="chevronRight" />
          </button>
        </div>
        <div className="mobile-recipe-library-filters">
          <SearchField
            className="mobile-recipe-search"
            inputId="mobile-recipe-search"
            ariaLabel="搜索菜谱"
            placeholder="搜索菜谱、食材或技巧"
            value={props.search}
            loading={Boolean(props.search.trim()) && Boolean(props.isSearchFetching)}
            leadingIcon={<RecipeUiIcon name="search" />}
            onChange={props.onSearchChange}
            onClear={() => props.onSearchChange('')}
            onCompositionStart={props.onSearchCompositionStart}
            onCompositionEnd={props.onSearchCompositionEnd}
          />
          <div className="mobile-recipe-tabs" aria-label="菜谱分类">
            {[
              { value: 'recommend' as const, label: '推荐' },
              { value: 'ready' as const, label: '可做' },
              { value: 'quick' as const, label: '快手' },
              { value: 'favorite' as const, label: '收藏' },
              { value: 'missing' as const, label: '缺料' },
            ].map((item) => (
              <button
                key={item.value}
                className={props.quickFilter === item.value && props.sceneFilter === 'all' ? 'active' : ''}
                type="button"
                onClick={() => props.onShowMobileRecipeFilter(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
        {props.mobileLibraryCards.length > 0 ? (
          <div className="mobile-recipe-library-grid">
            {props.mobileLibraryCards.map((card) => (
              <MobileRecipeCard
                key={card.recipe.id}
                card={card}
                isFavorite={props.favoriteRecipeIds.has(card.recipe.id)}
                isFavoritePending={props.isUpdatingFavorite}
                onDetail={() => props.onOpenDetail(card)}
                onFavorite={() => void props.onToggleRecipeFavorite(card)}
                onCook={() => props.onOpenCook(card)}
                onShopping={() => props.onOpenShopping(card)}
              />
            ))}
          </div>
        ) : (
          <div className="mobile-recipe-empty">
            <strong>{props.recipes.length === 0 ? '还没有菜谱' : props.activeDiscoveryCopy.emptyTitle}</strong>
            <span>{props.recipes.length === 0 ? '先新增几份常做菜，之后就能按库存推荐。' : props.activeDiscoveryCopy.emptyDescription}</span>
            <button type="button" onClick={props.recipes.length === 0 ? props.onOpenCreate : () => props.onShowMobileRecipeFilter('recommend')}>
              {props.recipes.length === 0 ? '新增菜谱' : '清空筛选'}
            </button>
          </div>
        )}
      </section>
    </section>
  );
}
