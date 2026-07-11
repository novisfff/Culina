import { useEffect, useRef, useState } from 'react';
import { readJsonStorage, writeJsonStorage } from '../../lib/storage';
import {
  restoreIngredientForm,
  type IngredientCreateFormState,
  type InventorySortMode,
  type InventoryStorageFocus,
} from './ingredientWorkspaceForms';
import type { IngredientWorkspacePanel, IngredientWorkspaceView, ShoppingCardFocus } from './workspaceModel';
import type { InventoryEntryFilter } from './inventoryOverviewModel';

export type CatalogStatusFilter = 'all' | 'actionNeeded' | 'expired' | 'expiring' | 'lowStock' | 'stable';
export type MobileIngredientFilter = 'all' | 'ingredient' | 'food' | 'seasoning' | 'alerted' | 'expiring';
export type InventoryQuickFilter = 'all' | 'ingredient' | 'food' | 'seasoning' | 'alerted' | 'expiring';
export type InventorySourceFilter = 'all' | 'ingredient' | 'food';

export const STORAGE_SHELF_IDEAL_WIDTH = 260;
export const STORAGE_SHELF_MAX_DISPLAY_COLUMNS = 4;
export const STORAGE_SHELF_MIN_WIDTH = 226;
export const STORAGE_SHELF_MAX_WIDTH = 318;
export const STORAGE_SHELF_GAP = 18;
const INGREDIENT_WORKSPACE_STATE_KEY = 'culina-ingredient-workspace-state-v1';

export type PersistedIngredientWorkspaceState = {
  workspaceView?: IngredientWorkspaceView;
  activePanel?: IngredientWorkspacePanel;
  editingIngredientId?: string | null;
  selectedIngredientId?: string | null;
  catalogSearch?: string;
  catalogCategoryFilter?: 'all' | string;
  inventorySearch?: string;
  inventorySourceFilter?: InventorySourceFilter;
  inventoryEntryFilter?: InventoryEntryFilter;
  ingredientForm?: IngredientCreateFormState;
};

type NavigationRequest =
  | { target: 'catalog'; requestId: number }
  | { target: 'detail'; ingredientId: string; requestId: number }
  | { target: 'shopping'; ingredientId: string; requestId: number }
  | { target: 'priority'; requestId: number }
  | null
  | undefined;

type UseIngredientWorkspaceStateArgs = {
  persistedWorkspaceState: PersistedIngredientWorkspaceState;
  ingredientIds: string[];
  navigationRequest?: NavigationRequest;
  editingIngredientId: string | null;
  ingredientForm: IngredientCreateFormState;
};

function isWorkspaceView(value: unknown): value is IngredientWorkspaceView {
  return value === 'hub' || value === 'catalog' || value === 'detail' || value === 'create';
}

function isWorkspacePanel(value: unknown): value is IngredientWorkspacePanel {
  return value === 'catalog' || value === 'inventory' || value === 'shopping';
}

function isInventorySourceFilter(value: unknown): value is InventorySourceFilter {
  return value === 'all' || value === 'ingredient' || value === 'food';
}

function isInventoryEntryFilter(value: unknown): value is InventoryEntryFilter {
  return value === 'all' || value === 'stocked' || value === 'pending';
}

export function readPersistedIngredientWorkspaceState(): PersistedIngredientWorkspaceState {
  const parsed = readJsonStorage<PersistedIngredientWorkspaceState>(INGREDIENT_WORKSPACE_STATE_KEY, {});
  const rawActivePanel = (parsed as { activePanel?: string }).activePanel;
  return {
    workspaceView: isWorkspaceView(parsed.workspaceView) ? parsed.workspaceView : undefined,
    activePanel: rawActivePanel === 'hub' ? 'catalog' : isWorkspacePanel(rawActivePanel) ? rawActivePanel : undefined,
    editingIngredientId:
      typeof parsed.editingIngredientId === 'string' || parsed.editingIngredientId === null
        ? parsed.editingIngredientId
        : undefined,
    selectedIngredientId:
      typeof parsed.selectedIngredientId === 'string' || parsed.selectedIngredientId === null
        ? parsed.selectedIngredientId
        : undefined,
    catalogSearch: typeof parsed.catalogSearch === 'string' ? parsed.catalogSearch : undefined,
    catalogCategoryFilter:
      typeof parsed.catalogCategoryFilter === 'string' ? parsed.catalogCategoryFilter : undefined,
    inventorySearch: typeof parsed.inventorySearch === 'string' ? parsed.inventorySearch : undefined,
    inventorySourceFilter: isInventorySourceFilter(parsed.inventorySourceFilter)
      ? parsed.inventorySourceFilter
      : undefined,
    inventoryEntryFilter: isInventoryEntryFilter(parsed.inventoryEntryFilter)
      ? parsed.inventoryEntryFilter
      : undefined,
    ingredientForm: parsed.ingredientForm ? restoreIngredientForm(parsed.ingredientForm) : undefined,
  };
}

export function useIngredientWorkspaceState(args: UseIngredientWorkspaceStateArgs) {
  const [workspaceView, setWorkspaceView] = useState<IngredientWorkspaceView>(
    args.persistedWorkspaceState.workspaceView ?? 'hub'
  );
  const [activePanel, setActivePanel] = useState<IngredientWorkspacePanel>(
    args.persistedWorkspaceState.activePanel ?? 'catalog'
  );
  const [selectedIngredientId, setSelectedIngredientId] = useState<string | null>(
    args.persistedWorkspaceState.selectedIngredientId ?? args.ingredientIds[0] ?? null
  );
  const [expandedCatalogIngredientId, setExpandedCatalogIngredientId] = useState<string | null>(null);
  const [catalogSearch, setCatalogSearch] = useState(args.persistedWorkspaceState.catalogSearch ?? '');
  const [catalogCategoryFilter, setCatalogCategoryFilter] = useState<'all' | string>(
    args.persistedWorkspaceState.catalogCategoryFilter ?? 'all'
  );
  const [catalogStatusFilter, setCatalogStatusFilter] = useState<CatalogStatusFilter>('all');
  const [inventorySearch, setInventorySearch] = useState(args.persistedWorkspaceState.inventorySearch ?? '');
  const [inventorySourceFilter, setInventorySourceFilter] = useState<InventorySourceFilter>('all');
  const [inventoryEntryFilter, setInventoryEntryFilter] = useState<InventoryEntryFilter>(
    isInventoryEntryFilter(args.persistedWorkspaceState.inventoryEntryFilter)
      ? args.persistedWorkspaceState.inventoryEntryFilter
      : 'all'
  );
  const [inventoryQuickFilter, setInventoryQuickFilter] = useState<InventoryQuickFilter>('all');
  const [inventoryStorageFocus, setInventoryStorageFocus] = useState<InventoryStorageFocus>('冷藏');
  const [inventorySortMode, setInventorySortMode] = useState<InventorySortMode>('default');
  const [shoppingSearch, setShoppingSearch] = useState('');
  const [shoppingFocus, setShoppingFocus] = useState<ShoppingCardFocus>('all');
  const [mobileIngredientFilter, setMobileIngredientFilter] = useState<MobileIngredientFilter>('all');
  const [mobileInventoryEntryFilter, setMobileInventoryEntryFilter] = useState<InventoryEntryFilter>('all');
  const [mobileStorageFocus, setMobileStorageFocus] = useState<InventoryStorageFocus>('all');
  const [showCompletedShopping, setShowCompletedShopping] = useState(false);
  const [catalogColumns, setCatalogColumns] = useState(1);
  const [catalogCardWidth, setCatalogCardWidth] = useState(STORAGE_SHELF_IDEAL_WIDTH);
  const catalogMeasureRef = useRef<HTMLDivElement | null>(null);

  const handledNavigationRequestIdRef = useRef<number | null>(null);

  useEffect(() => {
    const request = args.navigationRequest;
    if (!request || handledNavigationRequestIdRef.current === request.requestId) {
      return;
    }
    handledNavigationRequestIdRef.current = request.requestId;

    setCatalogSearch('');
    setCatalogCategoryFilter('all');

    if (request.target === 'priority') {
      // Desktop: activate shared 需处理 hub/catalog filter and land on the complete priority surface.
      // Mobile scrolls/focuses 今天先处理 from IngredientWorkspace once this request is consumed.
      setActivePanel('catalog');
      setCatalogStatusFilter('actionNeeded');
      setExpandedCatalogIngredientId(null);
      setWorkspaceView('hub');
      return;
    }

    if (request.target === 'shopping') {
      // Keep hub ready; IngredientWorkspace opens the shopping overlay with the real ingredient ID.
      setActivePanel('catalog');
      setCatalogStatusFilter('all');
      setSelectedIngredientId(request.ingredientId);
      setExpandedCatalogIngredientId(null);
      setWorkspaceView('hub');
      return;
    }

    setActivePanel('catalog');
    setCatalogStatusFilter('all');

    if (request.target === 'detail') {
      setSelectedIngredientId(request.ingredientId);
      setExpandedCatalogIngredientId(null);
      setWorkspaceView('detail');
      return;
    }

    // catalog
    setExpandedCatalogIngredientId(null);
    setWorkspaceView('hub');
  }, [args.navigationRequest?.requestId]);

  useEffect(() => {
    const snapshot: PersistedIngredientWorkspaceState = {
      workspaceView,
      activePanel,
      editingIngredientId: args.editingIngredientId,
      selectedIngredientId,
      catalogSearch,
      catalogCategoryFilter,
      inventorySearch,
      inventorySourceFilter,
      inventoryEntryFilter,
      ingredientForm: args.ingredientForm,
    };
    writeJsonStorage(INGREDIENT_WORKSPACE_STATE_KEY, snapshot);
  }, [
    workspaceView,
    activePanel,
    args.editingIngredientId,
    selectedIngredientId,
    catalogSearch,
    catalogCategoryFilter,
    inventorySearch,
    inventorySourceFilter,
    inventoryEntryFilter,
    args.ingredientForm,
  ]);

  function openWorkspacePanel(panel: IngredientWorkspacePanel) {
    if (panel === 'inventory') {
      setInventoryQuickFilter('all');
      setInventoryEntryFilter('all');
      setInventorySourceFilter('all');
      setInventoryStorageFocus('冷藏');
    }
    if (panel === 'catalog') {
      setCatalogStatusFilter('all');
    }
    setActivePanel(panel);
    setWorkspaceView('hub');
  }

  function openInventoryPanel(filter: InventoryQuickFilter = 'all') {
    setInventorySearch('');
    setInventoryQuickFilter(filter);
    setInventoryEntryFilter('all');
    setInventorySourceFilter('all');
    setInventoryStorageFocus('冷藏');
    setActivePanel('inventory');
    setWorkspaceView('hub');
  }

  function openShoppingPanel() {
    setActivePanel('shopping');
    setWorkspaceView('hub');
  }

  function toggleCatalogCard(ingredientId: string) {
    setSelectedIngredientId(ingredientId);
    setExpandedCatalogIngredientId((current) => (current === ingredientId ? null : ingredientId));
  }

  function openDetailView(ingredientId: string) {
    setSelectedIngredientId(ingredientId);
    if (activePanel === 'catalog') {
      setExpandedCatalogIngredientId(ingredientId);
    }
    setWorkspaceView('detail');
  }

  function goBackToWorkspace() {
    setWorkspaceView('hub');
  }

  function goBackToCatalog() {
    setActivePanel('catalog');
    setWorkspaceView('hub');
  }

  return {
    workspaceView,
    setWorkspaceView,
    activePanel,
    setActivePanel,
    selectedIngredientId,
    setSelectedIngredientId,
    expandedCatalogIngredientId,
    setExpandedCatalogIngredientId,
    catalogSearch,
    setCatalogSearch,
    catalogCategoryFilter,
    setCatalogCategoryFilter,
    catalogStatusFilter,
    setCatalogStatusFilter,
    inventorySearch,
    setInventorySearch,
    inventorySourceFilter,
    setInventorySourceFilter,
    inventoryEntryFilter,
    setInventoryEntryFilter,
    inventoryQuickFilter,
    setInventoryQuickFilter,
    inventoryStorageFocus,
    setInventoryStorageFocus,
    inventorySortMode,
    setInventorySortMode,
    shoppingSearch,
    setShoppingSearch,
    shoppingFocus,
    setShoppingFocus,
    mobileIngredientFilter,
    setMobileIngredientFilter,
    mobileInventoryEntryFilter,
    setMobileInventoryEntryFilter,
    mobileStorageFocus,
    setMobileStorageFocus,
    showCompletedShopping,
    setShowCompletedShopping,
    catalogColumns,
    setCatalogColumns,
    catalogCardWidth,
    setCatalogCardWidth,
    catalogMeasureRef,
    openWorkspacePanel,
    openInventoryPanel,
    openShoppingPanel,
    toggleCatalogCard,
    openDetailView,
    goBackToWorkspace,
    goBackToCatalog,
  };
}
