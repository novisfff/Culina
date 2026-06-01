import type { ComponentType } from 'react';
import type { ShoppingListItem } from '../../api/types';
import {
  ActionButton,
  Badge,
  EmptyState,
} from '../ui-kit';
import type {
  IngredientSummaryViewModel,
  InventoryStorageOverviewViewModel,
  ShoppingCardFocus,
  ShoppingCardViewModel,
  StorageGroupViewModel,
} from './workspaceModel';
import type { InventoryStorageFocus, InventorySortMode } from './ingredientWorkspaceForms';

type IngredientWorkspaceIconName =
  | 'search'
  | 'bell'
  | 'sort'
  | 'shopping'
  | 'plus'
  | 'metricList'
  | 'star'
  | 'link'
  | 'metricCircle'
  | 'reset'
  | 'chevronDown';

type IngredientWorkspaceIconComponent = ComponentType<{ name: IngredientWorkspaceIconName }>;
type InventoryStorageOverviewCardComponent = ComponentType<{
  item: InventoryStorageOverviewViewModel;
  active: boolean;
  onSelect: () => void;
}>;
type InventoryIngredientCardComponent = ComponentType<{
  summary: IngredientSummaryViewModel;
  onRestock: () => void;
  onConsume: () => void;
  onAddShopping: () => void;
  onDetail: () => void;
  onDestroyExpired: () => void;
}>;
type ShoppingWorkRowComponent = ComponentType<{
  card: ShoppingCardViewModel;
  onComplete: () => void;
  onDetail?: () => void;
  isBusy?: boolean;
}>;
type ShoppingHistoryRowComponent = ComponentType<{
  card: ShoppingCardViewModel;
  onRestore: () => void;
  onDetail?: () => void;
  isBusy?: boolean;
}>;

type InventoryPanelProps = {
  summariesCount: number;
  inventorySearch: string;
  inventoryQuickFilter: 'all' | 'alerted';
  inventoryStorageFocus: InventoryStorageFocus;
  inventorySortMode: InventorySortMode;
  focusedInventorySummaries: IngredientSummaryViewModel[];
  inventoryStorageOverview: InventoryStorageOverviewViewModel[];
  inventoryGroups: StorageGroupViewModel[];
  onInventorySearchChange: (value: string) => void;
  onInventoryQuickFilterChange: (next: 'all' | 'alerted' | ((current: 'all' | 'alerted') => 'all' | 'alerted')) => void;
  onInventoryStorageFocusChange: (next: InventoryStorageFocus | ((current: InventoryStorageFocus) => InventoryStorageFocus)) => void;
  onInventorySortModeChange: (next: InventorySortMode | ((current: InventorySortMode) => InventorySortMode)) => void;
  onResetFilters: () => void;
  onOpenInventoryOverlay: (ingredientId?: string) => void;
  onOpenConsumeOverlay: (ingredientId: string) => void;
  onOpenShoppingForSummary: (summary: IngredientSummaryViewModel) => void;
  onOpenDetailView: (summary: IngredientSummaryViewModel) => void;
  onOpenDestroyExpiredOverlay: (ingredientId: string) => void;
  onOpenCreateView: () => void;
  IngredientWorkspaceIcon: IngredientWorkspaceIconComponent;
  InventoryStorageOverviewCard: InventoryStorageOverviewCardComponent;
  InventoryIngredientCard: InventoryIngredientCardComponent;
};

export function IngredientInventoryPanel(props: InventoryPanelProps) {
  return (
    <div className="ingredients-panel-stack ingredients-inventory-stack">
      <div className="ingredients-panel-toolbar ingredients-inventory-toolbar">
        <div className="ingredients-inventory-toolbar-main">
          <label className="ingredients-search-field ingredients-inventory-search-field">
            <span className="ingredients-toolbar-label ingredients-catalog-label-with-icon">
              库存检索
            </span>
            <span className="ingredients-catalog-search-input-shell">
              <span className="ingredients-catalog-search-input-icon" aria-hidden="true">
                <props.IngredientWorkspaceIcon name="search" />
              </span>
              <input
                className="text-input"
                placeholder="搜索食材名称、分类、位置或提醒"
                value={props.inventorySearch}
                onChange={(event) => props.onInventorySearchChange(event.target.value)}
              />
            </span>
          </label>
          <div className="ingredients-inventory-filter-row">
            <button
              className={
                props.inventoryQuickFilter === 'all'
                  ? 'chip ingredients-inventory-filter-chip active'
                  : 'chip ingredients-inventory-filter-chip'
              }
              type="button"
              onClick={() => props.onInventoryQuickFilterChange('all')}
            >
              全部库存
            </button>
            <button
              className={
                props.inventoryQuickFilter === 'alerted'
                  ? 'chip ingredients-inventory-filter-chip active'
                  : 'chip ingredients-inventory-filter-chip'
              }
              type="button"
              onClick={() => props.onInventoryQuickFilterChange('alerted')}
            >
              仅看提醒
            </button>
            <button
              className="chip ingredients-inventory-filter-chip ingredients-inventory-clear-filter"
              type="button"
              onClick={props.onResetFilters}
            >
              清空筛选
            </button>
          </div>
        </div>
        <div className="ingredients-panel-toolbar-actions ingredients-inventory-toolbar-actions">
          <p className="ingredients-toolbar-summary">
            当前显示 {props.focusedInventorySummaries.length} 种食材
            {props.inventoryStorageFocus !== 'all' ? ` · ${props.inventoryStorageFocus}` : ''}
          </p>
          <ActionButton tone="primary" type="button" onClick={() => props.onOpenInventoryOverlay()}>
            快速入库
          </ActionButton>
        </div>
      </div>

      <section className="ingredients-inventory-overview-shell">
        <div className="ingredients-inventory-overview-head">
          <div className="ingredients-inventory-overview-headline">
            <h3>位置总览</h3>
            <p className="ingredients-inventory-overview-summary">
              {props.inventoryStorageFocus === 'all'
                ? '点击任一位置卡可聚焦查看'
                : `当前分区：${props.inventoryStorageFocus}`}
            </p>
          </div>
          <p className="ingredients-inventory-overview-tip subtle">
            先看各位置库存压力，再进入对应卡片直接处理。
          </p>
        </div>
        <div className="ingredients-inventory-overview-strip">
          {props.inventoryStorageOverview.map((item) => (
            <props.InventoryStorageOverviewCard
              key={item.key}
              item={item}
              active={props.inventoryStorageFocus === item.key}
              onSelect={() =>
                props.onInventoryStorageFocusChange((current) =>
                  current === item.key ? current : (item.key as InventoryStorageFocus)
                )
              }
            />
          ))}
        </div>
      </section>

      <div className="ingredients-storage-groups ingredients-inventory-groups">
        {props.inventoryGroups.length > 0 ? (
          props.inventoryGroups.map((group) => (
            <section
              key={group.key}
              className={`ingredients-storage-group ingredients-inventory-storage-group storage-${group.key}`}
            >
              <div className="ingredients-storage-head ingredients-inventory-storage-head">
                <div className="ingredients-inventory-storage-titleblock">
                  <h3>
                    <span>位置分区</span>
                    <small>/</small>
                    {group.label}
                  </h3>
                  <p className="subtle">
                    {group.items.length} 种食材 · {group.totalBatches} 条批次 · {group.alertCount} 条提醒
                  </p>
                </div>
                <div className="ingredients-inventory-storage-head-side" aria-label="库存分区筛选和排序">
                  <button
                    className={
                      props.inventoryQuickFilter === 'alerted'
                        ? 'chip ingredients-inventory-filter-chip active ingredients-inventory-filter-chip-icon'
                        : 'chip ingredients-inventory-filter-chip ingredients-inventory-filter-chip-icon'
                    }
                    type="button"
                    onClick={() =>
                      props.onInventoryQuickFilterChange((current) => (current === 'alerted' ? 'all' : 'alerted'))
                    }
                  >
                    <props.IngredientWorkspaceIcon name="bell" />
                    仅看提醒
                  </button>
                  <button
                    className={
                      props.inventorySortMode === 'expiry'
                        ? 'chip ingredients-inventory-filter-chip active ingredients-inventory-filter-chip-icon'
                        : 'chip ingredients-inventory-filter-chip ingredients-inventory-filter-chip-icon'
                    }
                    type="button"
                    onClick={() =>
                      props.onInventorySortModeChange((current) => (current === 'expiry' ? 'default' : 'expiry'))
                    }
                  >
                    <props.IngredientWorkspaceIcon name="sort" />
                    按到期时间排序
                  </button>
                </div>
              </div>
              <div className="ingredients-inventory-grid ingredients-storage-workbench-density-compact">
                {group.items.map((summary) => (
                  <props.InventoryIngredientCard
                    key={summary.ingredient.id}
                    summary={summary}
                    onRestock={() => props.onOpenInventoryOverlay(summary.ingredient.id)}
                    onConsume={() => props.onOpenConsumeOverlay(summary.ingredient.id)}
                    onAddShopping={() => props.onOpenShoppingForSummary(summary)}
                    onDetail={() => props.onOpenDetailView(summary)}
                    onDestroyExpired={() => props.onOpenDestroyExpiredOverlay(summary.ingredient.id)}
                  />
                ))}
              </div>
            </section>
          ))
        ) : (
          <EmptyState
            title={props.summariesCount === 0 ? '还没有库存对象' : '没有匹配的库存食材'}
            description={
              props.summariesCount === 0
                ? '先新增常用食材，再开始补库存和查看当前状态。'
                : props.inventoryStorageFocus !== 'all'
                  ? `当前 ${props.inventoryStorageFocus} 位置下没有匹配结果，试试切回全部位置或换个关键词。`
                  : '试试新的搜索词，或者先为常用食材登记一批库存。'
            }
            action={
              props.summariesCount === 0 ? (
                <ActionButton tone="secondary" type="button" onClick={props.onOpenCreateView}>
                  新增食材
                </ActionButton>
              ) : undefined
            }
          />
        )}
      </div>
    </div>
  );
}

type ShoppingOverviewItem = {
  key: ShoppingCardFocus;
  label: string;
  count: number;
};

type ShoppingPanelProps = {
  shoppingOverview: ShoppingOverviewItem[];
  shoppingFocus: ShoppingCardFocus;
  shoppingSearch: string;
  pendingShoppingCards: ShoppingCardViewModel[];
  visiblePendingShoppingCards: ShoppingCardViewModel[];
  completedShoppingCards: ShoppingCardViewModel[];
  visibleCompletedShoppingCards: ShoppingCardViewModel[];
  activeShoppingOverview: ShoppingOverviewItem | null;
  showCompletedShopping: boolean;
  isUpdatingShopping?: boolean;
  isCreatingInventory?: boolean;
  onShoppingSearchChange: (value: string) => void;
  onShoppingFocusChange: (next: ShoppingCardFocus | ((current: ShoppingCardFocus) => ShoppingCardFocus)) => void;
  onOpenShoppingOverlay: () => void;
  onOpenInventoryFromShopping: (item: ShoppingListItem) => void;
  onOpenDetailView: (summary: IngredientSummaryViewModel) => void;
  onToggleCompletedShopping: () => void;
  onRestoreShopping: (itemId: string) => void;
  IngredientWorkspaceIcon: IngredientWorkspaceIconComponent;
  ShoppingWorkRow: ShoppingWorkRowComponent;
  ShoppingHistoryRow: ShoppingHistoryRowComponent;
};

export function IngredientShoppingPanel(props: ShoppingPanelProps) {
  return (
    <div className="ingredients-panel-stack ingredients-shopping-stack">
      <section className="ingredients-shopping-toolbar-shell">
        <div className="ingredients-shopping-toolbar-head">
          <div className="ingredients-shopping-toolbar-copy">
            <div className="ingredients-shopping-title-line">
              <span className="ingredients-shopping-title-icon" aria-hidden="true">
                <props.IngredientWorkspaceIcon name="shopping" />
              </span>
              <div>
                <h3>采购工作台</h3>
                <p className="subtle">先处理待买项，买完后可直接入库。</p>
              </div>
            </div>
          </div>
          <div className="ingredients-shopping-toolbar-actions">
            <ActionButton tone="primary" type="button" onClick={props.onOpenShoppingOverlay}>
              <span className="ingredients-shopping-action-icon" aria-hidden="true">
                <props.IngredientWorkspaceIcon name="plus" />
              </span>
              新增采购项
            </ActionButton>
          </div>
        </div>
        <div className="ingredients-shopping-toolbar-metrics" aria-label="采购摘要">
          {props.shoppingOverview.map((item) => (
            <div
              key={item.key}
              className={
                item.key === props.shoppingFocus
                  ? `ingredients-shopping-toolbar-metric active tone-${item.key}`
                  : `ingredients-shopping-toolbar-metric tone-${item.key}`
              }
            >
              <span className="ingredients-shopping-toolbar-metric-icon" aria-hidden="true">
                <props.IngredientWorkspaceIcon
                  name={
                    item.key === 'all'
                      ? 'metricList'
                      : item.key === 'attention'
                        ? 'star'
                        : item.key === 'linked'
                          ? 'link'
                          : 'metricCircle'
                  }
                />
              </span>
              <strong>
                {item.key === 'all'
                  ? `共 ${item.count} 项`
                  : item.key === 'attention'
                    ? `${item.count} 项优先`
                    : item.key === 'linked'
                      ? `${item.count} 项关联档案`
                      : `${item.count} 项自由项`}
              </strong>
            </div>
          ))}
        </div>
      </section>

      <section className="ingredients-shopping-filter-shell" aria-label="采购筛选">
        <div className="ingredients-shopping-toolbar-tools">
          <label className="ingredients-search-field ingredients-shopping-search-field">
            <span className="ingredients-shopping-search-input-shell">
              <span className="ingredients-shopping-search-input-icon" aria-hidden="true">
                <props.IngredientWorkspaceIcon name="search" />
              </span>
              <input
                className="text-input"
                placeholder="搜索待买名称、原因、分类或关联食材"
                value={props.shoppingSearch}
                onChange={(event) => props.onShoppingSearchChange(event.target.value)}
              />
            </span>
          </label>
          <div className="ingredients-shopping-filter-group">
            <div className="ingredients-shopping-filter-row">
              {props.shoppingOverview.map((item) => (
                <button
                  key={item.key}
                  className={
                    props.shoppingFocus === item.key
                      ? 'chip ingredients-shopping-filter-chip active'
                      : 'chip ingredients-shopping-filter-chip'
                  }
                  type="button"
                  onClick={() =>
                    props.onShoppingFocusChange((current) => (current === item.key ? 'all' : item.key))
                  }
                >
                  {item.label}
                  <span>{item.count}</span>
                </button>
              ))}
            </div>
          </div>
          <button
            className="ingredients-shopping-clear-filter"
            type="button"
            onClick={() => {
              props.onShoppingSearchChange('');
              props.onShoppingFocusChange('all');
            }}
            disabled={!props.shoppingSearch.trim() && props.shoppingFocus === 'all'}
          >
            <span className="ingredients-shopping-clear-filter-icon" aria-hidden="true">
              <props.IngredientWorkspaceIcon name="reset" />
            </span>
            清空筛选
          </button>
        </div>
      </section>

      <section className="ingredients-workbench-section ingredients-shopping-stage">
        <div className="ingredients-purchase-section-head ingredients-shopping-stage-head">
          <div>
            <div className="ingredients-shopping-stage-title-line">
              <h3>待采购清单</h3>
              <span>
                {props.visiblePendingShoppingCards.length} 项待买 ·{' '}
                {props.visiblePendingShoppingCards.filter((card) => card.hasAttention).length} 项需优先处理
              </span>
            </div>
          </div>
        </div>

        {props.visiblePendingShoppingCards.length > 0 ? (
          <div className="shopping-work-row-list">
            {props.visiblePendingShoppingCards.map((card) => (
              <props.ShoppingWorkRow
                key={card.shoppingItem.id}
                card={card}
                onComplete={() => props.onOpenInventoryFromShopping(card.shoppingItem)}
                onDetail={
                  card.linkedSummary
                    ? () => {
                        if (card.linkedSummary) {
                          props.onOpenDetailView(card.linkedSummary);
                        }
                      }
                    : undefined
                }
                isBusy={props.isUpdatingShopping || props.isCreatingInventory}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            title={props.pendingShoppingCards.length === 0 ? '待买区很清爽' : '没找到匹配的待买项'}
            description={
              props.pendingShoppingCards.length === 0
                ? '当前没有待买项，可以从库存提醒或档案卡片一键加入采购。'
                : props.shoppingFocus !== 'all'
                  ? `当前 ${props.activeShoppingOverview?.label ?? '筛选'} 下没有匹配结果，试试切回全部或换个关键词。`
                  : '换个关键词试试，或者直接新增一条新的待买项。'
            }
            action={
              props.pendingShoppingCards.length === 0 ? (
                <ActionButton tone="secondary" type="button" onClick={props.onOpenShoppingOverlay}>
                  新增采购项
                </ActionButton>
              ) : undefined
            }
          />
        )}
      </section>

      {props.completedShoppingCards.length > 0 && (
        <section className="ingredients-workbench-section shopping-history-shell">
          <div className="ingredients-purchase-section-head shopping-history-head">
            <div className="shopping-history-title-line">
              <h3>已买回顾</h3>
              <p className="subtle">已完成的采购项，助你回顾与补充。</p>
            </div>
            <div className="shopping-history-head-actions">
              <Badge>{props.completedShoppingCards.length} 项</Badge>
              <ActionButton
                tone="tertiary"
                size="compact"
                type="button"
                onClick={props.onToggleCompletedShopping}
              >
                {props.showCompletedShopping ? '收起已买' : '展开已买'}
                <span
                  className={
                    props.showCompletedShopping
                      ? 'shopping-history-toggle-icon is-open'
                      : 'shopping-history-toggle-icon'
                  }
                  aria-hidden="true"
                >
                  <props.IngredientWorkspaceIcon name="chevronDown" />
                </span>
              </ActionButton>
            </div>
          </div>

          {props.showCompletedShopping ? (
            props.visibleCompletedShoppingCards.length > 0 ? (
              <div className="shopping-history-row-list">
                {props.visibleCompletedShoppingCards.map((card) => (
                  <props.ShoppingHistoryRow
                    key={card.shoppingItem.id}
                    card={card}
                    onRestore={() => props.onRestoreShopping(card.shoppingItem.id)}
                    onDetail={
                      card.linkedSummary
                        ? () => {
                            if (card.linkedSummary) {
                              props.onOpenDetailView(card.linkedSummary);
                            }
                          }
                        : undefined
                    }
                    isBusy={props.isUpdatingShopping}
                  />
                ))}
              </div>
            ) : (
              <EmptyState
                title="没有匹配的已买记录"
                description="当前搜索词下没有已买项目，试试清空搜索后再查看。"
              />
            )
          ) : null}
        </section>
      )}
    </div>
  );
}

export function IngredientMobileQuickBar(props: {
  onCreate: () => void;
  onInventory: () => void;
  onShopping: () => void;
}) {
  return (
    <div className="ingredients-mobile-bar">
      <button className="solid-button" type="button" onClick={props.onCreate}>
        新增食材
      </button>
      <button className="ghost-button" type="button" onClick={props.onInventory}>
        补库存
      </button>
      <button className="ghost-button" type="button" onClick={props.onShopping}>
        加采购
      </button>
    </div>
  );
}
