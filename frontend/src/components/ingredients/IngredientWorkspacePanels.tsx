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
  getUnifiedInventoryActionLabel,
  getUnifiedInventoryFoodPrimaryActionKind,
  getUnifiedInventorySourceLabel,
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
              档案检索
            </span>
            <SearchField
              className="ingredients-catalog-search-input-shell"
              ariaLabel="搜索食材"
              placeholder="搜索食材、分类、备注或关联菜谱"
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
              ariaLabel="按分类筛选食材档案"
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
            <div className="ingredients-catalog-filter-section ingredients-catalog-filter-section-status" aria-label="按库存状态筛选食材档案">
              <span className="ingredients-catalog-label-with-icon">
                <props.IngredientWorkspaceIcon name="status" />
                状态筛选
              </span>
              <OptionChipGroup
                ariaLabel="按库存状态筛选食材档案"
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
      <div ref={props.catalogMeasureRef} className="ingredient-grid ingredient-grid-catalog ingredients-catalog-grid" style={props.catalogGridStyle}>
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
            {props.hasMoreCatalogSummaries ? (
              <button className="paged-list-load-more" type="button" onClick={props.onLoadMoreCatalogSummaries}>
                继续加载食材
              </button>
            ) : (
              <span>已加载全部食材</span>
            )}
          </div>
          </>
        ) : (
          <EmptyState
            title={props.summariesCount === 0 ? '还没有食材档案' : '没找到匹配的食材'}
            description={
              props.summariesCount === 0
                ? '先新增几张常用食材资料卡，后面补货、消费和采购都会直接很多。'
                : '换个关键词试试，或者直接新建一张资料卡。'
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
  summariesCount: number;
  inventorySearch: string;
  isInventorySearchFetching?: boolean;
  onInventorySearchCompositionStart?: CompositionEventHandler<HTMLInputElement>;
  onInventorySearchCompositionEnd?: CompositionEventHandler<HTMLInputElement>;
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

type UnifiedInventorySummary = {
  totalCount: number;
  ingredientCount: number;
  foodCount: number;
  alertCount: number;
};

type CombinedInventoryGroup = {
  key: string;
  label: string;
  ingredientGroup: StorageGroupViewModel | null;
  unifiedGroup: UnifiedInventoryGroup | null;
};

type UnifiedInventoryPanelContextValue = {
  inventorySourceFilter: InventorySourceFilter;
  onInventorySourceFilterChange: (value: InventorySourceFilter) => void;
  unifiedInventoryItems: InventoryOverviewItem[];
  unifiedInventoryGroups: UnifiedInventoryGroup[];
  unifiedInventorySummary: UnifiedInventorySummary;
  isInventoryOverviewFetching?: boolean;
  onOpenFoodStock: (foodId: string) => void;
  onRecordFoodStockMeal: (foodId: string) => void;
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
}) {
  const actionLabel = getUnifiedInventoryActionLabel(props.item);
  const primaryAction =
    getUnifiedInventoryFoodPrimaryActionKind(props.item) === 'editStock'
      ? props.onEditStock
      : props.onRecordMeal;
  const sourceLabel = getUnifiedInventorySourceLabel(props.item);
  const imageUrl = resolveMediaUrl(props.item.image, 'card');
  const hasCustomImage = Boolean(props.item.image?.url);
  const storageLocation = props.item.storage_location || '常温';
  const metaLine = [props.item.category || '未分类', storageLocation].join(' · ');
  const expiryLabel =
    props.item.days_until_expiry == null
      ? '未记录到期'
      : props.item.days_until_expiry < 0
        ? `已过期 ${Math.abs(props.item.days_until_expiry)} 天`
        : props.item.days_until_expiry === 0
          ? '今天到期'
          : `${props.item.days_until_expiry} 天后到期`;
  const expiryTone = props.item.tone === 'danger' ? 'danger' : props.item.tone === 'warning' ? 'warning' : 'neutral';
  const statusLabel =
    props.item.tone === 'danger'
      ? '需处理'
      : props.item.tone === 'warning'
        ? '临期提醒'
        : props.item.tone === 'empty'
          ? '未登记'
          : '平稳';
  const purchaseLine = props.item.purchase_source ? `最近来源 ${props.item.purchase_source}` : '未记录购买来源';
  const footerNote =
    props.item.primary_action === 'edit_food_stock'
      ? '建议先核对到期和剩余数量，再决定是否记餐。'
      : '记到今天时可以同步扣减这份成品库存。';
  const cardClassName = [
    'ingredient-card ingredient-card-interactive ingredient-visual-card ingredient-visual-card-summary ingredient-visual-card-inventory ingredient-work-card inventory-ingredient-card ingredients-unified-inventory-card',
    `tone-${props.item.tone}`,
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
            aria-label={`编辑 ${props.item.title} 库存资料`}
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
            </div>
            <p className="ingredient-visual-meta" title={metaLine}>
              {metaLine}
            </p>
            <div className="inventory-ingredient-card-stockline">
              <div className="inventory-ingredient-card-stockline-head">
                <span className="inventory-ingredient-card-stockline-label">剩余库存</span>
                <span
                  className={`inventory-ingredient-card-expiry-badge tone-${expiryTone}`}
                  title={props.item.expiry_date ? `到期日 ${props.item.expiry_date}` : '未记录到期日'}
                >
                  {expiryLabel}
                </span>
              </div>
              <strong>{props.item.quantity_label}</strong>
              <p title={purchaseLine}>{purchaseLine}</p>
              <div className="inventory-ingredient-card-data-row">
                <span>库存 {props.item.quantity_label}</span>
                <span>成品记录</span>
                <span>{props.item.tone === 'warning' || props.item.tone === 'danger' ? '1 条提醒' : '0 条提醒'}</span>
              </div>
            </div>

            <div className="ingredient-visual-tag-row inventory-ingredient-card-tag-row">
              <span className="ingredient-visual-pill inventory-ingredient-card-pill-location">
                {storageLocation}
              </span>
              <span className="ingredient-visual-pill ingredient-work-card-stable-pill ingredient-visual-pill-flex">
                {sourceLabel} · {statusLabel}
              </span>
            </div>
          </div>
        </div>

        <div className="ingredient-work-card-actions inventory-ingredient-card-actions">
          <ActionButton
            tone="secondary"
            size="compact"
            type="button"
            className="ingredient-work-card-action-button ingredient-work-card-action-button-primary"
            onClick={primaryAction}
          >
            {actionLabel}
          </ActionButton>
          <ActionButton
            tone="secondary"
            size="compact"
            type="button"
            className="ingredient-work-card-action-button ingredient-work-card-action-button-secondary"
            onClick={props.onEditStock}
          >
            编辑资料
          </ActionButton>
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

export function IngredientInventoryPanel(props: InventoryPanelProps) {
  const unifiedContext = useUnifiedInventoryPanelContext();
  const unifiedGroups = unifiedContext?.unifiedInventoryGroups ?? [];
  const sourceFilter = unifiedContext?.inventorySourceFilter ?? 'ingredient';
  const hasInventorySearch = props.inventorySearch.trim().length > 0;
  const unifiedSummary = unifiedContext?.unifiedInventorySummary ?? {
    totalCount: props.focusedInventorySummaries.length,
    ingredientCount: props.focusedInventorySummaries.length,
    foodCount: 0,
    alertCount: 0,
  };
  const inventorySummaryText = [
    `${unifiedSummary.totalCount}项`,
    unifiedSummary.foodCount > 0 ? `成品${unifiedSummary.foodCount}` : null,
    props.inventoryStorageFocus !== 'all' ? props.inventoryStorageFocus : null,
  ].filter(Boolean).join(' · ');
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

  return (
    <div className="ingredients-panel-stack ingredients-inventory-stack">
      <div className="ingredients-panel-toolbar ingredients-inventory-toolbar">
        <div className="ingredients-inventory-toolbar-main">
          <label className="ingredients-search-field ingredients-inventory-search-field">
            <span className="ingredients-toolbar-label ingredients-catalog-label-with-icon">
              <props.IngredientWorkspaceIcon name="inventory" />
              库存检索
            </span>
            <SearchField
              className="ingredients-inventory-search-input-shell"
              ariaLabel="搜索库存"
              placeholder="搜索食材名称、分类、位置或提醒"
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
            {unifiedContext ? (
              <OptionChipGroup
                ariaLabel="库存来源筛选"
                value={unifiedContext.inventorySourceFilter}
                options={[
                  { value: 'all', label: '全部', description: String(unifiedSummary.totalCount) },
                  { value: 'ingredient', label: '食材', description: String(unifiedSummary.ingredientCount) },
                  { value: 'food', label: '成品', description: String(unifiedSummary.foodCount) },
                ]}
                className="ingredients-inventory-source-chip-group"
                onChange={unifiedContext.onInventorySourceFilterChange}
              />
            ) : null}
            <button
              className={
                props.inventoryQuickFilter === 'alerted'
                  ? 'ui-option-chip is-selected ingredients-inventory-alert-toggle'
                  : 'ui-option-chip ingredients-inventory-alert-toggle'
              }
              type="button"
              aria-pressed={props.inventoryQuickFilter === 'alerted'}
              onClick={() =>
                props.onInventoryQuickFilterChange((current) => (current === 'alerted' ? 'all' : 'alerted'))
              }
            >
              <span>提醒</span>
              <small>{unifiedSummary.alertCount}</small>
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
        {combinedInventoryGroups.length > 0 ? (
          combinedInventoryGroups.map((group) => {
            const foodItems = (group.unifiedGroup?.items ?? [])
              .filter((item) => item.source_type === 'food')
              .filter((item) =>
                props.inventoryQuickFilter === 'alerted' ? item.tone === 'warning' || item.tone === 'danger' : true
              );
            const ingredientGroup = sourceFilter === 'food' ? null : group.ingredientGroup;
            const ingredientCount = group.unifiedGroup?.ingredientCount ?? ingredientGroup?.items.length ?? 0;
            const foodCount = group.unifiedGroup?.foodCount ?? 0;
            const alertCount = group.unifiedGroup?.alertCount ?? ingredientGroup?.alertCount ?? 0;
            const totalBatches = ingredientGroup?.totalBatches ?? 0;
            const ingredientItems = ingredientGroup?.items ?? [];

            if (foodItems.length === 0 && ingredientItems.length === 0) {
              return null;
            }

            return (
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
                      {ingredientCount} 种食材
                      {foodCount > 0 ? ` · ${foodCount} 个成品速食` : ''}
                      {totalBatches > 0 ? ` · ${totalBatches} 条批次` : ''}
                      · {alertCount} 条提醒
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
                  {foodItems.map((item) => (
                    <UnifiedInventoryFoodCard
                      key={item.id}
                      item={item}
                      onRecordMeal={() => unifiedContext?.onRecordFoodStockMeal(item.source_id)}
                      onEditStock={() => unifiedContext?.onOpenFoodStock(item.source_id)}
                    />
                  ))}
                  {ingredientItems.map((summary) => (
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
            );
          })
        ) : (
          <EmptyState
            title={
              hasInventorySearch
                ? sourceFilter === 'food'
                  ? '没有匹配的成品速食库存'
                  : sourceFilter === 'ingredient'
                    ? '没有匹配的食材库存'
                    : '没有匹配的库存记录'
                : sourceFilter === 'food'
                  ? '还没有成品速食库存'
                  : sourceFilter === 'ingredient'
                    ? '还没有食材库存'
                    : '还没有库存记录'
            }
            description={
              hasInventorySearch
                ? props.inventoryStorageFocus !== 'all'
                  ? `当前 ${props.inventoryStorageFocus} 位置下没有匹配结果，试试切回全部位置或换个关键词。`
                  : sourceFilter === 'food'
                    ? '换个关键词试试，或者去食物页补充这份成品速食的库存信息。'
                    : sourceFilter === 'ingredient'
                      ? '换个关键词试试，或者先为常用食材登记一批库存。'
                      : '换个关键词试试，或者切换到食材库存 / 成品速食继续看。'
                : sourceFilter === 'food'
                  ? '成品速食的库存、到期和记餐入口会统一显示在这里。'
                  : sourceFilter === 'ingredient'
                    ? '先新增常用食材并登记库存，后面就能在这里集中处理提醒。'
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
  onRestoreShopping: (itemId: string) => void;
  IngredientWorkspaceIcon: IngredientWorkspaceIconComponent;
  ShoppingWorkRow: ShoppingWorkRowComponent;
  ShoppingHistoryRow: ShoppingHistoryRowComponent;
};

export function IngredientShoppingPanel(props: ShoppingPanelProps) {
  return (
    <div className="ingredients-panel-stack ingredients-shopping-stack">

      <section className="ingredients-shopping-filter-shell" aria-label="采购筛选">
        <div className="ingredients-shopping-toolbar-tools">
          <label className="ingredients-search-field ingredients-shopping-search-field">
            <span className="ingredients-toolbar-label ingredients-catalog-label-with-icon">
              <props.IngredientWorkspaceIcon name="shopping" />
              采购检索
            </span>
            <SearchField
              className="ingredients-shopping-search-input-shell"
              ariaLabel="搜索采购项"
              placeholder="搜索待买名称、原因、分类或关联食材"
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
              <h3>待采购清单</h3>
              <span>
                {props.visiblePendingShoppingCards.length} 项待买 ·{' '}
                {props.visiblePendingShoppingCards.filter((card) => card.hasAttention).length} 项需优先处理
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
