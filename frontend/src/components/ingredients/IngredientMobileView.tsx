import type { ReactNode } from 'react';
import { buildMediaSizes, buildMediaSrcSet, resolveAssetUrl, resolveMediaUrl } from '../../lib/assets';
import type { ShoppingListItem } from '../../api/types';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
import type {
  IngredientSummaryViewModel,
  InventoryCardStatusViewModel,
  InventoryStorageOverviewViewModel,
  ShoppingCardViewModel,
} from './workspaceModel';
import type { InventoryStorageFocus } from './ingredientWorkspaceForms';

type MobileIngredientFilter = 'all' | 'alerted' | 'empty' | 'stocked';

type CatalogCardStatus = {
  label: string;
  tone: 'stable' | 'warning' | 'danger' | 'empty';
  stockLine: string;
  hint: string;
};

type IngredientMobileViewProps = {
  allAlertsCount: number;
  stockedIngredientCount: number;
  pendingShoppingCount: number;
  summariesCount: number;
  catalogSearch: string;
  setCatalogSearch: (value: string) => void;
  mobileIngredientFilter: MobileIngredientFilter;
  setMobileIngredientFilter: (value: MobileIngredientFilter) => void;
  mobileStorageFocus: InventoryStorageFocus;
  setMobileStorageFocus: (value: InventoryStorageFocus | ((current: InventoryStorageFocus) => InventoryStorageFocus)) => void;
  mobilePrioritySummaries: IngredientSummaryViewModel[];
  mobileStorageCards: InventoryStorageOverviewViewModel[];
  mobileCatalogSummaries: IngredientSummaryViewModel[];
  mobileShoppingCards: ShoppingCardViewModel[];
  mobileHasCatalogFilters: boolean;
  notificationCenter?: ReactNode;
  openDetailView: (ingredientId: string) => void;
  openInventoryOverlay: (ingredientId?: string) => void;
  openConsumeOverlay: (ingredientId: string) => void;
  openShoppingOverlay: (options?: { ingredient?: IngredientSummaryViewModel['ingredient']; reason?: string }) => void;
  openDestroyExpiredOverlay: (ingredientId: string) => void;
  openCreateView: () => void;
  openInventoryFromShopping: (item: ShoppingListItem) => void;
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
          <button type="button" aria-label="聚焦搜索" onClick={() => document.getElementById('mobile-ingredient-search')?.focus()}>
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
              <strong>{props.stockedIngredientCount}</strong>
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
          <h2>今天先处理 <span>{props.mobilePrioritySummaries.length} 项</span></h2>
        </div>
        {props.mobilePrioritySummaries.length > 0 ? (
          <div className="mobile-ingredient-priority-scroller">
            {props.mobilePrioritySummaries.map((summary) => {
              const imageUrl = resolveMediaUrl(summary.ingredient.image, 'card');
              const status = props.buildPriorityStatus(summary);
              const canConsume = summary.availableInventoryItems.length > 0;
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
                    <div className="mobile-ingredient-chip-row">
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
                      ) : summary.quantitySummaries.length > 0 ? (
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
        ) : (
          <div className="mobile-ingredient-empty">
            <strong>当前没有需要优先处理的食材</strong>
            <span>可以继续浏览食材库，或直接登记一批新库存。</span>
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
          <h2>食材库</h2>
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
          <label className="mobile-ingredient-search">
            {props.renderIcon('search')}
            <input
              id="mobile-ingredient-search"
              value={props.catalogSearch}
              placeholder="搜索食材、分类、备注或菜谱"
              onChange={(event) => props.setCatalogSearch(event.target.value)}
            />
          </label>
          <div className="mobile-ingredient-tabs" aria-label="食材筛选">
            {[
              { value: 'all' as const, label: '全部' },
              { value: 'alerted' as const, label: '提醒' },
              { value: 'empty' as const, label: '缺货' },
              { value: 'stocked' as const, label: '在库' },
            ].map((item) => (
              <button
                key={item.value}
                className={props.mobileIngredientFilter === item.value ? 'active' : ''}
                type="button"
                onClick={() => props.setMobileIngredientFilter(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
        {props.mobileCatalogSummaries.length > 0 ? (
          <div className="mobile-ingredient-library-grid">
            {props.mobileCatalogSummaries.map((summary) => {
              const imageUrl = resolveMediaUrl(summary.ingredient.image, 'card');
              const status = props.buildCatalogStatus(summary);
              const canConsume = summary.availableInventoryItems.length > 0;
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
                    <div className="mobile-ingredient-chip-row">
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
                      ) : summary.quantitySummaries.length > 0 ? (
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
            {props.mobileShoppingCards.map((card) => {
              const imageUrl = resolveMediaUrl(card.linkedSummary?.ingredient.image, 'thumb');
              return (
                <article key={card.shoppingItem.id} className={`mobile-ingredient-shopping-card tone-${card.statusTone}`}>
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
                    onClick={() => props.openInventoryFromShopping(card.shoppingItem)}
                  >
                    入库
                  </button>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="mobile-ingredient-empty">
            <strong>当前没有待买项</strong>
            <span>可以从低库存食材一键加入采购，或手动添加。</span>
          </div>
        )}
      </section>
    </section>
  );
}
