import {
  createContext,
  useContext,
  useMemo,
  type ComponentType,
  type CompositionEventHandler,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import type { InventoryOverviewItem, ShoppingListItem } from '../../api/types';
import { buildMediaSizes, buildMediaSrcSet, resolveMediaUrl } from '../../lib/assets';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
import {
  ActionButton,
  Badge,
  EmptyState,
  OptionChipGroup,
  SearchField,
} from '../ui-kit';
import {
  getUnifiedInventorySourceLabel,
  isPendingInventoryOverviewItem,
  type InventoryEntryFilter,
  type UnifiedInventoryQuickFilter,
  type UnifiedInventoryGroup,
} from './inventoryOverviewModel';
import type {
  IngredientSummaryViewModel,
  InventoryStorageOverviewViewModel,
  ShoppingCardFocus,
  ShoppingCardGroupViewModel,
  ShoppingCardViewModel,
  StorageGroupViewModel,
} from './workspaceModel';
import type { InventoryStorageFocus, InventorySortMode } from './ingredientWorkspaceForms';
import type { CatalogStatusFilter, InventorySourceFilter } from './useIngredientWorkspaceState';

type IngredientWorkspaceIconName =
  | 'search'
  | 'filter'
  | 'status'
  | 'bell'
  | 'alert'
  | 'sort'
  | 'inventory'
  | 'shopping'
  | 'plus'
  | 'metricList'
  | 'star'
  | 'link'
  | 'metricCircle'
  | 'reset'
  | 'chevronDown'
  | 'stocked'
  | 'total';

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
type IngredientCatalogCardComponent = ComponentType<{
  summary: IngredientSummaryViewModel;
  expanded: boolean;
  onToggle: () => void;
  onRestock: () => void;
  onConsume: () => void;
  onAddShopping: () => void;
  onHandleAlert: () => void;
  onDetail: () => void;
}>;

type CatalogStatusItem = {
  value: CatalogStatusFilter;
  label: string;
};

type CatalogPanelProps = {
  summariesCount: number;
  allAlertsCount: number;
  pendingShoppingCount: number;
  stockedIngredientCount: number;
  catalogCountLabel: string;
  catalogSearch: string;
  isCatalogSearchFetching?: boolean;
  onCatalogSearchCompositionStart?: CompositionEventHandler<HTMLInputElement>;
  onCatalogSearchCompositionEnd?: CompositionEventHandler<HTMLInputElement>;
  catalogCategoryFilter: string;
  catalogStatusFilter: CatalogStatusFilter;
  catalogCategories: string[];
  catalogStatusItems: CatalogStatusItem[];
  catalogStatusCounts: Record<CatalogStatusFilter, number>;
  filteredSummaries: IngredientSummaryViewModel[];
  visibleFilteredSummaries: IngredientSummaryViewModel[];
  hasMoreCatalogSummaries: boolean;
  isLoadingMoreCatalogSummaries: boolean;
  onLoadMoreCatalogSummaries: () => void;
  catalogLoadMoreRef: RefObject<HTMLDivElement>;
  expandedCatalogIngredientId: string | null;
  catalogGridStyle: CSSProperties | undefined;
  onCatalogSearchChange: (value: string) => void;
  onCatalogCategoryFilterChange: (value: string) => void;
  onCatalogStatusFilterChange: (value: CatalogStatusFilter) => void;
  onResetCatalogFilters: () => void;
  onOpenInventoryPanelAlerted: () => void;
  onOpenShoppingPanel: () => void;
  onOpenInventoryPanelAll: () => void;
  onOpenCreateView: () => void;
  onToggleCatalogCard: (ingredientId: string) => void;
  onOpenInventoryOverlay: (ingredientId?: string) => void;
  onOpenConsumeOverlay: (ingredientId: string) => void;
  onOpenShoppingForSummary: (summary: IngredientSummaryViewModel) => void;
  onOpenHandleAlert: (summary: IngredientSummaryViewModel) => void;
  onOpenDetailView: (ingredientId: string) => void;
  catalogMeasureRef: RefObject<HTMLDivElement>;
  ScrollableChipRail: ComponentType<{
    ariaLabel: string;
    railClassName: string;
    children: ReactNode;
  }>;
  IngredientWorkspaceIcon: IngredientWorkspaceIconComponent;
  IngredientCatalogCard: IngredientCatalogCardComponent;
};

export function IngredientCatalogPanel(props: CatalogPanelProps) {
  return (
    <div className="ingredients-panel-stack ingredients-catalog-workbench">
      <section className="ingredients-catalog-toolbar">
        <div className="ingredients-catalog-search-row">
          <label className="ingredients-search-field ingredients-catalog-search-field">
            <span className="ingredients-toolbar-label ingredients-catalog-label-with-icon">
              <props.IngredientWorkspaceIcon name="search" />
              搜索食材
            </span>
            <SearchField
              className="ingredients-catalog-search-input-shell"
              ariaLabel="搜索食材"
              placeholder="搜索食材、分类、备注或相关菜谱"
              value={props.catalogSearch}
              loading={Boolean(props.catalogSearch.trim()) && Boolean(props.isCatalogSearchFetching)}
              leadingIcon={<props.IngredientWorkspaceIcon name="search" />}
              leadingIconClassName="ingredients-catalog-search-input-icon"
              onChange={props.onCatalogSearchChange}
              onClear={() => props.onCatalogSearchChange('')}
              onCompositionStart={props.onCatalogSearchCompositionStart}
              onCompositionEnd={props.onCatalogSearchCompositionEnd}
            />
          </label>
          <span className="ingredients-catalog-search-count">
            {props.catalogCountLabel}
          </span>
        </div>
        <div className="ingredients-catalog-filter-bar">
          <div className="ingredients-catalog-filter-section ingredients-catalog-filter-section-category">
            <span className="ingredients-catalog-filter-label ingredients-catalog-label-with-icon">
              <props.IngredientWorkspaceIcon name="filter" />
              分类筛选
            </span>
            <OptionChipGroup
              ariaLabel="按分类筛选食材"
              value={props.catalogCategoryFilter}
              options={[
                { value: 'all', label: '全部' },
                ...props.catalogCategories.map((category) => ({ value: category, label: category })),
              ]}
              className="ingredients-catalog-category-row ingredients-category-chip-group"
              onChange={props.onCatalogCategoryFilterChange}
            />
          </div>
          <div className="ingredients-catalog-filter-row-secondary">
            <div className="ingredients-catalog-filter-section ingredients-catalog-filter-section-status" aria-label="按库存状态筛选食材">
              <span className="ingredients-catalog-label-with-icon">
                <props.IngredientWorkspaceIcon name="status" />
                库存状态
              </span>
              <OptionChipGroup
                ariaLabel="按库存状态筛选食材"
                value={props.catalogStatusFilter}
                options={props.catalogStatusItems.map((item) => ({
                  value: item.value,
                  label: item.label,
                  description: String(props.catalogStatusCounts[item.value]),
                }))}
                className="ingredients-catalog-status-filter-row ingredients-status-chip-group"
                onChange={props.onCatalogStatusFilterChange}
              />
            </div>
            <button className="ingredients-catalog-clear-filter" type="button" onClick={props.onResetCatalogFilters}>
              <span className="ingredients-catalog-clear-filter-icon" aria-hidden="true">
                <props.IngredientWorkspaceIcon name="reset" />
              </span>
              清空筛选
            </button>
          </div>
        </div>
      </section>
      <div id="ingredient-priority-list" ref={props.catalogMeasureRef} className="ingredient-grid ingredient-grid-catalog ingredients-catalog-grid" style={props.catalogGridStyle} tabIndex={-1}>
        {props.filteredSummaries.length > 0 ? (
          <>
          {props.visibleFilteredSummaries.map((summary) => (
            <props.IngredientCatalogCard
              key={summary.ingredient.id}
              summary={summary}
              expanded={props.expandedCatalogIngredientId === summary.ingredient.id}
              onToggle={() => props.onToggleCatalogCard(summary.ingredient.id)}
              onRestock={() => props.onOpenInventoryOverlay(summary.ingredient.id)}
              onConsume={() => props.onOpenConsumeOverlay(summary.ingredient.id)}
              onAddShopping={() => props.onOpenShoppingForSummary(summary)}
              onHandleAlert={() => props.onOpenHandleAlert(summary)}
              onDetail={() => props.onOpenDetailView(summary.ingredient.id)}
            />
          ))}
          <div className="paged-list-status" ref={props.catalogLoadMoreRef}>
            {props.isLoadingMoreCatalogSummaries ? (
              <span role="status">正在加载更多食材…</span>
            ) : props.hasMoreCatalogSummaries ? (
              <button className="paged-list-load-more" type="button" onClick={props.onLoadMoreCatalogSummaries}>
                加载更多食材
              </button>
            ) : (
              <span>已加载全部食材</span>
            )}
          </div>
          </>
        ) : (
          <EmptyState
            title={props.summariesCount === 0 ? '还没有食材' : '没有找到匹配的食材'}
            description={
              props.summariesCount === 0
                ? '先添加几种常用食材，后面补货、记录用量和采购都会更方便。'
                : '换个关键词试试，或者直接新增食材。'
            }
            action={
              <button className="solid-button" type="button" onClick={props.onOpenCreateView}>
                新增食材
              </button>
            }
          />
        )}
      </div>
    </div>
  );
}

type InventoryPanelProps = {
  operationBanner?: ReactNode;
  summariesCount: number;
  inventorySearch: string;
  isInventorySearchFetching?: boolean;
  onInventorySearchCompositionStart?: CompositionEventHandler<HTMLInputElement>;
  onInventorySearchCompositionEnd?: CompositionEventHandler<HTMLInputElement>;
  inventoryQuickFilter: UnifiedInventoryQuickFilter;
  inventoryStorageFocus: InventoryStorageFocus;
  inventorySortMode: InventorySortMode;
  focusedInventorySummaries: IngredientSummaryViewModel[];
  inventoryStorageOverview: InventoryStorageOverviewViewModel[];
  inventoryGroups: StorageGroupViewModel[];
  onInventorySearchChange: (value: string) => void;
  onInventoryQuickFilterChange: (next: UnifiedInventoryQuickFilter) => void;
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

type UnifiedInventorySummary = {
  totalCount: number;
  ingredientCount: number;
  foodCount: number;
  alertCount: number;
  pendingCount: number;
  stockedCount: number;
};

type CombinedInventoryGroup = {
  key: string;
  label: string;
  ingredientGroup: StorageGroupViewModel | null;
  unifiedGroup: UnifiedInventoryGroup | null;
};

type MixedInventoryCard =
  | { key: string; type: 'food'; item: InventoryOverviewItem }
  | { key: string; type: 'ingredient'; summary: IngredientSummaryViewModel };

type UnifiedInventoryPanelContextValue = {
  inventorySourceFilter: InventorySourceFilter;
  onInventorySourceFilterChange: (value: InventorySourceFilter) => void;
  inventoryEntryFilter: InventoryEntryFilter;
  onInventoryEntryFilterChange: (value: InventoryEntryFilter) => void;
  unifiedInventoryItems: InventoryOverviewItem[];
  unifiedInventoryEntryItems: InventoryOverviewItem[];
  unifiedInventoryGroups: UnifiedInventoryGroup[];
  unifiedInventorySummary: UnifiedInventorySummary;
  unifiedInventoryEntrySummary: UnifiedInventorySummary;
  isInventoryOverviewFetching?: boolean;
  onOpenFoodStock: (foodId: string) => void;
  onRecordFoodStockMeal: (foodId: string) => void;
  onAddFoodShopping: (foodId: string) => void;
};

const UnifiedInventoryPanelContext = createContext<UnifiedInventoryPanelContextValue | null>(null);

export function IngredientInventoryPanelContextProvider(props: {
  value: UnifiedInventoryPanelContextValue;
  children: ReactNode;
}) {
  return (
    <UnifiedInventoryPanelContext.Provider value={props.value}>
      {props.children}
    </UnifiedInventoryPanelContext.Provider>
  );
}

function useUnifiedInventoryPanelContext() {
  return useContext(UnifiedInventoryPanelContext);
}

function UnifiedInventoryFoodCard(props: {
  item: InventoryOverviewItem;
  onRecordMeal: () => void;
  onEditStock: () => void;
  onAddShopping: () => void;
}) {
  const isPending = isPendingFoodStockItem(props.item);
  const sourceLabel = getUnifiedInventorySourceLabel(props.item);
  const imageUrl = resolveMediaUrl(props.item.image, 'card');
  const hasCustomImage = Boolean(props.item.image?.url);
  const storageLocation = props.item.storage_location || '常温';
  const metaLine = [props.item.category || '未分类', storageLocation].join(' · ');
  const expiryLabel =
    isPending
      ? '需要补充库存'
      : props.item.days_until_expiry == null
      ? '未填写到期日'
      : props.item.days_until_expiry < 0
        ? `已过期 ${Math.abs(props.item.days_until_expiry)} 天`
        : props.item.days_until_expiry === 0
          ? '今天到期'
          : `${props.item.days_until_expiry} 天后到期`;
  const expiryTone = props.item.tone === 'danger' ? 'danger' : props.item.tone === 'warning' ? 'warning' : 'neutral';
  const statusLabel =
    isPending
      ? '需要补充库存'
      : props.item.tone === 'danger'
      ? '需要处理'
      : props.item.tone === 'warning'
        ? '临期提醒'
        : props.item.tone === 'empty'
          ? '还没有库存'
          : '库存正常';
  const purchaseLine = props.item.purchase_source ? `最近购买：${props.item.purchase_source}` : '未填写购买来源';
  const footerNote = isPending ? '先加入库存，之后就能在这里记录用量或餐食。' : '记录用量时，也可以同时记下这顿饭。';
  const foodSourceLabel = '成品速食';
  const shouldShowShoppingAction = isPending;
  const cardClassName = [
    'ingredient-card ingredient-card-interactive ingredient-visual-card ingredient-visual-card-summary ingredient-visual-card-inventory ingredient-work-card inventory-ingredient-card ingredients-unified-inventory-card ingredients-unified-inventory-card-source-food',
    `tone-${props.item.tone}`,
    isPending ? 'ingredients-unified-inventory-card-pending' : '',
    props.item.tone === 'danger' ? 'ingredient-work-card-has-danger' : '',
    props.item.tone === 'warning' ? 'ingredient-work-card-has-warning' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <article className={cardClassName}>
      <div className="ingredient-work-card-primary">
        <div className="ingredient-work-card-toggle">
          <button
            type="button"
            className="ingredient-visual-media ingredient-visual-media-button inventory-ingredient-card-media ingredients-unified-inventory-card-media"
            onClick={props.onEditStock}
            aria-label={`编辑 ${props.item.title} 库存信息`}
          >
            <div
              className={
                hasCustomImage
                  ? 'ingredient-visual-canvas'
                  : 'ingredient-visual-canvas ingredient-visual-canvas-placeholder'
              }
            >
              <MediaWithPlaceholder
                className="ingredient-visual-cover-frame"
                imageClassName="ingredient-visual-cover"
                src={imageUrl}
                srcSet={buildMediaSrcSet(props.item.image)}
                sizes={buildMediaSizes('card')}
                alt={props.item.title}
                emptyLabel="成品图片"
                showLabel={false}
              />
            </div>
            <span className="ingredient-visual-entry-hint" aria-hidden="true">
              <span>↗</span>
            </span>
            {(props.item.tone === 'warning' || props.item.tone === 'danger') && (
              <span className={`ingredient-visual-corner ingredient-visual-corner-${props.item.tone}`}>
                {expiryLabel}
              </span>
            )}
          </button>

          <div className="ingredient-visual-body inventory-ingredient-card-body">
            <div className="ingredient-visual-title-row inventory-ingredient-card-title-row">
              <h3>{props.item.title}</h3>
              <span className="ingredients-unified-inventory-source-badge">{sourceLabel}</span>
            </div>
            <p className="ingredient-visual-meta" title={metaLine}>
              {metaLine}
            </p>
            <div className="inventory-ingredient-card-stockline">
              <div className="inventory-ingredient-card-stockline-head">
                <span className="inventory-ingredient-card-stockline-label">剩余库存</span>
                <span
                  className={`inventory-ingredient-card-expiry-badge tone-${expiryTone}`}
                  title={props.item.expiry_date ? `到期日 ${props.item.expiry_date}` : '未填写到期日'}
                >
                  {expiryLabel}
                </span>
              </div>
              <strong>{props.item.quantity_label}</strong>
              <p title={purchaseLine}>{purchaseLine}</p>
              <div className="inventory-ingredient-card-data-row">
                <span>库存 {props.item.quantity_label}</span>
                <span>成品</span>
                <span>{props.item.tone === 'warning' || props.item.tone === 'danger' ? '有提醒' : '没有提醒'}</span>
              </div>
            </div>

            <div className="ingredient-visual-tag-row inventory-ingredient-card-tag-row">
              <span className="ingredient-visual-pill inventory-ingredient-card-pill-location">
                {storageLocation}
              </span>
              <span className="ingredient-visual-pill ingredient-work-card-stable-pill ingredient-visual-pill-flex">
                {foodSourceLabel} · {statusLabel}
              </span>
            </div>
          </div>
        </div>

        <div className="ingredient-work-card-actions inventory-ingredient-card-actions">
          {!isPending ? (
            <ActionButton
              tone="primary"
              size="compact"
              type="button"
              className="ingredient-work-card-action-button ingredient-work-card-action-button-primary"
              onClick={props.onRecordMeal}
            >
              扣减
            </ActionButton>
          ) : null}
          <ActionButton
            tone={isPending ? 'primary' : 'secondary'}
            size="compact"
            type="button"
            className={`ingredient-work-card-action-button ${
              isPending ? 'ingredient-work-card-action-button-primary' : 'ingredient-work-card-action-button-secondary'
            }`}
            onClick={props.onEditStock}
          >
            补充库存
          </ActionButton>
          {shouldShowShoppingAction ? (
            <ActionButton
              tone="secondary"
              size="compact"
              type="button"
              className="ingredient-work-card-action-button ingredient-work-card-action-button-secondary"
              onClick={props.onAddShopping}
            >
              加入采购清单
            </ActionButton>
          ) : null}
        </div>

        <div className="ingredient-work-card-footer inventory-ingredient-card-footer">
          <span className="ingredient-work-card-footer-note inventory-ingredient-card-footer-note">
            {footerNote}
          </span>
        </div>
      </div>
    </article>
  );
}

function isPendingFoodStockItem(item: InventoryOverviewItem) {
  return isPendingInventoryOverviewItem(item);
}

function isPendingIngredientSummary(summary: IngredientSummaryViewModel) {
  return summary.quantitySummaries.length === 0;
}

export function IngredientInventoryPanel(props: InventoryPanelProps) {
  const unifiedContext = useUnifiedInventoryPanelContext();
  const unifiedGroups = unifiedContext?.unifiedInventoryGroups ?? [];
  const sourceFilter = unifiedContext?.inventorySourceFilter ?? 'ingredient';
  const entryFilter = unifiedContext?.inventoryEntryFilter ?? 'all';
  const hasInventorySearch = props.inventorySearch.trim().length > 0;
  const unifiedSummary = unifiedContext?.unifiedInventorySummary ?? {
    totalCount: props.focusedInventorySummaries.length,
    ingredientCount: props.focusedInventorySummaries.length,
    foodCount: 0,
    alertCount: 0,
    pendingCount: 0,
    stockedCount: props.focusedInventorySummaries.length,
  };
  const entryBaseFoodItems =
    sourceFilter === 'ingredient'
      ? []
      : (unifiedContext?.unifiedInventoryEntryItems ?? []).filter((item) => item.source_type === 'food');
  const entryBaseIngredientSummaries = sourceFilter === 'food' ? [] : props.focusedInventorySummaries;
  const ingredientPendingCount = entryBaseIngredientSummaries.filter(isPendingIngredientSummary).length;
  const ingredientStockedCount = entryBaseIngredientSummaries.length - ingredientPendingCount;
  const foodPendingCount = entryBaseFoodItems.filter(isPendingFoodStockItem).length;
  const foodStockedCount = entryBaseFoodItems.length - foodPendingCount;
  const entryOptionCounts = {
    total: entryBaseIngredientSummaries.length + entryBaseFoodItems.length,
    stocked: ingredientStockedCount + foodStockedCount,
    pending: ingredientPendingCount + foodPendingCount,
  };
  const combinedInventoryGroups = useMemo(() => {
    if (sourceFilter === 'food') {
      return unifiedGroups.map<CombinedInventoryGroup>((group) => ({
        key: group.key,
        label: group.label,
        ingredientGroup: null,
        unifiedGroup: group,
      }));
    }

    const groups = props.inventoryGroups.map<CombinedInventoryGroup>((group) => ({
      key: group.key,
      label: group.label,
      ingredientGroup: group,
      unifiedGroup: unifiedGroups.find((candidate) => candidate.key === group.key) ?? null,
    }));
    if (sourceFilter === 'ingredient') {
      return groups;
    }
    const existingKeys = new Set(groups.map((group) => group.key));
    for (const unifiedGroup of unifiedGroups) {
      if (existingKeys.has(unifiedGroup.key)) {
        continue;
      }
      groups.push({
        key: unifiedGroup.key,
        label: unifiedGroup.label,
        ingredientGroup: null,
        unifiedGroup,
      });
    }
    return groups;
  }, [props.inventoryGroups, sourceFilter, unifiedGroups]);
  const mixedInventoryCards = useMemo<MixedInventoryCard[]>(() => {
    const cards: MixedInventoryCard[] = [];
    for (const group of combinedInventoryGroups) {
      const ingredientGroup = sourceFilter === 'food' ? null : group.ingredientGroup;
      const ingredientItems = (ingredientGroup?.items ?? []).filter((summary) => {
        if (entryFilter === 'pending') {
          return isPendingIngredientSummary(summary);
        }
        if (entryFilter === 'stocked') {
          return !isPendingIngredientSummary(summary);
        }
        return true;
      });
      const foodItems = (group.unifiedGroup?.items ?? [])
        .filter((item) => item.source_type === 'food');

      for (const summary of ingredientItems) {
        cards.push({ key: `ingredient:${summary.ingredient.id}`, type: 'ingredient', summary });
      }
      for (const item of foodItems) {
        cards.push({ key: item.id, type: 'food', item });
      }
    }
    return cards;
  }, [combinedInventoryGroups, entryFilter, props.inventoryQuickFilter, sourceFilter]);
  const pendingCardCount = mixedInventoryCards.filter((card) =>
    card.type === 'food' ? isPendingFoodStockItem(card.item) : isPendingIngredientSummary(card.summary)
  ).length;
  const inventorySummaryText = [
    `共 ${mixedInventoryCards.length} 项`,
    entryFilter === 'pending' ? `${pendingCardCount} 项需要补充库存` : null,
    entryFilter === 'stocked' ? '仅显示有库存' : null,
    unifiedSummary.foodCount > 0 ? `成品 ${unifiedSummary.foodCount} 项` : null,
    props.inventoryStorageFocus !== 'all' ? props.inventoryStorageFocus : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className="ingredients-panel-stack ingredients-inventory-stack">
      {props.operationBanner}
      <div className="ingredients-panel-toolbar ingredients-inventory-toolbar">
        <div className="ingredients-inventory-toolbar-main">
          <label className="ingredients-search-field ingredients-inventory-search-field">
            <span className="ingredients-toolbar-label ingredients-catalog-label-with-icon">
              <props.IngredientWorkspaceIcon name="inventory" />
              搜索库存
            </span>
            <SearchField
              className="ingredients-inventory-search-input-shell"
              ariaLabel="搜索库存"
              placeholder="搜索食材、成品、分类或位置"
              value={props.inventorySearch}
              loading={
                (Boolean(props.inventorySearch.trim()) && Boolean(props.isInventorySearchFetching)) ||
                Boolean(unifiedContext?.isInventoryOverviewFetching)
              }
              leadingIcon={<props.IngredientWorkspaceIcon name="search" />}
              leadingIconClassName="ingredients-inventory-search-input-icon"
              onChange={props.onInventorySearchChange}
              onClear={() => props.onInventorySearchChange('')}
              onCompositionStart={props.onInventorySearchCompositionStart}
              onCompositionEnd={props.onInventorySearchCompositionEnd}
            />
          </label>
          <div className="ingredients-inventory-filter-row">
            <OptionChipGroup
              ariaLabel="库存快捷筛选"
              value={props.inventoryQuickFilter}
              options={[
                { value: 'all', label: '全部' },
                { value: 'ingredient', label: '食材' },
                { value: 'food', label: '食物' },
                { value: 'seasoning', label: '调料' },
                { value: 'alerted', label: '提醒' },
                { value: 'expiring', label: '临期' },
              ]}
              className="ingredients-inventory-quick-chip-group"
              onChange={props.onInventoryQuickFilterChange}
            />
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
              按到期日排序
            </button>
            <button
              className="chip ingredients-inventory-filter-chip ingredients-inventory-clear-filter"
              type="button"
              onClick={() => {
                unifiedContext?.onInventoryEntryFilterChange('all');
                unifiedContext?.onInventorySourceFilterChange('all');
                props.onResetFilters();
              }}
            >
              清空筛选
            </button>
          </div>
        </div>
        <div className="ingredients-panel-toolbar-actions ingredients-inventory-toolbar-actions">
          <p className="ingredients-toolbar-summary">
            {inventorySummaryText}
          </p>
        </div>
      </div>

      <section className="ingredients-inventory-overview-shell">
        <div className="ingredients-inventory-overview-head">
          <div className="ingredients-inventory-overview-headline">
            <h3>位置总览</h3>
            <p className="ingredients-inventory-overview-summary">
              {props.inventoryStorageFocus === 'all'
                ? '点击位置卡片查看该处库存'
                : `当前存放位置：${props.inventoryStorageFocus}`}
            </p>
          </div>
          <p className="ingredients-inventory-overview-tip subtle">
            存放位置和库存状态都会影响筛选。
          </p>
          {unifiedContext ? (
            <OptionChipGroup
              ariaLabel="库存状态筛选"
              value={unifiedContext.inventoryEntryFilter}
              options={[
                { value: 'all', label: '全部', description: String(entryOptionCounts.total) },
                { value: 'stocked', label: '有库存', description: String(entryOptionCounts.stocked) },
                { value: 'pending', label: '待补充库存', description: String(entryOptionCounts.pending) },
              ]}
              className="ingredients-inventory-entry-chip-group"
              onChange={unifiedContext.onInventoryEntryFilterChange}
            />
          ) : null}
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
        {mixedInventoryCards.length > 0 ? (
          <section className="ingredients-storage-group ingredients-inventory-storage-group ingredients-inventory-mixed-group">
            <div className="ingredients-inventory-grid ingredients-inventory-mixed-grid ingredients-storage-workbench-density-compact">
              {mixedInventoryCards.map((card) =>
                card.type === 'food' ? (
                    <UnifiedInventoryFoodCard
                      key={card.key}
                      item={card.item}
                      onRecordMeal={() => unifiedContext?.onRecordFoodStockMeal(card.item.source_id)}
                      onEditStock={() => unifiedContext?.onOpenFoodStock(card.item.source_id)}
                      onAddShopping={() => unifiedContext?.onAddFoodShopping(card.item.source_id)}
                    />
                  ) : (
                    <props.InventoryIngredientCard
                      key={card.key}
                      summary={card.summary}
                      onRestock={() => props.onOpenInventoryOverlay(card.summary.ingredient.id)}
                      onConsume={() => props.onOpenConsumeOverlay(card.summary.ingredient.id)}
                      onAddShopping={() => props.onOpenShoppingForSummary(card.summary)}
                      onDetail={() => props.onOpenDetailView(card.summary)}
                      onDestroyExpired={() => props.onOpenDestroyExpiredOverlay(card.summary.ingredient.id)}
                    />
                  )
              )}
            </div>
          </section>
        ) : (
          <EmptyState
            title={
              hasInventorySearch
                ? sourceFilter === 'food'
                  ? '没有找到匹配的成品速食库存'
                  : sourceFilter === 'ingredient'
                    ? '没有找到匹配的食材库存'
                    : '没有找到匹配的库存'
                : sourceFilter === 'food'
                    ? '还没有成品速食库存'
                  : sourceFilter === 'ingredient'
                    ? '还没有食材库存'
                    : '还没有库存'
            }
            description={
              hasInventorySearch
                ? props.inventoryStorageFocus !== 'all'
                  ? `当前 ${props.inventoryStorageFocus} 位置下没有匹配结果，试试切回全部位置或换个关键词。`
                  : sourceFilter === 'food'
                    ? '换个关键词试试，或者去食物页补充这份成品速食的库存信息。'
                    : sourceFilter === 'ingredient'
                      ? '换个关键词试试，或者先为常用食材加入库存。'
                    : '换个关键词试试，或者切换到食材或成品库存继续查看。'
                   : sourceFilter === 'food'
                     ? '成品速食的库存、到期和扣减信息会集中显示在这里。'
                  : sourceFilter === 'ingredient'
                    ? '先新增常用食材并加入库存，后面就能在这里集中处理提醒。'
                    : '食材库存和成品速食库存会一起汇总在这里，方便统一查看和处理。'
            }
            action={
              !hasInventorySearch && sourceFilter !== 'food' && props.summariesCount === 0 ? (
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
  operationBanner?: ReactNode;
  shoppingOverview: ShoppingOverviewItem[];
  shoppingFocus: ShoppingCardFocus;
  shoppingSearch: string;
  pendingShoppingCards: ShoppingCardViewModel[];
  visiblePendingShoppingCards: ShoppingCardViewModel[];
  visiblePendingShoppingGroups: ShoppingCardGroupViewModel[];
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
  onRestoreShopping: (item: ShoppingListItem) => void;
  IngredientWorkspaceIcon: IngredientWorkspaceIconComponent;
  ShoppingWorkRow: ShoppingWorkRowComponent;
  ShoppingHistoryRow: ShoppingHistoryRowComponent;
};

export function IngredientShoppingPanel(props: ShoppingPanelProps) {
  return (
    <div className="ingredients-panel-stack ingredients-shopping-stack">
      {props.operationBanner}

      <section className="ingredients-shopping-filter-shell" aria-label="采购筛选">
        <div className="ingredients-shopping-toolbar-tools">
          <label className="ingredients-search-field ingredients-shopping-search-field">
            <span className="ingredients-toolbar-label ingredients-catalog-label-with-icon">
              <props.IngredientWorkspaceIcon name="shopping" />
              搜索采购清单
            </span>
            <SearchField
              className="ingredients-shopping-search-input-shell"
              ariaLabel="搜索采购清单"
              placeholder="搜索名称、原因、分类或对应食材"
              value={props.shoppingSearch}
              leadingIcon={<props.IngredientWorkspaceIcon name="search" />}
              leadingIconClassName="ingredients-shopping-search-input-icon"
              onChange={props.onShoppingSearchChange}
              onClear={() => props.onShoppingSearchChange('')}
            />
          </label>
          <div className="ingredients-shopping-filter-group">
            <OptionChipGroup
              ariaLabel="采购清单筛选"
              value={props.shoppingFocus}
              options={props.shoppingOverview.map((item) => ({
                value: item.key,
                label: item.label,
                description: String(item.count),
              }))}
              className="ingredients-shopping-filter-row ingredients-shopping-filter-chip-group"
              onChange={(nextFocus) =>
                props.onShoppingFocusChange((current) => (current === nextFocus ? 'all' : nextFocus))
              }
            />
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
              <h3>采购清单</h3>
              <span>
                {props.visiblePendingShoppingCards.length} 项待买 ·{' '}
                {props.visiblePendingShoppingCards.filter((card) => card.hasAttention).length} 项建议优先购买
              </span>
            </div>
          </div>
        </div>

        {props.visiblePendingShoppingCards.length > 0 ? (
          <div className="ingredients-shopping-group-stack">
            {props.visiblePendingShoppingGroups.map((group) => (
              <section key={group.key} className={`ingredients-shopping-card-group group-${group.key}`}>
                <div className="ingredients-shopping-card-group-head">
                  <h4>{group.title}</h4>
                  <span>{group.cards.length} 项 · {group.detail}</span>
                </div>
                <div className="shopping-work-row-list">
                  {group.cards.map((card) => (
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
              </section>
            ))}
          </div>
        ) : (
          <EmptyState
            title={props.pendingShoppingCards.length === 0 ? '还没有待买内容' : '没有找到匹配的待买内容'}
            description={
              props.pendingShoppingCards.length === 0
                ? '当前没有待买内容，可以从库存提醒或食材卡片一键加入采购清单。'
                : props.shoppingFocus !== 'all'
                  ? `当前 ${props.activeShoppingOverview?.label ?? '筛选'} 下没有匹配结果，试试切回全部或换个关键词。`
                  : '换个关键词试试，或者直接添加新的待买内容。'
            }
            action={
              props.pendingShoppingCards.length === 0 ? (
                <ActionButton tone="secondary" type="button" onClick={props.onOpenShoppingOverlay}>
                  新增采购内容
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
              <h3>已购买记录</h3>
              <p className="subtle">方便回看已购买内容，需要时也能再次加入采购清单。</p>
            </div>
            <div className="shopping-history-head-actions">
              <Badge>{props.completedShoppingCards.length} 项</Badge>
              <ActionButton
                tone="tertiary"
                size="compact"
                type="button"
                onClick={props.onToggleCompletedShopping}
              >
                {props.showCompletedShopping ? '收起购买记录' : '查看已购买'}
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
                    onRestore={() => props.onRestoreShopping(card.shoppingItem)}
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
                title="没有找到匹配的已购买记录"
                description="当前搜索没有找到已购买记录，试试清空搜索后再查看。"
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
        补充库存
      </button>
      <button className="ghost-button" type="button" onClick={props.onShopping}>
        加入采购清单
      </button>
    </div>
  );
}
