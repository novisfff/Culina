import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { invalidateAfterFoodChanged } from '../../api/cacheInvalidation';
import type {
  ConsumeInventoryResponse,
  CorrectInventoryExpiryDateRequest,
  DisposeExpiredInventoryRequest,
  DisposeExpiredInventoryResponse,
  SnoozeExpiryAlertsRequest,
  Food,
  Ingredient,
  IngredientExpiryMode,
  IngredientInventoryState,
  IngredientUnitConversion,
  InventoryItem,
  InventoryOverviewItem,
  InventoryStatus,
  MealType,
  RecordMealResponse,
  Recipe,
  ShoppingListItem,
  UpsertIngredientInventoryStateRequest,
} from '../../api/types';
import { getFoodCoverAsset, todayKey } from '../../lib/ui';
import { businessDateKey } from '../../lib/date';
import type { AiRenderPayload } from '../../lib/aiImages';
import { useDebouncedSearchValue, useSearchCompositionState } from '../../hooks/useDebouncedValue';
import { usePagedList } from '../../hooks/usePagedList';
import { useNotice } from '../../hooks/useNotice';
import {
  ActionButton,
  WorkspaceDrawer,
  WorkspaceModal,
  WorkspaceOverlayFrame,
} from '../ui-kit';
import { tracksIngredientQuantity } from '../../lib/ingredientTracking';
import type { ExpiryInventoryActionGroup } from '../../features/inventory/inventoryActionModel';
import {
  canSubmitWithCandidateResolution,
  createMealBusinessDate,
  createMealRecordDateOptions,
} from '../../features/meals/MealComposerModel';
import { MealQuickRecordView } from '../../features/meals/MealQuickRecordView';
import { MealRecordResultBar } from '../../features/meals/MealRecordResultBar';
import { IngredientInventoryCard } from './IngredientInventoryCard';
import { ShoppingHistoryRow as IngredientShoppingHistoryRow } from './ShoppingHistoryRow';
import { ShoppingWorkRow } from './ShoppingWorkRow';
import { IngredientWorkspaceIcon, type IngredientWorkspaceIconName } from './IngredientWorkspaceIcon';
import {
  createClientRequestId,
  getDefaultFoodStockMealType,
  isPendingShopping,
  resolveErrorMessage,
} from './ingredientWorkspaceHelpers';
import { IngredientQuickDetailPopover } from './IngredientQuickDetailPopover';
import { IngredientCatalogCard as ExtractedIngredientCatalogCard } from './IngredientCatalogCard';
import type { MealRecordResult } from '../../features/meals/useMealRecordResultState';
import {
  buildIngredientSummaries,
  buildInventoryCardPresentation,
  buildInventoryCardStatus,
  buildInventorySummaryLine,
  buildInventoryTotalLabel,
  buildCatalogCardStatus,
  buildCatalogExpandedNote,
  getIngredientAlertTone,
  resolveShoppingReason,
  countDisposableExpiredInventoryItems,
  filterIngredientSummariesByCatalogStatus,
  type IngredientSummaryViewModel,
  type IngredientWorkspacePanel,
  type ShoppingCardViewModel,
} from './workspaceModel';
import {
  defaultIngredientForm,
  type IngredientCreateFormState,
} from './ingredientWorkspaceForms';
import { IngredientDetailView } from './IngredientDetailView';
import { IngredientDetailPage } from './IngredientDetailPage';
import { IngredientEditorView } from './IngredientEditorView';
import { IngredientHubPage } from './IngredientHubPage';
import {
  IngredientStorageIcon,
  IngredientStorageIllustration,
  IngredientStorageOverviewCard,
} from './IngredientStorageOverviewCard';
import { IngredientInventoryPanelContextProvider } from './IngredientWorkspacePanels';
import {
  buildUnifiedInventoryGroups,
  buildUnifiedInventorySummary,
  filterUnifiedInventoryItems,
  parseUnifiedFoodStockQuantity,
  resolveUnifiedFoodStockDeductQuantity,
  type InventoryEntryFilter,
} from './inventoryOverviewModel';
import { useIngredientWorkspaceEffects } from './useIngredientWorkspaceEffects';
import { useIngredientWorkspaceData } from './useIngredientWorkspaceData';
import { useIngredientEditorState } from './useIngredientEditorState';
import { useIngredientActionState } from './useIngredientActionState';
import {
  useIngredientOverlayState,
} from './useIngredientOverlayState';
import {
  readPersistedIngredientWorkspaceState,
  STORAGE_SHELF_IDEAL_WIDTH,
  STORAGE_SHELF_MAX_DISPLAY_COLUMNS,
  type CatalogStatusFilter,
  type InventoryQuickFilter,
  type InventorySourceFilter,
  type PersistedIngredientWorkspaceState,
  useIngredientWorkspaceState,
} from './useIngredientWorkspaceState';
import { buildIngredientImagePayload, formatExpiryRuleLabel, formatLowStockRuleLabel } from './ingredientWorkspaceModels';
import { ScrollableChipRail } from './ScrollableChipRail';
import {
  useIngredientFoodStockState,
} from './useIngredientFoodStockState';
import { IngredientFoodStockDialogs } from './IngredientFoodStockDialogs';
import { useIngredientFoodStockActions } from './useIngredientFoodStockActions';
import { useIngredientWorkspaceSearch } from './useIngredientWorkspaceSearch';
import {
  useIngredientInventoryRefresh,
  useIngredientInventoryOperationInvalidation,
} from './useIngredientInventoryRefresh';
import { useIngredientFoodLookup } from './useIngredientFoodLookup';
import { useIngredientFoodStockMealRecord } from './useIngredientFoodStockMealRecord';

type IngredientWorkspaceProps = {
  ingredients: Ingredient[];
  foods: Food[];
  inventoryItems: InventoryItem[];
  inventoryStates?: IngredientInventoryState[];
  recipes: Recipe[];
  shoppingItems: ShoppingListItem[];
  /** Ordinary Food recording owner (Task 15). */
  recordMeal?: (payload: import('../../api/types').RecordMealPayload) => Promise<import('../../api/types').RecordMealResponse>;
  loadMealCandidates?: (
    date: string,
    mealType: MealType,
  ) => Promise<import('../../api/types').MealLogCandidate[]>;
  onRecordSuccess?: (response: import('../../api/types').RecordMealResponse) => void;
  recordResult?: import('../../features/meals/useMealRecordResultState').MealRecordResult | null;
  isRevertingRecord?: boolean;
  recordRevertError?: string | null;
  recordRateError?: string | null;
  onRevertRecord?: () => void | Promise<void>;
  onViewRecord?: () => void;
  onRateRecord?: (rating: number | null | undefined) => void | Promise<void>;
  onDismissRecord?: () => void;
  isRecordingMeal?: boolean;
  /** Shared shopping intake entry. Shopping-origin restock must open this, not local create+done. */
  openShoppingIntake?: (args?: { selectedItemId?: string }) => void;
  openReconciliation?: (args?: { scope?: 'suggested' | 'refrigerated' | 'frozen' | 'room_temperature' | 'all' }) => void;
  openOperationHistory?: (operationId?: string) => void;
  operationBanner?: ReactNode;
  notificationCenter?: ReactNode;
  navigationRequest?:
    | { target: 'catalog'; requestId: number }
    | { target: 'create'; requestId: number }
    | { target: 'detail'; ingredientId: string; requestId: number }
    | { target: 'shopping'; ingredientId: string; requestId: number }
    | { target: 'priority'; requestId: number }
    | null;
  onNavigationRequestConsumed?: (requestId: number) => void;
  createIngredient: (payload: {
    name: string;
    category: string;
    default_unit: string;
    quantity_tracking_mode?: Ingredient['quantity_tracking_mode'];
    unit_conversions: IngredientUnitConversion[];
    default_storage: string;
    default_expiry_mode: IngredientExpiryMode;
    default_expiry_days?: number | null;
    default_low_stock_threshold?: number | null;
    notes: string;
    media_ids: string[];
  }) => Promise<Ingredient>;
  updateIngredient: (
    ingredientId: string,
    payload: {
      expected_row_version: number;
      name: string;
      category: string;
      default_unit: string;
      quantity_tracking_mode?: Ingredient['quantity_tracking_mode'];
      unit_conversions: IngredientUnitConversion[];
      default_storage: string;
      default_expiry_mode: IngredientExpiryMode;
      default_expiry_days?: number | null;
      default_low_stock_threshold?: number | null;
      notes: string;
      media_ids: string[];
    }
  ) => Promise<Ingredient>;
  transitionIngredientTrackingMode?: (
    ingredientId: string,
    payload: import('../../api/types').IngredientTrackingModeTransitionRequest
  ) => Promise<Ingredient>;
  createInventory: (payload: {
    ingredient_id: string;
    quantity?: number | null;
    unit?: string | null;
    status: InventoryStatus;
    purchase_date: string;
    expiry_date?: string;
    storage_location: string;
    notes: string;
    low_stock_threshold?: number;
  }) => Promise<InventoryItem>;
  upsertInventoryState: (
    ingredientId: string,
    payload: UpsertIngredientInventoryStateRequest,
  ) => Promise<IngredientInventoryState>;
  consumeInventory: (payload: {
    ingredient_id: string;
    quantity?: number | null;
    unit?: string | null;
  }) => Promise<ConsumeInventoryResponse>;
  disposeExpiredInventory: (payload: DisposeExpiredInventoryRequest) => Promise<DisposeExpiredInventoryResponse | unknown>;
  snoozeInventoryExpiryAlerts: (payload: SnoozeExpiryAlertsRequest) => Promise<unknown>;
  correctInventoryExpiryDate: (
    inventoryItemId: string,
    payload: CorrectInventoryExpiryDateRequest,
  ) => Promise<unknown>;
  createShoppingItem: (payload: {
    title: string;
    quantity?: number | null;
    unit?: string | null;
    ingredient_id?: string | null;
    food_id?: string | null;
    quantity_mode?: ShoppingListItem['quantity_mode'];
    display_label?: string | null;
    reason: string;
  }) => Promise<ShoppingListItem>;
  updateShoppingItem: (payload: {
    itemId: string;
    payload: {
      expected_row_version: number;
      title?: string;
      quantity?: number | null;
      unit?: string | null;
      ingredient_id?: string | null;
      food_id?: string | null;
      quantity_mode?: ShoppingListItem['quantity_mode'];
      display_label?: string | null;
      reason?: string;
      done?: boolean;
    };
  }) => Promise<ShoppingListItem>;
  deleteShoppingItem: (itemId: string, expectedRowVersion: number) => Promise<void>;
  isCreatingIngredient?: boolean;
  isUpdatingIngredient?: boolean;
  isCreatingInventory?: boolean;
  isConsumingInventory?: boolean;
  isDisposingExpiredInventory?: boolean;
  isCreatingShopping?: boolean;
  isUpdatingShopping?: boolean;
};

const PANEL_ITEMS: Array<{ value: IngredientWorkspacePanel; label: string; icon: IngredientWorkspaceIconName }> = [
  { value: 'catalog', label: '食材库', icon: 'archive' },
  { value: 'inventory', label: '库存', icon: 'inventory' },
  { value: 'shopping', label: '采购', icon: 'shopping' },
];
const CATALOG_STATUS_FILTERS: Array<{ value: CatalogStatusFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'actionNeeded', label: '需要处理' },
  { value: 'expired', label: '已过期' },
  { value: 'expiring', label: '临期' },
  { value: 'lowStock', label: '库存不足' },
  { value: 'stable', label: '正常' },
];

export function IngredientWorkspace(props: IngredientWorkspaceProps) {
  const lookupFood = useIngredientFoodLookup();
  const invalidateInventoryOperation = useIngredientInventoryOperationInvalidation();
  const todayDate = todayKey();
  const mealBusinessDate = createMealBusinessDate();
  const foodStockRecordDateOptions = useMemo(
    () => createMealRecordDateOptions(mealBusinessDate),
    [mealBusinessDate]
  );
  const [persistedWorkspaceState] = useState<PersistedIngredientWorkspaceState>(readPersistedIngredientWorkspaceState);
  const [transientIngredient, setTransientIngredient] = useState<Ingredient | null>(null);
  const [transientShoppingFood, setTransientShoppingFood] = useState<Food | null>(null);
  // Compact ordinary Food record (Task 15) — independent of inventory.
  const {
    quickRecord,
    setQuickRecord,
    inventoryFollowUp,
    setInventoryFollowUp,
    foodStockDeductDialog,
    setFoodStockDeductDialog,
    foodStockAdjustDialog,
    setFoodStockAdjustDialog,
    foodStockSubmitting,
    setFoodStockSubmitting,
    setFoodStockRestockQuantity,
    setFoodStockRestockExpiryDays,
    setFoodStockRestockSource,
  } = useIngredientFoodStockState(todayDate);
  const [editingIngredientId, setEditingIngredientId] = useState<string | null>(
    persistedWorkspaceState.editingIngredientId ?? null
  );
  const [ingredientForm, setIngredientForm] = useState<IngredientCreateFormState>(
    () => persistedWorkspaceState.ingredientForm ?? defaultIngredientForm()
  );
  const ingredientOptions = (() => {
    if (!transientIngredient) {
      return props.ingredients;
    }
    const others = props.ingredients.filter((item) => item.id !== transientIngredient.id);
    // Prefer the local transitioned/saved snapshot so dual-write recovery can update mode/version
    // before query invalidation lands.
    return [transientIngredient, ...others];
  })();
  const readyFoodOptions = useMemo(
    () => {
      const sourceFoods =
        transientShoppingFood && !props.foods.some((food) => food.id === transientShoppingFood.id)
          ? [transientShoppingFood, ...props.foods]
          : props.foods;
      return sourceFoods.filter((food) => ['readyMade', 'instant', 'packaged'].includes(food.type));
    },
    [props.foods, transientShoppingFood]
  );
  const { notice, showNotice, clearNotice } = useNotice();
  const {
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
  } = useIngredientWorkspaceState({
    persistedWorkspaceState,
    ingredientIds: props.ingredients.map((item) => item.id),
    navigationRequest: props.navigationRequest,
    onNavigationRequestConsumed: props.onNavigationRequestConsumed,
    editingIngredientId,
    ingredientForm,
  });
  const {
    catalogSearchComposition,
    inventorySearchComposition,
    inventoryOverviewQuery,
    appliedCatalogSearch,
    appliedInventorySearch,
    catalogSearchMatchedIngredientIds,
    inventorySearchMatchedIngredientIds,
    searchAwareIngredients,
    searchAwareInventoryItems,
    unifiedInventoryItems,
    entryFilterBaseUnifiedInventoryItems,
    filteredUnifiedInventoryItems,
    unifiedInventoryGroups,
    unifiedInventorySummary,
    unifiedInventoryEntrySummary,
    mobileFoodStockItems,
    isCatalogSearchFetching,
    isInventorySearchFetching,
  } = useIngredientWorkspaceSearch({
    ingredients: props.ingredients,
    inventoryItems: props.inventoryItems,
    catalogSearch,
    inventorySearch,
    inventorySourceFilter,
    inventoryEntryFilter,
    inventoryQuickFilter,
    inventoryStorageFocus,
  });
  const {
    summaries,
    catalogCategories,
    filteredSummaries,
    catalogCountLabel,
    catalogStatusCounts,
    inventoryStorageOverview,
    focusedInventorySummaries,
    inventoryGroups,
    selectedIngredient,
    allAlerts,
    inventoryActionGroups,
    priorityActionCount,
    pendingShopping,
    completedShoppingCards,
    pendingShoppingCards,
    visiblePendingShoppingCards,
    visiblePendingShoppingGroups,
    visibleCompletedShoppingCards,
    shoppingOverview,
    activeShoppingOverview,
    stockedIngredientCount,
    workspaceMetrics,
    mobilePriorityRows,
    mobilePrioritySummaries,
    mobileStorageCards,
    mobileCatalogSummaries,
    mobileShoppingCards,
    mobileShoppingGroups,
    mobileHasCatalogFilters,
    quickRestockIngredients,
  } = useIngredientWorkspaceData({
    ingredients: searchAwareIngredients,
    inventoryItems: searchAwareInventoryItems,
    inventoryStates: props.inventoryStates ?? [],
    recipes: props.recipes,
    foods: readyFoodOptions,
    shoppingItems: props.shoppingItems,
    ingredientOptions,
    selectedIngredientId,
    catalogSearch: appliedCatalogSearch,
    catalogSearchMatchedIngredientIds,
    catalogCategoryFilter,
    catalogStatusFilter,
    inventoryQuickFilter,
    inventorySearch: appliedInventorySearch,
    inventorySearchMatchedIngredientIds,
    inventoryStorageFocus,
    inventorySortMode,
    shoppingSearch,
    shoppingFocus,
    mobileIngredientFilter,
    mobileInventoryEntryFilter,
    mobileStorageFocus,
    filterIngredientSummariesByCatalogStatus,
    isPendingShopping,
  });
  const mobileCatalogResetKey = [
    appliedCatalogSearch,
    mobileIngredientFilter,
    mobileInventoryEntryFilter,
    mobileStorageFocus,
  ].join('|');
  const mobileHasCatalogFiltersForUi =
    Boolean(catalogSearch.trim()) || mobileHasCatalogFilters;
  const catalogCardPager = usePagedList({
    itemCount: filteredSummaries.length,
    resetKey: [
      activePanel,
      appliedCatalogSearch,
      catalogCategoryFilter,
      catalogStatusFilter,
    ].join('|'),
  });
  const visibleFilteredSummaries = filteredSummaries.slice(0, catalogCardPager.visibleCount);
  const maxCatalogItems = Math.max(STORAGE_SHELF_MAX_DISPLAY_COLUMNS, filteredSummaries.length);

  const editorState = useIngredientEditorState({
    editingIngredientId,
    setEditingIngredientId,
    ingredientForm,
    setIngredientForm,
    ingredientOptions,
    inventoryItems: props.inventoryItems,
    inventoryStates: props.inventoryStates,
    setTransientIngredient,
    setSelectedIngredientId,
    setWorkspaceView,
    setInventoryForm: (value) => setInventoryForm(value),
    setInventoryAdvancedOpen: (value) => setInventoryAdvancedOpen(value),
    setOverlayMode: (value) => setOverlayMode(value),
    isCreatingIngredient: props.isCreatingIngredient,
    isUpdatingIngredient: props.isUpdatingIngredient,
    createIngredient: props.createIngredient,
    updateIngredient: props.updateIngredient,
    transitionIngredientTrackingMode: props.transitionIngredientTrackingMode,
    onTrackingTransitionSettled: async () => {
      // Invalidate only after the dual-write path finishes (success or recovered transition),
      // so inventory/state refresh does not land under an open transition dialog.
      await invalidateInventoryOperation();
    },
    showNotice,
    resolveErrorMessage,
  });

  const inventoryActionReferenceDate = businessDateKey();

  const {
    overlayMode,
    setOverlayMode,
    inventoryForm,
    setInventoryForm,
    consumeForm,
    setConsumeForm,
    shoppingForm,
    setShoppingForm,
    editingShoppingItemId,
    editingShoppingItemRowVersion,
    inventoryActionIngredientId,
    inventoryActionGroup,
    inventoryActionBusy,
    setInventoryActionBusy,
    inventoryActionError,
    setInventoryActionError,
    inventoryActionConflict,
    setInventoryActionConflict,
    inventoryAdvancedOpen,
    setInventoryAdvancedOpen,
    openInventoryOverlay,
    openConsumeOverlay,
    openInventoryFromShopping,
    openShoppingOverlay,
    openDestroyExpiredOverlay,
    closeOverlay,
  } = useIngredientOverlayState({
    ingredientOptions,
    foodOptions: readyFoodOptions,
    summaries,
    inventoryActionGroups,
    referenceDate: inventoryActionReferenceDate,
    onRequireCreate: () => {
      setActivePanel('catalog');
      editorState.openCreateView();
    },
    onOpenShoppingIntake: (item) => {
      if (props.openShoppingIntake) {
        props.openShoppingIntake({ selectedItemId: item.id });
        return;
      }
    },
  });

  // Consume shopping/priority navigation once by requestId; do not keep shopping form state in home.
  const handledSideEffectNavigationRequestIdRef = useRef<number | null>(null);
  useEffect(() => {
    const request = props.navigationRequest;
    if (!request || handledSideEffectNavigationRequestIdRef.current === request.requestId) {
      return;
    }

    if (request.target === 'shopping') {
      const ingredient = props.ingredients.find((item) => item.id === request.ingredientId);
      if (!ingredient) {
        // Wait until the real ingredient is available; shopping always requires ingredientId.
        return;
      }
      handledSideEffectNavigationRequestIdRef.current = request.requestId;
      openShoppingOverlay({ ingredient, reason: '库存不足' });
      props.onNavigationRequestConsumed?.(request.requestId);
      return;
    }

    if (request.target === 'create') {
      handledSideEffectNavigationRequestIdRef.current = request.requestId;
      editorState.openCreateView();
      props.onNavigationRequestConsumed?.(request.requestId);
      return;
    }

    if (request.target === 'priority') {
      handledSideEffectNavigationRequestIdRef.current = request.requestId;
      // Desktop: focus the complete priority list under the shared 需处理 catalog filter.
      // Mobile: scroll/focus the existing 今天先处理 section.
      const focusPrioritySurface = () => {
        const mobileSection = document.getElementById('mobile-ingredient-priority');
        if (mobileSection) {
          mobileSection.scrollIntoView({ block: 'start', behavior: 'smooth' });
          if (typeof mobileSection.focus === 'function') {
            mobileSection.focus({ preventScroll: true });
          }
          return;
        }
        const desktopList =
          document.getElementById('ingredient-priority-list') ??
          document.querySelector('.ingredients-catalog-grid, .ingredient-grid-catalog');
        if (desktopList instanceof HTMLElement) {
          desktopList.scrollIntoView({ block: 'start', behavior: 'smooth' });
          if (typeof desktopList.focus === 'function') {
            desktopList.focus({ preventScroll: true });
          }
        }
      };
      window.requestAnimationFrame(() => {
        window.setTimeout(focusPrioritySurface, 0);
      });
      props.onNavigationRequestConsumed?.(request.requestId);
    }
  }, [props.navigationRequest?.requestId, props.ingredients, props.onNavigationRequestConsumed]);
  const selectedInventoryIngredient =
    ingredientOptions.find((item) => item.id === inventoryForm.ingredientId) ?? null;

  useIngredientWorkspaceEffects({
    ingredients: props.ingredients,
    transientIngredient,
    setTransientIngredient,
    selectedIngredientId,
    setSelectedIngredientId,
    summaries,
    expandedCatalogIngredientId,
    setExpandedCatalogIngredientId,
    filteredSummaries,
    editingIngredientId,
    setEditingIngredientId,
    ingredientOptions,
    workspaceView,
    setIngredientForm,
    showCompletedShopping,
    setShowCompletedShopping,
    completedShoppingCount: completedShoppingCards.length,
    catalogCategoryFilter,
    catalogCategories,
    setCatalogCategoryFilter,
    activePanel,
    catalogMeasureRef,
    maxCatalogItems,
    setCatalogColumns,
    setCatalogCardWidth,
    storageShelfIdealWidth: STORAGE_SHELF_IDEAL_WIDTH,
    storageShelfMaxDisplayColumns: STORAGE_SHELF_MAX_DISPLAY_COLUMNS,
  });

  const refreshInventoryActionGroup = useIngredientInventoryRefresh({
    recipes: props.recipes,
    referenceDate: inventoryActionReferenceDate,
  });

  const {
    submitInventory,
    submitShopping,
    submitConsume,
    disposeSelectedInventoryBatches,
    snoozeSelectedInventoryAlerts,
    correctSelectedInventoryExpiryDate,
  } = useIngredientActionState({
    ingredientOptions,
    foodOptions: readyFoodOptions,
    summaries,
    inventoryForm,
    setInventoryForm,
    setInventoryAdvancedOpen,
    consumeForm,
    shoppingForm,
    setShoppingForm,
    editingShoppingItemId,
    editingShoppingItemRowVersion,
    inventoryActionIngredientId,
    inventoryActionGroup,
    selectedInventoryIngredient,
    setSelectedIngredientId,
    closeOverlay,
    setInventoryActionBusy,
    setInventoryActionError,
    setInventoryActionConflict,
    createInventory: props.createInventory,
    upsertInventoryState: props.upsertInventoryState,
    consumeInventory: props.consumeInventory,
    disposeExpiredInventory: props.disposeExpiredInventory,
    snoozeInventoryExpiryAlerts: props.snoozeInventoryExpiryAlerts,
    correctInventoryExpiryDate: props.correctInventoryExpiryDate,
    refreshInventoryActionGroup,
    createShoppingItem: props.createShoppingItem,
    updateShoppingItem: props.updateShoppingItem,
    showNotice,
    resolveErrorMessage,
  });

  const desktopActions = (
    <div className="ingredients-actions">
      {activePanel === 'catalog' && (
        <ActionButton tone="primary" type="button" onClick={editorState.openCreateView}>
          新增食材
        </ActionButton>
      )}
      {activePanel === 'inventory' && (
        <>
          <ActionButton
            tone="primary"
            type="button"
            onClick={() => props.openReconciliation?.({ scope: 'suggested' })}
          >
            快速盘点
          </ActionButton>
          <ActionButton tone="secondary" type="button" onClick={() => openInventoryOverlay()}>
            快速加入库存
          </ActionButton>
          {props.openOperationHistory ? (
            <ActionButton tone="tertiary" type="button" onClick={() => props.openOperationHistory?.()}>
              变更记录
            </ActionButton>
          ) : null}
        </>
      )}
      {activePanel === 'shopping' && (
        <>
          <ActionButton
            tone="primary"
            type="button"
            onClick={() => props.openShoppingIntake?.()}
          >
            记录本次购买
          </ActionButton>
          <ActionButton tone="secondary" type="button" onClick={() => openShoppingOverlay()}>
            新增采购内容
          </ActionButton>
          {props.openOperationHistory ? (
            <ActionButton tone="tertiary" type="button" onClick={() => props.openOperationHistory?.()}>
              变更记录
            </ActionButton>
          ) : null}
        </>
      )}
    </div>
  );
  const activePanelBackLabel =
    activePanel === 'inventory' ? '返回库存' : activePanel === 'shopping' ? '返回采购' : '返回食材库';
  const catalogGridStyle = {
    '--ingredients-catalog-columns': String(catalogColumns),
    '--ingredients-catalog-card-width': `${catalogCardWidth}px`,
  } as CSSProperties;
  const noticeToast = notice ? (
    <div className={`recipe-notice-toast tone-${notice.tone}`} role={notice.tone === 'danger' ? 'alert' : 'status'} aria-live="polite">
      <span className="recipe-notice-icon">
        <IngredientWorkspaceIcon name={notice.tone === 'success' ? 'check' : 'exclamation'} />
      </span>
      <span className="recipe-notice-copy">
        <strong>{notice.title}</strong>
        <small>{notice.message}</small>
      </span>
      <button type="button" onClick={clearNotice} aria-label="关闭提示">
        ×
      </button>
    </div>
  ) : null;
  const openCreateView = editorState.openCreateView;
  const openEditView = editorState.openEditView;
  const goBackFromIngredientForm = editorState.goBackFromIngredientForm;
  const applyIngredientCategoryPreset = editorState.applyIngredientCategoryPreset;
  const submitIngredient = editorState.submitIngredient;
  const handleCreateSubmit = editorState.handleCreateSubmit;
  const isEditingIngredient = editorState.isEditingIngredient;
  const isIngredientFormSubmitting = Boolean(props.isCreatingIngredient || props.isUpdatingIngredient);
  const closeIngredientFormIfAllowed = () => {
    if (!isIngredientFormSubmitting) {
      goBackFromIngredientForm();
    }
  };
  const ingredientVisibleCategoryPresets = editorState.ingredientVisibleCategoryPresets;
  const ingredientCategoryIsVisiblePreset = editorState.ingredientCategoryIsVisiblePreset;
  const showIngredientCategoryCustomInput = editorState.showIngredientCategoryCustomInput;
  const ingredientUnitAdvancedOpen = editorState.ingredientUnitAdvancedOpen;
  const setIngredientUnitAdvancedOpen = editorState.setIngredientUnitAdvancedOpen;
  const setIngredientCustomCategoryOpen = editorState.setIngredientCustomCategoryOpen;
  const ingredientUsesCustomUnit = editorState.ingredientUsesCustomUnit;
  const ingredientUnitOptions = editorState.ingredientUnitOptions;
  const ingredientUsesCustomStorage = editorState.ingredientUsesCustomStorage;
  const ingredientDefaultExpiryRangeValue = editorState.ingredientDefaultExpiryRangeValue;
  const ingredientLowStockEnabled = editorState.ingredientLowStockEnabled;
  const ingredientLowStockValue = editorState.ingredientLowStockValue;
  const ingredientLowStockStep = editorState.ingredientLowStockStep;
  const ingredientLowStockQuickValues = editorState.ingredientLowStockQuickValues;
  const ingredientImageComposer = editorState.ingredientImageComposer;
  const ingredientPreviewImage = editorState.ingredientPreviewImage;
  const createSummaryItems = editorState.createSummaryItems;
  const createChecklistItems = editorState.createChecklistItems;
  const createCanSubmit = editorState.createCanSubmit;
  const trimmedIngredientUnit = editorState.trimmedIngredientUnit;
  const overlayLayerProps = {
    overlayMode,
    closeOverlay,
    inventoryForm,
    setInventoryForm,
    inventoryAdvancedOpen,
    setInventoryAdvancedOpen,
    consumeForm,
    setConsumeForm,
    shoppingForm,
    setShoppingForm,
    inventoryActionIngredientId,
    inventoryActionGroup,
    inventoryActionReferenceDate,
    inventoryActionBusy: inventoryActionBusy || Boolean(props.isDisposingExpiredInventory),
    inventoryActionError,
    inventoryActionConflict,
    ingredients: ingredientOptions,
    foods: readyFoodOptions,
    ingredientSummaries: summaries,
    quickRestockIngredients,
    submitInventory,
    submitConsume,
    submitShopping,
    disposeSelectedInventoryBatches,
    snoozeSelectedInventoryAlerts,
    correctSelectedInventoryExpiryDate,
    isCreatingInventory: props.isCreatingInventory,
    isConsumingInventory: props.isConsumingInventory,
    isCreatingShopping: props.isCreatingShopping,
  } as const;

  function findUnifiedInventoryItemBySourceId(sourceId: string) {
    return unifiedInventoryItems.find((item) => item.source_id === sourceId);
  }

  function handleOpenFoodStockFromInventory(foodId: string) {
    const item = findUnifiedInventoryItemBySourceId(foodId);
    if (item) {
      setFoodStockAdjustDialog({
        item,
        quantity: '1',
        unit: item.unit || '份',
        expiryDate: item.expiry_date ?? '',
        purchaseSource: item.purchase_source ?? '',
        error: null,
      });
      return;
    }
    showNotice({
      tone: 'warning',
      title: '暂时无法补充库存',
      message: '这项成品库存还没有加载完成，请稍后再试。',
    });
  }

  /** Primary 减扣: open compact recordMeal. Inventory is a separate optional follow-up. */
  function handleRecordFoodStockMeal(foodId: string) {
    const item = findUnifiedInventoryItemBySourceId(foodId);
    if (!item) {
      showNotice({
        tone: 'warning',
        title: '暂时无法打开扣减流程',
        message: '这项成品库存还没有加载完成，请稍后再试。',
      });
      return;
    }
    const food =
      props.foods.find((entry) => entry.id === foodId) ??
      readyFoodOptions.find((entry) => entry.id === foodId) ??
      null;
    if (!food) {
      // Inventory-only path when Food entity is not loaded.
      setFoodStockDeductDialog({
        item,
        stockQuantity: item.quantity && item.quantity > 0 ? '1' : '',
        error: null,
      });
      return;
    }
    setQuickRecord({
      food,
      item,
      date: mealBusinessDate,
      mealType: getDefaultFoodStockMealType(),
      target: { kind: 'new' },
      selectedCandidateId: null,
      candidateMode: 'none',
      candidates: [],
      candidateResolution: { status: 'loading' },
      targetTouchedByUser: false,
      clientRequestId: createClientRequestId(),
      busy: false,
      error: null,
    });
  }

  async function handleAddFoodShopping(foodId: string) {
    let food = readyFoodOptions.find((item) => item.id === foodId) ?? null;
    if (!food) {
      const item = findUnifiedInventoryItemBySourceId(foodId);
      if (!item) {
        showNotice({ tone: 'warning', title: '暂时无法加入采购清单', message: '这项成品信息还没有加载完成，请稍后再试。' });
        return;
      }
      try {
        food = await lookupFood(item.title, foodId);
      } catch (error) {
        showNotice({
          tone: 'warning',
          title: '暂时无法加入采购清单',
          message: resolveErrorMessage(error, '这项成品信息暂时没有查到，请稍后再试。'),
        });
        return;
      }
      if (food) {
        setTransientShoppingFood(food);
      }
    }
    if (!food) {
      showNotice({ tone: 'warning', title: '暂时无法加入采购清单', message: '这项成品信息暂时没有查到，请稍后再试。' });
      return;
    }
    openShoppingOverlay({ food, reason: '补充成品库存' });
  }

  function handleInventoryEntryFilterChange(nextFilter: InventoryEntryFilter) {
    setInventoryEntryFilter(nextFilter);
    if (nextFilter === 'pending') {
      setInventoryQuickFilter('all');
    }
  }

  function handleInventoryQuickFilterChange(nextFilter: InventoryQuickFilter) {
    setInventoryQuickFilter(nextFilter);
    setInventoryStorageFocus('all');
    handleInventoryEntryFilterChange('all');
    setInventorySourceFilter('all');
  }


  const { submitCompactFoodRecord } = useIngredientFoodStockMealRecord({
    quickRecord,
    setQuickRecord,
    setInventoryFollowUp,
    loadMealCandidates: props.loadMealCandidates,
    recordMeal: props.recordMeal,
    recipes: props.recipes,
    onRecordSuccess: props.onRecordSuccess,
  });

  const { submitInventoryFollowUp, submitFoodStockDeductDialog, submitFoodStockAdjustDialog } = useIngredientFoodStockActions({
    foodStockSubmitting,
    setFoodStockSubmitting,
    inventoryFollowUp,
    setInventoryFollowUp,
    foodStockDeductDialog,
    setFoodStockDeductDialog,
    foodStockAdjustDialog,
    setFoodStockAdjustDialog,
    showNotice,
  });

  const renderIngredientHubPage = (mobileDetailPopover?: ReactNode) => (
    <IngredientInventoryPanelContextProvider
      value={{
        inventorySourceFilter,
        onInventorySourceFilterChange: setInventorySourceFilter,
        inventoryEntryFilter,
        onInventoryEntryFilterChange: handleInventoryEntryFilterChange,
        unifiedInventoryItems: filteredUnifiedInventoryItems,
        unifiedInventoryEntryItems: entryFilterBaseUnifiedInventoryItems,
        unifiedInventoryGroups,
        unifiedInventorySummary,
        unifiedInventoryEntrySummary,
        isInventoryOverviewFetching: inventoryOverviewQuery.isFetching,
        onOpenFoodStock: handleOpenFoodStockFromInventory,
        onRecordFoodStockMeal: handleRecordFoodStockMeal,
        onAddFoodShopping: handleAddFoodShopping,
      }}
    >
      <IngredientHubPage
        noticeToast={noticeToast}
        overlays={overlayLayerProps}
        workspaceMetrics={workspaceMetrics}
        desktopActions={desktopActions}
        panelItems={PANEL_ITEMS.map((item) => ({
          ...item,
          icon: <IngredientWorkspaceIcon name={item.icon} />,
        }))}
        activePanel={activePanel}
        openWorkspacePanel={openWorkspacePanel}
        allAlertsCount={priorityActionCount}
        stockedIngredientCount={stockedIngredientCount}
        pendingShoppingCount={pendingShopping.length}
        summariesCount={summaries.length}
        catalogSearch={catalogSearch}
        setCatalogSearch={setCatalogSearch}
        mobileIngredientFilter={mobileIngredientFilter}
        setMobileIngredientFilter={setMobileIngredientFilter}
        mobileInventoryEntryFilter={mobileInventoryEntryFilter}
        setMobileInventoryEntryFilter={setMobileInventoryEntryFilter}
        mobileStorageFocus={mobileStorageFocus}
        setMobileStorageFocus={setMobileStorageFocus}
        mobilePriorityRows={mobilePriorityRows}
        mobilePrioritySummaries={mobilePrioritySummaries}
        mobileFoodStockItems={mobileFoodStockItems}
        mobileStorageCards={mobileStorageCards}
        mobileCatalogSummaries={mobileCatalogSummaries}
        mobileCatalogResetKey={mobileCatalogResetKey}
        mobileShoppingCards={mobileShoppingCards}
        mobileShoppingGroups={mobileShoppingGroups}
        mobileHasCatalogFilters={mobileHasCatalogFiltersForUi}
        notificationCenter={props.notificationCenter}
        openDetailView={openDetailView}
        openInventoryOverlay={openInventoryOverlay}
        openConsumeOverlay={openConsumeOverlay}
        openShoppingOverlay={openShoppingOverlay}
        openDestroyExpiredOverlay={openDestroyExpiredOverlay}
        openCreateView={openCreateView}
        openInventoryFromShopping={(item) => {
          if (props.openShoppingIntake) {
            props.openShoppingIntake({ selectedItemId: item.id });
            return;
          }
          openInventoryFromShopping(item);
        }}
        openShoppingIntake={props.openShoppingIntake}
        openReconciliation={props.openReconciliation}
        operationBanner={props.operationBanner}
        openFoodStockMeal={handleRecordFoodStockMeal}
        openFoodStockEditor={handleOpenFoodStockFromInventory}
        openFoodShopping={handleAddFoodShopping}
        buildPriorityStatus={buildInventoryCardStatus}
        buildCatalogStatus={buildCatalogCardStatus}
        buildInventorySummaryLine={buildInventorySummaryLine}
        buildShoppingReason={resolveShoppingReason}
        countDisposableExpiredItems={(summary) => countDisposableExpiredInventoryItems(summary, businessDateKey())}
        renderStorageIllustration={IngredientStorageIllustration}
        renderIcon={(name) => <IngredientWorkspaceIcon name={name as IngredientWorkspaceIconName} />}
        isUpdatingShopping={props.isUpdatingShopping}
        isCreatingInventory={props.isCreatingInventory}
        isCatalogSearchFetching={isCatalogSearchFetching}
        onCatalogSearchCompositionStart={catalogSearchComposition.onCompositionStart}
        onCatalogSearchCompositionEnd={catalogSearchComposition.onCompositionEnd}
        catalogCountLabel={catalogCountLabel}
        catalogCategoryFilter={catalogCategoryFilter}
        catalogStatusFilter={catalogStatusFilter}
        catalogCategories={catalogCategories}
        catalogStatusItems={CATALOG_STATUS_FILTERS}
        catalogStatusCounts={catalogStatusCounts}
        filteredSummaries={filteredSummaries}
        visibleFilteredSummaries={visibleFilteredSummaries}
        hasMoreCatalogSummaries={catalogCardPager.hasMore}
        isLoadingMoreCatalogSummaries={catalogCardPager.isLoadingMore}
        onLoadMoreCatalogSummaries={catalogCardPager.loadMore}
        catalogLoadMoreRef={catalogCardPager.sentinelRef}
        expandedCatalogIngredientId={expandedCatalogIngredientId}
        catalogGridStyle={catalogGridStyle}
        setCatalogCategoryFilter={setCatalogCategoryFilter}
        setCatalogStatusFilter={setCatalogStatusFilter}
        openInventoryPanel={openInventoryPanel}
        toggleCatalogCard={toggleCatalogCard}
        catalogMeasureRef={catalogMeasureRef}
        ScrollableChipRail={ScrollableChipRail}
        IngredientCatalogCard={ExtractedIngredientCatalogCard}
        inventorySearch={inventorySearch}
        isInventorySearchFetching={isInventorySearchFetching}
        onInventorySearchCompositionStart={inventorySearchComposition.onCompositionStart}
        onInventorySearchCompositionEnd={inventorySearchComposition.onCompositionEnd}
        setInventorySearch={setInventorySearch}
        inventoryQuickFilter={inventoryQuickFilter}
        setInventoryQuickFilter={handleInventoryQuickFilterChange}
        inventoryStorageFocus={inventoryStorageFocus}
        setInventoryStorageFocus={setInventoryStorageFocus}
        inventorySortMode={inventorySortMode}
        setInventorySortMode={setInventorySortMode}
        focusedInventorySummaries={focusedInventorySummaries}
        inventoryStorageOverview={inventoryStorageOverview}
        inventoryGroups={inventoryGroups}
        InventoryStorageOverviewCard={IngredientStorageOverviewCard}
        InventoryIngredientCard={IngredientInventoryCard}
        shoppingOverview={shoppingOverview}
        shoppingFocus={shoppingFocus}
        setShoppingFocus={setShoppingFocus}
        shoppingSearch={shoppingSearch}
        setShoppingSearch={setShoppingSearch}
        pendingShoppingCards={pendingShoppingCards}
        visiblePendingShoppingCards={visiblePendingShoppingCards}
        visiblePendingShoppingGroups={visiblePendingShoppingGroups}
        completedShoppingCards={completedShoppingCards}
        visibleCompletedShoppingCards={visibleCompletedShoppingCards}
        activeShoppingOverview={activeShoppingOverview}
        showCompletedShopping={showCompletedShopping}
        setShowCompletedShopping={setShowCompletedShopping}
        onUpdateShoppingItem={props.updateShoppingItem}
        onDeleteShoppingItem={props.deleteShoppingItem}
        ShoppingWorkRow={ShoppingWorkRow}
        ShoppingHistoryRow={IngredientShoppingHistoryRow}
        mobileDetailPopover={mobileDetailPopover}
      />
    </IngredientInventoryPanelContextProvider>
  );

  if (workspaceView === 'detail' && selectedIngredient) {
    const detailQuantityLabel = selectedIngredient.quantitySummaries[0]?.label ?? '还没有库存';
    const detailMetricItems = [
      {
        icon: 'stocked' as const,
        label: '当前库存',
        value: detailQuantityLabel,
        tone: 'green',
      },
      {
        icon: 'link' as const,
        label: '相关菜谱',
        value: `${selectedIngredient.recipeReferences.length}`,
        tone: 'brown',
      },
      {
        icon: 'scale' as const,
        label: '默认单位',
        value: selectedIngredient.ingredient.default_unit || '个',
        tone: 'brown',
      },
      {
        icon: 'bell' as const,
        label: '当前提醒',
        value: `${selectedIngredient.alerts.length}`,
        tone: selectedIngredient.alerts.length > 0 ? 'red' : 'green',
      },
    ];
    const detailStorageLabel = selectedIngredient.primaryStorage || selectedIngredient.ingredient.default_storage || '常温';

    const detailViewProps = {
      activePanelBackLabel,
      selectedIngredient,
      detailStorageLabel,
      detailMetricItems,
      recipes: props.recipes,
      goBackToWorkspace,
      openInventoryOverlay,
      openConsumeOverlay,
      openShoppingOverlay,
      openEditView,
      renderIcon: (name: string) => <IngredientWorkspaceIcon name={name as IngredientWorkspaceIconName} />,
      formatExpiryRuleLabel,
      formatLowStockRuleLabel,
    };

    return (
      <>
        <div className="ingredients-detail-desktop-only">
          <IngredientDetailPage
            noticeToast={noticeToast}
            overlays={overlayLayerProps}
            onOpenCreateView={openCreateView}
            {...detailViewProps}
          />
        </div>
        <div className="ingredients-detail-mobile-only">
          {renderIngredientHubPage(
            <WorkspaceOverlayFrame
              rootClassName="ingredient-workspace-overlay-root mobile-ingredient-detail-popover-root"
              backdropClassName="mobile-ingredient-detail-popover-backdrop"
              onClose={goBackToWorkspace}
            >
              <WorkspaceDrawer
                eyebrow={selectedIngredient.ingredient.category || '食材'}
                title={selectedIngredient.ingredient.name}
                description={selectedIngredient.ingredient.notes || `适合做${selectedIngredient.recipeReferences.slice(0, 2).map((recipe) => recipe.title).join('、') || '日常菜'}`}
                closeLabel="关闭"
                closeAriaLabel="关闭食材详情"
                className="mobile-ingredient-detail-popover-panel ingredient-detail-drawer"
                onClose={goBackToWorkspace}
              >
                <IngredientDetailView {...detailViewProps} />
              </WorkspaceDrawer>
            </WorkspaceOverlayFrame>
          )}
        </div>
      </>
    );
  }

  return (
    <>
      {renderIngredientHubPage()}

      {workspaceView === 'create' && (
        <WorkspaceOverlayFrame
          rootClassName="ingredient-workspace-overlay-root"
          closeOnBackdrop={!isIngredientFormSubmitting}
          onClose={closeIngredientFormIfAllowed}
        >
          <WorkspaceModal
            title={isEditingIngredient ? '编辑食材' : '新增食材'}
            description={isEditingIngredient ? '调整名称、分类、图片和备注后，可以直接保存食材信息。' : '填写基础信息、图片和备注后，就能继续加入库存。'}
            eyebrow="食材信息"
            className="ingredient-editor-modal"
            closeLabel="关闭"
            onClose={closeIngredientFormIfAllowed}
          >
            <IngredientEditorView
              embedded
              activePanelBackLabel={activePanelBackLabel}
              isEditingIngredient={isEditingIngredient}
              ingredientForm={ingredientForm}
              setIngredientForm={setIngredientForm}
              ingredientVisibleCategoryPresets={ingredientVisibleCategoryPresets}
              ingredientCategoryIsVisiblePreset={ingredientCategoryIsVisiblePreset}
              showIngredientCategoryCustomInput={showIngredientCategoryCustomInput}
              setIngredientCustomCategoryOpen={setIngredientCustomCategoryOpen}
              applyIngredientCategoryPreset={applyIngredientCategoryPreset}
              ingredientUnitAdvancedOpen={ingredientUnitAdvancedOpen}
              setIngredientUnitAdvancedOpen={setIngredientUnitAdvancedOpen}
              ingredientUnitOptions={ingredientUnitOptions}
              ingredientUsesCustomUnit={ingredientUsesCustomUnit}
              ingredientUsesCustomStorage={ingredientUsesCustomStorage}
              trimmedIngredientUnit={trimmedIngredientUnit}
              ingredientDefaultExpiryRangeValue={ingredientDefaultExpiryRangeValue}
              ingredientLowStockEnabled={ingredientLowStockEnabled}
              ingredientLowStockValue={ingredientLowStockValue}
              ingredientLowStockStep={ingredientLowStockStep}
              ingredientLowStockQuickValues={ingredientLowStockQuickValues}
              ingredientPreviewImage={ingredientPreviewImage}
              createSummaryItems={createSummaryItems}
              createChecklistItems={createChecklistItems}
              createCanSubmit={createCanSubmit}
              ingredientImageState={ingredientImageComposer.state}
              trackingTransitionDraft={editorState.trackingTransitionDraft}
              trackingTransitionBusy={editorState.trackingTransitionBusy}
              trackingTransitionError={editorState.trackingTransitionError}
              onCancelTrackingTransition={editorState.cancelTrackingTransition}
              onUpdatePresenceResolution={editorState.updatePresenceResolution}
              onUpdateExactResolution={editorState.updateExactResolution}
              onConfirmTrackingTransition={() => void editorState.confirmTrackingTransition()}
              onUploadImage={(files) => void ingredientImageComposer.upload(files)}
              onGenerateImage={(mode) => void ingredientImageComposer.generate(mode)}
              onResetImage={ingredientImageComposer.reset}
              onSubmit={handleCreateSubmit}
              onSaveWithoutRestock={() => void submitIngredient(false)}
              onBack={closeIngredientFormIfAllowed}
              isCreatingIngredient={props.isCreatingIngredient}
              isUpdatingIngredient={props.isUpdatingIngredient}
              renderIcon={(name) => <IngredientWorkspaceIcon name={name as IngredientWorkspaceIconName} />}
              renderStorageIcon={(storage) => <IngredientStorageIcon storage={storage} />}
              ScrollableChipRail={ScrollableChipRail}
            />
          </WorkspaceModal>
        </WorkspaceOverlayFrame>
      )}

      {/* Shared ordinary-record result bar; preserved if inventory follow-up is dismissed/fails. */}
      <MealRecordResultBar
        result={props.recordResult ?? null}
        isReverting={props.isRevertingRecord}
        revertError={props.recordRevertError}
        rateError={props.recordRateError}
        onRevert={props.onRevertRecord}
        onView={props.onViewRecord}
        onRate={props.onRateRecord}
        onDismiss={props.onDismissRecord}
      />

      {quickRecord ? (
        <MealQuickRecordView
          open
          prefilledFood={{
            food_id: quickRecord.food.id,
            name: quickRecord.food.name,
            cover: getFoodCoverAsset(quickRecord.food, props.recipes) ?? null,
            servings: 1,
          }}
          date={quickRecord.date}
          mealType={quickRecord.mealType}
          dateOptions={foodStockRecordDateOptions}
          candidates={quickRecord.candidates}
          selectedCandidateId={quickRecord.selectedCandidateId}
          candidateMode={quickRecord.candidateMode}
          target={quickRecord.target}
          busy={quickRecord.busy || Boolean(props.isRecordingMeal)}
          submitDisabled={!canSubmitWithCandidateResolution(quickRecord.candidateResolution)}
          error={quickRecord.error}
          overlayRootClassName="ingredient-workspace-overlay-root"
          onClose={() => {
            if (!quickRecord.busy) setQuickRecord(null);
          }}
          onDateChange={(date) => {
            setQuickRecord((current) =>
              current
                ? {
                    ...current,
                    date,
                    target: { kind: 'new' },
                    selectedCandidateId: null,
                    candidateMode: 'none',
                    candidates: [],
                    candidateResolution: { status: 'loading' },
                    targetTouchedByUser: false,
                    error: null,
                  }
                : current,
            );
          }}
          onMealTypeChange={(mealType) => {
            setQuickRecord((current) =>
              current
                ? {
                    ...current,
                    mealType,
                    target: { kind: 'new' },
                    selectedCandidateId: null,
                    candidateMode: 'none',
                    candidates: [],
                    candidateResolution: { status: 'loading' },
                    targetTouchedByUser: false,
                    error: null,
                  }
                : current,
            );
          }}
          onTargetChange={(target, selectedCandidateId) => {
            setQuickRecord((current) =>
              current
                ? {
                    ...current,
                    target,
                    selectedCandidateId:
                      selectedCandidateId ??
                      (target.kind === 'existing' ? target.meal_log_id : null),
                    targetTouchedByUser: true,
                    error: null,
                  }
                : current,
            );
          }}
          onSubmit={() => {
            void submitCompactFoodRecord();
          }}
        />
      ) : null}

      <IngredientFoodStockDialogs
        todayDate={todayDate}
        inventoryFollowUp={inventoryFollowUp}
        foodStockDeductDialog={foodStockDeductDialog}
        foodStockAdjustDialog={foodStockAdjustDialog}
        foodStockSubmitting={foodStockSubmitting}
        setInventoryFollowUp={setInventoryFollowUp}
        setFoodStockDeductDialog={setFoodStockDeductDialog}
        setFoodStockAdjustDialog={setFoodStockAdjustDialog}
        setFoodStockRestockQuantity={setFoodStockRestockQuantity}
        setFoodStockRestockExpiryDays={setFoodStockRestockExpiryDays}
        setFoodStockRestockSource={setFoodStockRestockSource}
        submitInventoryFollowUp={submitInventoryFollowUp}
        submitFoodStockDeductDialog={submitFoodStockDeductDialog}
        submitFoodStockAdjustDialog={submitFoodStockAdjustDialog}
      />
    </>
  );
}
