import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type {
  ConsumeInventoryResponse,
  DisposeExpiredInventoryResponse,
  Ingredient,
  IngredientExpiryMode,
  IngredientUnitConversion,
  InventoryItem,
  InventoryStatus,
  Recipe,
  ShoppingListItem,
} from '../../api/types';
import { buildMediaSizes, buildMediaSrcSet, resolveAssetUrl, resolveMediaUrl } from '../../lib/assets';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
import { addDateKeyDays } from '../../lib/date';
import {
  formatDate,
  formatDateTime,
  formatRelativeDays,
  getImagePreview,
  INVENTORY_STATUS_LABELS,
} from '../../lib/ui';
import {
  type AiRenderPayload,
  getMediaIds,
} from '../../lib/aiImages';
import {
  IDLE_IMAGE_GENERATION_STATE,
  useImageComposer,
} from '../../hooks/useImageComposer';
import { useNotice } from '../../hooks/useNotice';
import {
  ActionButton,
  Badge,
  SectionHeading,
  WorkspaceModal,
} from '../ui-kit';
import {
  convertQuantityFromDefaultUnit,
  convertQuantityToDefaultUnit,
  getIngredientAvailableQuantityInDefault,
  getIngredientUnitOptions,
  getInventoryConsumedQuantity,
  getInventoryRemainingQuantity,
  normalizeIngredientUnit,
  resolvePreferredIngredientUnit,
} from '../../lib/ingredientUnits';
import { tracksIngredientQuantity } from '../../lib/ingredientTracking';
import {
  buildDisposableExpiredInventoryItems,
  buildInventoryCardPresentation,
  buildInventoryCardStatus,
  buildInventoryStorageOverview,
  buildIngredientSummaries,
  buildShoppingCards,
  buildShoppingOverview,
  buildIngredientCategoryFilters,
  buildStorageGroups,
  filterShoppingCards,
  filterIngredientSummaries,
  filterIngredientSummariesForInventory,
  getIngredientCategoryPreset,
  INGREDIENT_CATEGORY_PRESETS,
  sortInventorySummariesByExpiry,
  type IngredientSummaryViewModel,
  type IngredientWorkspacePanel,
  type InventoryStorageOverviewViewModel,
  type ShoppingCardViewModel,
} from './workspaceModel';
import {
  buildConsumeUnitOptions,
  buildIngredientForm,
  buildInventoryForm,
  buildShoppingForm,
  buildUnitPresetOptions,
  clampNumber,
  createIngredientUnitConversionDraft,
  defaultConsumeForm,
  defaultIngredientForm,
  formatNumericString,
  INVENTORY_STORAGE_PRESETS,
  isCustomChoiceValue,
  parseOptionalNumber,
  parsePositiveNumber,
  resolveClampedDaysValue,
  resolveExpiryDateFromDays,
  resolveInventoryStatusForStorage,
  resolveTouchDefaultValue,
  resolveTouchQuickValues,
  resolveTouchStep,
  sanitizeIngredientUnitConversions,
  type IngredientCreateFormState,
  type IngredientUnitConversionDraft,
  type InventoryStorageFocus,
} from './ingredientWorkspaceForms';
import {
  IngredientCatalogPanel,
  IngredientInventoryPanel,
  IngredientShoppingPanel,
} from './IngredientWorkspacePanels';
import { IngredientDetailPage } from './IngredientDetailPage';
import { IngredientEditorView } from './IngredientEditorView';
import { IngredientHubPage } from './IngredientHubPage';
import { useIngredientWorkspaceEffects } from './useIngredientWorkspaceEffects';
import { useIngredientWorkspaceData } from './useIngredientWorkspaceData';
import { useIngredientEditorState } from './useIngredientEditorState';
import { useIngredientActionState } from './useIngredientActionState';
import { useIngredientOverlayState } from './useIngredientOverlayState';
import {
  readPersistedIngredientWorkspaceState,
  STORAGE_SHELF_IDEAL_WIDTH,
  STORAGE_SHELF_MAX_DISPLAY_COLUMNS,
  type CatalogStatusFilter,
  type InventoryQuickFilter,
  type MobileIngredientFilter,
  type PersistedIngredientWorkspaceState,
  useIngredientWorkspaceState,
} from './useIngredientWorkspaceState';

type ScrollableChipRailProps = {
  ariaLabel: string;
  railClassName: string;
  children: ReactNode;
};

type IngredientWorkspaceProps = {
  ingredients: Ingredient[];
  inventoryItems: InventoryItem[];
  recipes: Recipe[];
  shoppingItems: ShoppingListItem[];
  notificationCenter?: ReactNode;
  navigationRequest?: {
    view: 'catalog' | 'detail';
    ingredientId?: string;
    requestId: number;
  } | null;
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
  consumeInventory: (payload: {
    ingredient_id: string;
    quantity?: number | null;
    unit?: string | null;
  }) => Promise<ConsumeInventoryResponse>;
  disposeExpiredInventory: (payload: {
    ingredient_id: string;
    inventory_item_ids: string[];
  }) => Promise<DisposeExpiredInventoryResponse>;
  createShoppingItem: (payload: {
    title: string;
    quantity?: number | null;
    unit?: string | null;
    ingredient_id?: string | null;
    quantity_mode?: ShoppingListItem['quantity_mode'];
    display_label?: string | null;
    reason: string;
  }) => Promise<ShoppingListItem>;
  updateShoppingItem: (payload: { itemId: string; done: boolean }) => Promise<ShoppingListItem>;
  isCreatingIngredient?: boolean;
  isUpdatingIngredient?: boolean;
  isCreatingInventory?: boolean;
  isConsumingInventory?: boolean;
  isDisposingExpiredInventory?: boolean;
  isCreatingShopping?: boolean;
  isUpdatingShopping?: boolean;
};

function resolveErrorMessage(reason: unknown, fallback: string) {
  return reason instanceof Error && reason.message.trim() ? reason.message : fallback;
}

function isPendingShopping(item: ShoppingListItem) {
  return !item.done;
}

type IngredientAlertTone = 'warning' | 'danger';
type IngredientWorkspaceIconName =
  | 'logo'
  | 'archive'
  | 'inventory'
  | 'shopping'
  | 'search'
  | 'filter'
  | 'status'
  | 'reset'
  | 'alert'
  | 'bell'
  | 'check'
  | 'chevronDown'
  | 'link'
  | 'metricList'
  | 'metricCircle'
  | 'sort'
  | 'plus'
  | 'star'
  | 'stocked'
  | 'total'
  | 'calendar'
  | 'scale'
  | 'swap'
  | 'edit'
  | 'clock'
  | 'user'
  | 'lightbulb'
  | 'exclamation'
  | 'image';

function IngredientWorkspaceIcon(props: { name: IngredientWorkspaceIconName }) {
  switch (props.name) {
    case 'logo':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 10h12" />
          <path d="M7 10v3a5 5 0 0 0 10 0v-3" />
          <path d="M17 11h1a2 2 0 0 1 0 4h-1" />
          <path d="M9 7V5" />
          <path d="M12 7V4" />
          <path d="M15 7V5" />
        </svg>
      );
    case 'archive':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="5" y="4.5" width="14" height="15" rx="2" />
          <path d="M8.5 8.5h7" />
          <path d="M8.5 12h7" />
          <path d="M8.5 15.5h4.5" />
        </svg>
      );
    case 'inventory':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 9.5h14v9H5z" />
          <path d="M7 9.5 8.5 5h7L17 9.5" />
          <path d="M9 14h6" />
        </svg>
      );
    case 'shopping':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 7h1.5l1.2 8.2h7.8l1.3-5.6H8.2" />
          <circle cx="10" cy="18" r="1.2" />
          <circle cx="16" cy="18" r="1.2" />
        </svg>
      );
    case 'search':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="6.5" />
          <path d="m16 16 4 4" />
        </svg>
      );
    case 'filter':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 7h14" />
          <path d="M8 12h8" />
          <path d="M10.5 17h3" />
        </svg>
      );
    case 'status':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5.5 8h13" />
          <path d="M5.5 12h13" />
          <path d="M5.5 16h13" />
          <path d="M9 6.7v2.6" />
          <path d="M15 10.7v2.6" />
          <path d="M11.5 14.7v2.6" />
        </svg>
      );
    case 'reset':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M7 8.5A6.5 6.5 0 1 1 6.7 15" />
          <path d="M7 5v3.5h3.5" />
        </svg>
      );
    case 'alert':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 5.5 20 19H4z" />
          <path d="M12 10v4" />
          <path d="M12 17h.01" />
        </svg>
      );
    case 'bell':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 9a6 6 0 0 1 12 0c0 7 3 6 3 8H3c0-2 3-1 3-8" />
          <path d="M10 20a2 2 0 0 0 4 0" />
        </svg>
      );
    case 'check':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m6 12.4 4 4L18.5 8" />
        </svg>
      );
    case 'chevronDown':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m7 10 5 5 5-5" />
        </svg>
      );
    case 'link':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M9.4 14.6 14.6 9.4" />
          <path d="M10.8 7.2 12 6a4 4 0 0 1 5.7 5.7l-1.2 1.2" />
          <path d="M13.2 16.8 12 18a4 4 0 0 1-5.7-5.7l1.2-1.2" />
        </svg>
      );
    case 'metricList':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="6.5" y="5" width="11" height="14" rx="2" />
          <path d="M9.2 9h5.6" />
          <path d="M9.2 12h5.6" />
          <path d="M9.2 15h3.6" />
          <path d="M15.2 3.8v3.4" />
        </svg>
      );
    case 'metricCircle':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="7" />
        </svg>
      );
    case 'sort':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M8 5v14" />
          <path d="m5 8 3-3 3 3" />
          <path d="M16 19V5" />
          <path d="m13 16 3 3 3-3" />
        </svg>
      );
    case 'plus':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="7" />
          <path d="M12 8.5v7" />
          <path d="M8.5 12h7" />
        </svg>
      );
    case 'star':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m12 4.5 2.1 4.3 4.7.7-3.4 3.3.8 4.7-4.2-2.2-4.2 2.2.8-4.7-3.4-3.3 4.7-.7z" />
        </svg>
      );
    case 'stocked':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 9h12v9H6z" />
          <path d="M8 9V6h8v3" />
          <path d="M9.5 13.5h5" />
        </svg>
      );
    case 'total':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="5" y="5" width="14" height="14" rx="3" />
          <path d="M9 9h6" />
          <path d="M9 12h6" />
          <path d="M9 15h4" />
        </svg>
      );
    case 'calendar':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="5" y="6" width="14" height="13" rx="2" />
          <path d="M8 4.5v3" />
          <path d="M16 4.5v3" />
          <path d="M5 10h14" />
          <path d="M9 14h3.5" />
          <path d="M9 16.5h2" />
        </svg>
      );
    case 'scale':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M8.5 19h7" />
          <path d="M12 16.5V5" />
          <path d="M7 7h10" />
          <path d="m7 7-3 6h6z" />
          <path d="m17 7-3 6h6z" />
        </svg>
      );
    case 'swap':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M7 8h11" />
          <path d="m15 5 3 3-3 3" />
          <path d="M17 16H6" />
          <path d="m9 13-3 3 3 3" />
        </svg>
      );
    case 'edit':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 18h12" />
          <path d="M7.5 14.5 15 7l2 2-7.5 7.5H7.5z" />
          <path d="m14 8 2 2" />
        </svg>
      );
    case 'clock':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="7" />
          <path d="M12 8v4.2l2.8 1.6" />
        </svg>
      );
    case 'user':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="8.2" r="3" />
          <path d="M6.5 19a5.5 5.5 0 0 1 11 0" />
        </svg>
      );
    case 'lightbulb':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M9 17h6" />
          <path d="M10 20h4" />
          <path d="M8.5 13.8a5.2 5.2 0 1 1 7 0c-.7.6-1 1.2-1.1 2H9.6c-.1-.8-.4-1.4-1.1-2z" />
        </svg>
      );
    case 'exclamation':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 6.8v7.2" />
          <path d="M12 17.4h.01" />
        </svg>
      );
    case 'image':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="5" y="6" width="14" height="12" rx="2" />
          <circle cx="9" cy="10" r="1.3" />
          <path d="m7 16 3.3-3.4 2.4 2.4 1.5-1.6L17 16" />
        </svg>
      );
  }
}

const PANEL_ITEMS: Array<{ value: IngredientWorkspacePanel; label: string; icon: IngredientWorkspaceIconName }> = [
  { value: 'catalog', label: '档案', icon: 'archive' },
  { value: 'inventory', label: '库存', icon: 'inventory' },
  { value: 'shopping', label: '采购', icon: 'shopping' },
];
const CATALOG_STATUS_FILTERS: Array<{ value: CatalogStatusFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'expired', label: '已过期' },
  { value: 'expiring', label: '临期' },
  { value: 'lowStock', label: '库存不足' },
  { value: 'stable', label: '正常' },
];
function formatExpiryRuleLabel(ingredient: Ingredient) {
  const expiryMode =
    ingredient.default_expiry_mode === 'days' ||
    ingredient.default_expiry_mode === 'manual_date' ||
    ingredient.default_expiry_mode === 'none'
      ? ingredient.default_expiry_mode
      : 'none';
  if (expiryMode === 'days') {
    return ingredient.default_expiry_days ? `买后 ${ingredient.default_expiry_days} 天到期` : '按买后天数计算到期';
  }
  if (expiryMode === 'manual_date') {
    return '补库存时填写包装到期日';
  }
  return '默认不跟踪到期';
}

function formatLowStockRuleLabel(ingredient: Ingredient) {
  return ingredient.default_low_stock_threshold !== null && ingredient.default_low_stock_threshold !== undefined
    ? `少于 ${ingredient.default_low_stock_threshold}${ingredient.default_unit} 时提醒`
    : '未设置低库存提醒';
}

function buildIngredientImagePayload(form: IngredientCreateFormState): AiRenderPayload {
  return {
    entity_type: 'ingredient',
    title: form.name.trim() || '家庭食材',
    category: form.category.trim(),
    notes: form.notes.trim(),
  };
}

function ScrollableChipRail(props: ScrollableChipRailProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [hasOverflow, setHasOverflow] = useState(false);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    let frame = 0;
    const updateScrollState = () => {
      cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const overflow = viewport.scrollWidth > viewport.clientWidth + 4;
        const nextCanScrollLeft = viewport.scrollLeft > 4;
        const nextCanScrollRight = viewport.scrollLeft + viewport.clientWidth < viewport.scrollWidth - 4;
        setHasOverflow((current) => (current === overflow ? current : overflow));
        setCanScrollLeft((current) => (current === nextCanScrollLeft ? current : nextCanScrollLeft));
        setCanScrollRight((current) => (current === nextCanScrollRight ? current : nextCanScrollRight));
      });
    };

    updateScrollState();
    viewport.addEventListener('scroll', updateScrollState, { passive: true });

    const observer = new ResizeObserver(() => {
      updateScrollState();
    });
    observer.observe(viewport);
    if (contentRef.current) {
      observer.observe(contentRef.current);
    }

    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener('scroll', updateScrollState);
      observer.disconnect();
    };
  }, [props.children]);

  function scrollByDirection(direction: -1 | 1) {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    viewport.scrollBy({
      left: direction * Math.max(180, viewport.clientWidth * 0.72),
      behavior: 'smooth',
    });
  }

  function handleViewportKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!hasOverflow) {
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      scrollByDirection(-1);
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      scrollByDirection(1);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      viewportRef.current?.scrollTo({ left: 0, behavior: 'smooth' });
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      viewportRef.current?.scrollTo({ left: viewportRef.current.scrollWidth, behavior: 'smooth' });
    }
  }

  const shellClassName = [
    'ingredients-chip-rail-shell',
    hasOverflow ? 'has-overflow' : '',
    canScrollLeft ? 'can-scroll-left' : '',
    canScrollRight ? 'can-scroll-right' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={shellClassName}>
      <button
        className="ingredients-chip-rail-button ingredients-chip-rail-button-left"
        type="button"
        aria-label="向左查看更多分类"
        onClick={() => scrollByDirection(-1)}
        disabled={!hasOverflow || !canScrollLeft}
      >
        <span aria-hidden="true">‹</span>
      </button>
      <div
        ref={viewportRef}
        className="ingredients-chip-rail-viewport"
        aria-label={props.ariaLabel}
        onKeyDown={handleViewportKeyDown}
        tabIndex={hasOverflow ? 0 : -1}
      >
        <div ref={contentRef} className={props.railClassName}>
          {props.children}
        </div>
      </div>
      <button
        className="ingredients-chip-rail-button ingredients-chip-rail-button-right"
        type="button"
        aria-label="向右查看更多分类"
        onClick={() => scrollByDirection(1)}
        disabled={!hasOverflow || !canScrollRight}
      >
        <span aria-hidden="true">›</span>
      </button>
    </div>
  );
}

function getIngredientAlertTone(summary: IngredientSummaryViewModel): IngredientAlertTone {
  return summary.alerts.some((item) => item.tone === 'danger') ? 'danger' : 'warning';
}

function getBatchTone(alerts: Array<{ tone: 'warning' | 'danger' }>): 'default' | 'warning' | 'danger' {
  if (alerts.some((item) => item.tone === 'danger')) {
    return 'danger';
  }
  if (alerts.length > 0) {
    return 'warning';
  }
  return 'default';
}

function buildInventorySummaryLine(summary: IngredientSummaryViewModel) {
  if (summary.quantitySummaries.length === 0) {
    return '未登记库存';
  }

  return summary.quantitySummaries
    .slice(0, 2)
    .map((item) => item.label)
    .join(' · ');
}

function buildInventoryRowDescription(summary: IngredientSummaryViewModel) {
  if (summary.inventoryItems.length === 0) {
    return `${summary.primaryStorage} · 还没登记库存，适合先补一批常用量。`;
  }
  if (summary.quantitySummaries.length === 0) {
    return `${summary.primaryStorage} · 当前可用库存已空，先处理到期批次或补一批新的。`;
  }

  return [
    buildInventorySummaryLine(summary),
    summary.primaryStorage,
    summary.latestPurchaseDate ? `最近补货 ${formatDate(summary.latestPurchaseDate)}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function buildInventoryTotalLabel(summary: IngredientSummaryViewModel) {
  if (!tracksIngredientQuantity(summary.ingredient)) {
    return summary.availableInventoryItems.length > 0 ? '已有' : '未配置';
  }
  const totalQuantity = getIngredientAvailableQuantityInDefault(summary.ingredient, summary.inventoryItems);
  if (totalQuantity <= 0) {
    return `0${summary.ingredient.default_unit || '个'}`;
  }
  return `${formatNumericString(totalQuantity)}${summary.ingredient.default_unit || '个'}`;
}

type CatalogCardStatusTone = 'stable' | 'warning' | 'danger' | 'empty';

function buildCatalogCardStatus(summary: IngredientSummaryViewModel): {
  label: string;
  tone: CatalogCardStatusTone;
  stockLine: string;
  hint: string;
} {
  const expiredAlert = summary.alerts.find((item) => item.kind === 'expiry' && item.title.includes('已经过期'));
  const expiringAlert = summary.alerts.find((item) => item.kind === 'expiry' && !item.title.includes('已经过期'));
  const firstWarningAlert = summary.alerts.find((item) => item.tone === 'warning');
  const availableLabel = summary.quantitySummaries[0]?.label ?? `0 ${summary.ingredient.default_unit || '个'}`;
  const batchLabel = `${summary.inventoryItems.length} 批次`;
  const stockLine = `库存 ${availableLabel} · ${batchLabel}`;

  if (expiredAlert) {
    return {
      label: '已过期',
      tone: 'danger',
      stockLine,
      hint: '优先处理过期批次',
    };
  }

  if (expiringAlert) {
    return {
      label: '临期',
      tone: 'warning',
      stockLine,
      hint: '建议优先安排使用',
    };
  }

  if (summary.quantitySummaries.length === 0) {
    return {
      label: '缺货',
      tone: 'empty',
      stockLine,
      hint: summary.inventoryItems.length > 0 ? '可补货或加入采购' : '建议先登记一批库存',
    };
  }

  if (firstWarningAlert) {
    return {
      label: '库存偏低',
      tone: 'warning',
      stockLine,
      hint: '建议加入采购或补货',
    };
  }

  return {
    label: '库存正常',
    tone: 'stable',
    stockLine,
    hint: summary.latestPurchaseDate ? `最近补货 ${formatDate(summary.latestPurchaseDate)}` : '可按需消费或补货',
  };
}

function matchesCatalogStatusFilter(summary: IngredientSummaryViewModel, filter: CatalogStatusFilter) {
  if (filter === 'all') {
    return true;
  }
  const hasExpiredAlert = summary.alerts.some((item) => item.kind === 'expiry' && item.title.includes('已经过期'));
  const hasExpiringAlert = summary.alerts.some((item) => item.kind === 'expiry' && !item.title.includes('已经过期'));
  const hasLowStockAlert = summary.alerts.some((item) => item.kind === 'lowStock');
  if (filter === 'expired') {
    return hasExpiredAlert;
  }
  if (filter === 'expiring') {
    return hasExpiringAlert;
  }
  if (filter === 'lowStock') {
    return hasLowStockAlert;
  }
  return summary.quantitySummaries.length > 0 && summary.alerts.length === 0;
}

function filterIngredientSummariesByCatalogStatus(
  summaries: IngredientSummaryViewModel[],
  filter: CatalogStatusFilter
) {
  return summaries.filter((summary) => matchesCatalogStatusFilter(summary, filter));
}

function buildCatalogExpandedNote(summary: IngredientSummaryViewModel) {
  if (summary.ingredient.notes.trim()) {
    return summary.ingredient.notes.trim();
  }
  if (summary.latestPurchaseDate) {
    return `最近补货于 ${formatDate(summary.latestPurchaseDate)}，当前主要放在 ${summary.primaryStorage}。`;
  }
  if (summary.inventoryItems.length > 0) {
    return `${summary.inventoryItems.length} 条批次在用，可继续补货或查看完整详情。`;
  }
  return '这张资料卡还没有库存记录，先补一批会更顺手。';
}

function resolveShoppingReason(summary: IngredientSummaryViewModel) {
  if (summary.alerts.some((item) => item.kind === 'lowStock')) {
    return '库存偏低，准备补货';
  }
  if (summary.alerts.some((item) => item.kind === 'expiry')) {
    return '备一份新的，替换临期库存';
  }
  return '纳入近期采购计划';
}

type InventoryStorageOverviewCardProps = {
  item: InventoryStorageOverviewViewModel;
  active: boolean;
  onSelect: () => void;
};

function InventoryStorageIcon(props: { storage: string }) {
  if (props.storage === '冷冻') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 3v18" />
        <path d="m8 5 4 4 4-4" />
        <path d="m8 19 4-4 4 4" />
        <path d="M4.2 7.5 19.8 16.5" />
        <path d="m4.8 12.9 5.5-1.5-1.5-5.5" />
        <path d="m19.2 11.1-5.5 1.5 1.5 5.5" />
        <path d="M19.8 7.5 4.2 16.5" />
        <path d="m15.2 5.9-1.5 5.5 5.5 1.5" />
        <path d="m8.8 18.1 1.5-5.5-5.5-1.5" />
      </svg>
    );
  }
  if (props.storage === '常温') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="5" y="5" width="14" height="16" rx="1.8" />
        <path d="M5 10h14" />
        <path d="M12 10v11" />
        <path d="M8.5 14v2" />
        <path d="M15.5 14v2" />
        <path d="M9 7.5h6" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="6" y="4" width="12" height="17" rx="2" />
      <path d="M6 10h12" />
      <path d="M9 7h6" />
      <path d="M9 14v3" />
      <path d="M15 14v3" />
    </svg>
  );
}

function resolveInventoryStorageAsset(storage: string) {
  if (storage === '冷冻') {
    return '/assets/asset_storage_freezer_frozen.webp';
  }
  if (storage === '常温') {
    return '/assets/asset_storage_pantry_roomtemp.webp';
  }
  return '/assets/asset_storage_fridge_chilled.webp';
}

function InventoryStorageIllustration(props: { storage: string }) {
  return <img src={resolveInventoryStorageAsset(props.storage)} alt="" aria-hidden="true" />;
}

function InventoryStorageOverviewCard(props: InventoryStorageOverviewCardProps) {
  const className = [
    'ingredients-inventory-overview-card',
    `tone-${props.item.tone}`,
    `storage-${props.item.key}`,
    props.active ? 'active' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button type="button" className={className} onClick={props.onSelect} aria-pressed={props.active}>
      <span className="ingredients-inventory-overview-illustration">
        <InventoryStorageIllustration storage={props.item.key} />
      </span>
      <div className="ingredients-inventory-overview-card-head">
        <span className="ingredients-inventory-overview-card-title">
          <span className="ingredients-inventory-overview-card-icon">
            <InventoryStorageIcon storage={props.item.key} />
          </span>
          {props.item.label}
          {props.active && <span className="ingredients-inventory-overview-card-focus">当前查看</span>}
        </span>
        <span className="ingredients-inventory-overview-card-action" aria-hidden="true">
          {props.active ? '✓' : '›'}
        </span>
      </div>
      <div className="ingredients-inventory-overview-card-body">
        <div className="ingredients-inventory-overview-card-metric">
          <strong>{props.item.ingredientCount}</strong>
          <span>种食材</span>
        </div>
        <div className="ingredients-inventory-overview-card-metric">
          <strong>{props.item.totalBatches}</strong>
          <span>条批次</span>
        </div>
        <div className="ingredients-inventory-overview-card-metric">
          <strong>{props.item.alertCount}</strong>
          <span>条提醒</span>
        </div>
      </div>
      <p className="ingredients-inventory-overview-card-status">
        <span aria-hidden="true" />
        {props.item.statusLabel}
      </p>
    </button>
  );
}

type ShoppingWorkRowProps = {
  card: ShoppingCardViewModel;
  onComplete: () => void;
  onDetail?: () => void;
  isBusy?: boolean;
};

function ShoppingWorkRow(props: ShoppingWorkRowProps) {
  const { card } = props;
  const linkedSummary = card.linkedSummary;
  const imageUrl = resolveAssetUrl(linkedSummary?.ingredient.image?.url);
  const hasCustomImage = Boolean(linkedSummary?.ingredient.image?.url);
  const footerNote =
    card.statusTone === 'danger'
      ? '已过期，建议优先补充并入库。'
      : card.hasAttention
        ? '当前有提醒，建议优先补齐并入库。'
        : card.footerNote;
  const rowClassName = [
    'shopping-work-row',
    `tone-${card.tone}`,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <article className={rowClassName}>
      <div className="shopping-work-row-main">
        <div className="shopping-work-row-leading">
          <div className={hasCustomImage ? 'shopping-work-row-media' : 'shopping-work-row-media is-placeholder'}>
            <MediaWithPlaceholder src={imageUrl} alt={card.title} />
          </div>
        </div>

        <div className="shopping-work-row-copy">
          <div className="shopping-work-row-head">
            <div className="shopping-work-row-titleblock">
              <h3>{card.title}</h3>
              <strong className="shopping-work-row-quantity">{card.headline}</strong>
            </div>
          </div>
          <p className="shopping-work-row-subline" title={card.subline}>
            {card.subline}
          </p>
          <div className="shopping-work-row-context">
            {card.contextTags.map((tag) => (
              <span key={`${card.shoppingItem.id}-${tag}`} className="shopping-work-row-context-tag">
                {tag}
              </span>
            ))}
          </div>
        </div>

        <div className="shopping-work-row-badges shopping-work-row-badges-inline">
          <span className={`shopping-work-row-source tone-${card.tone}`}>{card.sourceLabel}</span>
          <span className={`shopping-work-row-status tone-${card.statusTone}`}>{card.statusLabel}</span>
        </div>

        <div className="shopping-work-row-actions">
          <ActionButton
            tone="primary"
            type="button"
            className="shopping-work-row-primary-action"
            onClick={props.onComplete}
            disabled={props.isBusy}
          >
            已买并入库
          </ActionButton>
          {props.onDetail ? (
            <ActionButton
              tone="secondary"
              size="compact"
              type="button"
              onClick={props.onDetail}
              disabled={props.isBusy}
            >
              查看档案
            </ActionButton>
          ) : (
            <div className="shopping-work-row-action-note">自由项会按当前标题进入补库存流程。</div>
          )}
        </div>
      </div>
      <div className="shopping-work-row-footer">
        <span className="shopping-work-row-footer-icon" aria-hidden="true">i</span>
        <span className="shopping-work-row-footer-note">{footerNote}</span>
      </div>
    </article>
  );
}

type ShoppingHistoryRowProps = {
  card: ShoppingCardViewModel;
  onRestore: () => void;
  onDetail?: () => void;
  isBusy?: boolean;
};

function ShoppingHistoryRow(props: ShoppingHistoryRowProps) {
  const { card } = props;

  return (
    <article className="shopping-history-row">
      <div className="shopping-history-row-main">
        <div className="shopping-history-row-copy">
          <div className="shopping-history-row-head">
            <h4>{card.title}</h4>
          </div>
          <p className="shopping-history-row-meta">
            {card.reasonLabel} · {card.contextLine}
          </p>
        </div>
        <span className="shopping-history-row-quantity">{card.quantityLabel}</span>
        <div className="shopping-history-row-actions">
          {props.onDetail ? (
            <ActionButton
              tone="tertiary"
              size="compact"
              type="button"
              onClick={props.onDetail}
              disabled={props.isBusy}
            >
              查看档案
            </ActionButton>
          ) : null}
          <ActionButton
            tone="tertiary"
            size="compact"
            type="button"
            onClick={props.onRestore}
            disabled={props.isBusy}
          >
            再次加入采购
          </ActionButton>
        </div>
      </div>
    </article>
  );
}

type InventoryIngredientCardProps = {
  summary: IngredientSummaryViewModel;
  onRestock: () => void;
  onConsume: () => void;
  onAddShopping: () => void;
  onDetail: () => void;
  onDestroyExpired: () => void;
};

function InventoryIngredientCard(props: InventoryIngredientCardProps) {
  const { summary } = props;
  const status = buildInventoryCardStatus(summary);
  const presentation = buildInventoryCardPresentation(summary);
  const disposableExpiredItems = buildDisposableExpiredInventoryItems(summary);
  const canDestroyExpired = disposableExpiredItems.length > 0;
  const alertTone = summary.alerts.length > 0 ? getIngredientAlertTone(summary) : null;
  const imageUrl = resolveMediaUrl(summary.ingredient.image, 'card');
  const hasCustomImage = Boolean(summary.ingredient.image?.url);
  const tracksQuantity = tracksIngredientQuantity(summary.ingredient);
  const metaLine = [summary.ingredient.category || '未分类', summary.primaryStorage].join(' · ');
  const totalInventoryLabel = buildInventoryTotalLabel(summary);
  const cardClassName = [
    'ingredient-card ingredient-card-interactive ingredient-visual-card ingredient-visual-card-summary ingredient-visual-card-inventory ingredient-work-card inventory-ingredient-card',
    `tone-${status.tone}`,
    alertTone ? `ingredient-work-card-has-${alertTone}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <article className={cardClassName}>
      <div className="ingredient-work-card-primary">
        <div className="ingredient-work-card-toggle">
          <button
            type="button"
            className="ingredient-visual-media ingredient-visual-media-button inventory-ingredient-card-media"
            onClick={props.onDetail}
            aria-label={`查看 ${summary.ingredient.name} 详情`}
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
                srcSet={buildMediaSrcSet(summary.ingredient.image)}
                sizes={buildMediaSizes('card')}
                alt={summary.ingredient.name}
              />
            </div>
            <span className="ingredient-visual-entry-hint" aria-hidden="true">
              <span>↗</span>
            </span>
            {alertTone && (
              <span className={`ingredient-visual-corner ingredient-visual-corner-${alertTone}`}>
                {summary.alerts.length} 条提醒
              </span>
            )}
          </button>

          <div className="ingredient-visual-body inventory-ingredient-card-body">
            <div className="ingredient-visual-title-row inventory-ingredient-card-title-row">
              <h3>{summary.ingredient.name}</h3>
            </div>
            <p className="ingredient-visual-meta" title={metaLine}>
              {metaLine}
            </p>
            <div className="inventory-ingredient-card-stockline">
              <div className="inventory-ingredient-card-stockline-head">
                <span className="inventory-ingredient-card-stockline-label">可用库存</span>
                {presentation.hasExpiryInfo && presentation.expiryLabel && presentation.expiryTone ? (
                  <span
                    className={`inventory-ingredient-card-expiry-badge tone-${presentation.expiryTone}`}
                    title={`最早 ${presentation.expiryDateLabel} 到期`}
                  >
                    {presentation.expiryLabel}
                  </span>
                ) : null}
              </div>
              <strong>{presentation.headline}</strong>
              <p title={presentation.secondary}>{presentation.secondary}</p>
              <div className="inventory-ingredient-card-data-row">
                <span>总库存 {totalInventoryLabel}</span>
                <span>{summary.inventoryItems.length} 批次</span>
                <span>{summary.alerts.length} 条提醒</span>
              </div>
            </div>

            <div className="ingredient-visual-tag-row inventory-ingredient-card-tag-row">
              <span className="ingredient-visual-pill inventory-ingredient-card-pill-location">
                {summary.primaryStorage}
              </span>
              {summary.alerts.length > 0 ? (
                <span
                  className={`ingredient-visual-pill ingredient-visual-pill-${alertTone} ingredient-visual-pill-flex`}
                >
                  {summary.alerts.length} 条提醒
                </span>
              ) : (
                <span className="ingredient-visual-pill ingredient-work-card-stable-pill ingredient-visual-pill-flex">
                  {status.label}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="ingredient-work-card-actions inventory-ingredient-card-actions">
          {canDestroyExpired ? (
            <>
              <ActionButton
                tone="secondary"
                size="compact"
                type="button"
                className="ingredient-work-card-action-button ingredient-work-card-action-button-primary"
                onClick={props.onDestroyExpired}
                title="查看并确认销毁已过期批次"
              >
                处理提醒
              </ActionButton>
              <ActionButton
                tone="secondary"
                size="compact"
                type="button"
                className="ingredient-work-card-action-button ingredient-work-card-action-button-secondary"
                onClick={props.onDetail}
              >
                查看批次
              </ActionButton>
            </>
          ) : tracksQuantity && summary.quantitySummaries.length > 0 ? (
            <>
              <ActionButton
                tone="secondary"
                size="compact"
                type="button"
                className="ingredient-work-card-action-button ingredient-work-card-action-button-primary"
                onClick={props.onConsume}
              >
                消费
              </ActionButton>
              <ActionButton
                tone="secondary"
                size="compact"
                type="button"
                className="ingredient-work-card-action-button ingredient-work-card-action-button-secondary"
                onClick={props.onRestock}
              >
                补货
              </ActionButton>
            </>
          ) : !tracksQuantity && summary.inventoryItems.length > 0 ? (
            <>
              <ActionButton
                tone="secondary"
                size="compact"
                type="button"
                className="ingredient-work-card-action-button ingredient-work-card-action-button-primary"
                onClick={props.onDetail}
              >
                查看
              </ActionButton>
              <ActionButton
                tone="secondary"
                size="compact"
                type="button"
                className="ingredient-work-card-action-button ingredient-work-card-action-button-secondary"
                onClick={props.onRestock}
              >
                补充
              </ActionButton>
            </>
          ) : (
            <>
              <ActionButton
                tone="secondary"
                size="compact"
                type="button"
                className="ingredient-work-card-action-button ingredient-work-card-action-button-primary"
                onClick={props.onRestock}
              >
                {summary.inventoryItems.length > 0 ? '补货' : '登记首批'}
              </ActionButton>
              <ActionButton
                tone="secondary"
                size="compact"
                type="button"
                className="ingredient-work-card-action-button ingredient-work-card-action-button-secondary"
                onClick={props.onAddShopping}
              >
                加入采购
              </ActionButton>
            </>
          )}
        </div>

        <div className="ingredient-work-card-footer inventory-ingredient-card-footer">
          <span className="ingredient-work-card-footer-note inventory-ingredient-card-footer-note">
            {presentation.footerNote}
          </span>
        </div>
      </div>
    </article>
  );
}

type IngredientCatalogCardProps = {
  summary: IngredientSummaryViewModel;
  expanded: boolean;
  onToggle: () => void;
  onRestock: () => void;
  onConsume: () => void;
  onAddShopping: () => void;
  onHandleAlert: () => void;
  onDetail: () => void;
};

function IngredientCatalogCard(props: IngredientCatalogCardProps) {
  const { summary, expanded } = props;
  const primaryRef = useRef<HTMLDivElement | null>(null);
  const [expandedPrimaryHeight, setExpandedPrimaryHeight] = useState<number | null>(null);
  const hasCustomImage = Boolean(summary.ingredient.image?.url);
  const imageUrl = resolveMediaUrl(summary.ingredient.image, 'card');
  const alertTone = getIngredientAlertTone(summary);
  const status = buildCatalogCardStatus(summary);
  const tracksQuantity = tracksIngredientQuantity(summary.ingredient);
  const canConsume = tracksQuantity && summary.availableInventoryItems.length > 0;
  const disposableExpiredItems = buildDisposableExpiredInventoryItems(summary);
  const canDestroyExpired = disposableExpiredItems.length > 0;
  const metaLine = [
    summary.ingredient.category || '未分类',
    summary.primaryStorage || summary.ingredient.default_storage || '常温',
  ].join(' · ');
  const cardClassName = [
    'ingredient-card ingredient-card-interactive ingredient-visual-card ingredient-visual-card-catalog ingredient-work-card',
    expanded ? 'is-expanded' : '',
    summary.alerts.length > 0 ? `ingredient-work-card-has-${alertTone}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const cardStyle =
    expanded && expandedPrimaryHeight
      ? ({ '--ingredient-work-card-expanded-height': `${expandedPrimaryHeight}px` } as CSSProperties)
      : undefined;

  useLayoutEffect(() => {
    if (!expanded) {
      setExpandedPrimaryHeight(null);
      return;
    }

    const node = primaryRef.current;
    if (!node) {
      return;
    }

    let frameId = 0;

    const syncHeight = () => {
      const nextHeight = Math.ceil(node.getBoundingClientRect().height);
      setExpandedPrimaryHeight((currentHeight) => (currentHeight === nextHeight ? currentHeight : nextHeight));
    };

    syncHeight();

    if (typeof ResizeObserver === 'undefined') {
      return () => {
        if (frameId) {
          cancelAnimationFrame(frameId);
        }
      };
    }

    const observer = new ResizeObserver(() => {
      if (frameId) {
        cancelAnimationFrame(frameId);
      }
      frameId = requestAnimationFrame(syncHeight);
    });

    observer.observe(node);

    return () => {
      observer.disconnect();
      if (frameId) {
        cancelAnimationFrame(frameId);
      }
    };
  }, [expanded]);

  return (
    <article className={cardClassName} style={cardStyle}>
      <div ref={primaryRef} className="ingredient-work-card-primary">
        <div className="ingredient-work-card-toggle">
          <button
            type="button"
            className="ingredient-visual-media ingredient-visual-media-button"
            onClick={props.onDetail}
            aria-label={`查看 ${summary.ingredient.name} 详情`}
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
                srcSet={buildMediaSrcSet(summary.ingredient.image)}
                sizes={buildMediaSizes('card')}
                alt={summary.ingredient.name}
              />
            </div>
            <span className="ingredient-visual-entry-hint" aria-hidden="true">
              <span>↗</span>
            </span>
            {summary.alerts.length > 0 && (
              <span className={`ingredient-visual-corner ingredient-visual-corner-${alertTone}`}>
                {summary.alerts.length} 条提醒
              </span>
            )}
          </button>
          <div className="ingredient-visual-body">
            <div className="ingredient-visual-title-row">
              <h3>{summary.ingredient.name}</h3>
              <ActionButton
                tone="tertiary"
                size="compact"
                type="button"
                className="ingredient-work-card-more-icon"
                onClick={props.onToggle}
                aria-expanded={expanded}
                aria-label={`${expanded ? '收起' : '查看更多'} ${summary.ingredient.name}`}
              >
                <span aria-hidden="true">•••</span>
              </ActionButton>
            </div>
            <p className="ingredient-visual-meta" title={metaLine}>
              {metaLine}
            </p>
            <div className={`ingredient-catalog-status tone-${status.tone}`}>
              <div className="ingredient-catalog-status-head">
                <span>{status.label}</span>
                {summary.alerts.length > 0 && <small>{summary.alerts.length} 条提醒</small>}
              </div>
              <p>{status.stockLine}</p>
              <strong>{status.hint}</strong>
            </div>
          </div>
        </div>

        <div className="ingredient-work-card-actions">
          {canDestroyExpired ? (
            <>
              <ActionButton
                tone="secondary"
                size="compact"
                type="button"
                className="ingredient-work-card-action-button ingredient-work-card-action-button-primary"
                onClick={props.onHandleAlert}
              >
                处理
              </ActionButton>
              <ActionButton
                tone="secondary"
                size="compact"
                type="button"
                className="ingredient-work-card-action-button ingredient-work-card-action-button-secondary"
                onClick={props.onDetail}
              >
                查看批次
              </ActionButton>
            </>
          ) : canConsume ? (
            <>
              <ActionButton
                tone="secondary"
                size="compact"
                type="button"
                className="ingredient-work-card-action-button ingredient-work-card-action-button-primary"
                onClick={props.onConsume}
              >
                消费
              </ActionButton>
              <ActionButton
                tone="secondary"
                size="compact"
                type="button"
                className="ingredient-work-card-action-button ingredient-work-card-action-button-secondary"
                onClick={props.onRestock}
              >
                补货
              </ActionButton>
            </>
          ) : !tracksQuantity && summary.inventoryItems.length > 0 ? (
            <>
              <ActionButton
                tone="secondary"
                size="compact"
                type="button"
                className="ingredient-work-card-action-button ingredient-work-card-action-button-primary"
                onClick={props.onDetail}
              >
                查看
              </ActionButton>
              <ActionButton
                tone="secondary"
                size="compact"
                type="button"
                className="ingredient-work-card-action-button ingredient-work-card-action-button-secondary"
                onClick={props.onRestock}
              >
                补充
              </ActionButton>
            </>
          ) : (
            <>
              <ActionButton
                tone="secondary"
                size="compact"
                type="button"
                className="ingredient-work-card-action-button ingredient-work-card-action-button-primary"
                onClick={props.onRestock}
              >
                {summary.inventoryItems.length > 0 ? '补货' : '登记首批'}
              </ActionButton>
              <ActionButton
                tone="secondary"
                size="compact"
                type="button"
                className="ingredient-work-card-action-button ingredient-work-card-action-button-secondary"
                onClick={props.onAddShopping}
              >
                加入采购
              </ActionButton>
            </>
          )}
        </div>

        <div className="ingredient-work-card-footer">
          <span className="ingredient-work-card-footer-note">
            <span className="ingredient-work-card-footer-icon" aria-hidden="true">
              i
            </span>
            {!tracksQuantity ? '只记录有无，做菜时不按数量扣减' : canConsume ? '可消费库存已剔除过期批次' : '当前无可消费库存'}
          </span>
        </div>
      </div>

      {expanded && (
        <aside className="ingredient-work-card-side">
          <div className="ingredient-work-card-side-head">
            <span className="ingredient-work-card-side-eyebrow">当前工作详情</span>
            <ActionButton
              tone="tertiary"
              size="compact"
              type="button"
              className="ingredient-work-card-side-link"
              onClick={props.onDetail}
              aria-label={`查看 ${summary.ingredient.name} 详情`}
            >
              <span aria-hidden="true">↗</span>
            </ActionButton>
            <strong className="ingredient-work-card-side-heading">
              {summary.alerts.length > 0 ? `${summary.alerts.length} 条提醒待处理` : '库存状态平稳'}
            </strong>
          </div>
          <div className="ingredient-work-card-alerts">
            {summary.alerts.length > 0 ? (
              summary.alerts.slice(0, 2).map((alert) => (
                <span key={alert.id} className={`ingredient-work-card-alert ingredient-work-card-alert-${alert.tone}`}>
                  {alert.title}
                </span>
              ))
            ) : (
              <span className="ingredient-work-card-alert ingredient-work-card-alert-neutral">当前没有提醒</span>
            )}
          </div>
          <div className="ingredient-work-card-expand">
            <div className="ingredient-work-card-expand-grid">
              <div className="ingredient-work-card-detail">
                <span>当前库存</span>
                <strong className="ingredient-work-card-detail-value">{buildInventorySummaryLine(summary)}</strong>
                <p className="ingredient-work-card-detail-meta">
                  {summary.inventoryItems.length > 0 ? `${summary.inventoryItems.length} 条批次在用` : '还没有库存记录'}
                </p>
              </div>
              <div className="ingredient-work-card-detail">
                <span>最近补货</span>
                <strong className="ingredient-work-card-detail-value ingredient-work-card-detail-value-nowrap">
                  {summary.latestPurchaseDate ? formatDate(summary.latestPurchaseDate) : '还没补过'}
                </strong>
                <p className="ingredient-work-card-detail-meta ingredient-work-card-detail-meta-nowrap">
                  {summary.primaryStorage} · 默认 {summary.ingredient.default_unit || '个'}
                </p>
              </div>
              <div className="ingredient-work-card-detail ingredient-work-card-detail-wide">
                <span>状态备注</span>
                <strong className="ingredient-work-card-detail-value">{summary.alerts.length > 0 ? '需要留意' : '当前平稳'}</strong>
                <p className="ingredient-work-card-detail-meta ingredient-work-card-detail-meta-wide">
                  {buildCatalogExpandedNote(summary)}
                </p>
              </div>
            </div>
          </div>
        </aside>
      )}
    </article>
  );
}

export function IngredientWorkspace(props: IngredientWorkspaceProps) {
  const [persistedWorkspaceState] = useState<PersistedIngredientWorkspaceState>(readPersistedIngredientWorkspaceState);
  const [transientIngredient, setTransientIngredient] = useState<Ingredient | null>(null);
  const [editingIngredientId, setEditingIngredientId] = useState<string | null>(
    persistedWorkspaceState.editingIngredientId ?? null
  );
  const [ingredientForm, setIngredientForm] = useState<IngredientCreateFormState>(
    () => persistedWorkspaceState.ingredientForm ?? defaultIngredientForm()
  );
  const ingredientOptions =
    transientIngredient && !props.ingredients.some((item) => item.id === transientIngredient.id)
      ? [transientIngredient, ...props.ingredients]
      : props.ingredients;
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
    editingIngredientId,
    ingredientForm,
  });
  const normalizedInventorySearch = inventorySearch.trim();
  const normalizedCatalogSearch = catalogSearch.trim();
  const catalogSearchQuery = useQuery({
    queryKey: queryKeys.ingredientSearch(normalizedCatalogSearch),
    queryFn: () => api.getIngredients({ q: normalizedCatalogSearch, limit: 100 }),
    enabled: Boolean(normalizedCatalogSearch),
    placeholderData: keepPreviousData,
  });
  const inventorySearchQuery = useQuery({
    queryKey: queryKeys.inventorySearch(normalizedInventorySearch),
    queryFn: () => api.getInventory({ q: normalizedInventorySearch }),
    enabled: Boolean(normalizedInventorySearch),
    placeholderData: keepPreviousData,
  });
  const inventorySearchMatchedIngredientIds = useMemo(
    () =>
      normalizedInventorySearch
        ? Array.from(new Set((inventorySearchQuery.data ?? []).map((item) => item.ingredient_id)))
        : [],
    [normalizedInventorySearch, inventorySearchQuery.data]
  );
  const catalogSearchMatchedIngredientIds = useMemo(
    () => (normalizedCatalogSearch ? Array.from(new Set((catalogSearchQuery.data ?? []).map((item) => item.id))) : []),
    [normalizedCatalogSearch, catalogSearchQuery.data]
  );
  const searchAwareIngredients = normalizedCatalogSearch && catalogSearchQuery.data ? catalogSearchQuery.data : props.ingredients;
  const searchAwareInventoryItems =
    normalizedInventorySearch && inventorySearchQuery.data ? inventorySearchQuery.data : props.inventoryItems;

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
    recipes: props.recipes,
    shoppingItems: props.shoppingItems,
    ingredientOptions,
    selectedIngredientId,
    catalogSearch,
    catalogSearchMatchedIngredientIds,
    catalogCategoryFilter,
    catalogStatusFilter,
    inventoryQuickFilter,
    inventorySearch,
    inventorySearchMatchedIngredientIds,
    inventoryStorageFocus,
    inventorySortMode,
    shoppingSearch,
    shoppingFocus,
    mobileIngredientFilter,
    mobileStorageFocus,
    filterIngredientSummariesByCatalogStatus,
    isPendingShopping,
  });
  const mobileCatalogResetKey = [catalogSearch, mobileIngredientFilter, mobileStorageFocus].join('|');
  const maxCatalogItems = Math.max(STORAGE_SHELF_MAX_DISPLAY_COLUMNS, filteredSummaries.length);

  const editorState = useIngredientEditorState({
    editingIngredientId,
    setEditingIngredientId,
    ingredientForm,
    setIngredientForm,
    ingredientOptions,
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
    showNotice,
    resolveErrorMessage,
  });

  const {
    overlayMode,
    setOverlayMode,
    inventoryForm,
    setInventoryForm,
    consumeForm,
    setConsumeForm,
    shoppingForm,
    setShoppingForm,
    pendingShoppingToComplete,
    destroyExpiredIngredientId,
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
    summaries,
    onRequireCreate: () => {
      setActivePanel('catalog');
      editorState.openCreateView();
    },
  });
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

  const { submitInventory, submitShopping, submitConsume, submitDestroyExpired } = useIngredientActionState({
    ingredientOptions,
    summaries,
    inventoryForm,
    setInventoryForm,
    setInventoryAdvancedOpen,
    consumeForm,
    shoppingForm,
    setShoppingForm,
    pendingShoppingToComplete,
    destroyExpiredIngredientId,
    selectedInventoryIngredient,
    setSelectedIngredientId,
    closeOverlay,
    createInventory: props.createInventory,
    consumeInventory: props.consumeInventory,
    disposeExpiredInventory: props.disposeExpiredInventory,
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
        <ActionButton tone="primary" type="button" onClick={() => openInventoryOverlay()}>
          快速入库
        </ActionButton>
      )}
      {activePanel === 'shopping' && (
        <ActionButton tone="primary" type="button" onClick={() => openShoppingOverlay()}>
          新增采购
        </ActionButton>
      )}
    </div>
  );
  const activePanelBackLabel =
    activePanel === 'inventory' ? '返回库存' : activePanel === 'shopping' ? '返回采购' : '返回档案';
  const catalogGridStyle = {
    '--ingredients-catalog-columns': String(catalogColumns),
    '--ingredients-catalog-card-width': `${catalogCardWidth}px`,
  } as CSSProperties;
  const noticeToast = notice ? (
    <div className={`recipe-notice-toast tone-${notice.tone}`} role={notice.tone === 'danger' ? 'alert' : 'status'} aria-live="polite">
      <span className="recipe-notice-icon">
        <IngredientWorkspaceIcon name={notice.tone === 'success' ? 'check' : 'alert'} />
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
    destroyExpiredIngredientId,
    ingredients: ingredientOptions,
    ingredientSummaries: summaries,
    quickRestockIngredients,
    submitInventory,
    submitConsume,
    submitShopping,
    submitDestroyExpired,
    pendingShoppingToComplete,
    isCreatingInventory: props.isCreatingInventory,
    isConsumingInventory: props.isConsumingInventory,
    isDisposingExpiredInventory: props.isDisposingExpiredInventory,
    isCreatingShopping: props.isCreatingShopping,
  } as const;

  if (workspaceView === 'detail' && selectedIngredient) {
    const detailQuantityLabel = selectedIngredient.quantitySummaries[0]?.label ?? '暂无库存';
    const detailMetricItems = [
      {
        icon: 'stocked' as const,
        label: '当前库存',
        value: detailQuantityLabel,
        tone: 'green',
      },
      {
        icon: 'link' as const,
        label: '关联菜谱',
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

    return (
      <IngredientDetailPage
        noticeToast={noticeToast}
        overlays={overlayLayerProps}
        activePanelBackLabel={activePanelBackLabel}
        selectedIngredient={selectedIngredient}
        detailStorageLabel={detailStorageLabel}
        detailMetricItems={detailMetricItems}
        recipes={props.recipes}
        onOpenCreateView={openCreateView}
        goBackToWorkspace={goBackToWorkspace}
        openInventoryOverlay={openInventoryOverlay}
        openConsumeOverlay={openConsumeOverlay}
        openShoppingOverlay={openShoppingOverlay}
        openEditView={openEditView}
        renderIcon={(name) => <IngredientWorkspaceIcon name={name as IngredientWorkspaceIconName} />}
        formatExpiryRuleLabel={formatExpiryRuleLabel}
        formatLowStockRuleLabel={formatLowStockRuleLabel}
      />
    );
  }

  return (
    <>
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
        allAlertsCount={allAlerts.length}
        stockedIngredientCount={stockedIngredientCount}
        pendingShoppingCount={pendingShopping.length}
        summariesCount={summaries.length}
        catalogSearch={catalogSearch}
        setCatalogSearch={setCatalogSearch}
        mobileIngredientFilter={mobileIngredientFilter}
        setMobileIngredientFilter={setMobileIngredientFilter}
        mobileStorageFocus={mobileStorageFocus}
        setMobileStorageFocus={setMobileStorageFocus}
        mobilePrioritySummaries={mobilePrioritySummaries}
        mobileStorageCards={mobileStorageCards}
        mobileCatalogSummaries={mobileCatalogSummaries}
        mobileCatalogResetKey={mobileCatalogResetKey}
        mobileShoppingCards={mobileShoppingCards}
        mobileShoppingGroups={mobileShoppingGroups}
        mobileHasCatalogFilters={mobileHasCatalogFilters}
        notificationCenter={props.notificationCenter}
        openDetailView={openDetailView}
        openInventoryOverlay={openInventoryOverlay}
        openConsumeOverlay={openConsumeOverlay}
        openShoppingOverlay={openShoppingOverlay}
        openDestroyExpiredOverlay={openDestroyExpiredOverlay}
        openCreateView={openCreateView}
        openInventoryFromShopping={openInventoryFromShopping}
        buildPriorityStatus={buildInventoryCardStatus}
        buildCatalogStatus={buildCatalogCardStatus}
        buildInventorySummaryLine={buildInventorySummaryLine}
        buildShoppingReason={resolveShoppingReason}
        countDisposableExpiredItems={(summary) => buildDisposableExpiredInventoryItems(summary).length}
        renderStorageIllustration={InventoryStorageIllustration}
        renderIcon={(name) => <IngredientWorkspaceIcon name={name as IngredientWorkspaceIconName} />}
        isUpdatingShopping={props.isUpdatingShopping}
        isCreatingInventory={props.isCreatingInventory}
        catalogCountLabel={catalogCountLabel}
        catalogCategoryFilter={catalogCategoryFilter}
        catalogStatusFilter={catalogStatusFilter}
        catalogCategories={catalogCategories}
        catalogStatusItems={CATALOG_STATUS_FILTERS}
        catalogStatusCounts={catalogStatusCounts}
        filteredSummaries={filteredSummaries}
        expandedCatalogIngredientId={expandedCatalogIngredientId}
        catalogGridStyle={catalogGridStyle}
        setCatalogCategoryFilter={setCatalogCategoryFilter}
        setCatalogStatusFilter={setCatalogStatusFilter}
        openInventoryPanel={openInventoryPanel}
        toggleCatalogCard={toggleCatalogCard}
        catalogMeasureRef={catalogMeasureRef}
        ScrollableChipRail={ScrollableChipRail}
        IngredientCatalogCard={IngredientCatalogCard}
        inventorySearch={inventorySearch}
        setInventorySearch={setInventorySearch}
        inventoryQuickFilter={inventoryQuickFilter}
        setInventoryQuickFilter={setInventoryQuickFilter}
        inventoryStorageFocus={inventoryStorageFocus}
        setInventoryStorageFocus={setInventoryStorageFocus}
        inventorySortMode={inventorySortMode}
        setInventorySortMode={setInventorySortMode}
        focusedInventorySummaries={focusedInventorySummaries}
        inventoryStorageOverview={inventoryStorageOverview}
        inventoryGroups={inventoryGroups}
        InventoryStorageOverviewCard={InventoryStorageOverviewCard}
        InventoryIngredientCard={InventoryIngredientCard}
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
        ShoppingWorkRow={ShoppingWorkRow}
        ShoppingHistoryRow={ShoppingHistoryRow}
      />

      {workspaceView === 'create' && (
        <div className="workspace-overlay-root ingredient-workspace-overlay-root">
          <div className="workspace-overlay-backdrop" onClick={goBackFromIngredientForm} />
          <WorkspaceModal
            title={isEditingIngredient ? '编辑食材' : '新增食材'}
            description={isEditingIngredient ? '调整名称、分类、图片和备注后，可以直接保存这张资料卡。' : '填写基础信息、图片和备注后，就能继续登记第一批库存。'}
            eyebrow="食材资料"
            className="ingredient-editor-modal"
            closeLabel="关闭"
            onClose={goBackFromIngredientForm}
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
              onUploadImage={(files) => void ingredientImageComposer.upload(files)}
              onGenerateImage={(mode) => void ingredientImageComposer.generate(mode)}
              onResetImage={ingredientImageComposer.reset}
              onSubmit={handleCreateSubmit}
              onSaveWithoutRestock={() => void submitIngredient(false)}
              onBack={goBackFromIngredientForm}
              isCreatingIngredient={props.isCreatingIngredient}
              isUpdatingIngredient={props.isUpdatingIngredient}
              renderIcon={(name) => <IngredientWorkspaceIcon name={name as IngredientWorkspaceIconName} />}
              renderStorageIcon={(storage) => <InventoryStorageIcon storage={storage} />}
              ScrollableChipRail={ScrollableChipRail}
            />
          </WorkspaceModal>
        </div>
      )}
    </>
  );
}
