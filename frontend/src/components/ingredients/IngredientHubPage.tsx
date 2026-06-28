import type {
  CSSProperties,
  ComponentType,
  CompositionEventHandler,
  Dispatch,
  ReactNode,
  RefObject,
  SetStateAction,
} from 'react';
import type { ShoppingListItem } from '../../api/types';
import type { OverlayLayerProps } from './IngredientWorkspaceOverlayTypes';
import { IngredientHubView } from './IngredientHubView';
import { IngredientMobileView } from './IngredientMobileView';
import {
  IngredientCatalogPanel,
  IngredientInventoryPanel,
  IngredientShoppingPanel,
} from './IngredientWorkspacePanels';
import { IngredientWorkspaceFrame } from './IngredientWorkspaceFrame';
import type { InventoryStorageFocus, InventorySortMode } from './ingredientWorkspaceForms';
import type {
  IngredientSummaryViewModel,
  InventoryCardStatusViewModel,
  IngredientWorkspacePanel,
  InventoryStorageOverviewViewModel,
  ShoppingCardFocus,
  ShoppingCardGroupViewModel,
  ShoppingCardViewModel,
  ShoppingOverviewViewModel,
  StorageGroupViewModel,
} from './workspaceModel';
import type {
  CatalogStatusFilter,
  InventoryQuickFilter,
  MobileIngredientFilter,
} from './useIngredientWorkspaceState';

type IngredientWorkspaceIconName =
  | 'logo'
  | 'archive'
  | 'inventory'
  | 'shopping'
  | 'search'
  | 'filter'
  | 'status'
  | 'bell'
  | 'alert'
  | 'sort'
  | 'plus'
  | 'metricList'
  | 'star'
  | 'link'
  | 'metricCircle'
  | 'reset'
  | 'chevronDown'
  | 'stocked'
  | 'total';

type InventoryStorageIllustrationComponent = ComponentType<{ storage: string }>;
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

type IngredientHubPageProps = {
  noticeToast: ReactNode;
  overlays: OverlayLayerProps;
  workspaceMetrics: Array<{ label: string; value: string; detail?: string }>;
  desktopActions: ReactNode;
  panelItems: Array<{ value: IngredientWorkspacePanel; label: string; icon: ReactNode }>;
  activePanel: IngredientWorkspacePanel;
  openWorkspacePanel: (value: IngredientWorkspacePanel) => void;
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
  mobileCatalogResetKey: string;
  mobileShoppingCards: ShoppingCardViewModel[];
  mobileShoppingGroups: ShoppingCardGroupViewModel[];
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
  buildCatalogStatus: (summary: IngredientSummaryViewModel) => {
    label: string;
    tone: 'stable' | 'warning' | 'danger' | 'empty';
    stockLine: string;
    hint: string;
  };
  buildInventorySummaryLine: (summary: IngredientSummaryViewModel) => string;
  buildShoppingReason: (summary: IngredientSummaryViewModel) => string;
  countDisposableExpiredItems: (summary: IngredientSummaryViewModel) => number;
  renderStorageIllustration: InventoryStorageIllustrationComponent;
  renderIcon: (name: IngredientWorkspaceIconName) => ReactNode;
  isUpdatingShopping?: boolean;
  isCreatingInventory?: boolean;
  isCatalogSearchFetching?: boolean;
  onCatalogSearchCompositionStart?: CompositionEventHandler<HTMLInputElement>;
  onCatalogSearchCompositionEnd?: CompositionEventHandler<HTMLInputElement>;
  catalogCountLabel: string;
  catalogCategoryFilter: string;
  catalogStatusFilter: CatalogStatusFilter;
  catalogCategories: string[];
  catalogStatusItems: Array<{ value: CatalogStatusFilter; label: string }>;
  catalogStatusCounts: Record<CatalogStatusFilter, number>;
  filteredSummaries: IngredientSummaryViewModel[];
  expandedCatalogIngredientId: string | null;
  catalogGridStyle: CSSProperties | undefined;
  setCatalogCategoryFilter: (value: string) => void;
  setCatalogStatusFilter: (value: CatalogStatusFilter) => void;
  openInventoryPanel: (focus?: 'all' | 'alerted') => void;
  toggleCatalogCard: (ingredientId: string) => void;
  catalogMeasureRef: RefObject<HTMLDivElement>;
  ScrollableChipRail: ComponentType<{
    ariaLabel: string;
    railClassName: string;
    children: ReactNode;
  }>;
  IngredientCatalogCard: IngredientCatalogCardComponent;
  inventorySearch: string;
  isInventorySearchFetching?: boolean;
  onInventorySearchCompositionStart?: CompositionEventHandler<HTMLInputElement>;
  onInventorySearchCompositionEnd?: CompositionEventHandler<HTMLInputElement>;
  setInventorySearch: (value: string) => void;
  inventoryQuickFilter: InventoryQuickFilter;
  setInventoryQuickFilter: Dispatch<SetStateAction<InventoryQuickFilter>>;
  inventoryStorageFocus: InventoryStorageFocus;
  setInventoryStorageFocus: Dispatch<SetStateAction<InventoryStorageFocus>>;
  inventorySortMode: InventorySortMode;
  setInventorySortMode: Dispatch<SetStateAction<InventorySortMode>>;
  focusedInventorySummaries: IngredientSummaryViewModel[];
  inventoryStorageOverview: InventoryStorageOverviewViewModel[];
  inventoryGroups: StorageGroupViewModel[];
  InventoryStorageOverviewCard: InventoryStorageOverviewCardComponent;
  InventoryIngredientCard: InventoryIngredientCardComponent;
  shoppingOverview: ShoppingOverviewViewModel[];
  shoppingFocus: ShoppingCardFocus;
  setShoppingFocus: Dispatch<SetStateAction<ShoppingCardFocus>>;
  shoppingSearch: string;
  setShoppingSearch: (value: string) => void;
  pendingShoppingCards: ShoppingCardViewModel[];
  visiblePendingShoppingCards: ShoppingCardViewModel[];
  visiblePendingShoppingGroups: ShoppingCardGroupViewModel[];
  completedShoppingCards: ShoppingCardViewModel[];
  visibleCompletedShoppingCards: ShoppingCardViewModel[];
  activeShoppingOverview: ShoppingOverviewViewModel | null;
  showCompletedShopping: boolean;
  setShowCompletedShopping: Dispatch<SetStateAction<boolean>>;
  onUpdateShoppingItem: (payload: { itemId: string; done: boolean }) => Promise<unknown>;
  ShoppingWorkRow: ShoppingWorkRowComponent;
  ShoppingHistoryRow: ShoppingHistoryRowComponent;
};

export function IngredientHubPage(props: IngredientHubPageProps) {
  const activePanelContent =
    props.activePanel === 'catalog' ? (
      <IngredientCatalogPanel
        summariesCount={props.summariesCount}
        allAlertsCount={props.allAlertsCount}
        pendingShoppingCount={props.pendingShoppingCount}
        stockedIngredientCount={props.stockedIngredientCount}
        catalogCountLabel={props.catalogCountLabel}
        catalogSearch={props.catalogSearch}
        isCatalogSearchFetching={props.isCatalogSearchFetching}
        onCatalogSearchCompositionStart={props.onCatalogSearchCompositionStart}
        onCatalogSearchCompositionEnd={props.onCatalogSearchCompositionEnd}
        catalogCategoryFilter={props.catalogCategoryFilter}
        catalogStatusFilter={props.catalogStatusFilter}
        catalogCategories={props.catalogCategories}
        catalogStatusItems={props.catalogStatusItems}
        catalogStatusCounts={props.catalogStatusCounts}
        filteredSummaries={props.filteredSummaries}
        expandedCatalogIngredientId={props.expandedCatalogIngredientId}
        catalogGridStyle={props.catalogGridStyle}
        onCatalogSearchChange={props.setCatalogSearch}
        onCatalogCategoryFilterChange={props.setCatalogCategoryFilter}
        onCatalogStatusFilterChange={props.setCatalogStatusFilter}
        onResetCatalogFilters={() => {
          props.setCatalogSearch('');
          props.setCatalogCategoryFilter('all');
          props.setCatalogStatusFilter('all');
        }}
        onOpenInventoryPanelAlerted={() => props.openInventoryPanel('alerted')}
        onOpenShoppingPanel={() => props.openWorkspacePanel('shopping')}
        onOpenInventoryPanelAll={() => props.openInventoryPanel('all')}
        onOpenCreateView={props.openCreateView}
        onToggleCatalogCard={props.toggleCatalogCard}
        onOpenInventoryOverlay={props.openInventoryOverlay}
        onOpenConsumeOverlay={props.openConsumeOverlay}
        onOpenShoppingForSummary={(summary) =>
          props.openShoppingOverlay({
            ingredient: summary.ingredient,
            reason: props.buildShoppingReason(summary),
          })
        }
        onOpenHandleAlert={(summary) =>
          props.countDisposableExpiredItems(summary) > 0
            ? props.openDestroyExpiredOverlay(summary.ingredient.id)
            : props.openDetailView(summary.ingredient.id)
        }
        onOpenDetailView={props.openDetailView}
        catalogMeasureRef={props.catalogMeasureRef}
        ScrollableChipRail={props.ScrollableChipRail}
        IngredientWorkspaceIcon={({ name }) => props.renderIcon(name as IngredientWorkspaceIconName)}
        IngredientCatalogCard={props.IngredientCatalogCard}
      />
    ) : props.activePanel === 'inventory' ? (
      <IngredientInventoryPanel
        summariesCount={props.summariesCount}
        inventorySearch={props.inventorySearch}
        isInventorySearchFetching={props.isInventorySearchFetching}
        onInventorySearchCompositionStart={props.onInventorySearchCompositionStart}
        onInventorySearchCompositionEnd={props.onInventorySearchCompositionEnd}
        inventoryQuickFilter={props.inventoryQuickFilter}
        inventoryStorageFocus={props.inventoryStorageFocus}
        inventorySortMode={props.inventorySortMode}
        focusedInventorySummaries={props.focusedInventorySummaries}
        inventoryStorageOverview={props.inventoryStorageOverview}
        inventoryGroups={props.inventoryGroups}
        onInventorySearchChange={props.setInventorySearch}
        onInventoryQuickFilterChange={props.setInventoryQuickFilter}
        onInventoryStorageFocusChange={props.setInventoryStorageFocus}
        onInventorySortModeChange={props.setInventorySortMode}
        onResetFilters={() => {
          props.setInventorySearch('');
          props.setInventoryQuickFilter('all');
          props.setInventoryStorageFocus('冷藏');
          props.setInventorySortMode('default');
        }}
        onOpenInventoryOverlay={props.openInventoryOverlay}
        onOpenConsumeOverlay={props.openConsumeOverlay}
        onOpenShoppingForSummary={(summary) =>
          props.openShoppingOverlay({
            ingredient: summary.ingredient,
            reason: props.buildShoppingReason(summary),
          })
        }
        onOpenDetailView={(summary) => props.openDetailView(summary.ingredient.id)}
        onOpenDestroyExpiredOverlay={props.openDestroyExpiredOverlay}
        onOpenCreateView={props.openCreateView}
        IngredientWorkspaceIcon={({ name }) => props.renderIcon(name as IngredientWorkspaceIconName)}
        InventoryStorageOverviewCard={props.InventoryStorageOverviewCard}
        InventoryIngredientCard={props.InventoryIngredientCard}
      />
    ) : (
      <IngredientShoppingPanel
        shoppingOverview={props.shoppingOverview}
        shoppingFocus={props.shoppingFocus}
        shoppingSearch={props.shoppingSearch}
        pendingShoppingCards={props.pendingShoppingCards}
        visiblePendingShoppingCards={props.visiblePendingShoppingCards}
        visiblePendingShoppingGroups={props.visiblePendingShoppingGroups}
        completedShoppingCards={props.completedShoppingCards}
        visibleCompletedShoppingCards={props.visibleCompletedShoppingCards}
        activeShoppingOverview={props.activeShoppingOverview}
        showCompletedShopping={props.showCompletedShopping}
        isUpdatingShopping={props.isUpdatingShopping}
        isCreatingInventory={props.isCreatingInventory}
        onShoppingSearchChange={props.setShoppingSearch}
        onShoppingFocusChange={props.setShoppingFocus}
        onOpenShoppingOverlay={() => props.openShoppingOverlay()}
        onOpenInventoryFromShopping={props.openInventoryFromShopping}
        onOpenDetailView={(summary) => props.openDetailView(summary.ingredient.id)}
        onToggleCompletedShopping={() => props.setShowCompletedShopping((current) => !current)}
        onRestoreShopping={(itemId) =>
          void props.onUpdateShoppingItem({
            itemId,
            done: false,
          })
        }
        IngredientWorkspaceIcon={({ name }) => props.renderIcon(name as IngredientWorkspaceIconName)}
        ShoppingWorkRow={props.ShoppingWorkRow}
        ShoppingHistoryRow={props.ShoppingHistoryRow}
      />
    );

  return (
    <IngredientWorkspaceFrame
      noticeToast={props.noticeToast}
      mobileQuickBar={{
        onCreate: props.openCreateView,
        onInventory: () => props.openInventoryOverlay(),
        onShopping: () => props.openShoppingOverlay(),
      }}
      overlays={props.overlays}
    >
      <IngredientHubView
        mobileView={
          <IngredientMobileView
            allAlertsCount={props.allAlertsCount}
            stockedIngredientCount={props.stockedIngredientCount}
            pendingShoppingCount={props.pendingShoppingCount}
            summariesCount={props.summariesCount}
            catalogSearch={props.catalogSearch}
            setCatalogSearch={props.setCatalogSearch}
            mobileIngredientFilter={props.mobileIngredientFilter}
            setMobileIngredientFilter={props.setMobileIngredientFilter}
            mobileStorageFocus={props.mobileStorageFocus}
            setMobileStorageFocus={props.setMobileStorageFocus}
            mobilePrioritySummaries={props.mobilePrioritySummaries}
            mobileStorageCards={props.mobileStorageCards}
            mobileCatalogSummaries={props.mobileCatalogSummaries}
            mobileCatalogResetKey={props.mobileCatalogResetKey}
            mobileShoppingCards={props.mobileShoppingCards}
            mobileShoppingGroups={props.mobileShoppingGroups}
            mobileHasCatalogFilters={props.mobileHasCatalogFilters}
            notificationCenter={props.notificationCenter}
            openDetailView={props.openDetailView}
            openInventoryOverlay={props.openInventoryOverlay}
            openConsumeOverlay={props.openConsumeOverlay}
            openShoppingOverlay={props.openShoppingOverlay}
            openDestroyExpiredOverlay={props.openDestroyExpiredOverlay}
            openCreateView={props.openCreateView}
            openInventoryFromShopping={props.openInventoryFromShopping}
            buildPriorityStatus={props.buildPriorityStatus}
            buildCatalogStatus={props.buildCatalogStatus}
            buildInventorySummaryLine={props.buildInventorySummaryLine}
            buildShoppingReason={props.buildShoppingReason}
            countDisposableExpiredItems={props.countDisposableExpiredItems}
            renderStorageIllustration={(storage) => <props.renderStorageIllustration storage={storage} />}
            renderIcon={(name) => props.renderIcon(name as IngredientWorkspaceIconName)}
            isUpdatingShopping={props.isUpdatingShopping}
            isCreatingInventory={props.isCreatingInventory}
            isCatalogSearchFetching={props.isCatalogSearchFetching}
            onCatalogSearchCompositionStart={props.onCatalogSearchCompositionStart}
            onCatalogSearchCompositionEnd={props.onCatalogSearchCompositionEnd}
          />
        }
        workspaceMetrics={props.workspaceMetrics}
        desktopActions={props.desktopActions}
        panelItems={props.panelItems}
        activePanel={props.activePanel}
        onPanelChange={props.openWorkspacePanel}
        activePanelContent={activePanelContent}
      />
    </IngredientWorkspaceFrame>
  );
}
