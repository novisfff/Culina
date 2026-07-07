import { useState, type CompositionEventHandler, type KeyboardEvent, type ReactNode } from 'react';
import { buildMediaSizes, buildMediaSrcSet, resolveMediaUrl } from '../../lib/assets';
import type { InventoryOverviewItem, ShoppingListItem } from '../../api/types';
import { chunkMobilePagedItems, useMobilePagedScroller } from '../../hooks/useMobilePagedScroller';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
import { OptionChipGroup, SearchField, WorkspaceDrawer, WorkspaceOverlayFrame, type OptionChip } from '../ui-kit';
import { tracksIngredientQuantity } from '../../lib/ingredientTracking';
import { focusMobileInput } from '../../lib/mobileFocus';
import type {
  IngredientSummaryViewModel,
  InventoryCardStatusViewModel,
  InventoryStorageOverviewViewModel,
  ShoppingCardGroupViewModel,
  ShoppingCardViewModel,
} from './workspaceModel';
import type { InventoryStorageFocus } from './ingredientWorkspaceForms';
import type { MobileIngredientFilter } from './useIngredientWorkspaceState';

type CatalogCardStatus = {
  label: string;
  tone: 'stable' | 'warning' | 'danger' | 'empty';
  stockLine: string;
  hint: string;
};

const MOBILE_INGREDIENT_FILTER_OPTIONS: readonly OptionChip<MobileIngredientFilter>[] = [
  { value: 'all', label: '全部' },
  { value: 'seasoning', label: '调料' },
  { value: 'alerted', label: '提醒' },
  { value: 'empty', label: '缺货' },
  { value: 'stocked', label: '在库' },
];

function focusMobileIngredientSearch() {
  focusMobileInput('mobile-ingredient-search', { containerSelector: '.mobile-ingredient-library-filters' });
}

type IngredientMobileViewProps = {
  allAlertsCount: number;
  stockedIngredientCount: number;
  pendingShoppingCount: number;
  summariesCount: number;
  catalogSearch: string;
  isCatalogSearchFetching?: boolean;
  onCatalogSearchCompositionStart?: CompositionEventHandler<HTMLInputElement>;
  onCatalogSearchCompositionEnd?: CompositionEventHandler<HTMLInputElement>;
  setCatalogSearch: (value: string) => void;
  mobileIngredientFilter: MobileIngredientFilter;
  setMobileIngredientFilter: (value: MobileIngredientFilter) => void;
  mobileStorageFocus: InventoryStorageFocus;
  setMobileStorageFocus: (value: InventoryStorageFocus | ((current: InventoryStorageFocus) => InventoryStorageFocus)) => void;
  mobilePrioritySummaries: IngredientSummaryViewModel[];
  mobileFoodStockItems: InventoryOverviewItem[];
  mobileStorageCards: InventoryStorageOverviewViewModel[];
  mobileCatalogSummaries: IngredientSummaryViewModel[];
  mobileCatalogResetKey: string;
  mobileShoppingCards: ShoppingCardViewModel[];
  mobileShoppingGroups: ShoppingCardGroupViewModel[];
  mobileHasCatalogFilters: boolean;
  notificationCenter?: ReactNode;
  openDetailView: (ingredientId: string) => void;
  openInventoryOverlay: (ingredientId?: string) => void;
  openConsumeOverlay: (ingredientId: string) => void;
  openShoppingOverlay: (options?: { ingredient?: IngredientSummaryViewModel['ingredient']; reason?: string; shoppingItem?: ShoppingListItem }) => void;
  onDeleteShoppingItem: (itemId: string) => Promise<unknown>;
  openDestroyExpiredOverlay: (ingredientId: string) => void;
  openCreateView: () => void;
  openInventoryFromShopping: (item: ShoppingListItem) => void;
  openFoodStockMeal: (foodId: string) => void;
  openFoodStockEditor: (foodId: string) => void;
  buildPriorityStatus: (summary: IngredientSummaryViewModel) => InventoryCardStatusViewModel;
  buildCatalogStatus: (summary: IngredientSummaryViewModel) => CatalogCardStatus;
  buildInventorySummaryLine: (summary: IngredientSummaryViewModel) => string;
  buildShoppingReason: (summary: IngredientSummaryViewModel) => string;
  countDisposableExpiredItems: (summary: IngredientSummaryViewModel) => number;
  renderStorageIllustration: (storage: string) => ReactNode;
  renderIcon: (name: string) => ReactNode;
  isUpdatingShopping?: boolean;
  isCreatingInventory?: boolean;
};

export function IngredientMobileView(props: IngredientMobileViewProps) {
  const [selectedShoppingCardId, setSelectedShoppingCardId] = useState<string | null>(null);
  const priorityItemCount = props.mobilePrioritySummaries.length + props.mobileFoodStockItems.length;
  const hasPriorityItems = priorityItemCount > 0;
  const catalogPager = useMobilePagedScroller({
    itemCount: props.mobileCatalogSummaries.length,
    resetKey: props.mobileCatalogResetKey,
  });
  const mobileCatalogPages = chunkMobilePagedItems(props.mobileCatalogSummaries, catalogPager.visiblePageCount);
  const selectedShoppingCard =
    selectedShoppingCardId
      ? props.mobileShoppingCards.find((card) => card.shoppingItem.id === selectedShoppingCardId) ?? null
      : null;

  function openShoppingCard(card: ShoppingCardViewModel) {
    setSelectedShoppingCardId(card.shoppingItem.id);
  }

  function closeShoppingCard() {
    setSelectedShoppingCardId(null);
  }

  function closeShoppingCardIfAllowed() {
    if (!props.isUpdatingShopping) {
      closeShoppingCard();
    }
  }

  function handleShoppingCardKeyDown(event: KeyboardEvent<HTMLElement>, card: ShoppingCardViewModel) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    openShoppingCard(card);
  }

  function editShoppingCard(card: ShoppingCardViewModel) {
    closeShoppingCard();
    props.openShoppingOverlay({ shoppingItem: card.shoppingItem });
  }

  function restockShoppingCard(card: ShoppingCardViewModel) {
    closeShoppingCard();
    props.openInventoryFromShopping(card.shoppingItem);
  }

  function deleteShoppingCard(card: ShoppingCardViewModel) {
    void props.onDeleteShoppingItem(card.shoppingItem.id)
      .then(closeShoppingCard)
      .catch(() => undefined);
  }

  function getFoodStockExpiryLine(item: InventoryOverviewItem) {
    if (item.days_until_expiry == null) {
      return '未记录到期';
    }
    if (item.days_until_expiry <= 0) {
      return '今天需处理';
    }
    return `${item.days_until_expiry} 天后到期`;
  }

  return (
    <section className="mobile-ingredient-page" aria-label="手机食材页">
      <div className="mobile-ingredient-topbar">
        <div className="mobile-ingredient-brand">
          <span className="mobile-ingredient-logo">{props.renderIcon('logo')}</span>
          <span>
            <strong>Culina</strong>
            <small>家庭厨房工作台</small>
          </span>
        </div>
        <div className="mobile-ingredient-top-actions">
          <button type="button" aria-label="聚焦搜索" onClick={focusMobileIngredientSearch}>
            {props.renderIcon('search')}
          </button>
          {props.notificationCenter ?? (
            <button
              type="button"
              aria-label="查看食材提醒"
              onClick={() => {
                props.setMobileIngredientFilter('alerted');
                props.setMobileStorageFocus('all');
              }}
            >
              {props.renderIcon('bell')}
              {props.allAlertsCount > 0 && <i aria-hidden="true" />}
            </button>
          )}
        </div>
      </div>

      <header className="mobile-ingredient-hero">
        <h1>食材</h1>
        <p>先看家里还有什么，再处理临期、低库存和今天要买的东西。</p>
        <div className="mobile-ingredient-metrics" aria-label="食材摘要">
          <button type="button" className="metric-btn tone-stocked" onClick={() => props.setMobileIngredientFilter('stocked')}>
            <span className="metric-btn-icon">{props.renderIcon('stocked')}</span>
            <div className="metric-btn-content">
              <strong>{props.stockedIngredientCount + props.mobileFoodStockItems.length}</strong>
              <span>在库</span>
            </div>
          </button>
          <button type="button" className={props.allAlertsCount > 0 ? "metric-btn tone-alert has-alert" : "metric-btn tone-alert"} onClick={() => props.setMobileIngredientFilter('alerted')}>
            <span className="metric-btn-icon">{props.renderIcon('bell')}</span>
            <div className="metric-btn-content">
              <strong>{props.allAlertsCount}</strong>
              <span>提醒</span>
            </div>
          </button>
          <button type="button" className="metric-btn tone-shopping" onClick={() => document.getElementById('mobile-ingredient-shopping')?.scrollIntoView({ block: 'start', behavior: 'smooth' })}>
            <span className="metric-btn-icon">{props.renderIcon('shopping')}</span>
            <div className="metric-btn-content">
              <strong>{props.pendingShoppingCount}</strong>
              <span>待买</span>
            </div>
          </button>
        </div>
        <div className="mobile-ingredient-actions">
          <button className="mobile-ingredient-primary" type="button" onClick={() => props.openInventoryOverlay()}>
            {props.renderIcon('plus')}
            快速入库
          </button>
          <button className="mobile-ingredient-secondary" type="button" onClick={() => props.openShoppingOverlay()}>
            {props.renderIcon('shopping')}
            加采购
          </button>
        </div>
      </header>

      <section className="mobile-ingredient-panel">
        <div className="mobile-ingredient-section-head">
          <h2>今天先处理 <span>{priorityItemCount} 项</span></h2>
        </div>
        {hasPriorityItems ? (
          <>
            {props.mobilePrioritySummaries.length > 0 && (
              <div className="mobile-ingredient-priority-scroller">
                {props.mobilePrioritySummaries.map((summary) => {
                  const imageUrl = resolveMediaUrl(summary.ingredient.image, 'card');
                  const status = props.buildPriorityStatus(summary);
                  const canConsume = tracksIngredientQuantity(summary.ingredient) && summary.availableInventoryItems.length > 0;
                  const canDestroyExpired = props.countDisposableExpiredItems(summary) > 0;
                  return (
                    <article key={summary.ingredient.id} className={`mobile-ingredient-priority-card tone-${status.tone}`}>
                      <button className="mobile-ingredient-priority-cover" type="button" onClick={() => props.openDetailView(summary.ingredient.id)}>
                        <MediaWithPlaceholder
                          src={imageUrl}
                          srcSet={buildMediaSrcSet(summary.ingredient.image)}
                          sizes={buildMediaSizes('card')}
                          alt={summary.ingredient.name}
                        />
                      </button>
                      <div className="mobile-ingredient-priority-body">
                        <div className="mobile-ingredient-card-head">
                          <h3>{summary.ingredient.name}</h3>
                          <span>{status.label}</span>
                        </div>
                        <p>{summary.alerts[0]?.detail ?? status.detail}</p>
                        <div className="mobile-ingredient-meta-row">
                          <span>{summary.primaryStorage}</span>
                          <span>{props.buildInventorySummaryLine(summary)}</span>
                        </div>
                        <div className="mobile-ingredient-card-actions">
                          {canDestroyExpired ? (
                            <>
                              <button
                                className="mobile-ingredient-primary compact"
                                type="button"
                                onClick={() => props.openDestroyExpiredOverlay(summary.ingredient.id)}
                              >
                                处理
                              </button>
                              <button
                                type="button"
                                onClick={() => props.openDetailView(summary.ingredient.id)}
                              >
                                查看批次
                              </button>
                            </>
                          ) : canConsume ? (
                            <>
                              <button
                                className="mobile-ingredient-primary compact"
                                type="button"
                                onClick={() => props.openConsumeOverlay(summary.ingredient.id)}
                              >
                                消费
                              </button>
                              <button
                                type="button"
                                onClick={() => props.openInventoryOverlay(summary.ingredient.id)}
                              >
                                补货
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                className="mobile-ingredient-primary compact"
                                type="button"
                                onClick={() => props.openInventoryOverlay(summary.ingredient.id)}
                              >
                                {summary.inventoryItems.length > 0 ? '补货' : '登记首批'}
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  props.openShoppingOverlay({
                                    ingredient: summary.ingredient,
                                    reason: props.buildShoppingReason(summary),
                                  })
                                }
                              >
                                采购
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
            {props.mobileFoodStockItems.length > 0 && (
              <div className="mobile-food-stock-strip" aria-label="成品速食库存">
                {props.mobileFoodStockItems.slice(0, 6).map((item) => (
                  <article key={item.id} className={`mobile-food-stock-card tone-${item.tone}`}>
                    <div>
                      <span>成品速食</span>
                      <h3>{item.title}</h3>
                      <p>{item.quantity_label} · {getFoodStockExpiryLine(item)}</p>
                    </div>
                    <div className="mobile-food-stock-card-actions">
                      <button
                        type="button"
                        className="mobile-ingredient-primary compact"
                        onClick={() => props.openFoodStockMeal(item.source_id)}
                      >
                        记到今天
                      </button>
                      <button type="button" onClick={() => props.openFoodStockEditor(item.source_id)}>
                        编辑
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </>
        ) : (
          <div className="mobile-ingredient-empty">
            <strong>当前没有需要优先处理的食材或成品</strong>
            <span>可以继续浏览食材库、看看成品速食库存，或直接登记一批新库存。</span>
          </div>
        )}
      </section>

      <section className="mobile-ingredient-panel">
        <div className="mobile-ingredient-section-head">
          <h2>按位置看库存</h2>
          <button
            type="button"
            onClick={() => {
              props.setMobileStorageFocus('all');
              props.setMobileIngredientFilter('all');
            }}
          >
            全部
            {props.renderIcon('reset')}
          </button>
        </div>
        <div className="mobile-ingredient-storage-row" aria-label="库存位置">
          {props.mobileStorageCards.map((item) => (
            <button
              key={item.key}
              className={props.mobileStorageFocus === item.key ? `active tone-${item.tone}` : `tone-${item.tone}`}
              type="button"
              onClick={() =>
                props.setMobileStorageFocus((current) =>
                  current === item.key ? 'all' : (item.key as InventoryStorageFocus)
                )
              }
            >
              <span>{props.renderStorageIllustration(item.key)}</span>
              <strong>{item.label}</strong>
              <small>{item.ingredientCount} 种 · {item.alertCount} 提醒</small>
            </button>
          ))}
        </div>
      </section>

      <section className="mobile-ingredient-panel mobile-ingredient-library">
        <div className="mobile-ingredient-section-head">
          <h2>
            食材库
            {props.mobileCatalogSummaries.length > 0 && (
              <span>{catalogPager.visibleCount}/{props.mobileCatalogSummaries.length}</span>
            )}
          </h2>
          <button
            type="button"
            onClick={
              props.mobileHasCatalogFilters
                ? () => {
                    props.setCatalogSearch('');
                    props.setMobileIngredientFilter('all');
                    props.setMobileStorageFocus('all');
                  }
                : props.openCreateView
            }
          >
            {props.mobileHasCatalogFilters ? '清除筛选' : '新增'}
            {props.renderIcon(props.mobileHasCatalogFilters ? 'reset' : 'plus')}
          </button>
        </div>
        <div className="mobile-ingredient-library-filters">
          <SearchField
            className="mobile-ingredient-search"
            inputId="mobile-ingredient-search"
            leadingIcon={props.renderIcon('search')}
            ariaLabel="搜索食材"
            placeholder="搜索食材、分类、备注或菜谱"
            value={props.catalogSearch}
            loading={Boolean(props.catalogSearch.trim()) && Boolean(props.isCatalogSearchFetching)}
            onChange={props.setCatalogSearch}
            onCompositionStart={props.onCatalogSearchCompositionStart}
            onCompositionEnd={props.onCatalogSearchCompositionEnd}
          />
          <OptionChipGroup
            ariaLabel="食材筛选"
            value={props.mobileIngredientFilter}
            options={MOBILE_INGREDIENT_FILTER_OPTIONS}
            size="large"
            className="mobile-ingredient-chip-group"
            onChange={props.setMobileIngredientFilter}
          />
        </div>
        {props.mobileCatalogSummaries.length > 0 ? (
          <>
            <div className="mobile-ingredient-library-scroller" aria-label="食材库横向分页" onScroll={catalogPager.handleScroll}>
              {mobileCatalogPages.map((page, pageIndex) => (
                <div className="mobile-ingredient-library-grid" key={`ingredient-library-page-${pageIndex}`}>
                  {page.map((summary) => {
                    const imageUrl = resolveMediaUrl(summary.ingredient.image, 'card');
                    const status = props.buildCatalogStatus(summary);
                    const canConsume = tracksIngredientQuantity(summary.ingredient) && summary.availableInventoryItems.length > 0;
                    const canDestroyExpired = props.countDisposableExpiredItems(summary) > 0;
                    return (
                      <article key={summary.ingredient.id} className={`mobile-ingredient-library-card tone-${status.tone}`}>
                        <button className="mobile-ingredient-library-cover" type="button" onClick={() => props.openDetailView(summary.ingredient.id)}>
                          <MediaWithPlaceholder
                            src={imageUrl}
                            srcSet={buildMediaSrcSet(summary.ingredient.image)}
                            sizes={buildMediaSizes('card')}
                            alt={summary.ingredient.name}
                          />
                          {summary.alerts.length > 0 && <span>{summary.alerts.length} 提醒</span>}
                        </button>
                        <div className="mobile-ingredient-library-body">
                          <h3>{summary.ingredient.name}</h3>
                          <p>{summary.ingredient.category || '未分类'} · {summary.primaryStorage}</p>
                          <div className="mobile-ingredient-meta-row">
                            <span>{status.label}</span>
                            <span>{props.buildInventorySummaryLine(summary)}</span>
                          </div>
                          <div className="mobile-ingredient-library-actions">
                            {canDestroyExpired ? (
                              <>
                                <button
                                  className="mobile-ingredient-primary"
                                  type="button"
                                  onClick={() => props.openDestroyExpiredOverlay(summary.ingredient.id)}
                                >
                                  处理
                                </button>
                                <button
                                  type="button"
                                  onClick={() => props.openDetailView(summary.ingredient.id)}
                                >
                                  查看批次
                                </button>
                              </>
                            ) : canConsume ? (
                              <>
                                <button
                                  className="mobile-ingredient-primary"
                                  type="button"
                                  onClick={() => props.openConsumeOverlay(summary.ingredient.id)}
                                >
                                  消费
                                </button>
                                <button
                                  type="button"
                                  onClick={() => props.openInventoryOverlay(summary.ingredient.id)}
                                >
                                  补货
                                </button>
                              </>
                            ) : (
                              <>
                                <button
                                  className="mobile-ingredient-primary"
                                  type="button"
                                  onClick={() => props.openInventoryOverlay(summary.ingredient.id)}
                                >
                                  {summary.inventoryItems.length > 0 ? '补货' : '登记首批'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    props.openShoppingOverlay({
                                      ingredient: summary.ingredient,
                                      reason: props.buildShoppingReason(summary),
                                    })
                                  }
                                >
                                  采购
                                </button>
                              </>
                            )}
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
          <div className="mobile-ingredient-empty">
            <strong>{props.summariesCount === 0 ? '还没有食材档案' : '没有匹配的食材'}</strong>
            <span>{props.summariesCount === 0 ? '先新增常用食材，后续补货、消费和采购都会更快。' : '换个关键词或清空筛选后再试。'}</span>
            <button
              type="button"
              onClick={
                props.summariesCount === 0
                  ? props.openCreateView
                  : () => {
                      props.setCatalogSearch('');
                      props.setMobileIngredientFilter('all');
                      props.setMobileStorageFocus('all');
                    }
              }
            >
              {props.summariesCount === 0 ? '新增食材' : '清空筛选'}
            </button>
          </div>
        )}
      </section>

      <section id="mobile-ingredient-shopping" className="mobile-ingredient-panel">
        <div className="mobile-ingredient-section-head">
          <h2>采购待办 <span>{props.pendingShoppingCount} 项</span></h2>
          <button type="button" onClick={() => props.openShoppingOverlay()}>
            新增
            {props.renderIcon('plus')}
          </button>
        </div>
        {props.mobileShoppingCards.length > 0 ? (
          <div className="mobile-ingredient-shopping-list">
            {props.mobileShoppingGroups.map((group) => (
              <section key={group.key} className={`mobile-ingredient-shopping-group group-${group.key}`}>
                <div className="mobile-ingredient-shopping-group-head">
                  <strong>{group.title}</strong>
                  <span>{group.cards.length} 项</span>
                </div>
                {group.cards.map((card) => {
                  const imageUrl = resolveMediaUrl(card.linkedSummary?.ingredient.image, 'thumb');
                  return (
                    <article
                      key={card.shoppingItem.id}
                      className={`mobile-ingredient-shopping-card tone-${card.statusTone}`}
                      role="button"
                      tabIndex={0}
                      aria-label={`查看采购待办：${card.title}`}
                      onClick={() => openShoppingCard(card)}
                      onKeyDown={(event) => handleShoppingCardKeyDown(event, card)}
                    >
                      <span className="mobile-ingredient-shopping-cover">
                        <MediaWithPlaceholder
                          src={imageUrl}
                          srcSet={buildMediaSrcSet(card.linkedSummary?.ingredient.image)}
                          sizes={buildMediaSizes('thumb')}
                          alt={card.title}
                        />
                      </span>
                      <div className="mobile-ingredient-shopping-copy">
                        <strong>{card.title}</strong>
                        <small>{card.quantityLabel} · {card.reasonLabel}</small>
                      </div>
                      <button
                        type="button"
                        disabled={props.isUpdatingShopping || props.isCreatingInventory}
                        onClick={(event) => {
                          event.stopPropagation();
                          props.openInventoryFromShopping(card.shoppingItem);
                        }}
                      >
                        入库
                      </button>
                    </article>
                  );
                })}
              </section>
            ))}
          </div>
        ) : (
          <div className="mobile-ingredient-empty">
            <strong>当前没有待买项</strong>
            <span>可以从低库存食材一键加入采购，或手动添加。</span>
          </div>
        )}
      </section>

      {selectedShoppingCard && (
        <WorkspaceOverlayFrame
          rootClassName="ingredient-workspace-overlay-root mobile-ingredient-shopping-drawer-root"
          backdropClassName="mobile-ingredient-shopping-drawer-backdrop"
          closeOnBackdrop={!props.isUpdatingShopping}
          onClose={closeShoppingCardIfAllowed}
        >
          <WorkspaceDrawer
            eyebrow={selectedShoppingCard.sourceLabel}
            title={selectedShoppingCard.title}
            description={`${selectedShoppingCard.quantityLabel} · ${selectedShoppingCard.reasonLabel}`}
            closeLabel="关闭"
            closeAriaLabel="关闭采购待办详情"
            className={`mobile-ingredient-shopping-drawer tone-${selectedShoppingCard.statusTone}`}
            onClose={closeShoppingCardIfAllowed}
          >
            <div className="mobile-ingredient-shopping-drawer-summary">
              <span className="mobile-ingredient-shopping-drawer-cover">
                <MediaWithPlaceholder
                  src={resolveMediaUrl(selectedShoppingCard.linkedSummary?.ingredient.image, 'thumb')}
                  srcSet={buildMediaSrcSet(selectedShoppingCard.linkedSummary?.ingredient.image)}
                  sizes={buildMediaSizes('thumb')}
                  alt={selectedShoppingCard.title}
                />
              </span>
              <div>
                <strong>{selectedShoppingCard.title}</strong>
                <p>{selectedShoppingCard.quantityLabel} · {selectedShoppingCard.reasonLabel}</p>
              </div>
            </div>

            <div className="mobile-ingredient-shopping-drawer-facts">
              <div>
                <span>库存状态</span>
                <strong>{selectedShoppingCard.statusLabel}</strong>
              </div>
              <div>
                <span>当前库存</span>
                <strong>{selectedShoppingCard.inventoryLabel}</strong>
              </div>
              <div>
                <span>存放信息</span>
                <strong>{selectedShoppingCard.contextLine}</strong>
              </div>
            </div>

            <p className="mobile-ingredient-shopping-drawer-note">{selectedShoppingCard.footerNote}</p>

            <div className="mobile-ingredient-shopping-drawer-tags">
              {selectedShoppingCard.contextTags.map((tag) => (
                <span key={`${selectedShoppingCard.shoppingItem.id}-${tag}`}>{tag}</span>
              ))}
            </div>

            <div className="mobile-ingredient-shopping-drawer-actions">
              <button type="button" onClick={() => editShoppingCard(selectedShoppingCard)}>
                修改
              </button>
              {selectedShoppingCard.linkedSummary && (
                <button
                  type="button"
                  onClick={() => {
                    closeShoppingCard();
                    props.openDetailView(selectedShoppingCard.linkedSummary!.ingredient.id);
                  }}
                >
                  看档案
                </button>
              )}
              <button
                className="primary"
                type="button"
                disabled={props.isUpdatingShopping || props.isCreatingInventory}
                onClick={() => restockShoppingCard(selectedShoppingCard)}
              >
                入库
              </button>
              <button
                className="danger"
                type="button"
                disabled={props.isUpdatingShopping}
                onClick={() => deleteShoppingCard(selectedShoppingCard)}
              >
                删除
              </button>
            </div>
          </WorkspaceDrawer>
        </WorkspaceOverlayFrame>
      )}
    </section>
  );
}
