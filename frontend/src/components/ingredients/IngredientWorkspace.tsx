import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type {
  ConsumeInventoryResponse,
  DisposeExpiredInventoryResponse,
  ImageInputValue,
  Ingredient,
  IngredientExpiryMode,
  IngredientUnitConversion,
  InventoryItem,
  InventoryStatus,
  Recipe,
  ShoppingListItem,
} from '../../api/types';
import { resolveAssetUrl } from '../../lib/assets';
import { addDateKeyDays } from '../../lib/date';
import { readJsonStorage, writeJsonStorage } from '../../lib/storage';
import {
  buildIngredientPlaceholderSvg,
  emptyImages,
  formatDate,
  formatDateTime,
  formatRelativeDays,
  getImagePreview,
  INVENTORY_STATUS_LABELS,
  todayKey,
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
  Avatar,
  Badge,
  CompactMetric,
  EmptyState,
  ImageComposer,
  PageHeader,
  SegmentedTabs,
  SectionHeading,
  TouchRangeField,
  TouchStepperField,
  WorkspaceModal,
  WorkspaceSubnav,
  WorkspaceSubpageShell,
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
  type IngredientOverlayMode,
  type IngredientSummaryViewModel,
  type IngredientWorkspacePanel,
  type IngredientWorkspaceView,
  type InventoryStorageOverviewViewModel,
  type ShoppingCardFocus,
  type ShoppingCardViewModel,
} from './workspaceModel';
import {
  buildConsumeQuickValues,
  clampConsumeQuantity,
  getConsumeRemainingQuantity,
  isConsumeAllSelected,
  resolveConsumeStep,
  resolveInitialConsumeQuantity,
} from './consumeQuickHelpers';

type IngredientCreateFormState = {
  name: string;
  category: string;
  defaultUnit: string;
  unitConversions: IngredientUnitConversionDraft[];
  defaultStorage: string;
  defaultExpiryMode: IngredientExpiryMode;
  defaultExpiryDays: string;
  defaultLowStockThreshold: string;
  notes: string;
  images: ImageInputValue;
};

type InventoryDrawerFormState = {
  ingredientId: string;
  ingredientQuery: string;
  ingredientLocked: boolean;
  quantity: string;
  unit: string;
  status: InventoryStatus;
  statusDirty: boolean;
  purchaseDate: string;
  purchaseDatePreset: InventoryPurchasePreset;
  expiryInputMode: IngredientExpiryMode;
  expiryDays: string;
  expiryDate: string;
  storageLocation: string;
  notes: string;
};

type ShoppingDialogFormState = {
  title: string;
  quantity: string;
  unit: string;
  reason: string;
};

type ConsumeDialogFormState = {
  ingredientId: string;
  unit: string;
  quantity: string;
};

type PendingShoppingCompletion = {
  itemId: string;
  title: string;
};

type ConsumeUnitOption = {
  unit: string;
  available: number;
  ratioToDefault: number;
};

type IngredientUnitConversionDraft = {
  id: string;
  unit: string;
  ratioToDefault: string;
};

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
  navigationRequest?: {
    view: 'catalog' | 'detail';
    ingredientId?: string;
    requestId: number;
  } | null;
  createIngredient: (payload: {
    name: string;
    category: string;
    default_unit: string;
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
    quantity: number;
    unit: string;
    status: InventoryStatus;
    purchase_date: string;
    expiry_date?: string;
    storage_location: string;
    notes: string;
    low_stock_threshold?: number;
  }) => Promise<InventoryItem>;
  consumeInventory: (payload: {
    ingredient_id: string;
    quantity: number;
    unit: string;
  }) => Promise<ConsumeInventoryResponse>;
  disposeExpiredInventory: (payload: {
    ingredient_id: string;
    inventory_item_ids: string[];
  }) => Promise<DisposeExpiredInventoryResponse>;
  createShoppingItem: (payload: {
    title: string;
    quantity: number;
    unit: string;
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

function defaultIngredientForm(): IngredientCreateFormState {
  return {
    name: '',
    category: '',
    defaultUnit: '个',
    unitConversions: [],
    defaultStorage: '冷藏',
    defaultExpiryMode: 'none',
    defaultExpiryDays: '',
    defaultLowStockThreshold: '',
    notes: '',
    images: emptyImages(),
  };
}

function buildIngredientForm(ingredient?: Ingredient | null): IngredientCreateFormState {
  if (!ingredient) {
    return defaultIngredientForm();
  }
  const defaultExpiryMode =
    ingredient.default_expiry_mode === 'days' ||
    ingredient.default_expiry_mode === 'manual_date' ||
    ingredient.default_expiry_mode === 'none'
      ? ingredient.default_expiry_mode
      : 'none';
  return {
    name: ingredient.name,
    category: ingredient.category,
    defaultUnit: ingredient.default_unit,
    unitConversions: buildIngredientUnitConversionDrafts(ingredient.unit_conversions),
    defaultStorage: ingredient.default_storage,
    defaultExpiryMode,
    defaultExpiryDays:
      ingredient.default_expiry_days === null || ingredient.default_expiry_days === undefined
        ? ''
        : String(clampNumber(ingredient.default_expiry_days, 1, 30)),
    defaultLowStockThreshold:
      ingredient.default_low_stock_threshold === null || ingredient.default_low_stock_threshold === undefined
        ? ''
        : String(ingredient.default_low_stock_threshold),
    notes: ingredient.notes,
    images: ingredient.image ? { generatedAsset: ingredient.image } : emptyImages(),
  };
}

function buildInventoryForm(
  ingredients: Ingredient[],
  ingredientId?: string,
  overrides: Partial<InventoryDrawerFormState> = {}
): InventoryDrawerFormState {
  const selectedIngredient =
    ingredientId ? ingredients.find((item) => item.id === ingredientId) : undefined;
  const purchaseDate = overrides.purchaseDate ?? todayKey();
  const storageLocation = selectedIngredient?.default_storage ?? '冷藏';
  const expiryInputMode = overrides.expiryInputMode ?? selectedIngredient?.default_expiry_mode ?? 'none';
  const expiryDays =
    overrides.expiryDays ??
    (expiryInputMode === 'days' && selectedIngredient?.default_expiry_days !== null && selectedIngredient?.default_expiry_days !== undefined
      ? String(clampNumber(selectedIngredient.default_expiry_days, 1, 30))
      : '');
  const expiryDate =
    overrides.expiryDate ??
    (expiryInputMode === 'days' ? resolveExpiryDateFromDays(purchaseDate, expiryDays) : '');

  return {
    ingredientId: selectedIngredient?.id ?? '',
    ingredientQuery: selectedIngredient?.name ?? '',
    ingredientLocked: false,
    quantity: '1',
    unit: resolvePreferredIngredientUnit(selectedIngredient, overrides.unit) || selectedIngredient?.default_unit || '个',
    status: resolveInventoryStatusForStorage(storageLocation),
    statusDirty: false,
    purchaseDate,
    purchaseDatePreset: resolveInventoryPurchasePreset(purchaseDate),
    expiryInputMode,
    expiryDays,
    expiryDate,
    storageLocation,
    notes: '',
    ...overrides,
  };
}

function buildShoppingForm(ingredient?: Ingredient, reason = ''): ShoppingDialogFormState {
  return {
    title: ingredient?.name ?? '',
    quantity: '1',
    unit: resolvePreferredIngredientUnit(ingredient, ingredient?.default_unit) || '个',
    reason,
  };
}

function defaultConsumeForm(): ConsumeDialogFormState {
  return {
    ingredientId: '',
    unit: '',
    quantity: '',
  };
}

function resolveErrorMessage(reason: unknown, fallback: string) {
  return reason instanceof Error && reason.message.trim() ? reason.message : fallback;
}

function isPendingShopping(item: ShoppingListItem) {
  return !item.done;
}

type IngredientAlertTone = 'warning' | 'danger';
type CatalogStatusFilter = 'all' | 'expired' | 'expiring' | 'lowStock' | 'stable';
type MobileIngredientFilter = 'all' | 'alerted' | 'empty' | 'stocked';
type InventoryQuickFilter = 'all' | 'alerted';
type InventoryStorageFocus = 'all' | '冷藏' | '冷冻' | '常温';
type InventoryPurchasePreset = 'today' | 'yesterday' | 'custom';
type InventorySortMode = 'default' | 'expiry';
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
const STORAGE_SHELF_MIN_WIDTH = 226;
const STORAGE_SHELF_IDEAL_WIDTH = 260;
const STORAGE_SHELF_MAX_WIDTH = 318;
const STORAGE_SHELF_GAP = 18;
const STORAGE_SHELF_MAX_DISPLAY_COLUMNS = 4;
const INGREDIENT_WORKSPACE_STATE_KEY = 'culina-ingredient-workspace-state-v1';
const INVENTORY_STORAGE_PRESETS = ['冷藏', '冷冻', '常温'] as const;
const COMMON_UNIT_PRESETS = ['个', '份', '盒', '袋', '瓶', '包', '块', '罐', '根', '条', '颗', '枚', '把', 'ml', 'g', 'kg'] as const;
const INTEGER_STEP_UNITS = new Set(['个', '份', '盒', '袋', '瓶', '包', '块', '罐', '根', '条', '颗', '枚', '把']);
const EXPIRY_DAY_MARKS = [1, 3, 7, 14, 30];
const CATALOG_STATUS_FILTERS: Array<{ value: CatalogStatusFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'expired', label: '已过期' },
  { value: 'expiring', label: '临期' },
  { value: 'lowStock', label: '库存不足' },
  { value: 'stable', label: '正常' },
];
let ingredientUnitConversionDraftCounter = 0;

function createIngredientUnitConversionDraft(
  entry?: Partial<Pick<IngredientUnitConversion, 'unit' | 'ratio_to_default'>>
): IngredientUnitConversionDraft {
  ingredientUnitConversionDraftCounter += 1;
  return {
    id: `ingredient-unit-conversion-${ingredientUnitConversionDraftCounter}`,
    unit: entry?.unit ?? '',
    ratioToDefault:
      entry?.ratio_to_default === null || entry?.ratio_to_default === undefined ? '' : String(entry.ratio_to_default),
  };
}

function buildIngredientUnitConversionDrafts(entries: IngredientUnitConversion[] = []) {
  return entries.map((entry) => createIngredientUnitConversionDraft(entry));
}

function resolveInventoryStatusForStorage(storageLocation: string): InventoryStatus {
  return storageLocation.trim() === '冷冻' ? 'frozen' : 'fresh';
}

function resolveExpiryDateFromDays(purchaseDate: string, expiryDays: string) {
  const safeDays = Number(expiryDays);
  if (!purchaseDate || !Number.isFinite(safeDays) || safeDays <= 0) {
    return '';
  }
  return addDateKeyDays(purchaseDate, safeDays);
}

function parseOptionalNumber(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const numeric = Number(trimmed);
  return Number.isFinite(numeric) ? numeric : null;
}

function parsePositiveNumber(value: string) {
  const numeric = parseOptionalNumber(value);
  return numeric !== null && numeric > 0 ? numeric : null;
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function formatNumericString(value: number) {
  return String(Number(value.toFixed(2)));
}

function buildUnitPresetOptions(preferred?: string) {
  const normalizedPreferred = normalizeIngredientUnit(preferred);
  return [
    ...new Set(
      [normalizedPreferred, ...COMMON_UNIT_PRESETS]
        .map((item) => item?.trim() ?? '')
        .filter(Boolean)
    ),
  ];
}

function isCustomChoiceValue(value: string, presets: readonly string[]) {
  const normalized = value.trim();
  return !normalized || !presets.includes(normalized);
}

function resolveTouchStep(unit: string) {
  return INTEGER_STEP_UNITS.has(unit.trim()) ? 1 : 0.5;
}

function resolveTouchQuickValues(unit: string, mode: 'quantity' | 'threshold') {
  const usesIntegerStep = INTEGER_STEP_UNITS.has(unit.trim());
  if (mode === 'quantity') {
    return usesIntegerStep ? [1, 2, 3, 5, 8] : [0.5, 1, 1.5, 2, 3];
  }
  return usesIntegerStep ? [1, 2, 3, 5] : [0.5, 1, 1.5, 2];
}

function resolveTouchDefaultValue(unit: string, mode: 'quantity' | 'threshold') {
  return resolveTouchQuickValues(unit, mode)[0] ?? resolveTouchStep(unit);
}

function buildConsumeUnitOptions(
  ingredient: Pick<Ingredient, 'default_unit' | 'unit_conversions'> | null | undefined,
  inventoryItems: InventoryItem[],
  preferredUnit?: string
): ConsumeUnitOption[] {
  const totalAvailableInDefault = getIngredientAvailableQuantityInDefault(ingredient, inventoryItems);
  const options = getIngredientUnitOptions(ingredient).map((entry) => ({
    unit: entry.unit,
    ratioToDefault: entry.ratio_to_default,
    available:
      convertQuantityFromDefaultUnit(ingredient, totalAvailableInDefault, entry.unit) ?? totalAvailableInDefault,
  }));

  return options
    .filter((entry) => entry.available > 0)
    .sort((left, right) => {
      if (preferredUnit && left.unit === preferredUnit && right.unit !== preferredUnit) {
        return -1;
      }
      if (preferredUnit && right.unit === preferredUnit && left.unit !== preferredUnit) {
        return 1;
      }
      return left.ratioToDefault - right.ratioToDefault || left.unit.localeCompare(right.unit, 'zh-CN');
    });
}

function resolveClampedDaysValue(value: string, fallback = 3) {
  const parsed = parsePositiveNumber(value);
  return clampNumber(parsed ?? fallback, 1, 30);
}

function resolveInventoryPurchasePreset(purchaseDate: string): InventoryPurchasePreset {
  if (purchaseDate === todayKey()) {
    return 'today';
  }
  if (purchaseDate === addDateKeyDays(todayKey(), -1)) {
    return 'yesterday';
  }
  return 'custom';
}

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

function sanitizeIngredientUnitConversions(
  defaultUnit: string,
  unitConversions: IngredientUnitConversionDraft[]
): IngredientUnitConversion[] {
  const normalizedDefaultUnit = normalizeIngredientUnit(defaultUnit);
  const seenUnits = new Set(normalizedDefaultUnit ? [normalizedDefaultUnit] : []);
  const normalizedEntries: IngredientUnitConversion[] = [];

  for (const entry of unitConversions) {
    const unit = normalizeIngredientUnit(entry.unit);
    const ratio = parsePositiveNumber(entry.ratioToDefault);
    const isEmptyEntry = !unit && !entry.ratioToDefault.trim();
    if (isEmptyEntry) {
      continue;
    }
    if (!unit) {
      throw new Error('请先填写副单位名称。');
    }
    if (ratio === null) {
      throw new Error(`请确认 ${unit} 对主单位的换算值。`);
    }
    if (seenUnits.has(unit)) {
      throw new Error(`单位 ${unit} 已重复，副单位不能与主单位或其他单位重复。`);
    }
    seenUnits.add(unit);
    normalizedEntries.push({
      unit,
      ratio_to_default: ratio,
    });
  }

  return normalizedEntries;
}

type PersistedIngredientWorkspaceState = {
  workspaceView?: IngredientWorkspaceView;
  activePanel?: IngredientWorkspacePanel;
  editingIngredientId?: string | null;
  selectedIngredientId?: string | null;
  catalogSearch?: string;
  catalogCategoryFilter?: 'all' | string;
  inventorySearch?: string;
  ingredientForm?: IngredientCreateFormState;
};

function isWorkspaceView(value: unknown): value is IngredientWorkspaceView {
  return value === 'hub' || value === 'catalog' || value === 'detail' || value === 'create';
}

function isWorkspacePanel(value: unknown): value is IngredientWorkspacePanel {
  return value === 'catalog' || value === 'inventory' || value === 'shopping';
}

function isMediaAssetLike(
  value: unknown
): value is NonNullable<ImageInputValue['referenceAsset']> | NonNullable<ImageInputValue['generatedAsset']> {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'id' in value &&
      typeof (value as { id?: unknown }).id === 'string' &&
      'url' in value &&
      typeof (value as { url?: unknown }).url === 'string'
  );
}

function restoreIngredientForm(raw: unknown): IngredientCreateFormState {
  const fallback = defaultIngredientForm();
  if (!raw || typeof raw !== 'object') {
    return fallback;
  }
  const candidate = raw as Partial<IngredientCreateFormState>;
  const candidateImages =
    candidate.images && typeof candidate.images === 'object'
      ? {
          referenceAsset: isMediaAssetLike(candidate.images.referenceAsset) ? candidate.images.referenceAsset : undefined,
          generatedAsset: isMediaAssetLike(candidate.images.generatedAsset) ? candidate.images.generatedAsset : undefined,
        }
      : fallback.images;
  const candidateUnitConversions = Array.isArray(candidate.unitConversions)
    ? candidate.unitConversions.flatMap((entry) => {
        if (!entry || typeof entry !== 'object') {
          return [];
        }
        const unit = typeof entry.unit === 'string' ? entry.unit : '';
        const ratioToDefault =
          typeof entry.ratioToDefault === 'string'
            ? entry.ratioToDefault
            : typeof entry.ratioToDefault === 'number'
              ? String(entry.ratioToDefault)
              : '';
        return [createIngredientUnitConversionDraft({ unit, ratio_to_default: parseOptionalNumber(ratioToDefault) ?? undefined })];
      })
    : fallback.unitConversions;

  return {
    name: typeof candidate.name === 'string' ? candidate.name : fallback.name,
    category: typeof candidate.category === 'string' ? candidate.category : fallback.category,
    defaultUnit: typeof candidate.defaultUnit === 'string' ? candidate.defaultUnit : fallback.defaultUnit,
    unitConversions: candidateUnitConversions,
    defaultStorage: typeof candidate.defaultStorage === 'string' ? candidate.defaultStorage : fallback.defaultStorage,
    defaultExpiryMode:
      candidate.defaultExpiryMode === 'days' ||
      candidate.defaultExpiryMode === 'manual_date' ||
      candidate.defaultExpiryMode === 'none'
        ? candidate.defaultExpiryMode
        : fallback.defaultExpiryMode,
    defaultExpiryDays:
      typeof candidate.defaultExpiryDays === 'string' ? candidate.defaultExpiryDays : fallback.defaultExpiryDays,
    defaultLowStockThreshold:
      typeof candidate.defaultLowStockThreshold === 'string'
        ? candidate.defaultLowStockThreshold
        : fallback.defaultLowStockThreshold,
    notes: typeof candidate.notes === 'string' ? candidate.notes : fallback.notes,
    images: candidateImages,
  };
}

function readPersistedWorkspaceState(): PersistedIngredientWorkspaceState {
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
    ingredientForm: parsed.ingredientForm ? restoreIngredientForm(parsed.ingredientForm) : undefined,
  };
}

function getStorageShelfCardWidth(availableWidth: number, columns: number) {
  if (availableWidth <= 0 || columns <= 0) {
    return STORAGE_SHELF_IDEAL_WIDTH;
  }

  return (availableWidth - STORAGE_SHELF_GAP * (columns - 1)) / columns;
}

function resolveStorageShelfLayout(availableWidth: number, maxGroupItems: number) {
  const safeMaxGroupItems = Math.max(1, maxGroupItems);
  const maxDisplayColumns = Math.min(safeMaxGroupItems, STORAGE_SHELF_MAX_DISPLAY_COLUMNS);
  if (availableWidth <= 0) {
    return {
      columns: 1,
      cardWidth: STORAGE_SHELF_IDEAL_WIDTH,
    };
  }

  const minColumns = Math.max(
    1,
    Math.ceil((availableWidth + STORAGE_SHELF_GAP) / (STORAGE_SHELF_MAX_WIDTH + STORAGE_SHELF_GAP))
  );
  const maxColumns = Math.max(
    1,
    Math.floor((availableWidth + STORAGE_SHELF_GAP) / (STORAGE_SHELF_MIN_WIDTH + STORAGE_SHELF_GAP))
  );
  const lowerBound = Math.min(maxDisplayColumns, minColumns);
  const upperBound = Math.min(
    maxDisplayColumns,
    Math.max(lowerBound, maxColumns)
  );
  const candidates =
    lowerBound <= upperBound
      ? Array.from({ length: upperBound - lowerBound + 1 }, (_, index) => lowerBound + index)
      : Array.from({ length: maxDisplayColumns }, (_, index) => index + 1);

  let bestColumns = candidates[0] ?? 1;
  let bestCardWidth = getStorageShelfCardWidth(availableWidth, bestColumns);

  for (const candidate of candidates) {
    const nextCardWidth = getStorageShelfCardWidth(availableWidth, candidate);
    const nextDeviation = Math.abs(nextCardWidth - STORAGE_SHELF_IDEAL_WIDTH);
    const bestDeviation = Math.abs(bestCardWidth - STORAGE_SHELF_IDEAL_WIDTH);

    if (
      nextDeviation < bestDeviation - 0.01 ||
      (Math.abs(nextDeviation - bestDeviation) < 0.01 && candidate > bestColumns)
    ) {
      bestColumns = candidate;
      bestCardWidth = nextCardWidth;
    }
  }

  return {
    columns: bestColumns,
    cardWidth: Number(bestCardWidth.toFixed(2)),
  };
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
    return '/assets/asset_storage_freezer_frozen.png';
  }
  if (storage === '常温') {
    return '/assets/asset_storage_pantry_roomtemp.png';
  }
  return '/assets/asset_storage_fridge_chilled.png';
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
  const imageUrl =
    resolveAssetUrl(linkedSummary?.ingredient.image?.url) ?? buildIngredientPlaceholderSvg(card.title || '待买项');
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
            <img src={imageUrl} alt={card.title} />
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
  const imageUrl =
    resolveAssetUrl(summary.ingredient.image?.url) ?? buildIngredientPlaceholderSvg(summary.ingredient.name);
  const hasCustomImage = Boolean(summary.ingredient.image?.url);
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
              <img
                className={
                  hasCustomImage
                    ? 'ingredient-visual-cover'
                    : 'ingredient-visual-cover ingredient-visual-cover-placeholder'
                }
                src={imageUrl}
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
          ) : summary.quantitySummaries.length > 0 ? (
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
  const imageUrl =
    resolveAssetUrl(summary.ingredient.image?.url) ?? buildIngredientPlaceholderSvg(summary.ingredient.name);
  const alertTone = getIngredientAlertTone(summary);
  const status = buildCatalogCardStatus(summary);
  const canConsume = summary.availableInventoryItems.length > 0;
  const hasDangerAlert = summary.alerts.some((item) => item.tone === 'danger');
  const hasWarningAlert = summary.alerts.some((item) => item.tone === 'warning');
  const shouldPrioritizeShopping = !hasDangerAlert && (!canConsume || hasWarningAlert);
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
              <img
                className={
                  hasCustomImage
                    ? 'ingredient-visual-cover'
                    : 'ingredient-visual-cover ingredient-visual-cover-placeholder'
                }
                src={imageUrl}
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
          {hasDangerAlert ? (
            <ActionButton
              tone="secondary"
              size="compact"
              type="button"
              className="ingredient-work-card-action-button ingredient-work-card-action-button-primary"
              onClick={props.onHandleAlert}
            >
              处理提醒
            </ActionButton>
          ) : shouldPrioritizeShopping ? (
            <ActionButton
              tone="secondary"
              size="compact"
              type="button"
              className="ingredient-work-card-action-button ingredient-work-card-action-button-primary"
              onClick={props.onAddShopping}
            >
              加入采购
            </ActionButton>
          ) : (
            <ActionButton
              tone="secondary"
              size="compact"
              type="button"
              className="ingredient-work-card-action-button ingredient-work-card-action-button-primary"
              onClick={props.onConsume}
            >
              消费
            </ActionButton>
          )}
          <ActionButton
            tone="secondary"
            size="compact"
            type="button"
            className="ingredient-work-card-action-button ingredient-work-card-action-button-secondary"
            onClick={props.onRestock}
          >
            补货
          </ActionButton>
        </div>

        <div className="ingredient-work-card-footer">
          <span className="ingredient-work-card-footer-note">
            <span className="ingredient-work-card-footer-icon" aria-hidden="true">
              i
            </span>
            {canConsume ? '可消费库存已剔除过期批次' : '当前无可消费库存'}
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
  const [persistedWorkspaceState] = useState<PersistedIngredientWorkspaceState>(readPersistedWorkspaceState);
  const [transientIngredient, setTransientIngredient] = useState<Ingredient | null>(null);
  const [workspaceView, setWorkspaceView] = useState<IngredientWorkspaceView>(
    persistedWorkspaceState.workspaceView ?? 'hub'
  );
  const [activePanel, setActivePanel] = useState<IngredientWorkspacePanel>(
    persistedWorkspaceState.activePanel ?? 'catalog'
  );
  const [overlayMode, setOverlayMode] = useState<IngredientOverlayMode>(null);
  const [editingIngredientId, setEditingIngredientId] = useState<string | null>(
    persistedWorkspaceState.editingIngredientId ?? null
  );
  const [selectedIngredientId, setSelectedIngredientId] = useState<string | null>(
    persistedWorkspaceState.selectedIngredientId ?? props.ingredients[0]?.id ?? null
  );
  const [expandedCatalogIngredientId, setExpandedCatalogIngredientId] = useState<string | null>(null);
  const [catalogSearch, setCatalogSearch] = useState(persistedWorkspaceState.catalogSearch ?? '');
  const [catalogCategoryFilter, setCatalogCategoryFilter] = useState<'all' | string>(
    persistedWorkspaceState.catalogCategoryFilter ?? 'all'
  );
  const [catalogStatusFilter, setCatalogStatusFilter] = useState<CatalogStatusFilter>('all');
  const [inventorySearch, setInventorySearch] = useState(persistedWorkspaceState.inventorySearch ?? '');
  const [inventoryQuickFilter, setInventoryQuickFilter] = useState<InventoryQuickFilter>('all');
  const [inventoryStorageFocus, setInventoryStorageFocus] = useState<InventoryStorageFocus>('冷藏');
  const [inventorySortMode, setInventorySortMode] = useState<InventorySortMode>('default');
  const [shoppingSearch, setShoppingSearch] = useState('');
  const [shoppingFocus, setShoppingFocus] = useState<ShoppingCardFocus>('all');
  const [mobileIngredientFilter, setMobileIngredientFilter] = useState<MobileIngredientFilter>('all');
  const [mobileStorageFocus, setMobileStorageFocus] = useState<InventoryStorageFocus>('all');
  const [ingredientForm, setIngredientForm] = useState<IngredientCreateFormState>(
    () => persistedWorkspaceState.ingredientForm ?? defaultIngredientForm()
  );
  const [catalogColumns, setCatalogColumns] = useState(1);
  const [catalogCardWidth, setCatalogCardWidth] = useState(STORAGE_SHELF_IDEAL_WIDTH);
  const catalogMeasureRef = useRef<HTMLDivElement | null>(null);
  const ingredientOptions =
    transientIngredient && !props.ingredients.some((item) => item.id === transientIngredient.id)
      ? [transientIngredient, ...props.ingredients]
      : props.ingredients;
  const [inventoryForm, setInventoryForm] = useState<InventoryDrawerFormState>(
    buildInventoryForm(ingredientOptions)
  );
  const [consumeForm, setConsumeForm] = useState<ConsumeDialogFormState>(defaultConsumeForm());
  const [shoppingForm, setShoppingForm] = useState<ShoppingDialogFormState>(buildShoppingForm());
  const [pendingShoppingToComplete, setPendingShoppingToComplete] = useState<PendingShoppingCompletion | null>(null);
  const [destroyExpiredIngredientId, setDestroyExpiredIngredientId] = useState<string | null>(null);
  const { notice, showNotice, clearNotice } = useNotice();
  const [inventoryAdvancedOpen, setInventoryAdvancedOpen] = useState(false);
  const [ingredientUnitAdvancedOpen, setIngredientUnitAdvancedOpen] = useState(false);
  const [ingredientCustomCategoryOpen, setIngredientCustomCategoryOpen] = useState(false);
  const [showCompletedShopping, setShowCompletedShopping] = useState(false);
  const selectedInventoryIngredient =
    ingredientOptions.find((item) => item.id === inventoryForm.ingredientId) ?? null;

  const summaries = buildIngredientSummaries({
    ingredients: props.ingredients,
    inventoryItems: props.inventoryItems,
    recipes: props.recipes,
  });
  const catalogCategories = buildIngredientCategoryFilters(props.ingredients);
  const catalogBaseSummaries = filterIngredientSummaries(summaries, catalogSearch, catalogCategoryFilter);
  const filteredSummaries = filterIngredientSummariesByCatalogStatus(catalogBaseSummaries, catalogStatusFilter);
  const maxCatalogItems = Math.max(STORAGE_SHELF_MAX_DISPLAY_COLUMNS, filteredSummaries.length);
  const catalogHasActiveFilter =
    Boolean(catalogSearch.trim()) || catalogCategoryFilter !== 'all' || catalogStatusFilter !== 'all';
  const catalogCountLabel = catalogHasActiveFilter
    ? `当前筛选 ${filteredSummaries.length} 项`
    : `共 ${summaries.length} 项`;
  const inventorySourceSummaries =
    inventoryQuickFilter === 'alerted' ? summaries.filter((item) => item.alerts.length > 0) : summaries;
  const filteredInventorySummaries = filterIngredientSummariesForInventory(inventorySourceSummaries, inventorySearch);
  const inventoryStorageOverview = buildInventoryStorageOverview(filteredInventorySummaries);
  const focusedInventorySummaries =
    inventoryStorageFocus === 'all'
      ? filteredInventorySummaries
      : filteredInventorySummaries.filter((item) => item.primaryStorage === inventoryStorageFocus);
  const inventoryGroups = buildStorageGroups(focusedInventorySummaries).map((group) => ({
    ...group,
    items: inventorySortMode === 'expiry' ? sortInventorySummariesByExpiry(group.items) : group.items,
  }));
  const selectedIngredient =
    summaries.find((item) => item.ingredient.id === selectedIngredientId) ?? summaries[0] ?? null;
  const allAlerts = summaries.flatMap((item) => item.alerts);
  const pendingShopping = props.shoppingItems.filter(isPendingShopping);
  const completedShopping = props.shoppingItems.filter((item) => item.done);
  const pendingShoppingCards = buildShoppingCards(pendingShopping, summaries);
  const completedShoppingCards = buildShoppingCards(completedShopping, summaries, { completed: true });
  const shoppingOverview = buildShoppingOverview(pendingShoppingCards);
  const visiblePendingShoppingCards = filterShoppingCards(pendingShoppingCards, shoppingSearch, shoppingFocus);
  const visibleCompletedShoppingCards = filterShoppingCards(completedShoppingCards, shoppingSearch, 'all');
  const activeShoppingOverview =
    shoppingOverview.find((item) => item.key === shoppingFocus) ?? shoppingOverview[0] ?? null;
  const stockedIngredientCount = summaries.filter((item) => item.quantitySummaries.length > 0).length;
  const workspaceMetrics = [
    { label: '提醒', value: `${allAlerts.length} 条`, detail: '低库存与临期需要优先处理' },
    { label: '待买', value: `${pendingShopping.length} 项`, detail: '购物清单中尚未完成的项目' },
    { label: '在库食材', value: `${stockedIngredientCount} 种`, detail: '已经登记过库存的食材' },
  ];
  const mobilePrioritySummaries = [...summaries]
    .filter((summary) => summary.alerts.length > 0 || summary.quantitySummaries.length === 0)
    .sort((left, right) => {
      const leftStatus = buildInventoryCardStatus(left);
      const rightStatus = buildInventoryCardStatus(right);
      return (
        rightStatus.priority - leftStatus.priority ||
        right.alerts.length - left.alerts.length ||
        right.latestUpdatedAt.localeCompare(left.latestUpdatedAt) ||
        left.ingredient.name.localeCompare(right.ingredient.name, 'zh-CN')
      );
    })
    .slice(0, 6);
  const mobileStorageCards = buildInventoryStorageOverview(summaries).filter((item) =>
    ['冷藏', '冷冻', '常温'].includes(item.key)
  );
  const mobileSearchSummaries = filterIngredientSummaries(summaries, catalogSearch, 'all');
  const mobileCatalogSummaries = mobileSearchSummaries
    .filter((summary) => {
      if (mobileStorageFocus !== 'all' && summary.primaryStorage !== mobileStorageFocus) {
        return false;
      }
      if (mobileIngredientFilter === 'alerted') {
        return summary.alerts.length > 0;
      }
      if (mobileIngredientFilter === 'empty') {
        return summary.quantitySummaries.length === 0;
      }
      if (mobileIngredientFilter === 'stocked') {
        return summary.quantitySummaries.length > 0;
      }
      return true;
    })
    .slice(0, 6);
  const mobileShoppingCards = pendingShoppingCards.slice(0, 4);
  const mobileHasCatalogFilters =
    Boolean(catalogSearch.trim()) || mobileIngredientFilter !== 'all' || mobileStorageFocus !== 'all';
  const quickRestockIngredients = (
    summaries
      .filter((item) => item.inventoryItems.length > 0 || item.latestPurchaseDate)
      .sort(
        (left, right) =>
          (right.latestPurchaseDate ?? '').localeCompare(left.latestPurchaseDate ?? '') ||
          right.latestUpdatedAt.localeCompare(left.latestUpdatedAt) ||
          left.ingredient.name.localeCompare(right.ingredient.name, 'zh-CN')
      )
      .map((item) => item.ingredient)
      .concat(ingredientOptions)
  ).filter((ingredient, index, list) => list.findIndex((entry) => entry.id === ingredient.id) === index).slice(0, 6);

  useEffect(() => {
    if (transientIngredient && props.ingredients.some((item) => item.id === transientIngredient.id)) {
      setTransientIngredient(null);
    }
  }, [props.ingredients, transientIngredient]);

  useEffect(() => {
    if (!selectedIngredientId && summaries[0]) {
      setSelectedIngredientId(summaries[0].ingredient.id);
      return;
    }
    if (selectedIngredientId && !summaries.some((item) => item.ingredient.id === selectedIngredientId)) {
      setSelectedIngredientId(summaries[0]?.ingredient.id ?? null);
    }
  }, [selectedIngredientId, summaries]);

  useEffect(() => {
    if (
      expandedCatalogIngredientId &&
      !filteredSummaries.some((item) => item.ingredient.id === expandedCatalogIngredientId)
    ) {
      setExpandedCatalogIngredientId(null);
    }
  }, [expandedCatalogIngredientId, filteredSummaries]);

  useEffect(() => {
    if (editingIngredientId && !ingredientOptions.some((item) => item.id === editingIngredientId)) {
      setEditingIngredientId(null);
      if (workspaceView === 'create') {
        setIngredientForm(defaultIngredientForm());
      }
    }
  }, [editingIngredientId, ingredientOptions, workspaceView]);

  useEffect(() => {
    if (inventoryForm.ingredientId && !ingredientOptions.some((item) => item.id === inventoryForm.ingredientId)) {
      setInventoryForm(buildInventoryForm(ingredientOptions));
    }
  }, [ingredientOptions, inventoryForm.ingredientId]);

  useEffect(() => {
    if (destroyExpiredIngredientId && !summaries.some((item) => item.ingredient.id === destroyExpiredIngredientId)) {
      setDestroyExpiredIngredientId(null);
      if (overlayMode === 'destroyExpired') {
        setOverlayMode(null);
      }
    }
  }, [destroyExpiredIngredientId, overlayMode, summaries]);

  useEffect(() => {
    if (showCompletedShopping && completedShoppingCards.length === 0) {
      setShowCompletedShopping(false);
    }
  }, [completedShoppingCards.length, showCompletedShopping]);

  useEffect(() => {
    if (inventoryForm.expiryInputMode === 'days') {
      const nextExpiryDate = resolveExpiryDateFromDays(inventoryForm.purchaseDate, inventoryForm.expiryDays);
      if (inventoryForm.expiryDate !== nextExpiryDate) {
        setInventoryForm((current) => ({ ...current, expiryDate: nextExpiryDate }));
      }
      return;
    }
    if (inventoryForm.expiryInputMode === 'none' && inventoryForm.expiryDate) {
      setInventoryForm((current) => ({ ...current, expiryDate: '' }));
    }
  }, [inventoryForm.expiryDate, inventoryForm.expiryDays, inventoryForm.expiryInputMode, inventoryForm.purchaseDate]);

  useEffect(() => {
    if (inventoryForm.statusDirty) {
      return;
    }
    const recommendedStatus = resolveInventoryStatusForStorage(inventoryForm.storageLocation);
    if (inventoryForm.status !== recommendedStatus) {
      setInventoryForm((current) => ({ ...current, status: recommendedStatus }));
    }
  }, [inventoryForm.status, inventoryForm.statusDirty, inventoryForm.storageLocation]);

  useEffect(() => {
    if (catalogCategoryFilter !== 'all' && !catalogCategories.includes(catalogCategoryFilter)) {
      setCatalogCategoryFilter('all');
    }
  }, [catalogCategories, catalogCategoryFilter]);

  useEffect(() => {
    if (!props.navigationRequest) {
      return;
    }

    setActivePanel('catalog');
    setCatalogSearch('');
    setCatalogCategoryFilter('all');
    setCatalogStatusFilter('all');

    if (props.navigationRequest.ingredientId) {
      setSelectedIngredientId(props.navigationRequest.ingredientId);
      setExpandedCatalogIngredientId(
        props.navigationRequest.view === 'catalog' ? props.navigationRequest.ingredientId : null
      );
    } else {
      setExpandedCatalogIngredientId(null);
    }

    setWorkspaceView(
      props.navigationRequest.view === 'detail' && props.navigationRequest.ingredientId ? 'detail' : 'hub'
    );
  }, [props.navigationRequest?.requestId]);

  useEffect(() => {
    const snapshot: PersistedIngredientWorkspaceState = {
      workspaceView,
      activePanel,
      editingIngredientId,
      selectedIngredientId,
      catalogSearch,
      catalogCategoryFilter,
      inventorySearch,
      ingredientForm,
    };
    writeJsonStorage(INGREDIENT_WORKSPACE_STATE_KEY, snapshot);
  }, [
    workspaceView,
    activePanel,
    editingIngredientId,
    selectedIngredientId,
    catalogSearch,
    catalogCategoryFilter,
    inventorySearch,
    ingredientForm,
  ]);

  useEffect(() => {
    if (activePanel !== 'catalog' || workspaceView !== 'hub') {
      return;
    }

    const target = catalogMeasureRef.current;
    if (!target) {
      return;
    }

    const updateLayout = (availableWidth: number) => {
      const next = resolveStorageShelfLayout(availableWidth, maxCatalogItems);
      setCatalogColumns((current) => (current === next.columns ? current : next.columns));
      setCatalogCardWidth((current) =>
        Math.abs(current - next.cardWidth) < 0.01 ? current : next.cardWidth
      );
    };

    updateLayout(target.clientWidth);

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      updateLayout(entry?.contentRect.width ?? target.clientWidth);
    });

    observer.observe(target);

    return () => {
      observer.disconnect();
    };
  }, [activePanel, workspaceView, maxCatalogItems]);

  function openCreateView() {
    setEditingIngredientId(null);
    setIngredientForm(defaultIngredientForm());
    setIngredientUnitAdvancedOpen(false);
    ingredientImageComposer.setState(IDLE_IMAGE_GENERATION_STATE);
    setWorkspaceView('create');
  }

  function openEditView(ingredient: Ingredient) {
    setEditingIngredientId(ingredient.id);
    setSelectedIngredientId(ingredient.id);
    setIngredientForm(buildIngredientForm(ingredient));
    setIngredientUnitAdvancedOpen((ingredient.unit_conversions?.length ?? 0) > 0);
    ingredientImageComposer.setState(IDLE_IMAGE_GENERATION_STATE);
    setWorkspaceView('create');
  }

  function openWorkspacePanel(panel: IngredientWorkspacePanel) {
    if (panel === 'inventory') {
      setInventoryQuickFilter('all');
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
    setInventoryStorageFocus('冷藏');
    setActivePanel('inventory');
    setWorkspaceView('hub');
  }

  function openShoppingPanel() {
    setActivePanel('shopping');
    setWorkspaceView('hub');
  }

  function toggleCatalogCard(summary: IngredientSummaryViewModel) {
    setSelectedIngredientId(summary.ingredient.id);
    setExpandedCatalogIngredientId((current) =>
      current === summary.ingredient.id ? null : summary.ingredient.id
    );
  }

  function openDetailView(summary: IngredientSummaryViewModel) {
    setSelectedIngredientId(summary.ingredient.id);
    if (activePanel === 'catalog') {
      setExpandedCatalogIngredientId(summary.ingredient.id);
    }
    setWorkspaceView('detail');
  }

  function openInventoryOverlay(ingredientId?: string, quantity = '1') {
    if (ingredientOptions.length === 0) {
      setPendingShoppingToComplete(null);
      setDestroyExpiredIngredientId(null);
      setActivePanel('catalog');
      openCreateView();
      return;
    }
    setPendingShoppingToComplete(null);
    setDestroyExpiredIngredientId(null);
    setInventoryForm(
      buildInventoryForm(ingredientOptions, ingredientId, {
        quantity,
        ingredientLocked: Boolean(ingredientId),
      })
    );
    setInventoryAdvancedOpen(false);
    setOverlayMode('inventory');
  }

  function buildConsumeFormForIngredient(ingredientId: string): ConsumeDialogFormState {
    const summary = summaries.find((item) => item.ingredient.id === ingredientId) ?? null;
    const unitOptions = buildConsumeUnitOptions(
      summary?.ingredient,
      summary?.availableInventoryItems ?? [],
      summary?.ingredient.default_unit
    );
    const selectedUnit = unitOptions[0]?.unit ?? '';
    const availableQuantity = unitOptions[0]?.available ?? 0;

    return {
      ingredientId,
      unit: selectedUnit,
      quantity: availableQuantity > 0 ? formatNumericString(resolveInitialConsumeQuantity(availableQuantity)) : '',
    };
  }

  function openConsumeOverlay(ingredientId: string) {
    const summary = summaries.find((item) => item.ingredient.id === ingredientId) ?? null;
    if (!summary || summary.availableInventoryItems.length === 0) {
      return;
    }
    setPendingShoppingToComplete(null);
    setDestroyExpiredIngredientId(null);
    setConsumeForm(buildConsumeFormForIngredient(ingredientId));
    setOverlayMode('consume');
  }

  function openInventoryFromShopping(item: ShoppingListItem) {
    if (ingredientOptions.length === 0) {
      setPendingShoppingToComplete(null);
      setDestroyExpiredIngredientId(null);
      setActivePanel('catalog');
      openCreateView();
      return;
    }
    const normalizedTitle = item.title.trim();
    const matchedIngredient =
      ingredientOptions.find((ingredient) => ingredient.name === normalizedTitle) ?? null;

    setPendingShoppingToComplete({
      itemId: item.id,
      title: normalizedTitle || item.title,
    });
    setInventoryForm(
      buildInventoryForm(ingredientOptions, matchedIngredient?.id, {
        ingredientQuery: matchedIngredient?.name ?? normalizedTitle,
        ingredientLocked: Boolean(matchedIngredient),
        quantity: formatNumericString(item.quantity),
        unit: resolvePreferredIngredientUnit(matchedIngredient, item.unit) || matchedIngredient?.default_unit || item.unit.trim() || '个',
      })
    );
    setInventoryAdvancedOpen(false);
    setOverlayMode('inventory');
  }

  function openShoppingOverlay(options?: { ingredient?: Ingredient; reason?: string }) {
    setPendingShoppingToComplete(null);
    setDestroyExpiredIngredientId(null);
    setShoppingForm(buildShoppingForm(options?.ingredient, options?.reason));
    setOverlayMode('shopping');
  }

  function openDestroyExpiredOverlay(ingredientId: string) {
    const summary = summaries.find((item) => item.ingredient.id === ingredientId) ?? null;
    if (!summary || buildDisposableExpiredInventoryItems(summary).length === 0) {
      return;
    }
    setPendingShoppingToComplete(null);
    setDestroyExpiredIngredientId(ingredientId);
    setOverlayMode('destroyExpired');
  }

  function closeOverlay() {
    setOverlayMode(null);
    setPendingShoppingToComplete(null);
    setDestroyExpiredIngredientId(null);
    setInventoryAdvancedOpen(false);
    setConsumeForm(defaultConsumeForm());
  }

  function goBackToWorkspace() {
    setWorkspaceView('hub');
  }

  function goBackFromIngredientForm() {
    if (editingIngredientId) {
      setSelectedIngredientId(editingIngredientId);
      setWorkspaceView('detail');
      return;
    }
    setWorkspaceView('hub');
  }

  function goBackToCatalog() {
    setActivePanel('catalog');
    setWorkspaceView('hub');
  }

  function applyIngredientCategoryPreset(category: string) {
    const preset = getIngredientCategoryPreset(category);
    setIngredientForm((current) => ({
      ...current,
      category,
      defaultUnit: preset?.defaultUnit ?? current.defaultUnit,
      defaultStorage: preset?.defaultStorage ?? current.defaultStorage,
    }));
  }

  async function submitIngredient(restockAfterSave: boolean) {
    if (props.isCreatingIngredient || props.isUpdatingIngredient) {
      return;
    }
    if (!ingredientForm.name.trim()) {
      return;
    }
    const defaultExpiryDays =
      ingredientForm.defaultExpiryMode === 'days'
        ? clampNumber(parsePositiveNumber(ingredientForm.defaultExpiryDays) ?? 0, 1, 30)
        : null;
    const lowStockThreshold = parseOptionalNumber(ingredientForm.defaultLowStockThreshold);
    if (ingredientForm.defaultExpiryMode === 'days' && !parsePositiveNumber(ingredientForm.defaultExpiryDays)) {
      showNotice({ tone: 'warning', title: '还不能保存食材', message: '请先填写默认保质期天数，方便以后补库存时自动带出到期建议。' });
      return;
    }
    if (lowStockThreshold !== null && lowStockThreshold <= 0) {
      showNotice({ tone: 'warning', title: '低库存提醒无效', message: '默认低库存提醒值需要大于 0；如果不需要提醒，请切换为不提醒。' });
      return;
    }
    try {
      const unitConversions = sanitizeIngredientUnitConversions(
        ingredientForm.defaultUnit,
        ingredientForm.unitConversions
      );
      const payload = {
        name: ingredientForm.name.trim(),
        category: ingredientForm.category.trim() || '未分类',
        default_unit: ingredientForm.defaultUnit.trim() || '个',
        unit_conversions: unitConversions,
        default_storage: ingredientForm.defaultStorage.trim() || '冷藏',
        default_expiry_mode: ingredientForm.defaultExpiryMode,
        default_expiry_days: defaultExpiryDays,
        default_low_stock_threshold: lowStockThreshold,
        notes: ingredientForm.notes.trim(),
        media_ids: getMediaIds(ingredientForm.images),
      };
      const saved = editingIngredientId
        ? await props.updateIngredient(editingIngredientId, payload)
        : await props.createIngredient(payload);
      if (!editingIngredientId) {
        setTransientIngredient(saved);
      }
      ingredientImageComposer.setState(IDLE_IMAGE_GENERATION_STATE);
      setIngredientForm(defaultIngredientForm());
      setIngredientUnitAdvancedOpen(false);
      setEditingIngredientId(null);
      setSelectedIngredientId(saved.id);
      setWorkspaceView('detail');
      if (restockAfterSave) {
        setInventoryForm(
          buildInventoryForm([saved, ...ingredientOptions], saved.id, {
            ingredientLocked: true,
          })
        );
        setInventoryAdvancedOpen(false);
        setOverlayMode('inventory');
      }
    } catch (reason) {
      showNotice({
        tone: 'danger',
        title: editingIngredientId ? '更新食材失败' : '新增食材失败',
        message: resolveErrorMessage(reason, editingIngredientId ? '更新食材失败' : '新增食材失败'),
      });
    }
  }

  function handleCreateSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitIngredient(true);
  }

  async function submitInventory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!inventoryForm.ingredientId) {
      showNotice({ tone: 'warning', title: '还不能录入库存', message: '先选中这次补的是哪种食材，再保存这批库存。' });
      return;
    }
    const quantity = parsePositiveNumber(inventoryForm.quantity);
    if (quantity === null) {
      showNotice({ tone: 'warning', title: '库存数量无效', message: '数量要大于 0，才能把这批库存记进系统。' });
      return;
    }
    if (!inventoryForm.purchaseDate) {
      showNotice({ tone: 'warning', title: '缺少购买日期', message: '请确认这批食材的购买日期。' });
      return;
    }
    if (!inventoryForm.storageLocation.trim()) {
      showNotice({ tone: 'warning', title: '缺少存放位置', message: '请确认这批食材放在哪里，后面的提醒才会更准确。' });
      return;
    }
    if (inventoryForm.expiryInputMode === 'days' && parsePositiveNumber(inventoryForm.expiryDays) === null) {
      showNotice({ tone: 'warning', title: '缺少保质期', message: '请填写这批食材大概几天后到期，系统才能自动算出到期日。' });
      return;
    }
    if (inventoryForm.expiryInputMode === 'manual_date' && !inventoryForm.expiryDate) {
      showNotice({ tone: 'warning', title: '缺少到期日期', message: '请填写包装上的到期日期，系统才能继续帮你监控临期。' });
      return;
    }
    try {
      await props.createInventory({
        ingredient_id: inventoryForm.ingredientId,
        quantity,
        unit: inventoryForm.unit.trim() || selectedInventoryIngredient?.default_unit || '个',
        status: inventoryForm.status,
        purchase_date: inventoryForm.purchaseDate,
        expiry_date: inventoryForm.expiryDate || undefined,
        storage_location: inventoryForm.storageLocation.trim(),
        notes: inventoryForm.notes.trim(),
      });
      if (pendingShoppingToComplete) {
        try {
          await props.updateShoppingItem({
            itemId: pendingShoppingToComplete.itemId,
            done: true,
          });
        } catch (reason) {
          showNotice({
            tone: 'warning',
            title: '库存已登记',
            message:
              reason instanceof Error
                ? `待买项仍未标记完成：${reason.message}`
                : '待买项仍未标记为已买，请稍后再试。',
          });
        }
      }
      setSelectedIngredientId(inventoryForm.ingredientId);
      setInventoryForm(buildInventoryForm(ingredientOptions, inventoryForm.ingredientId));
      setInventoryAdvancedOpen(false);
      closeOverlay();
    } catch (reason) {
      showNotice({ tone: 'danger', title: '录入库存失败', message: resolveErrorMessage(reason, '录入库存失败') });
    }
  }

  async function submitShopping(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!shoppingForm.title.trim()) {
      return;
    }
    const quantity = parsePositiveNumber(shoppingForm.quantity);
    if (quantity === null) {
      showNotice({ tone: 'warning', title: '待买数量无效', message: '请确认待买数量，至少要大于 0。' });
      return;
    }
    try {
      await props.createShoppingItem({
        title: shoppingForm.title.trim(),
        quantity,
        unit: shoppingForm.unit.trim() || '个',
        reason: shoppingForm.reason.trim(),
      });
      setShoppingForm(buildShoppingForm());
      closeOverlay();
    } catch (reason) {
      showNotice({ tone: 'danger', title: '加入购物清单失败', message: resolveErrorMessage(reason, '加入购物清单失败') });
    }
  }

  async function submitConsume(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!consumeForm.ingredientId) {
      showNotice({ tone: 'warning', title: '还不能记录消费', message: '先确认是要消费哪种食材。' });
      return;
    }

    const selectedSummary = summaries.find((item) => item.ingredient.id === consumeForm.ingredientId) ?? null;
    if (!selectedSummary) {
      showNotice({ tone: 'warning', title: '食材不可用', message: '这份食材暂时不可用，请稍后再试。' });
      return;
    }

    const unitOptions = buildConsumeUnitOptions(
      selectedSummary.ingredient,
      selectedSummary.availableInventoryItems,
      selectedSummary.ingredient.default_unit
    );
    const selectedUnitOption = unitOptions.find((item) => item.unit === consumeForm.unit) ?? unitOptions[0] ?? null;
    if (!selectedUnitOption) {
      showNotice({ tone: 'warning', title: '没有可消费库存', message: '这份食材当前没有可消费的库存。' });
      return;
    }

    const quantity = parsePositiveNumber(consumeForm.quantity);
    if (quantity === null) {
      showNotice({ tone: 'warning', title: '消费数量无效', message: '请确认这次实际消费了多少。' });
      return;
    }

    if (quantity - selectedUnitOption.available > 0.0001) {
      showNotice({
        tone: 'warning',
        title: '超过可用库存',
        message: `当前最多还能消费 ${formatNumericString(selectedUnitOption.available)}${selectedUnitOption.unit}。`,
      });
      return;
    }

    try {
      await props.consumeInventory({
        ingredient_id: consumeForm.ingredientId,
        quantity,
        unit: selectedUnitOption.unit,
      });
      setSelectedIngredientId(consumeForm.ingredientId);
      closeOverlay();
    } catch (reason) {
      showNotice({ tone: 'danger', title: '记录消费失败', message: resolveErrorMessage(reason, '记录消费失败') });
    }
  }

  async function submitDestroyExpired(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!destroyExpiredIngredientId) {
      showNotice({ tone: 'warning', title: '还不能销毁过期批次', message: '先确认要处理哪种食材。' });
      return;
    }

    const selectedSummary = summaries.find((item) => item.ingredient.id === destroyExpiredIngredientId) ?? null;
    if (!selectedSummary) {
      showNotice({ tone: 'warning', title: '食材不可用', message: '这份食材暂时不可用，请稍后再试。' });
      return;
    }

    const expiredItems = buildDisposableExpiredInventoryItems(selectedSummary);
    if (expiredItems.length === 0) {
      showNotice({ tone: 'warning', title: '没有可销毁批次', message: '当前没有可销毁的过期批次。' });
      return;
    }

    try {
      await props.disposeExpiredInventory({
        ingredient_id: selectedSummary.ingredient.id,
        inventory_item_ids: expiredItems.map((item) => item.id),
      });
      setSelectedIngredientId(selectedSummary.ingredient.id);
      closeOverlay();
    } catch (reason) {
      showNotice({ tone: 'danger', title: '销毁过期批次失败', message: resolveErrorMessage(reason, '销毁过期批次失败') });
    }
  }

  const desktopActions = (
    <div className="ingredients-actions">
      <ActionButton tone="primary" type="button" onClick={openCreateView}>
        新增食材
      </ActionButton>
    </div>
  );
  const activePanelBackLabel =
    activePanel === 'inventory' ? '返回库存' : activePanel === 'shopping' ? '返回采购' : '返回档案';
  const catalogGridStyle = {
    '--ingredients-catalog-columns': String(catalogColumns),
    '--ingredients-catalog-card-width': `${catalogCardWidth}px`,
  } as CSSProperties;
  const ingredientImagePayload = buildIngredientImagePayload(ingredientForm);
  const ingredientImageComposer = useImageComposer({
    value: ingredientForm.images,
    payload: ingredientImagePayload,
    onChange: (next) => setIngredientForm((current) => ({ ...current, images: next })),
  });
  const isEditingIngredient = Boolean(editingIngredientId);
  const trimmedIngredientName = ingredientForm.name.trim();
  const trimmedIngredientCategory = ingredientForm.category.trim();
  const trimmedIngredientUnit = ingredientForm.defaultUnit.trim();
  const trimmedIngredientStorage = ingredientForm.defaultStorage.trim();
  const ingredientVisibleCategoryPresets = INGREDIENT_CATEGORY_PRESETS.slice(0, 5);
  const ingredientCategoryIsVisiblePreset = ingredientVisibleCategoryPresets.some(
    (item) => item.label === trimmedIngredientCategory
  );
  const showIngredientCategoryCustomInput =
    ingredientCustomCategoryOpen || (Boolean(trimmedIngredientCategory) && !ingredientCategoryIsVisiblePreset);
  const ingredientDefaultExpiryDays = parseOptionalNumber(ingredientForm.defaultExpiryDays);
  const ingredientDefaultExpiryRangeValue = resolveClampedDaysValue(ingredientForm.defaultExpiryDays);
  const ingredientUnitOptions = buildUnitPresetOptions(ingredientForm.defaultUnit);
  const ingredientUsesCustomUnit = isCustomChoiceValue(ingredientForm.defaultUnit, ingredientUnitOptions);
  const ingredientUsesCustomStorage = !INVENTORY_STORAGE_PRESETS.includes(
    ingredientForm.defaultStorage as (typeof INVENTORY_STORAGE_PRESETS)[number]
  );
  const ingredientLowStockEnabled = Boolean(ingredientForm.defaultLowStockThreshold.trim());
  const ingredientLowStockValue =
    parsePositiveNumber(ingredientForm.defaultLowStockThreshold) ??
    resolveTouchDefaultValue(ingredientForm.defaultUnit || '个', 'threshold');
  const ingredientLowStockStep = resolveTouchStep(ingredientForm.defaultUnit || '个');
  const ingredientLowStockQuickValues = resolveTouchQuickValues(ingredientForm.defaultUnit || '个', 'threshold');
  const ingredientRulesValid =
    ingredientForm.defaultExpiryMode !== 'days' || (ingredientDefaultExpiryDays !== null && ingredientDefaultExpiryDays > 0);
  const ingredientHasGeneratedImage = getMediaIds(ingredientForm.images).length > 0;
  const ingredientHasReferenceImage = Boolean(ingredientForm.images.referenceAsset);
  const ingredientPreviewImage = getImagePreview(ingredientForm.images);
  const createCanSubmit =
    Boolean(trimmedIngredientName) &&
    ingredientRulesValid &&
    !props.isCreatingIngredient &&
    !props.isUpdatingIngredient &&
    !ingredientImageComposer.state.isGenerating;
  const createSummaryItems = [
    { label: '名称', value: trimmedIngredientName || '未填写食材名称' },
    { label: '分类', value: trimmedIngredientCategory || '未设置分类' },
    { label: '默认位置', value: trimmedIngredientStorage || '未设置位置' },
    { label: '默认保质期', value: ingredientForm.defaultExpiryMode === 'days' ? (ingredientDefaultExpiryDays ? `买后 ${ingredientDefaultExpiryDays} 天` : '待设置天数') : ingredientForm.defaultExpiryMode === 'manual_date' ? '录入包装日期' : '不跟踪到期' },
    {
      label: '图片',
      value: ingredientHasGeneratedImage
        ? 'AI 主图已就绪'
        : ingredientHasReferenceImage
          ? '已上传参考图，待生成主图'
          : '暂未生成主图',
    },
  ];
  const createChecklistItems = [
    { label: '已填写食材名称', done: Boolean(trimmedIngredientName) },
    { label: '已选择或输入分类', done: Boolean(trimmedIngredientCategory) },
    { label: '已设置常用单位', done: Boolean(trimmedIngredientUnit) },
    {
      label: '已补充默认保质期规则（可选）',
      done: ingredientForm.defaultExpiryMode !== 'days' || Boolean(ingredientDefaultExpiryDays),
      optional: true,
    },
    { label: '已生成 AI 主图（可选）', done: ingredientHasGeneratedImage, optional: true },
  ];
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

  if (workspaceView === 'create') {
    return (
      <div className="ingredients-workspace">
        {noticeToast}
        <WorkspaceSubpageShell className="ingredients-workspace-subpage ingredients-create-workspace">
          <header className="ingredients-create-header">
            <div className="ingredients-create-titleblock">
              <button className="workspace-back-link ingredient-detail-back" type="button" onClick={goBackFromIngredientForm}>
                ← {isEditingIngredient ? '返回食材详情' : activePanelBackLabel}
              </button>
              <p className="eyebrow">{isEditingIngredient ? '编辑食材' : '新增食材'}</p>
              <h2>{isEditingIngredient ? '编辑食材资料卡' : '新增食材资料卡'}</h2>
              <p className="subtle">
                {isEditingIngredient
                  ? '调整名称、分类、图片和备注后，可以直接保存这张资料卡。'
                  : '填写基础信息、图片和备注后，就能继续登记第一批库存。'}
              </p>
            </div>
            <Badge className="ingredients-create-page-badge">{isEditingIngredient ? '资料卡编辑' : '资料卡子页'}</Badge>
          </header>
          <form className="ingredients-create-layout" onSubmit={handleCreateSubmit}>
            <div className="ingredients-create-main">
              <section className="form-panel-section ingredients-create-section ingredients-create-basic-section">
                <div className="section-mini-title">基础信息</div>
                <div className="ingredients-create-form-stack">
                  <label className="ingredients-create-name-field">
                    <span>食材名称</span>
                    <input
                      className="text-input"
                      placeholder="请输入食材名称"
                      value={ingredientForm.name}
                      onChange={(event) => setIngredientForm({ ...ingredientForm, name: event.target.value })}
                    />
                  </label>
                  <div className="ingredients-category-field">
                    <span>分类</span>
                    <ScrollableChipRail ariaLabel="常见食材分类" railClassName="ingredients-category-presets">
                      {ingredientVisibleCategoryPresets.map((item) => (
                        <button
                          key={item.label}
                          className={
                            ingredientForm.category.trim() === item.label
                              ? 'chip ingredients-category-chip active'
                              : 'chip ingredients-category-chip'
                          }
                          type="button"
                          onClick={() => {
                            setIngredientCustomCategoryOpen(false);
                            applyIngredientCategoryPreset(item.label);
                          }}
                        >
                          {item.label}
                        </button>
                      ))}
                      {showIngredientCategoryCustomInput ? (
                        <input
                          className="ingredients-category-custom-input"
                          placeholder="自定义分类"
                          value={ingredientCategoryIsVisiblePreset ? '' : ingredientForm.category}
                          onChange={(event) => setIngredientForm({ ...ingredientForm, category: event.target.value })}
                          autoFocus
                        />
                      ) : (
                        <button
                          className="chip ingredients-category-chip"
                          type="button"
                          onClick={() => {
                            setIngredientCustomCategoryOpen(true);
                            setIngredientForm({ ...ingredientForm, category: '' });
                          }}
                        >
                          + 自定义
                        </button>
                      )}
                    </ScrollableChipRail>
                  </div>
                  <div className="form-grid compact-grid">
                    <div className="ingredients-restock-field-group">
                      <div className="ingredients-restock-field-head">
                        <div>
                          <span>常用单位</span>
                          <p className="subtle">常见单位直接点选，特殊单位再补充输入。</p>
                        </div>
                        <button
                          className="ghost-button ingredients-modal-advanced-toggle ingredients-unit-conversion-inline-toggle"
                          type="button"
                          onClick={() => setIngredientUnitAdvancedOpen(!ingredientUnitAdvancedOpen)}
                        >
                          {ingredientUnitAdvancedOpen ? '收起换算' : '更多单位与换算'}
                        </button>
                      </div>
                      <div className="ingredients-restock-choice-row">
                        {ingredientUnitOptions.map((unit) => (
                          <button
                            key={unit}
                            className={
                              ingredientForm.defaultUnit.trim() === unit
                                ? 'ingredients-choice-chip active'
                                : 'ingredients-choice-chip'
                            }
                            type="button"
                            onClick={() => setIngredientForm({ ...ingredientForm, defaultUnit: unit })}
                          >
                            {unit}
                          </button>
                        ))}
                        <button
                          className={ingredientUsesCustomUnit ? 'ingredients-choice-chip active' : 'ingredients-choice-chip'}
                          type="button"
                          onClick={() =>
                            setIngredientForm({
                              ...ingredientForm,
                              defaultUnit: ingredientUsesCustomUnit ? ingredientForm.defaultUnit : '',
                            })
                          }
                        >
                          自定义
                        </button>
                      </div>
                      {ingredientUsesCustomUnit && (
                        <label>
                          <span>自定义单位</span>
                          <input
                            className="text-input"
                            value={ingredientForm.defaultUnit}
                            onChange={(event) =>
                              setIngredientForm({ ...ingredientForm, defaultUnit: event.target.value })
                            }
                          />
                        </label>
                      )}
                      <section className="ingredients-unit-conversion-panel">
                        {ingredientUnitAdvancedOpen && (
                          <div className="ingredients-unit-conversion-list">
                            {ingredientForm.unitConversions.length > 0 ? (
                              ingredientForm.unitConversions.map((entry) => (
                                <div key={entry.id} className="ingredients-unit-conversion-row">
                                  <label>
                                    <span>副单位</span>
                                    <input
                                      className="text-input"
                                      placeholder="例如 袋"
                                      value={entry.unit}
                                      onChange={(event) =>
                                        setIngredientForm({
                                          ...ingredientForm,
                                          unitConversions: ingredientForm.unitConversions.map((item) =>
                                            item.id === entry.id ? { ...item, unit: event.target.value } : item
                                          ),
                                        })
                                      }
                                    />
                                  </label>
                                  <label>
                                    <span>换算值</span>
                                    <input
                                      className="text-input"
                                      type="number"
                                      min="0.01"
                                      step="0.01"
                                      placeholder="500"
                                      value={entry.ratioToDefault}
                                      onChange={(event) =>
                                        setIngredientForm({
                                          ...ingredientForm,
                                          unitConversions: ingredientForm.unitConversions.map((item) =>
                                            item.id === entry.id
                                              ? { ...item, ratioToDefault: event.target.value }
                                              : item
                                          ),
                                        })
                                      }
                                    />
                                  </label>
                                  <div className="ingredients-unit-conversion-preview">
                                    <span>预览</span>
                                    <strong>
                                      {normalizeIngredientUnit(entry.unit)
                                        ? `1 ${normalizeIngredientUnit(entry.unit)} = ${entry.ratioToDefault.trim() || '?'} ${trimmedIngredientUnit || '主单位'}`
                                        : `1 副单位 = ${entry.ratioToDefault.trim() || '?'} ${trimmedIngredientUnit || '主单位'}`}
                                    </strong>
                                  </div>
                                  <ActionButton
                                    tone="tertiary"
                                    size="compact"
                                    type="button"
                                    className="ingredients-unit-conversion-remove"
                                    onClick={() =>
                                      setIngredientForm({
                                        ...ingredientForm,
                                        unitConversions: ingredientForm.unitConversions.filter((item) => item.id !== entry.id),
                                      })
                                    }
                                  >
                                    删除
                                  </ActionButton>
                                </div>
                              ))
                            ) : (
                              <div className="ingredients-create-rule-note ingredients-unit-conversion-empty">
                                <span>先按主单位建档就够用</span>
                                <p>只有像“袋、盒、个”需要换成主单位时，再补充这里的高级设置。</p>
                              </div>
                            )}
                            <ActionButton
                              tone="secondary"
                              size="compact"
                              type="button"
                              className="ingredients-unit-conversion-add"
                              onClick={() =>
                                setIngredientForm({
                                  ...ingredientForm,
                                  unitConversions: [...ingredientForm.unitConversions, createIngredientUnitConversionDraft()],
                                })
                              }
                            >
                              添加副单位
                            </ActionButton>
                          </div>
                        )}
                      </section>
                    </div>
                    <div className="ingredients-restock-field-group">
                      <div className="ingredients-restock-field-head">
                        <span>默认存放位置</span>
                        <p className="subtle">以后补库存时会先带出这里的建议位置。</p>
                      </div>
                      <div className="ingredients-restock-choice-row">
                        {INVENTORY_STORAGE_PRESETS.map((storage) => (
                          <button
                            key={storage}
                            className={
                              ingredientForm.defaultStorage === storage
                                ? `ingredients-choice-chip ingredients-storage-choice-chip tone-${storage} active`
                                : `ingredients-choice-chip ingredients-storage-choice-chip tone-${storage}`
                            }
                            type="button"
                            onClick={() =>
                              setIngredientForm({ ...ingredientForm, defaultStorage: storage })
                            }
                          >
                            <span className="ingredients-storage-choice-icon" aria-hidden="true">
                              <InventoryStorageIcon storage={storage} />
                            </span>
                            {storage}
                          </button>
                        ))}
                        <button
                          className={
                            ingredientUsesCustomStorage
                              ? 'ingredients-choice-chip ingredients-storage-choice-chip tone-other active'
                              : 'ingredients-choice-chip ingredients-storage-choice-chip tone-other'
                          }
                          type="button"
                          onClick={() =>
                            setIngredientForm({
                              ...ingredientForm,
                              defaultStorage: ingredientUsesCustomStorage ? ingredientForm.defaultStorage : '',
                            })
                          }
                        >
                          <span className="ingredients-storage-choice-icon" aria-hidden="true">
                            <IngredientWorkspaceIcon name="plus" />
                          </span>
                          其他
                        </button>
                      </div>
                      {ingredientUsesCustomStorage && (
                        <label>
                          <span>自定义位置</span>
                          <input
                            className="text-input"
                            value={ingredientForm.defaultStorage}
                            placeholder="例如 阳台储物柜"
                            onChange={(event) =>
                              setIngredientForm({ ...ingredientForm, defaultStorage: event.target.value })
                            }
                          />
                        </label>
                      )}
                    </div>
                  </div>
                </div>
              </section>

              <section className="form-panel-section ingredients-create-section ingredients-create-rules-section">
                <div className="section-mini-title">补货默认值</div>
                <div className="form-grid compact-grid">
                  <div className="ingredients-restock-field-group ingredients-create-expiry-rule-card">
                    <div className="ingredients-restock-field-head">
                      <span>默认保质期规则</span>
                      <p className="subtle">把长期规则留在资料卡里，补库存时就不用每次重想。</p>
                    </div>
                    <SegmentedTabs
                      options={[
                        { value: 'none', label: '不跟踪到期' },
                        { value: 'days', label: '买后几天' },
                        { value: 'manual_date', label: '包装到期日' },
                      ]}
                      value={ingredientForm.defaultExpiryMode}
                      onChange={(value) =>
                        setIngredientForm({
                          ...ingredientForm,
                          defaultExpiryMode: value,
                          defaultExpiryDays:
                            value === 'days'
                              ? String(ingredientDefaultExpiryRangeValue || 3)
                              : '',
                        })
                      }
                    />
                  </div>
                  <div className="ingredients-restock-field-group ingredients-create-lowstock-card">
                    <div className="ingredients-restock-field-head">
                      <span>默认低库存提醒</span>
                      <p className="subtle">按食材总量提醒，值越小越接近“快没了”。</p>
                    </div>
                    <SegmentedTabs
                      options={[
                        { value: 'off', label: '不提醒' },
                        { value: 'on', label: '设置提醒' },
                      ]}
                      value={ingredientLowStockEnabled ? 'on' : 'off'}
                      onChange={(value) =>
                        setIngredientForm({
                          ...ingredientForm,
                          defaultLowStockThreshold:
                            value === 'on'
                              ? formatNumericString(ingredientLowStockValue)
                              : '',
                        })
                      }
                    />
                    {ingredientLowStockEnabled ? (
                      <TouchStepperField
                        label="提醒阈值"
                        value={ingredientLowStockValue}
                        min={ingredientLowStockStep}
                        step={ingredientLowStockStep}
                        quickValues={ingredientLowStockQuickValues}
                        allowCustomInput
                        customInputLabel="自定义提醒值"
                        inputMin={ingredientLowStockStep}
                        inputStep={ingredientLowStockStep}
                        formatValue={(value) => `${formatNumericString(value)}${ingredientForm.defaultUnit || '个'}`}
                        helper="库存汇总少于这个值时，档案和提醒区会提示你补货。"
                        onChange={(value) =>
                          setIngredientForm({
                            ...ingredientForm,
                            defaultLowStockThreshold: formatNumericString(value),
                          })
                        }
                      />
                    ) : (
                      <div className="ingredients-create-rule-note ingredients-create-lowstock-note">
                        <span>提醒状态</span>
                        <p>当前不做低库存提醒；需要时点一下就能开启，平时不用额外维护。</p>
                      </div>
                    )}
                  </div>
                  {ingredientForm.defaultExpiryMode === 'days' ? (
                    <TouchRangeField
                      label="默认几天到期"
                      value={ingredientDefaultExpiryRangeValue}
                      min={1}
                      max={30}
                      step={1}
                      marks={EXPIRY_DAY_MARKS}
                      helper="以后补库存时会先带出这个天数。"
                      formatValue={(value) => `${value} 天`}
                      onChange={(value) =>
                        setIngredientForm({ ...ingredientForm, defaultExpiryDays: String(value) })
                      }
                    />
                  ) : (
                    <div className="ingredients-create-rule-note ingredients-create-expiry-note">
                      <span>到期录入方式</span>
                      <p>
                        {ingredientForm.defaultExpiryMode === 'manual_date'
                          ? '以后补库存时会直接让你填写包装上的具体日期。'
                          : '以后补库存默认不要求到期信息，也不会自动做临期提醒。'}
                      </p>
                    </div>
                  )}
                  <div className="ingredients-create-rule-note ingredients-create-default-note">
                    <span>补库存时自动带出</span>
                    <p>这些默认值会在以后登记新批次时预填，你仍然可以按这次买回来的实际情况修改。</p>
                  </div>
                </div>
              </section>

              <div className="ingredients-create-secondary">
                <div className="ingredients-create-media-section">
                  <ImageComposer
                    title="食材图片"
                    value={ingredientForm.images}
                    previewLabel={ingredientForm.name || '食材'}
                    onUpload={(files) => void ingredientImageComposer.upload(files)}
                    onGenerate={(mode) => void ingredientImageComposer.generate(mode)}
                    onReset={ingredientImageComposer.reset}
                    isGenerating={ingredientImageComposer.state.isGenerating}
                    errorMessage={ingredientImageComposer.state.errorMessage}
                    variant="workspace-inline"
                  />
                </div>

                <section className="form-panel-section ingredients-create-section ingredients-create-notes-section">
                  <div className="section-mini-title">备注</div>
                  <div className="form-grid">
                    <label className="span-two">
                      <span>补充说明</span>
                      <textarea
                        className="text-input"
                        placeholder="请输入补充说明（可选）"
                        rows={4}
                        value={ingredientForm.notes}
                        onChange={(event) =>
                          setIngredientForm({ ...ingredientForm, notes: event.target.value })
                        }
                      />
                    </label>
                  </div>
                </section>
              </div>
            </div>

            <aside className="ingredients-create-side">
              <section className="form-panel-section ingredients-create-side-panel ingredients-create-action-rail">
                <div className="ingredients-create-rail-head">
                  <div className="ingredients-create-rail-copy">
                    <p className="eyebrow">录入摘要</p>
                    <h3>{isEditingIngredient ? '准备保存这次修改' : '准备保存这张资料卡'}</h3>
                    <p className="subtle">
                      {isEditingIngredient ? '保存后会回到详情页，也可以顺手继续登记新批次。' : '填完后直接保存，或继续进入首批库存登记。'}
                    </p>
                  </div>
                </div>

                <div className="ingredients-create-preview-card">
                  {ingredientPreviewImage?.url ? (
                    <img src={resolveAssetUrl(ingredientPreviewImage.url)} alt={ingredientForm.name || '食材图片'} />
                  ) : (
                    <div className="ingredients-create-preview-placeholder">
                      <IngredientWorkspaceIcon name="image" />
                      <span>未配图</span>
                    </div>
                  )}
                </div>

                <div className="ingredients-create-summary-list">
                  {createSummaryItems.map((item) => (
                    <div key={item.label} className="ingredients-create-summary-row">
                      <span>{item.label}</span>
                      <strong title={item.value}>{item.value}</strong>
                    </div>
                  ))}
                </div>

                <div className="ingredients-create-progress">
                  <p className="ingredients-create-progress-title">完成度</p>
                  <div className="ingredients-create-progress-list">
                    {createChecklistItems.map((item) => (
                      <div
                        key={item.label}
                        className={
                          item.done
                            ? 'ingredients-create-progress-item is-done'
                            : item.optional
                              ? 'ingredients-create-progress-item is-optional'
                              : 'ingredients-create-progress-item'
                        }
                      >
                        <span className="ingredients-create-progress-indicator" aria-hidden="true" />
                        <span>{item.label}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="ingredients-create-footer ingredients-create-footer-rail">
                  <button className="solid-button" type="submit" disabled={!createCanSubmit}>
                    {props.isCreatingIngredient || props.isUpdatingIngredient
                      ? '保存中...'
                      : ingredientImageComposer.state.isGenerating
                        ? '生成主图中...'
                        : isEditingIngredient
                          ? '保存修改并登记库存'
                          : '保存并登记库存'}
                  </button>
                  <button
                    className="ghost-button"
                    type="button"
                    disabled={!createCanSubmit}
                    onClick={() => void submitIngredient(false)}
                  >
                    {props.isCreatingIngredient || props.isUpdatingIngredient
                      ? '保存中...'
                      : ingredientImageComposer.state.isGenerating
                        ? '生成主图中...'
                        : isEditingIngredient
                          ? '仅保存修改'
                          : '仅保存资料卡'}
                  </button>
                  <button className="ingredients-create-link-button" type="button" onClick={isEditingIngredient ? goBackFromIngredientForm : goBackToCatalog}>
                    {isEditingIngredient ? '返回详情' : '返回档案'}
                  </button>
                </div>
              </section>
            </aside>
          </form>
        </WorkspaceSubpageShell>
        <MobileQuickBar
          onCreate={openCreateView}
          onInventory={() => openInventoryOverlay()}
          onShopping={() => openShoppingOverlay()}
        />
        <OverlayLayer
          overlayMode={overlayMode}
          closeOverlay={closeOverlay}
          inventoryForm={inventoryForm}
          setInventoryForm={setInventoryForm}
          inventoryAdvancedOpen={inventoryAdvancedOpen}
          setInventoryAdvancedOpen={setInventoryAdvancedOpen}
          consumeForm={consumeForm}
          setConsumeForm={setConsumeForm}
          shoppingForm={shoppingForm}
          setShoppingForm={setShoppingForm}
          destroyExpiredIngredientId={destroyExpiredIngredientId}
          ingredients={ingredientOptions}
          ingredientSummaries={summaries}
          quickRestockIngredients={quickRestockIngredients}
          submitInventory={submitInventory}
          submitConsume={submitConsume}
          submitShopping={submitShopping}
          submitDestroyExpired={submitDestroyExpired}
          pendingShoppingToComplete={pendingShoppingToComplete}
          isCreatingInventory={props.isCreatingInventory}
          isConsumingInventory={props.isConsumingInventory}
          isDisposingExpiredInventory={props.isDisposingExpiredInventory}
          isCreatingShopping={props.isCreatingShopping}
        />
      </div>
    );
  }

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
      <div className="ingredients-workspace">
        {noticeToast}
        <WorkspaceSubpageShell className="ingredients-workspace-subpage ingredients-detail-page">
          <header className="ingredient-detail-header">
            <div className="ingredient-detail-titleblock">
              <button className="workspace-back-link ingredient-detail-back" type="button" onClick={goBackToWorkspace}>
                ← {activePanelBackLabel}
              </button>
              <p className="eyebrow">食材详情</p>
              <h2>{selectedIngredient.ingredient.name}</h2>
              <p className="subtle">
                {selectedIngredient.ingredient.category || '未分类'} · 默认 {selectedIngredient.ingredient.default_unit || '个'} · 默认放在{' '}
                {selectedIngredient.ingredient.default_storage || '常温'}
              </p>
            </div>
            <div className="ingredient-detail-header-side">
              <Badge className="ingredient-detail-storage-badge">{detailStorageLabel}</Badge>
              <div className="ingredient-detail-primary-actions">
                <button
                  className="solid-button"
                  type="button"
                  onClick={() => openInventoryOverlay(selectedIngredient.ingredient.id)}
                >
                  <span className="ingredient-detail-button-icon" aria-hidden="true">
                    <IngredientWorkspaceIcon name="plus" />
                  </span>
                  补货
                </button>
                <button
                  className="ghost-button"
                  type="button"
                  onClick={() => openConsumeOverlay(selectedIngredient.ingredient.id)}
                  disabled={selectedIngredient.availableInventoryItems.length === 0}
                >
                  <span className="ingredient-detail-button-icon" aria-hidden="true">
                    <IngredientWorkspaceIcon name="check" />
                  </span>
                  快速消费
                </button>
                <button
                  className="tertiary-button"
                  type="button"
                  onClick={() =>
                    openShoppingOverlay({
                      ingredient: selectedIngredient.ingredient,
                      reason: '库存偏低，准备补货',
                    })
                  }
                >
                  <span className="ingredient-detail-button-icon" aria-hidden="true">
                    <IngredientWorkspaceIcon name="shopping" />
                  </span>
                  加入购物清单
                </button>
              </div>
            </div>
          </header>

          <article className="ingredient-detail-hero">
            <div className="ingredient-detail-cover">
              {selectedIngredient.ingredient.image?.url ? (
                <img
                  src={resolveAssetUrl(selectedIngredient.ingredient.image.url)}
                  alt={selectedIngredient.ingredient.name}
                />
              ) : (
                <Avatar
                  label={selectedIngredient.ingredient.name}
                  seed={selectedIngredient.ingredient.name}
                  large
                />
              )}
            </div>
            <div className="ingredient-detail-copy">
              <h3>{selectedIngredient.ingredient.notes || '适合搭配肉片和鸡蛋'}</h3>
              <div className="ingredient-detail-metric-grid" aria-label="食材摘要">
                {detailMetricItems.map((item) => (
                  <div key={item.label} className={`ingredient-detail-metric tone-${item.tone}`}>
                    <span className="ingredient-detail-metric-icon" aria-hidden="true">
                      <IngredientWorkspaceIcon name={item.icon} />
                    </span>
                    <span>{item.label}</span>
                    <strong>{item.value}</strong>
                  </div>
                ))}
              </div>
              <div className="inline-actions">
                <button
                  className="ghost-button"
                  type="button"
                  onClick={() => openEditView(selectedIngredient.ingredient)}
                >
                  <span className="ingredient-detail-button-icon" aria-hidden="true">
                    <IngredientWorkspaceIcon name="edit" />
                  </span>
                  编辑资料卡
                </button>
              </div>
            </div>
          </article>

          <div className="ingredient-detail-grid">
            <section className="card ingredient-detail-section">
              <SectionHeading title="补货默认规则" description="以后登记新批次时，系统会先带出这些建议" />
              <div className="stack-list">
                <article className="ingredient-related-row">
                  <span className="ingredient-detail-row-icon tone-brown" aria-hidden="true">
                    <IngredientWorkspaceIcon name="calendar" />
                  </span>
                  <div>
                    <h3>默认保质期</h3>
                    <p className="subtle">{formatExpiryRuleLabel(selectedIngredient.ingredient)}</p>
                  </div>
                  <Badge>{selectedIngredient.ingredient.default_expiry_mode === 'days' ? '自动带日期' : selectedIngredient.ingredient.default_expiry_mode === 'manual_date' ? '填写包装日期' : '不自动提醒'}</Badge>
                </article>
                <article className="ingredient-related-row">
                  <span className="ingredient-detail-row-icon tone-orange" aria-hidden="true">
                    <IngredientWorkspaceIcon name="bell" />
                  </span>
                  <div>
                    <h3>低库存提醒</h3>
                    <p className="subtle">{formatLowStockRuleLabel(selectedIngredient.ingredient)}</p>
                  </div>
                  <Badge>
                    {selectedIngredient.ingredient.default_low_stock_threshold !== null &&
                    selectedIngredient.ingredient.default_low_stock_threshold !== undefined
                      ? '按食材总量判断'
                      : '暂未开启'}
                  </Badge>
                </article>
                <article className="ingredient-related-row">
                  <span className="ingredient-detail-row-icon tone-green" aria-hidden="true">
                    <IngredientWorkspaceIcon name="swap" />
                  </span>
                  <div>
                    <h3>更多单位与换算</h3>
                    <p className="subtle">
                      {selectedIngredient.ingredient.unit_conversions.length > 0
                        ? selectedIngredient.ingredient.unit_conversions
                            .map(
                              (item) =>
                                `1 ${item.unit} = ${formatNumericString(item.ratio_to_default)}${selectedIngredient.ingredient.default_unit}`
                            )
                            .join(' · ')
                        : '当前只使用主单位，不额外做换算。'}
                    </p>
                  </div>
                  <Badge>
                    {selectedIngredient.ingredient.unit_conversions.length > 0
                      ? `${selectedIngredient.ingredient.unit_conversions.length} 个副单位`
                      : '高级功能未启用'}
                  </Badge>
                </article>
              </div>
            </section>

            <section className="card ingredient-detail-section">
              <SectionHeading
                title="当前提醒"
                description="优先处理临期和不足量食材"
              />
              <div className="stack-list">
                {selectedIngredient.alerts.length > 0 ? (
                  <>
                    {selectedIngredient.alerts.map((alert) => (
                      <article key={alert.id} className={`alert-card ${alert.tone}`}>
                        <span className="ingredient-detail-alert-icon" aria-hidden="true">
                          <IngredientWorkspaceIcon name="exclamation" />
                        </span>
                        <div>
                          <h3>{alert.title}</h3>
                          <p>{alert.detail}</p>
                        </div>
                      </article>
                    ))}
                    <div className="ingredient-detail-tip">
                      <span className="ingredient-detail-row-icon tone-brown" aria-hidden="true">
                        <IngredientWorkspaceIcon name="lightbulb" />
                      </span>
                      <strong>优先处理临期和不足量食材</strong>
                    </div>
                  </>
                ) : (
                  <EmptyState
                    title="状态很安稳"
                    description="这份食材当前没有低库存或临期提醒。"
                  />
                )}
              </div>
            </section>

            <section className="card ingredient-detail-section">
              <SectionHeading
                title="库存批次"
                description="按批次记录入库，并持续跟踪每批剩余量"
              />
              <div className="stack-list">
                {selectedIngredient.inventoryItems.length > 0 ? (
                  selectedIngredient.inventoryItems.map((item) => (
                    <article key={item.id} className={`inventory-card inventory-card-rich tone-${item.status}`}>
                      <span className="ingredient-detail-row-icon tone-green" aria-hidden="true">
                        <IngredientWorkspaceIcon name="stocked" />
                      </span>
                      <div>
                        <div className="inline-between">
                          <h3>
                            剩余{' '}
                            {formatNumericString(
                              convertQuantityToDefaultUnit(
                                selectedIngredient.ingredient,
                                getInventoryRemainingQuantity(item),
                                item.unit
                              ) ?? getInventoryRemainingQuantity(item)
                            )}
                            {selectedIngredient.ingredient.default_unit || item.unit}
                          </h3>
                          <Badge>{INVENTORY_STATUS_LABELS[item.status]}</Badge>
                        </div>
                        <p className="subtle ingredient-detail-icon-line">
                          <span aria-hidden="true">
                            <IngredientWorkspaceIcon name="calendar" />
                          </span>
                          {item.storage_location} · 购于 {formatDate(item.purchase_date)}
                          {item.expiry_date ? ` · ${formatRelativeDays(item.expiry_date)}` : ''}
                        </p>
                        <p>
                          {getInventoryConsumedQuantity(item) > 0
                            ? `原始入库 ${formatNumericString(
                                convertQuantityToDefaultUnit(selectedIngredient.ingredient, item.quantity, item.unit) ?? item.quantity
                              )}${selectedIngredient.ingredient.default_unit || item.unit}，已消费 ${formatNumericString(
                                convertQuantityToDefaultUnit(
                                  selectedIngredient.ingredient,
                                  getInventoryConsumedQuantity(item),
                                  item.unit
                                ) ?? getInventoryConsumedQuantity(item)
                              )}${selectedIngredient.ingredient.default_unit || item.unit}${
                                item.entered_quantity !== null &&
                                item.entered_quantity !== undefined &&
                                item.entered_unit &&
                                (Math.abs(item.entered_quantity - item.quantity) > 0.0001 ||
                                  item.entered_unit !== item.unit)
                                  ? ` · 登记时 ${formatNumericString(item.entered_quantity)}${item.entered_unit}`
                                  : ''
                              }${item.notes ? ` · ${item.notes}` : ''}`
                            : item.notes ||
                              `原始入库 ${formatNumericString(
                                convertQuantityToDefaultUnit(selectedIngredient.ingredient, item.quantity, item.unit) ?? item.quantity
                              )}${selectedIngredient.ingredient.default_unit || item.unit}${
                                item.entered_quantity !== null &&
                                item.entered_quantity !== undefined &&
                                item.entered_unit &&
                                (Math.abs(item.entered_quantity - item.quantity) > 0.0001 ||
                                  item.entered_unit !== item.unit)
                                  ? ` · 登记时 ${formatNumericString(item.entered_quantity)}${item.entered_unit}`
                                  : ''
                              }`}
                        </p>
                      </div>
                    </article>
                  ))
                ) : (
                  <EmptyState
                    title="还没有库存批次"
                    description="先登记第一批库存，这张资料卡就会更有用了。"
                    action={
                      <button
                        className="solid-button"
                        type="button"
                        onClick={() => openInventoryOverlay(selectedIngredient.ingredient.id)}
                      >
                        立即登记
                      </button>
                    }
                  />
                )}
              </div>
            </section>

            <section className="card ingredient-detail-section">
              <SectionHeading title="关联菜谱" description="这份食材已经被哪些菜谱引用" />
              <div className="stack-list">
                {selectedIngredient.recipeReferences.length > 0 ? (
                  selectedIngredient.recipeReferences.map((item) => (
                    <article key={item.id} className="ingredient-related-row">
                      {props.recipes.find((recipe) => recipe.id === item.id)?.images[0]?.url ? (
                        <img
                          className="ingredient-related-thumb"
                          src={resolveAssetUrl(props.recipes.find((recipe) => recipe.id === item.id)?.images[0]?.url)}
                          alt={item.title}
                        />
                      ) : null}
                      {!props.recipes.find((recipe) => recipe.id === item.id)?.images[0]?.url ? (
                        <span className="ingredient-detail-row-icon tone-brown" aria-hidden="true">
                          <IngredientWorkspaceIcon name="link" />
                        </span>
                      ) : null}
                      <div>
                        <h3>{item.title}</h3>
                        <p className="subtle">已在菜谱库中引用，可用于做饭推荐与食材串联。</p>
                      </div>
                      <Badge>已引用</Badge>
                    </article>
                  ))
                ) : (
                  <EmptyState
                    title="还没有菜谱引用"
                    description="后续在新建菜谱时选择这份食材，这里就会形成关联。"
                  />
                )}
              </div>
            </section>

            <section className="card ingredient-detail-section ingredient-detail-section-wide">
              <SectionHeading title="资料信息" description="谁在什么时候补充了这张资料卡" />
              <div className="ingredient-metadata">
                <p>
                  <span className="ingredient-metadata-icon" aria-hidden="true">
                    <IngredientWorkspaceIcon name="calendar" />
                  </span>
                  <strong>创建时间：</strong>
                  {formatDateTime(selectedIngredient.ingredient.created_at)}
                </p>
                <p>
                  <span className="ingredient-metadata-icon" aria-hidden="true">
                    <IngredientWorkspaceIcon name="clock" />
                  </span>
                  <strong>最近更新：</strong>
                  {formatDateTime(selectedIngredient.latestUpdatedAt || selectedIngredient.ingredient.updated_at)}
                </p>
                <p>
                  <span className="ingredient-metadata-icon" aria-hidden="true">
                    <IngredientWorkspaceIcon name="inventory" />
                  </span>
                  <strong>涉及位置：</strong>
                  {selectedIngredient.storageLocations.join('、')}
                </p>
              </div>
            </section>
          </div>
        </WorkspaceSubpageShell>

        <MobileQuickBar
          onCreate={openCreateView}
          onInventory={() => openInventoryOverlay(selectedIngredient.ingredient.id)}
          onShopping={() =>
            openShoppingOverlay({
              ingredient: selectedIngredient.ingredient,
              reason: '库存偏低，准备补货',
            })
          }
        />
        <OverlayLayer
          overlayMode={overlayMode}
          closeOverlay={closeOverlay}
          inventoryForm={inventoryForm}
          setInventoryForm={setInventoryForm}
          inventoryAdvancedOpen={inventoryAdvancedOpen}
          setInventoryAdvancedOpen={setInventoryAdvancedOpen}
          consumeForm={consumeForm}
          setConsumeForm={setConsumeForm}
          shoppingForm={shoppingForm}
          setShoppingForm={setShoppingForm}
          destroyExpiredIngredientId={destroyExpiredIngredientId}
          ingredients={ingredientOptions}
          ingredientSummaries={summaries}
          quickRestockIngredients={quickRestockIngredients}
          submitInventory={submitInventory}
          submitConsume={submitConsume}
          submitShopping={submitShopping}
          submitDestroyExpired={submitDestroyExpired}
          pendingShoppingToComplete={pendingShoppingToComplete}
          isCreatingInventory={props.isCreatingInventory}
          isConsumingInventory={props.isConsumingInventory}
          isDisposingExpiredInventory={props.isDisposingExpiredInventory}
          isCreatingShopping={props.isCreatingShopping}
        />
      </div>
    );
  }

  return (
    <div className="ingredients-workspace">
      {noticeToast}
      <section className="mobile-ingredient-page" aria-label="手机食材页">
        <div className="mobile-ingredient-topbar">
          <div className="mobile-ingredient-brand">
            <span className="mobile-ingredient-logo">
              <IngredientWorkspaceIcon name="logo" />
            </span>
            <span>
              <strong>Culina</strong>
              <small>家庭厨房工作台</small>
            </span>
          </div>
          <div className="mobile-ingredient-top-actions">
            <button type="button" aria-label="聚焦搜索" onClick={() => document.getElementById('mobile-ingredient-search')?.focus()}>
              <IngredientWorkspaceIcon name="search" />
            </button>
            <button
              type="button"
              aria-label="查看食材提醒"
              onClick={() => {
                setMobileIngredientFilter('alerted');
                setMobileStorageFocus('all');
              }}
            >
              <IngredientWorkspaceIcon name="bell" />
              {allAlerts.length > 0 && <i aria-hidden="true" />}
            </button>
          </div>
        </div>

        <header className="mobile-ingredient-hero">
          <h1>食材</h1>
          <p>先看家里还有什么，再处理临期、低库存和今天要买的东西。</p>
          <div className="mobile-ingredient-metrics" aria-label="食材摘要">
            <button type="button" onClick={() => setMobileIngredientFilter('stocked')}>
              <strong>{stockedIngredientCount}</strong>
              <span>在库</span>
            </button>
            <button type="button" onClick={() => setMobileIngredientFilter('alerted')}>
              <strong>{allAlerts.length}</strong>
              <span>提醒</span>
            </button>
            <button type="button" onClick={() => document.getElementById('mobile-ingredient-shopping')?.scrollIntoView({ block: 'start', behavior: 'smooth' })}>
              <strong>{pendingShopping.length}</strong>
              <span>待买</span>
            </button>
          </div>
          <div className="mobile-ingredient-actions">
            <button className="mobile-ingredient-primary" type="button" onClick={() => openInventoryOverlay()}>
              <IngredientWorkspaceIcon name="plus" />
              快速入库
            </button>
            <button className="mobile-ingredient-secondary" type="button" onClick={() => openShoppingOverlay()}>
              <IngredientWorkspaceIcon name="shopping" />
              加采购
            </button>
          </div>
        </header>

        <section className="mobile-ingredient-panel">
          <div className="mobile-ingredient-section-head">
            <h2>今天先处理 <span>{mobilePrioritySummaries.length} 项</span></h2>
            <button
              type="button"
              onClick={() => {
                setMobileIngredientFilter('alerted');
                setMobileStorageFocus('all');
              }}
              disabled={mobilePrioritySummaries.length === 0}
            >
              看提醒
              <IngredientWorkspaceIcon name="chevronDown" />
            </button>
          </div>
          {mobilePrioritySummaries.length > 0 ? (
            <div className="mobile-ingredient-priority-scroller">
              {mobilePrioritySummaries.map((summary) => {
                const imageUrl = resolveAssetUrl(summary.ingredient.image?.url) ?? buildIngredientPlaceholderSvg(summary.ingredient.name);
                const status = buildInventoryCardStatus(summary);
                const canConsume = summary.availableInventoryItems.length > 0;
                const canDestroyExpired = buildDisposableExpiredInventoryItems(summary).length > 0;
                return (
                  <article key={summary.ingredient.id} className={`mobile-ingredient-priority-card tone-${status.tone}`}>
                    <button className="mobile-ingredient-priority-cover" type="button" onClick={() => openDetailView(summary)}>
                      <img src={imageUrl} alt={summary.ingredient.name} />
                    </button>
                    <div className="mobile-ingredient-priority-body">
                      <div className="mobile-ingredient-card-head">
                        <h3>{summary.ingredient.name}</h3>
                        <span>{status.label}</span>
                      </div>
                      <p>{summary.alerts[0]?.detail ?? status.detail}</p>
                      <div className="mobile-ingredient-chip-row">
                        <span>{summary.primaryStorage}</span>
                        <span>{buildInventorySummaryLine(summary)}</span>
                      </div>
                      <div className="mobile-ingredient-card-actions">
                        <button
                          className="mobile-ingredient-primary compact"
                          type="button"
                          onClick={() =>
                            canDestroyExpired
                              ? openDestroyExpiredOverlay(summary.ingredient.id)
                              : canConsume
                                ? openConsumeOverlay(summary.ingredient.id)
                                : openShoppingOverlay({ ingredient: summary.ingredient, reason: resolveShoppingReason(summary) })
                          }
                        >
                          {canDestroyExpired ? '处理' : canConsume ? '消费' : '采购'}
                        </button>
                        <button type="button" onClick={() => openInventoryOverlay(summary.ingredient.id)}>
                          补货
                        </button>
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
                setMobileStorageFocus('all');
                setMobileIngredientFilter('all');
              }}
            >
              全部
              <IngredientWorkspaceIcon name="reset" />
            </button>
          </div>
          <div className="mobile-ingredient-storage-row" aria-label="库存位置">
            {mobileStorageCards.map((item) => (
              <button
                key={item.key}
                className={mobileStorageFocus === item.key ? `active tone-${item.tone}` : `tone-${item.tone}`}
                type="button"
                onClick={() => setMobileStorageFocus((current) => (current === item.key ? 'all' : (item.key as InventoryStorageFocus)))}
              >
                <span>
                  <InventoryStorageIllustration storage={item.key} />
                </span>
                <strong>{item.label}</strong>
                <small>{item.ingredientCount} 种 · {item.alertCount} 提醒</small>
              </button>
            ))}
          </div>
        </section>

        <section className="mobile-ingredient-panel mobile-ingredient-library">
          <div className="mobile-ingredient-section-head">
            <h2>食材库</h2>
            <button type="button" onClick={mobileHasCatalogFilters ? () => {
              setCatalogSearch('');
              setMobileIngredientFilter('all');
              setMobileStorageFocus('all');
            } : openCreateView}>
              {mobileHasCatalogFilters ? '清除筛选' : '新增'}
              <IngredientWorkspaceIcon name={mobileHasCatalogFilters ? 'reset' : 'plus'} />
            </button>
          </div>
          <div className="mobile-ingredient-library-filters">
            <label className="mobile-ingredient-search">
              <IngredientWorkspaceIcon name="search" />
              <input
                id="mobile-ingredient-search"
                value={catalogSearch}
                placeholder="搜索食材、分类、备注或菜谱"
                onChange={(event) => setCatalogSearch(event.target.value)}
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
                  className={mobileIngredientFilter === item.value ? 'active' : ''}
                  type="button"
                  onClick={() => setMobileIngredientFilter(item.value)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
          {mobileCatalogSummaries.length > 0 ? (
            <div className="mobile-ingredient-library-grid">
              {mobileCatalogSummaries.map((summary) => {
                const imageUrl = resolveAssetUrl(summary.ingredient.image?.url) ?? buildIngredientPlaceholderSvg(summary.ingredient.name);
                const status = buildCatalogCardStatus(summary);
                const canConsume = summary.availableInventoryItems.length > 0;
                return (
                  <article key={summary.ingredient.id} className={`mobile-ingredient-library-card tone-${status.tone}`}>
                    <button className="mobile-ingredient-library-cover" type="button" onClick={() => openDetailView(summary)}>
                      <img src={imageUrl} alt={summary.ingredient.name} />
                      {summary.alerts.length > 0 && <span>{summary.alerts.length} 提醒</span>}
                    </button>
                    <div className="mobile-ingredient-library-body">
                      <h3>{summary.ingredient.name}</h3>
                      <p>{summary.ingredient.category || '未分类'} · {summary.primaryStorage}</p>
                      <div className="mobile-ingredient-chip-row">
                        <span>{status.label}</span>
                        <span>{buildInventorySummaryLine(summary)}</span>
                      </div>
                      <div className="mobile-ingredient-library-actions">
                        <button
                          className="mobile-ingredient-primary"
                          type="button"
                          onClick={() => (canConsume ? openConsumeOverlay(summary.ingredient.id) : openInventoryOverlay(summary.ingredient.id))}
                        >
                          {canConsume ? '消费' : '补货'}
                        </button>
                        <button
                          type="button"
                          onClick={() => openShoppingOverlay({ ingredient: summary.ingredient, reason: resolveShoppingReason(summary) })}
                        >
                          采购
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="mobile-ingredient-empty">
              <strong>{summaries.length === 0 ? '还没有食材档案' : '没有匹配的食材'}</strong>
              <span>{summaries.length === 0 ? '先新增常用食材，后续补货、消费和采购都会更快。' : '换个关键词或清空筛选后再试。'}</span>
              <button type="button" onClick={summaries.length === 0 ? openCreateView : () => {
                setCatalogSearch('');
                setMobileIngredientFilter('all');
                setMobileStorageFocus('all');
              }}>
                {summaries.length === 0 ? '新增食材' : '清空筛选'}
              </button>
            </div>
          )}
        </section>

        <section id="mobile-ingredient-shopping" className="mobile-ingredient-panel">
          <div className="mobile-ingredient-section-head">
            <h2>采购待办 <span>{pendingShopping.length} 项</span></h2>
            <button type="button" onClick={() => openShoppingOverlay()}>
              新增
              <IngredientWorkspaceIcon name="plus" />
            </button>
          </div>
          {mobileShoppingCards.length > 0 ? (
            <div className="mobile-ingredient-shopping-list">
              {mobileShoppingCards.map((card) => {
                const imageUrl =
                  resolveAssetUrl(card.linkedSummary?.ingredient.image?.url) ??
                  buildIngredientPlaceholderSvg(card.title || '待买项');
                return (
                  <article key={card.shoppingItem.id} className={`mobile-ingredient-shopping-card tone-${card.statusTone}`}>
                    <span className="mobile-ingredient-shopping-cover">
                      <img src={imageUrl} alt={card.title} />
                    </span>
                    <div className="mobile-ingredient-shopping-copy">
                      <strong>{card.title}</strong>
                      <small>{card.quantityLabel} · {card.reasonLabel}</small>
                    </div>
                    <button type="button" disabled={props.isUpdatingShopping || props.isCreatingInventory} onClick={() => openInventoryFromShopping(card.shoppingItem)}>
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

      <div className="ingredients-desktop-view">
      <div className="ingredients-mobile-header">
        <PageHeader
          variant="workspace"
          eyebrow="食材档案"
          title="食材档案工作台"
          description="先找到食材，再直接补货、消费或加入采购；库存和采购页只做辅助处理。"
          meta={
            <div className="compact-metric-strip ingredients-header-metrics">
              {workspaceMetrics.map((item) => (
                <CompactMetric key={item.label} label={item.label} value={item.value} detail={item.detail} />
              ))}
            </div>
          }
          actions={desktopActions}
        />
      </div>

      <section className="ingredients-panel ingredients-panel-shell card">
        <div className="ingredients-panel-subnav">
          <WorkspaceSubnav
            items={PANEL_ITEMS.map((item) => ({
              ...item,
              icon: <IngredientWorkspaceIcon name={item.icon} />,
            }))}
            value={activePanel}
            onChange={openWorkspacePanel}
          />
        </div>
        <div className="ingredients-panel-body">
          {activePanel === 'catalog' && (
            <div className="ingredients-panel-stack ingredients-catalog-workbench">
              <section className="ingredients-catalog-toolbar">
                <div className="ingredients-catalog-toolbar-head">
                  <div className="ingredients-catalog-title-group">
                    <div className="ingredients-catalog-title-line">
                      <h3>食材档案</h3>
                    </div>
                    <div className="ingredients-catalog-mini-metrics" aria-label="档案快捷摘要">
                      <button type="button">
                        <span className="ingredients-catalog-mini-metric-icon">
                          <IngredientWorkspaceIcon name="total" />
                        </span>
                        {catalogCountLabel}
                      </button>
                      <button type="button" onClick={() => openInventoryPanel('alerted')}>
                        <span className="ingredients-catalog-mini-metric-icon">
                          <IngredientWorkspaceIcon name="alert" />
                        </span>
                        {allAlerts.length} 个提醒
                      </button>
                      <button type="button" onClick={openShoppingPanel}>
                        <span className="ingredients-catalog-mini-metric-icon">
                          <IngredientWorkspaceIcon name="shopping" />
                        </span>
                        {pendingShopping.length} 项待买
                      </button>
                      <button type="button" onClick={() => openInventoryPanel('all')}>
                        <span className="ingredients-catalog-mini-metric-icon">
                          <IngredientWorkspaceIcon name="stocked" />
                        </span>
                        {stockedIngredientCount} 个在库
                      </button>
                    </div>
                  </div>
                  <ActionButton tone="primary" type="button" className="ingredients-catalog-create-button" onClick={openCreateView}>
                    <span aria-hidden="true">+</span>
                    新增食材
                  </ActionButton>
                </div>
                <div className="ingredients-catalog-search-row">
                  <label className="ingredients-search-field ingredients-catalog-search-field">
                    <span className="ingredients-toolbar-label ingredients-catalog-label-with-icon">
                      <IngredientWorkspaceIcon name="search" />
                      档案检索
                    </span>
                    <span className="ingredients-catalog-search-input-shell">
                      <span className="ingredients-catalog-search-input-icon" aria-hidden="true">
                        <IngredientWorkspaceIcon name="search" />
                      </span>
                      <input
                        className="text-input"
                        placeholder="搜索食材、分类、备注或关联菜谱"
                        value={catalogSearch}
                        onChange={(event) => setCatalogSearch(event.target.value)}
                      />
                    </span>
                  </label>
                </div>
                <div className="ingredients-catalog-filter-bar">
                  <div className="ingredients-catalog-filter-section ingredients-catalog-filter-section-category">
                    <span className="ingredients-catalog-filter-label ingredients-catalog-label-with-icon">
                      <IngredientWorkspaceIcon name="filter" />
                      分类筛选
                    </span>
                    <ScrollableChipRail ariaLabel="按分类筛选食材档案" railClassName="ingredients-category-rail">
                      <button
                        className={
                          catalogCategoryFilter === 'all'
                            ? 'chip ingredients-category-chip active'
                            : 'chip ingredients-category-chip'
                        }
                        type="button"
                        onClick={() => setCatalogCategoryFilter('all')}
                      >
                        全部
                      </button>
                      {catalogCategories.map((category) => (
                        <button
                          key={category}
                          className={
                            catalogCategoryFilter === category
                              ? 'chip ingredients-category-chip active'
                              : 'chip ingredients-category-chip'
                          }
                          type="button"
                          onClick={() => setCatalogCategoryFilter(category)}
                        >
                          {category}
                        </button>
                      ))}
                    </ScrollableChipRail>
                  </div>
                  <div
                    className="ingredients-catalog-filter-section ingredients-catalog-filter-section-status"
                    aria-label="按库存状态筛选食材档案"
                  >
                    <span className="ingredients-catalog-label-with-icon">
                      <IngredientWorkspaceIcon name="status" />
                      状态筛选
                    </span>
                    <div className="ingredients-catalog-status-filter-row">
                      {CATALOG_STATUS_FILTERS.map((item) => {
                        const count = filterIngredientSummariesByCatalogStatus(catalogBaseSummaries, item.value).length;
                        return (
                          <button
                            key={item.value}
                            className={
                              catalogStatusFilter === item.value
                                ? `chip ingredients-status-chip tone-${item.value} active`
                                : `chip ingredients-status-chip tone-${item.value}`
                            }
                            type="button"
                            onClick={() => setCatalogStatusFilter(item.value)}
                          >
                            {item.label}
                            <small>{count}</small>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <button
                    className="ingredients-catalog-clear-filter"
                    type="button"
                    onClick={() => {
                      setCatalogSearch('');
                      setCatalogCategoryFilter('all');
                      setCatalogStatusFilter('all');
                    }}
                  >
                    <span className="ingredients-catalog-clear-filter-icon" aria-hidden="true">
                      <IngredientWorkspaceIcon name="reset" />
                    </span>
                    清空筛选
                  </button>
                </div>
              </section>
              <div
                ref={catalogMeasureRef}
                className="ingredient-grid ingredient-grid-catalog ingredients-catalog-grid"
                style={catalogGridStyle}
              >
                {filteredSummaries.length > 0 ? (
                  filteredSummaries.map((summary) => (
                    <IngredientCatalogCard
                      key={summary.ingredient.id}
                      summary={summary}
                      expanded={expandedCatalogIngredientId === summary.ingredient.id}
                      onToggle={() => toggleCatalogCard(summary)}
                      onRestock={() => openInventoryOverlay(summary.ingredient.id)}
                      onConsume={() => openConsumeOverlay(summary.ingredient.id)}
                      onAddShopping={() =>
                        openShoppingOverlay({
                          ingredient: summary.ingredient,
                          reason: resolveShoppingReason(summary),
                        })
                      }
                      onHandleAlert={() =>
                        buildDisposableExpiredInventoryItems(summary).length > 0
                          ? openDestroyExpiredOverlay(summary.ingredient.id)
                          : openDetailView(summary)
                      }
                      onDetail={() => openDetailView(summary)}
                    />
                  ))
                ) : (
                  <EmptyState
                    title={summaries.length === 0 ? '还没有食材档案' : '没找到匹配的食材'}
                    description={
                      summaries.length === 0
                        ? '先新增几张常用食材资料卡，后面补货、消费和采购都会直接很多。'
                        : '换个关键词试试，或者直接新建一张资料卡。'
                    }
                    action={
                      <button className="solid-button" type="button" onClick={openCreateView}>
                        新增食材
                      </button>
                    }
                  />
                )}
              </div>
            </div>
          )}

          {activePanel === 'inventory' && (
            <div className="ingredients-panel-stack ingredients-inventory-stack">
              <div className="ingredients-panel-toolbar ingredients-inventory-toolbar">
                <div className="ingredients-inventory-toolbar-main">
                  <label className="ingredients-search-field ingredients-inventory-search-field">
                    <span className="ingredients-toolbar-label ingredients-catalog-label-with-icon">
                      库存检索
                    </span>
                    <span className="ingredients-catalog-search-input-shell">
                      <span className="ingredients-catalog-search-input-icon" aria-hidden="true">
                        <IngredientWorkspaceIcon name="search" />
                      </span>
                      <input
                        className="text-input"
                        placeholder="搜索食材名称、分类、位置或提醒"
                        value={inventorySearch}
                        onChange={(event) => setInventorySearch(event.target.value)}
                      />
                    </span>
                  </label>
                  <div className="ingredients-inventory-filter-row">
                    <button
                      className={
                        inventoryQuickFilter === 'all'
                          ? 'chip ingredients-inventory-filter-chip active'
                          : 'chip ingredients-inventory-filter-chip'
                      }
                      type="button"
                      onClick={() => setInventoryQuickFilter('all')}
                    >
                      全部库存
                    </button>
                    <button
                      className={
                        inventoryQuickFilter === 'alerted'
                          ? 'chip ingredients-inventory-filter-chip active'
                          : 'chip ingredients-inventory-filter-chip'
                      }
                      type="button"
                      onClick={() => setInventoryQuickFilter('alerted')}
                    >
                      仅看提醒
                    </button>
                    <button
                      className="chip ingredients-inventory-filter-chip ingredients-inventory-clear-filter"
                      type="button"
                      onClick={() => {
                        setInventorySearch('');
                        setInventoryQuickFilter('all');
                        setInventoryStorageFocus('冷藏');
                        setInventorySortMode('default');
                      }}
                    >
                      清空筛选
                    </button>
                  </div>
                </div>
                <div className="ingredients-panel-toolbar-actions ingredients-inventory-toolbar-actions">
                  <p className="ingredients-toolbar-summary">
                    当前显示 {focusedInventorySummaries.length} 种食材
                    {inventoryStorageFocus !== 'all' ? ` · ${inventoryStorageFocus}` : ''}
                  </p>
                  <ActionButton tone="primary" type="button" onClick={() => openInventoryOverlay()}>
                    快速入库
                  </ActionButton>
                </div>
              </div>

              <section className="ingredients-inventory-overview-shell">
                <div className="ingredients-inventory-overview-head">
                  <div className="ingredients-inventory-overview-headline">
                    <h3>位置总览</h3>
                    <p className="ingredients-inventory-overview-summary">
                      {inventoryStorageFocus === 'all'
                        ? '点击任一位置卡可聚焦查看'
                        : `当前分区：${inventoryStorageFocus}`}
                    </p>
                  </div>
                  <p className="ingredients-inventory-overview-tip subtle">
                    先看各位置库存压力，再进入对应卡片直接处理。
                  </p>
                </div>
                <div className="ingredients-inventory-overview-strip">
                  {inventoryStorageOverview.map((item) => (
                    <InventoryStorageOverviewCard
                      key={item.key}
                      item={item}
                      active={inventoryStorageFocus === item.key}
                      onSelect={() =>
                        setInventoryStorageFocus((current) =>
                          current === item.key ? current : (item.key as InventoryStorageFocus)
                        )
                      }
                    />
                  ))}
                </div>
              </section>

              <div className="ingredients-storage-groups ingredients-inventory-groups">
                {inventoryGroups.length > 0 ? (
                  inventoryGroups.map((group) => (
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
                              inventoryQuickFilter === 'alerted'
                                ? 'chip ingredients-inventory-filter-chip active ingredients-inventory-filter-chip-icon'
                                : 'chip ingredients-inventory-filter-chip ingredients-inventory-filter-chip-icon'
                            }
                            type="button"
                            onClick={() =>
                              setInventoryQuickFilter((current) => (current === 'alerted' ? 'all' : 'alerted'))
                            }
                          >
                            <IngredientWorkspaceIcon name="bell" />
                            仅看提醒
                          </button>
                          <button
                            className={
                              inventorySortMode === 'expiry'
                                ? 'chip ingredients-inventory-filter-chip active ingredients-inventory-filter-chip-icon'
                                : 'chip ingredients-inventory-filter-chip ingredients-inventory-filter-chip-icon'
                            }
                            type="button"
                            onClick={() =>
                              setInventorySortMode((current) => (current === 'expiry' ? 'default' : 'expiry'))
                            }
                          >
                            <IngredientWorkspaceIcon name="sort" />
                            按到期时间排序
                          </button>
                        </div>
                      </div>
                      <div className="ingredients-inventory-grid ingredients-storage-workbench-density-compact">
                        {group.items.map((summary) => (
                          <InventoryIngredientCard
                            key={summary.ingredient.id}
                            summary={summary}
                            onRestock={() => openInventoryOverlay(summary.ingredient.id)}
                            onConsume={() => openConsumeOverlay(summary.ingredient.id)}
                            onAddShopping={() =>
                              openShoppingOverlay({
                                ingredient: summary.ingredient,
                                reason: resolveShoppingReason(summary),
                              })
                            }
                            onDetail={() => openDetailView(summary)}
                            onDestroyExpired={() => openDestroyExpiredOverlay(summary.ingredient.id)}
                          />
                        ))}
                      </div>
                    </section>
                  ))
                ) : (
                  <EmptyState
                    title={summaries.length === 0 ? '还没有库存对象' : '没有匹配的库存食材'}
                    description={
                      summaries.length === 0
                        ? '先新增常用食材，再开始补库存和查看当前状态。'
                        : inventoryStorageFocus !== 'all'
                          ? `当前 ${inventoryStorageFocus} 位置下没有匹配结果，试试切回全部位置或换个关键词。`
                          : '试试新的搜索词，或者先为常用食材登记一批库存。'
                    }
                    action={
                      summaries.length === 0 ? (
                        <ActionButton tone="secondary" type="button" onClick={openCreateView}>
                          新增食材
                        </ActionButton>
                      ) : undefined
                    }
                  />
                )}
              </div>
            </div>
          )}

          {activePanel === 'shopping' && (
            <div className="ingredients-panel-stack ingredients-shopping-stack">
              <section className="ingredients-shopping-toolbar-shell">
                <div className="ingredients-shopping-toolbar-head">
                  <div className="ingredients-shopping-toolbar-copy">
                    <div className="ingredients-shopping-title-line">
                      <span className="ingredients-shopping-title-icon" aria-hidden="true">
                        <IngredientWorkspaceIcon name="shopping" />
                      </span>
                      <div>
                        <h3>采购工作台</h3>
                        <p className="subtle">先处理待买项，买完后可直接入库。</p>
                      </div>
                    </div>
                  </div>
                  <div className="ingredients-shopping-toolbar-actions">
                    <ActionButton tone="primary" type="button" onClick={() => openShoppingOverlay()}>
                      <span className="ingredients-shopping-action-icon" aria-hidden="true">
                        <IngredientWorkspaceIcon name="plus" />
                      </span>
                      新增采购项
                    </ActionButton>
                  </div>
                </div>
                <div className="ingredients-shopping-toolbar-metrics" aria-label="采购摘要">
                  {shoppingOverview.map((item) => (
                    <div
                      key={item.key}
                      className={
                        item.key === shoppingFocus
                          ? `ingredients-shopping-toolbar-metric active tone-${item.key}`
                          : `ingredients-shopping-toolbar-metric tone-${item.key}`
                      }
                    >
                      <span className="ingredients-shopping-toolbar-metric-icon" aria-hidden="true">
                        <IngredientWorkspaceIcon
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
                        <IngredientWorkspaceIcon name="search" />
                      </span>
                      <input
                        className="text-input"
                        placeholder="搜索待买名称、原因、分类或关联食材"
                        value={shoppingSearch}
                        onChange={(event) => setShoppingSearch(event.target.value)}
                      />
                    </span>
                  </label>
                  <div className="ingredients-shopping-filter-group">
                    <div className="ingredients-shopping-filter-row">
                      {shoppingOverview.map((item) => (
                        <button
                          key={item.key}
                          className={
                            shoppingFocus === item.key
                              ? 'chip ingredients-shopping-filter-chip active'
                              : 'chip ingredients-shopping-filter-chip'
                          }
                          type="button"
                          onClick={() =>
                            setShoppingFocus((current) => (current === item.key ? 'all' : item.key))
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
                      setShoppingSearch('');
                      setShoppingFocus('all');
                    }}
                    disabled={!shoppingSearch.trim() && shoppingFocus === 'all'}
                  >
                    <span className="ingredients-shopping-clear-filter-icon" aria-hidden="true">
                      <IngredientWorkspaceIcon name="reset" />
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
                      {visiblePendingShoppingCards.length} 项待买 ·{' '}
                      {visiblePendingShoppingCards.filter((card) => card.hasAttention).length} 项需优先处理
                      </span>
                    </div>
                  </div>
                </div>

                {visiblePendingShoppingCards.length > 0 ? (
                  <div className="shopping-work-row-list">
                    {visiblePendingShoppingCards.map((card) => (
                      <ShoppingWorkRow
                        key={card.shoppingItem.id}
                        card={card}
                        onComplete={() => openInventoryFromShopping(card.shoppingItem)}
                        onDetail={
                          card.linkedSummary ? () => openDetailView(card.linkedSummary as IngredientSummaryViewModel) : undefined
                        }
                        isBusy={props.isUpdatingShopping || props.isCreatingInventory}
                      />
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    title={pendingShoppingCards.length === 0 ? '待买区很清爽' : '没找到匹配的待买项'}
                    description={
                      pendingShoppingCards.length === 0
                        ? '当前没有待买项，可以从库存提醒或档案卡片一键加入采购。'
                        : shoppingFocus !== 'all'
                          ? `当前 ${activeShoppingOverview?.label ?? '筛选'} 下没有匹配结果，试试切回全部或换个关键词。`
                          : '换个关键词试试，或者直接新增一条新的待买项。'
                    }
                    action={
                      pendingShoppingCards.length === 0 ? (
                        <ActionButton tone="secondary" type="button" onClick={() => openShoppingOverlay()}>
                          新增采购项
                        </ActionButton>
                      ) : undefined
                    }
                  />
                )}
              </section>

              {completedShoppingCards.length > 0 && (
                <section className="ingredients-workbench-section shopping-history-shell">
                  <div className="ingredients-purchase-section-head shopping-history-head">
                    <div className="shopping-history-title-line">
                      <h3>已买回顾</h3>
                      <p className="subtle">已完成的采购项，助你回顾与补充。</p>
                    </div>
                    <div className="shopping-history-head-actions">
                      <Badge>{completedShoppingCards.length} 项</Badge>
                      <ActionButton
                        tone="tertiary"
                        size="compact"
                        type="button"
                        onClick={() => setShowCompletedShopping((current) => !current)}
                      >
                        {showCompletedShopping ? '收起已买' : '展开已买'}
                        <span className={showCompletedShopping ? 'shopping-history-toggle-icon is-open' : 'shopping-history-toggle-icon'} aria-hidden="true">
                          <IngredientWorkspaceIcon name="chevronDown" />
                        </span>
                      </ActionButton>
                    </div>
                  </div>

                  {showCompletedShopping ? (
                    visibleCompletedShoppingCards.length > 0 ? (
                      <div className="shopping-history-row-list">
                        {visibleCompletedShoppingCards.map((card) => (
                          <ShoppingHistoryRow
                            key={card.shoppingItem.id}
                            card={card}
                            onRestore={() =>
                              void props.updateShoppingItem({
                                itemId: card.shoppingItem.id,
                                done: false,
                              })
                            }
                            onDetail={
                              card.linkedSummary ? () => openDetailView(card.linkedSummary as IngredientSummaryViewModel) : undefined
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
          )}
        </div>
      </section>
      </div>

      <MobileQuickBar
        onCreate={openCreateView}
        onInventory={() => openInventoryOverlay()}
        onShopping={() => openShoppingOverlay()}
      />

      <OverlayLayer
        overlayMode={overlayMode}
        closeOverlay={closeOverlay}
        inventoryForm={inventoryForm}
        setInventoryForm={setInventoryForm}
        inventoryAdvancedOpen={inventoryAdvancedOpen}
        setInventoryAdvancedOpen={setInventoryAdvancedOpen}
        consumeForm={consumeForm}
        setConsumeForm={setConsumeForm}
        shoppingForm={shoppingForm}
        setShoppingForm={setShoppingForm}
        destroyExpiredIngredientId={destroyExpiredIngredientId}
        ingredients={ingredientOptions}
        ingredientSummaries={summaries}
        quickRestockIngredients={quickRestockIngredients}
        submitInventory={submitInventory}
        submitConsume={submitConsume}
        submitShopping={submitShopping}
        submitDestroyExpired={submitDestroyExpired}
        pendingShoppingToComplete={pendingShoppingToComplete}
        isCreatingInventory={props.isCreatingInventory}
        isConsumingInventory={props.isConsumingInventory}
        isDisposingExpiredInventory={props.isDisposingExpiredInventory}
        isCreatingShopping={props.isCreatingShopping}
      />
    </div>
  );
}

function MobileQuickBar(props: {
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

function OverlayLayer(props: {
  overlayMode: IngredientOverlayMode;
  closeOverlay: () => void;
  inventoryForm: InventoryDrawerFormState;
  setInventoryForm: (next: InventoryDrawerFormState) => void;
  inventoryAdvancedOpen: boolean;
  setInventoryAdvancedOpen: (next: boolean) => void;
  consumeForm: ConsumeDialogFormState;
  setConsumeForm: (next: ConsumeDialogFormState) => void;
  shoppingForm: ShoppingDialogFormState;
  setShoppingForm: (next: ShoppingDialogFormState) => void;
  destroyExpiredIngredientId: string | null;
  ingredients: Ingredient[];
  ingredientSummaries: IngredientSummaryViewModel[];
  quickRestockIngredients: Ingredient[];
  submitInventory: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  submitConsume: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  submitShopping: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  submitDestroyExpired: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  pendingShoppingToComplete: PendingShoppingCompletion | null;
  isCreatingInventory?: boolean;
  isConsumingInventory?: boolean;
  isDisposingExpiredInventory?: boolean;
  isCreatingShopping?: boolean;
}) {
  if (!props.overlayMode) {
    return null;
  }

  const selectedInventoryIngredient =
    props.ingredients.find((item) => item.id === props.inventoryForm.ingredientId) ?? null;
  const selectedConsumeSummary =
    props.ingredientSummaries.find((item) => item.ingredient.id === props.consumeForm.ingredientId) ?? null;
  const selectedDestroyExpiredSummary =
    props.destroyExpiredIngredientId
      ? props.ingredientSummaries.find((item) => item.ingredient.id === props.destroyExpiredIngredientId) ?? null
      : null;
  const destroyExpiredItems = selectedDestroyExpiredSummary
    ? buildDisposableExpiredInventoryItems(selectedDestroyExpiredSummary)
    : [];
  const destroyExpiredPresentation = selectedDestroyExpiredSummary
    ? buildInventoryCardPresentation(selectedDestroyExpiredSummary)
    : null;
  const consumeUnitOptions = buildConsumeUnitOptions(
    selectedConsumeSummary?.ingredient,
    selectedConsumeSummary?.availableInventoryItems ?? [],
    selectedConsumeSummary?.ingredient.default_unit
  );
  const selectedConsumeUnit =
    consumeUnitOptions.find((item) => item.unit === props.consumeForm.unit) ?? consumeUnitOptions[0] ?? null;
  const consumeAvailableQuantity = selectedConsumeUnit?.available ?? 0;
  const consumeStep = resolveConsumeStep(consumeAvailableQuantity);
  const parsedConsumeQuantity = parseOptionalNumber(props.consumeForm.quantity);
  const consumeSuggestedQuantity = resolveInitialConsumeQuantity(consumeAvailableQuantity);
  const consumeQuantityValue =
    parsedConsumeQuantity !== null ? clampConsumeQuantity(parsedConsumeQuantity, consumeAvailableQuantity) : 0;
  const consumeQuickValues =
    selectedConsumeUnit && consumeAvailableQuantity > 0
      ? buildConsumeQuickValues(selectedConsumeUnit.unit, consumeAvailableQuantity)
      : [];
  const consumeRemainingQuantity = getConsumeRemainingQuantity(consumeAvailableQuantity, consumeQuantityValue);
  const consumeIsAllState = isConsumeAllSelected(consumeQuantityValue, consumeAvailableQuantity);
  const consumeCanSubmit = Boolean(selectedConsumeUnit) && parsedConsumeQuantity !== null && consumeQuantityValue > 0;
  const consumeRangeProgress =
    consumeAvailableQuantity > 0 ? (consumeQuantityValue / consumeAvailableQuantity) * 100 : 0;
  const consumeRangeStyle = {
    '--touch-range-progress': `${clampNumber(consumeRangeProgress, 0, 100)}%`,
  } as CSSProperties;
  const consumeTotalRemainingLabel =
    selectedConsumeSummary?.quantitySummaries[0]?.label ??
    (selectedConsumeUnit ? `${formatNumericString(consumeAvailableQuantity)}${selectedConsumeUnit.unit}` : '暂无库存');
  const usesCustomStorage = !INVENTORY_STORAGE_PRESETS.includes(
    props.inventoryForm.storageLocation as (typeof INVENTORY_STORAGE_PRESETS)[number]
  );
  const inventoryUnitOptions = selectedInventoryIngredient
    ? getIngredientUnitOptions(selectedInventoryIngredient)
    : [];
  const selectedInventoryUnit =
    inventoryUnitOptions.find((item) => item.unit === props.inventoryForm.unit) ?? inventoryUnitOptions[0] ?? null;
  const inventoryNormalizedQuantity =
    selectedInventoryIngredient && parsePositiveNumber(props.inventoryForm.quantity) !== null
      ? convertQuantityToDefaultUnit(
          selectedInventoryIngredient,
          parsePositiveNumber(props.inventoryForm.quantity) ?? 0,
          props.inventoryForm.unit
        )
      : null;
  const inventoryQuantityValue =
    parsePositiveNumber(props.inventoryForm.quantity) ??
    resolveTouchDefaultValue(props.inventoryForm.unit || selectedInventoryIngredient?.default_unit || '个', 'quantity');
  const inventoryQuantityStep = resolveTouchStep(
    props.inventoryForm.unit || selectedInventoryIngredient?.default_unit || '个'
  );
  const inventoryQuantityQuickValues = resolveTouchQuickValues(
    props.inventoryForm.unit || selectedInventoryIngredient?.default_unit || '个',
    'quantity'
  );
  const inventoryExpiryDaysValue = resolveClampedDaysValue(
    props.inventoryForm.expiryDays,
    selectedInventoryIngredient?.default_expiry_days ?? 3
  );
  const shoppingUnitOptions = buildUnitPresetOptions(props.shoppingForm.unit || '个');
  const shoppingQuantityValue =
    parsePositiveNumber(props.shoppingForm.quantity) ??
    resolveTouchDefaultValue(props.shoppingForm.unit || '个', 'quantity');
  const shoppingQuantityStep = resolveTouchStep(props.shoppingForm.unit || '个');
  const shoppingQuantityQuickValues = resolveTouchQuickValues(props.shoppingForm.unit || '个', 'quantity');
  const selectedShoppingIngredient = props.shoppingForm.title.trim()
    ? props.ingredients.find((item) => item.name === props.shoppingForm.title.trim()) ?? null
    : null;
  const shoppingIngredientUnitOptions = selectedShoppingIngredient
    ? getIngredientUnitOptions(selectedShoppingIngredient)
    : [];
  const selectedShoppingIngredientPreview =
    selectedShoppingIngredient?.image?.url
      ? resolveAssetUrl(selectedShoppingIngredient.image.url)
      : buildIngredientPlaceholderSvg((selectedShoppingIngredient?.name ?? props.shoppingForm.title) || '待买项');
  const selectedShoppingIngredientMeta = selectedShoppingIngredient
    ? [
        selectedShoppingIngredient.category || '未分类',
        `默认 ${selectedShoppingIngredient.default_unit || '个'}`,
        selectedShoppingIngredient.default_storage || '常温',
      ]
    : [];
  const selectedIngredientPreview =
    selectedInventoryIngredient?.image?.url
      ? resolveAssetUrl(selectedInventoryIngredient.image.url)
      : buildIngredientPlaceholderSvg(selectedInventoryIngredient?.name ?? '食材');
  const selectedIngredientMeta = selectedInventoryIngredient
    ? [
        selectedInventoryIngredient.category || '未分类',
        `默认 ${selectedInventoryIngredient.default_unit || '个'}`,
        selectedInventoryIngredient.default_storage || '常温',
      ]
    : [];
  const selectedConsumePreview =
    selectedConsumeSummary?.ingredient.image?.url
      ? resolveAssetUrl(selectedConsumeSummary.ingredient.image.url)
      : buildIngredientPlaceholderSvg(selectedConsumeSummary?.ingredient.name ?? '食材');
  const selectedConsumeMeta = selectedConsumeSummary
    ? [
        selectedConsumeSummary.ingredient.category || '未分类',
        `默认 ${selectedConsumeSummary.ingredient.default_unit || '个'}`,
        selectedConsumeSummary.primaryStorage || selectedConsumeSummary.ingredient.default_storage || '常温',
      ]
    : [];
  const selectedDestroyExpiredPreview =
    selectedDestroyExpiredSummary?.ingredient.image?.url
      ? resolveAssetUrl(selectedDestroyExpiredSummary.ingredient.image.url)
      : buildIngredientPlaceholderSvg(selectedDestroyExpiredSummary?.ingredient.name ?? '食材');
  const selectedDestroyExpiredMeta = selectedDestroyExpiredSummary
    ? [
        selectedDestroyExpiredSummary.ingredient.category || '未分类',
        `默认 ${selectedDestroyExpiredSummary.ingredient.default_unit || '个'}`,
        selectedDestroyExpiredSummary.primaryStorage || selectedDestroyExpiredSummary.ingredient.default_storage || '常温',
      ]
    : [];

  if (props.overlayMode === 'destroyExpired' && !selectedDestroyExpiredSummary) {
    return null;
  }

  function syncInventoryIngredient(ingredient: Ingredient | null, ingredientQuery = ingredient?.name ?? '') {
    props.setInventoryForm(
      buildInventoryForm(props.ingredients, ingredient?.id, {
        ingredientQuery,
        ingredientLocked: props.inventoryForm.ingredientLocked && Boolean(ingredient),
        quantity: props.inventoryForm.quantity,
        unit: resolvePreferredIngredientUnit(ingredient, props.inventoryForm.unit),
        purchaseDate: props.inventoryForm.purchaseDate,
        purchaseDatePreset: props.inventoryForm.purchaseDatePreset,
        notes: props.inventoryForm.notes,
      })
    );
  }

  function updateConsumeUnit(unit: string) {
    const nextUnit = consumeUnitOptions.find((item) => item.unit === unit) ?? null;
    if (!nextUnit) {
      props.setConsumeForm({ ...props.consumeForm, unit });
      return;
    }
    const currentQuantity = parsePositiveNumber(props.consumeForm.quantity) ?? resolveInitialConsumeQuantity(nextUnit.available);
    props.setConsumeForm({
      ...props.consumeForm,
      unit,
      quantity: formatNumericString(clampConsumeQuantity(currentQuantity, nextUnit.available)),
    });
  }

  function updateConsumeQuantity(value: number) {
    props.setConsumeForm({
      ...props.consumeForm,
      unit: selectedConsumeUnit?.unit ?? props.consumeForm.unit,
      quantity: formatNumericString(clampConsumeQuantity(value, consumeAvailableQuantity)),
    });
  }

  function updateConsumeQuantityInput(value: string) {
    if (!value.trim()) {
      props.setConsumeForm({
        ...props.consumeForm,
        unit: selectedConsumeUnit?.unit ?? props.consumeForm.unit,
        quantity: '',
      });
      return;
    }

    const parsedValue = Number(value);
    if (!Number.isFinite(parsedValue)) {
      props.setConsumeForm({
        ...props.consumeForm,
        unit: selectedConsumeUnit?.unit ?? props.consumeForm.unit,
        quantity: value,
      });
      return;
    }

    updateConsumeQuantity(parsedValue);
  }

  return (
    <div className="workspace-overlay-root">
      <div className="workspace-overlay-backdrop" onClick={props.closeOverlay} />

      {props.overlayMode === 'inventory' && (
        <WorkspaceModal
          title="登记这批库存"
          description="把这次买回来的这一批快速记下来。"
          closeLabel="×"
          closeAriaLabel="关闭"
          className="workspace-modal-wide inventory-restock-modal"
          onClose={props.closeOverlay}
        >
          <form className="ingredients-restock-form" onSubmit={(event) => void props.submitInventory(event)}>
            <div className="ingredients-restock-scroll">
              {props.pendingShoppingToComplete && (
                <div className="ingredients-restock-source-note">
                  <Badge>来自待买项</Badge>
                  <span>{props.pendingShoppingToComplete.title}</span>
                </div>
              )}
              {!props.inventoryForm.ingredientLocked && !selectedInventoryIngredient && props.quickRestockIngredients.length > 0 && (
                <section className="ingredients-restock-field-group ingredients-restock-selection-strip">
                  <div className="ingredients-restock-field-head">
                    <span>最近常补</span>
                    <p className="subtle">常用食材点一下就行。</p>
                  </div>
                  <div className="ingredients-restock-choice-row">
                    {props.quickRestockIngredients.map((ingredient) => (
                      <button
                        key={ingredient.id}
                        type="button"
                        className={
                          props.inventoryForm.ingredientId === ingredient.id
                            ? 'ingredients-choice-chip active'
                            : 'ingredients-choice-chip'
                        }
                        onClick={() => syncInventoryIngredient(ingredient, ingredient.name)}
                      >
                        {ingredient.name}
                      </button>
                    ))}
                  </div>
                </section>
              )}

              {!props.inventoryForm.ingredientLocked && !selectedInventoryIngredient && (
                <label className="ingredients-restock-search-field">
                  <span>食材</span>
                  <input
                    className="text-input"
                    list="ingredient-restock-options"
                    placeholder="搜索或选择食材"
                    value={props.inventoryForm.ingredientQuery}
                    onChange={(event) => {
                      const nextQuery = event.target.value;
                      const ingredient = props.ingredients.find((item) => item.name === nextQuery) ?? null;
                      syncInventoryIngredient(ingredient, nextQuery);
                    }}
                  />
                  <datalist id="ingredient-restock-options">
                    {props.ingredients.map((ingredient) => (
                      <option key={ingredient.id} value={ingredient.name} />
                    ))}
                  </datalist>
                </label>
              )}

              {selectedInventoryIngredient && (
                <section className="ingredients-restock-identity-card">
                  <div className="ingredients-restock-identity-media">
                    <img src={selectedIngredientPreview} alt={selectedInventoryIngredient.name} />
                  </div>
                  <div className="ingredients-restock-identity-copy">
                    <div className="ingredients-restock-identity-head">
                      <div>
                        <h4>{selectedInventoryIngredient.name}</h4>
                        <p>{selectedIngredientMeta.join(' · ')}</p>
                      </div>
                      <Badge>{props.inventoryForm.ingredientLocked ? '当前食材' : '已选食材'}</Badge>
                    </div>
                    {!props.inventoryForm.ingredientLocked && (
                      <ActionButton
                        tone="tertiary"
                        size="compact"
                        type="button"
                        className="ingredients-restock-identity-switch"
                        onClick={() => syncInventoryIngredient(null, '')}
                      >
                        换一个食材
                      </ActionButton>
                    )}
                  </div>
                </section>
              )}

              <section className="ingredients-restock-field-group ingredients-restock-quantity-section">
                <div className="ingredients-restock-quantity-row">
                  <TouchStepperField
                    label="数量"
                    value={inventoryQuantityValue}
                    min={inventoryQuantityStep}
                    step={inventoryQuantityStep}
                    quickValues={inventoryQuantityQuickValues}
                    allowCustomInput
                    customInputMode="inline"
                    customInputLabel="直接输入"
                    inputMin={inventoryQuantityStep}
                    inputStep={inventoryQuantityStep}
                    formatValue={(value) => formatNumericString(value)}
                    onChange={(value) =>
                      props.setInventoryForm({
                        ...props.inventoryForm,
                        quantity: formatNumericString(value),
                      })
                    }
                  />
                  <section className="ingredients-restock-unit-card">
                    <div className="ingredients-restock-unit-card-head">
                      <span>单位</span>
                      <strong>{props.inventoryForm.unit || selectedInventoryIngredient?.default_unit || '个'}</strong>
                    </div>
                    <p className="subtle">
                      {selectedInventoryIngredient
                        ? selectedInventoryUnit?.unit === selectedInventoryIngredient.default_unit
                          ? '默认按主单位直接记库存'
                          : inventoryNormalizedQuantity !== null
                            ? `将记为 ${formatNumericString(inventoryNormalizedQuantity)}${selectedInventoryIngredient.default_unit} 库存`
                            : '切换单位后会自动折算到主单位'
                        : '先选食材，再切换这次录入单位。'}
                    </p>
                    <div className="ingredients-restock-unit-chip-row">
                      {(selectedInventoryIngredient
                        ? inventoryUnitOptions
                        : [{ unit: props.inventoryForm.unit || '个', ratio_to_default: 1 }]
                      ).map((option) => (
                        <button
                          key={`inventory-unit-${option.unit}`}
                          type="button"
                          className={
                            props.inventoryForm.unit === option.unit
                              ? 'ingredients-choice-chip ingredients-unit-chip active'
                              : 'ingredients-choice-chip ingredients-unit-chip'
                          }
                          onClick={() =>
                            props.setInventoryForm({
                              ...props.inventoryForm,
                              unit: option.unit,
                            })
                          }
                          disabled={!selectedInventoryIngredient}
                        >
                          {option.unit}
                        </button>
                      ))}
                    </div>
                  </section>
                </div>
              </section>

              <section className="ingredients-restock-field-group">
                <div className="ingredients-restock-field-head">
                  <span>购买时间</span>
                  <p className="subtle">默认今天，需要时再改。</p>
                </div>
                <div className="ingredients-restock-choice-row">
                  {[
                    { value: 'today', label: '今天', date: todayKey() },
                    { value: 'yesterday', label: '昨天', date: addDateKeyDays(todayKey(), -1) },
                    { value: 'custom', label: '自定义', date: props.inventoryForm.purchaseDate },
                  ].map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      className={
                        props.inventoryForm.purchaseDatePreset === item.value
                          ? 'ingredients-choice-chip active'
                          : 'ingredients-choice-chip'
                      }
                      onClick={() =>
                        props.setInventoryForm({
                          ...props.inventoryForm,
                          purchaseDatePreset: item.value as InventoryPurchasePreset,
                          purchaseDate: item.value === 'custom' ? props.inventoryForm.purchaseDate : item.date,
                        })
                      }
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                {props.inventoryForm.purchaseDatePreset === 'custom' && (
                  <label>
                    <span>购买日期</span>
                    <input
                      className="text-input"
                      type="date"
                      required
                      value={props.inventoryForm.purchaseDate}
                      onChange={(event) =>
                        props.setInventoryForm({
                          ...props.inventoryForm,
                          purchaseDate: event.target.value,
                          purchaseDatePreset: 'custom',
                        })
                      }
                    />
                  </label>
                )}
              </section>

              <section className="ingredients-restock-field-group">
                <div className="ingredients-restock-field-head">
                  <span>存放位置</span>
                  <p className="subtle">按这次实际放的位置点一下。</p>
                </div>
                <div className="ingredients-restock-choice-row">
                  {INVENTORY_STORAGE_PRESETS.map((storage) => (
                    <button
                      key={storage}
                      type="button"
                      className={
                        props.inventoryForm.storageLocation === storage
                          ? 'ingredients-choice-chip active'
                          : 'ingredients-choice-chip'
                      }
                      onClick={() =>
                        props.setInventoryForm({
                          ...props.inventoryForm,
                          storageLocation: storage,
                        })
                      }
                    >
                      {storage}
                    </button>
                  ))}
                  <button
                    type="button"
                    className={usesCustomStorage ? 'ingredients-choice-chip active' : 'ingredients-choice-chip'}
                    onClick={() =>
                      props.setInventoryForm({
                        ...props.inventoryForm,
                        storageLocation:
                          usesCustomStorage && props.inventoryForm.storageLocation
                            ? props.inventoryForm.storageLocation
                            : '',
                      })
                    }
                  >
                    其他
                  </button>
                </div>
                {usesCustomStorage && (
                  <label>
                    <span>自定义位置</span>
                    <input
                      className="text-input"
                      value={props.inventoryForm.storageLocation}
                      placeholder="例如 门边小冰箱"
                      onChange={(event) =>
                        props.setInventoryForm({
                          ...props.inventoryForm,
                          storageLocation: event.target.value,
                        })
                      }
                    />
                  </label>
                )}
              </section>

              <section className="ingredients-restock-field-group">
                <div className="ingredients-restock-field-head">
                  <span>到期信息</span>
                  <p className="subtle">确认这批食材怎么跟踪到期。</p>
                </div>
                <div className="ingredients-restock-choice-row">
                  {[
                    { value: 'none', label: '不记录' },
                    { value: 'days', label: '几天后到期' },
                    { value: 'manual_date', label: '包装到期日' },
                  ].map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      className={
                        props.inventoryForm.expiryInputMode === item.value
                          ? 'ingredients-choice-chip active'
                          : 'ingredients-choice-chip'
                      }
                      onClick={() =>
                        props.setInventoryForm({
                          ...props.inventoryForm,
                          expiryInputMode: item.value as IngredientExpiryMode,
                          expiryDays:
                            item.value === 'days'
                              ? props.inventoryForm.expiryDays ||
                                (selectedInventoryIngredient?.default_expiry_days
                                  ? String(selectedInventoryIngredient.default_expiry_days)
                                  : '3')
                              : '',
                          expiryDate:
                            item.value === 'manual_date'
                              ? props.inventoryForm.expiryDate
                              : item.value === 'days'
                                ? resolveExpiryDateFromDays(
                                    props.inventoryForm.purchaseDate,
                                    props.inventoryForm.expiryDays ||
                                      (selectedInventoryIngredient?.default_expiry_days
                                        ? String(selectedInventoryIngredient.default_expiry_days)
                                        : '3')
                                  )
                                : '',
                        })
                      }
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                {props.inventoryForm.expiryInputMode === 'days' ? (
                  <div className="ingredients-restock-expiry-grid">
                    <TouchRangeField
                      label="买后几天到期"
                      value={inventoryExpiryDaysValue}
                      min={1}
                      max={30}
                      step={1}
                      marks={EXPIRY_DAY_MARKS}
                      formatValue={(value) => `${value} 天`}
                      onChange={(value) =>
                        props.setInventoryForm({
                          ...props.inventoryForm,
                          expiryDays: String(value),
                        })
                      }
                    />
                    <div className="ingredients-restock-result-card">
                      <span>预计到期日</span>
                      <strong>
                        {props.inventoryForm.expiryDate ? formatDate(props.inventoryForm.expiryDate) : '先选天数'}
                      </strong>
                      <p>
                        {props.inventoryForm.expiryDate
                          ? `${props.inventoryForm.purchaseDate} 购入`
                          : '拖动后会自动换算日期'}
                      </p>
                    </div>
                  </div>
                ) : props.inventoryForm.expiryInputMode === 'manual_date' ? (
                  <label>
                    <span>包装到期日</span>
                    <input
                      className="text-input"
                      type="date"
                      required
                      value={props.inventoryForm.expiryDate}
                      onChange={(event) =>
                        props.setInventoryForm({ ...props.inventoryForm, expiryDate: event.target.value })
                      }
                    />
                  </label>
                ) : (
                  <p className="ingredients-restock-field-note">这批不跟踪到期提醒。</p>
                )}
              </section>

              <section className="ingredients-modal-advanced">
                <button
                  className="ghost-button ingredients-modal-advanced-toggle"
                  type="button"
                  onClick={() => props.setInventoryAdvancedOpen(!props.inventoryAdvancedOpen)}
                >
                  {props.inventoryAdvancedOpen ? '收起更多选项' : '更多选项'}
                </button>
                {props.inventoryAdvancedOpen && (
                  <div className="form-grid compact-grid ingredients-modal-advanced-fields">
                    <label>
                      <span>状态</span>
                      <select
                        className="text-input"
                        value={props.inventoryForm.status}
                        onChange={(event) =>
                          props.setInventoryForm({
                            ...props.inventoryForm,
                            status: event.target.value as InventoryStatus,
                            statusDirty: true,
                          })
                        }
                      >
                        {Object.entries(INVENTORY_STATUS_LABELS).map(([key, label]) => (
                          <option key={key} value={key}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="span-two">
                      <span>备注</span>
                      <textarea
                        className="text-input"
                        rows={3}
                        value={props.inventoryForm.notes}
                        onChange={(event) =>
                          props.setInventoryForm({ ...props.inventoryForm, notes: event.target.value })
                        }
                      />
                    </label>
                  </div>
                )}
              </section>
            </div>

            <div className="ingredients-restock-footer-bar">
              <div className="workspace-overlay-actions">
                <ActionButton tone="secondary" type="button" onClick={props.closeOverlay}>
                  取消
                </ActionButton>
                <ActionButton
                  tone="primary"
                  type="submit"
                  disabled={props.isCreatingInventory || !props.inventoryForm.ingredientId}
                >
                  {props.isCreatingInventory ? '保存中...' : '保存这批库存'}
                </ActionButton>
              </div>
            </div>
          </form>
        </WorkspaceModal>
      )}

      {props.overlayMode === 'consume' && selectedConsumeSummary && (
        <WorkspaceModal
          title="快速消费"
          description="记下这次实际用掉多少，系统会自动从更早到期的批次开始扣减。"
          closeLabel="×"
          closeAriaLabel="关闭"
          className="consume-quick-modal"
          onClose={props.closeOverlay}
        >
          <form className="consume-quick-form" onSubmit={(event) => void props.submitConsume(event)}>
            <div className="consume-quick-scroll">
              <section className="ingredients-restock-identity-card ingredients-consume-identity-card">
                <div className="ingredients-restock-identity-media">
                  <img src={selectedConsumePreview} alt={selectedConsumeSummary.ingredient.name} />
                </div>
                <div className="ingredients-restock-identity-copy">
                  <div className="ingredients-restock-identity-head">
                    <div>
                      <h4>{selectedConsumeSummary.ingredient.name}</h4>
                      <p>{selectedConsumeMeta.join(' · ')}</p>
                    </div>
                    <div className="consume-quick-identity-badges">
                      <Badge>{selectedConsumeSummary.inventoryItems.length} 条批次</Badge>
                      {consumeIsAllState && <Badge className="consume-quick-state-badge">接近清空</Badge>}
                    </div>
                  </div>
                  <div className="consume-quick-identity-summary">
                    <article className="consume-quick-summary-card is-primary">
                      <span>当前总剩余</span>
                      <strong>{consumeTotalRemainingLabel}</strong>
                      <p>{selectedConsumeSummary.inventoryItems.length} 条批次会参与这次扣减</p>
                    </article>
                    <article className="consume-quick-summary-card">
                      <span>扣减方式</span>
                      <strong>优先更早到期</strong>
                      <p>系统会自动从更早到期的批次开始扣减。</p>
                    </article>
                  </div>
                  <div className="ingredients-consume-stock-strip consume-quick-stock-strip">
                    {consumeUnitOptions.map((item) => (
                      <span key={`${selectedConsumeSummary.ingredient.id}-${item.unit}`} className="ingredient-visual-pill">
                        可按 {item.unit} 记 {formatNumericString(item.available)}
                        {item.unit}
                      </span>
                    ))}
                  </div>
                </div>
              </section>

              <section className="ingredients-restock-field-group ingredients-consume-unit-section">
                <div className="ingredients-restock-field-head">
                  <span>记录单位</span>
                  <p className="subtle">
                    {consumeUnitOptions.length > 1
                      ? '先选这次实际用掉的是哪种单位，切换后数量会自动对齐到该单位剩余量。'
                      : '直接按这个单位记录就行，系统会自动处理批次扣减。'}
                  </p>
                </div>
                {consumeUnitOptions.length === 1 && selectedConsumeUnit ? (
                  <div className="ingredients-consume-unit-single">
                    <div className="ingredients-consume-unit-single-main">
                      <span>当前单位</span>
                      <strong>{selectedConsumeUnit.unit}</strong>
                    </div>
                    <div className="ingredients-consume-unit-single-meta">
                      <span>当前剩余</span>
                      <strong>
                        {formatNumericString(selectedConsumeUnit.available)}
                        {selectedConsumeUnit.unit}
                      </strong>
                    </div>
                  </div>
                ) : (
                  <div className="ingredients-restock-choice-row ingredients-consume-unit-row">
                    {consumeUnitOptions.map((item) => (
                      <button
                        key={`${selectedConsumeSummary.ingredient.id}-${item.unit}`}
                        type="button"
                        className={
                          selectedConsumeUnit?.unit === item.unit
                            ? 'ingredients-choice-chip ingredients-consume-unit-chip active'
                            : 'ingredients-choice-chip ingredients-consume-unit-chip'
                        }
                        onClick={() => updateConsumeUnit(item.unit)}
                      >
                        <span className="ingredients-consume-unit-chip-label">{item.unit}</span>
                        <small>
                          当前剩余 {formatNumericString(item.available)}
                          {item.unit}
                        </small>
                      </button>
                    ))}
                  </div>
                )}
              </section>

              <section
                className={
                  consumeIsAllState
                    ? 'ingredients-restock-field-group ingredients-consume-amount-section is-all'
                    : 'ingredients-restock-field-group ingredients-consume-amount-section'
                }
              >
                <div className="ingredients-restock-field-head">
                  <span>消费量</span>
                  <p className="subtle">拖动滑条快速操作，也可以点快捷值或直接输入来微调。</p>
                </div>
                <div className="consume-quick-live-row">
                  <article className="consume-quick-live-card is-active">
                    <span>本次消费</span>
                    <strong>
                      {selectedConsumeUnit ? `${formatNumericString(consumeQuantityValue)}${selectedConsumeUnit.unit}` : '先选单位'}
                    </strong>
                    <p>滑动时会实时同步到提交结果。</p>
                  </article>
                  <article className={consumeIsAllState ? 'consume-quick-live-card is-warning' : 'consume-quick-live-card'}>
                    <span>消费后剩余</span>
                    <strong>
                      {selectedConsumeUnit
                        ? `${formatNumericString(consumeRemainingQuantity)}${selectedConsumeUnit.unit}`
                        : '先选单位'}
                    </strong>
                    <p>{consumeIsAllState ? '这次会把当前单位库存几乎用完。' : '保留量会随着拖动即时更新。'}</p>
                  </article>
                </div>
                <div
                  className={consumeIsAllState ? 'touch-field touch-range-field consume-quick-range-field is-all' : 'touch-field touch-range-field consume-quick-range-field'}
                >
                  <div className="touch-field-head consume-quick-range-head">
                    <span>拖拉条</span>
                    <label className="consume-quick-range-editor-shell">
                      <input
                        className="consume-quick-range-editor-input"
                        type="number"
                        min={0}
                        max={consumeAvailableQuantity || undefined}
                        step={consumeStep}
                        inputMode="decimal"
                        aria-label="消费量输入"
                        placeholder={formatNumericString(consumeSuggestedQuantity)}
                        value={props.consumeForm.quantity}
                        disabled={!selectedConsumeUnit}
                        onChange={(event) => updateConsumeQuantityInput(event.target.value)}
                      />
                      <strong>{(selectedConsumeUnit?.unit ?? props.consumeForm.unit) || '单位'}</strong>
                    </label>
                  </div>
                  <div className="touch-field-helper">
                    {selectedConsumeUnit
                      ? `当前最多 ${formatNumericString(consumeAvailableQuantity)}${selectedConsumeUnit.unit}，拖动或直接改数字都会同步预估剩余量。`
                      : '先选择单位'}
                  </div>
                  <div className="touch-range-main">
                    <ActionButton
                      tone="secondary"
                      size="compact"
                      type="button"
                      className="touch-stepper-button"
                      aria-label="消费量减少"
                      disabled={!selectedConsumeUnit}
                      onClick={() => updateConsumeQuantity(consumeQuantityValue - consumeStep)}
                    >
                      -
                    </ActionButton>
                    <input
                      className="touch-range-input"
                      type="range"
                      min={0}
                      max={consumeAvailableQuantity || consumeStep}
                      step={consumeStep}
                      value={consumeQuantityValue}
                      style={consumeRangeStyle}
                      disabled={!selectedConsumeUnit}
                      aria-valuetext={
                        selectedConsumeUnit
                          ? `${formatNumericString(consumeQuantityValue)}${selectedConsumeUnit.unit}`
                          : formatNumericString(consumeQuantityValue)
                      }
                      onChange={(event) => updateConsumeQuantity(Number(event.target.value))}
                    />
                    <ActionButton
                      tone="secondary"
                      size="compact"
                      type="button"
                      className="touch-stepper-button"
                      aria-label="消费量增加"
                      disabled={!selectedConsumeUnit}
                      onClick={() => updateConsumeQuantity(consumeQuantityValue + consumeStep)}
                    >
                      +
                    </ActionButton>
                  </div>
                </div>
                {consumeQuickValues.length > 0 && (
                  <div className="consume-quick-shortcut-row">
                    {consumeQuickValues.map((item) => {
                      const isActive = item.isAll
                        ? consumeIsAllState
                        : Math.abs(consumeQuantityValue - item.value) < 0.001;
                      const className = [
                        'consume-quick-shortcut',
                        isActive ? 'active' : '',
                        item.isAll ? 'is-all' : '',
                      ]
                        .filter(Boolean)
                        .join(' ');

                      return (
                        <button
                          key={item.key}
                          type="button"
                          className={className}
                          disabled={!selectedConsumeUnit}
                          onClick={() => updateConsumeQuantity(item.value)}
                        >
                          {item.label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </section>
            </div>

            <div className="consume-quick-footer-bar">
              <div className="consume-quick-footer-summary">
                <span>本次将记录</span>
                <strong>
                  {selectedConsumeUnit ? `${formatNumericString(consumeQuantityValue)}${selectedConsumeUnit.unit}` : '先选单位'}
                </strong>
                <p>
                  {selectedConsumeUnit
                    ? consumeIsAllState
                      ? '提交后这一单位库存会接近清空。'
                      : `提交后剩余 ${formatNumericString(consumeRemainingQuantity)}${selectedConsumeUnit.unit}。`
                    : '系统会自动优先扣减更早到期批次。'}
                </p>
              </div>
              <div className="workspace-overlay-actions">
                <ActionButton tone="secondary" type="button" onClick={props.closeOverlay}>
                  取消
                </ActionButton>
                <ActionButton
                  tone="primary"
                  type="submit"
                  disabled={props.isConsumingInventory || !consumeCanSubmit}
                >
                  {props.isConsumingInventory ? '保存中...' : '记录这次消费'}
                </ActionButton>
              </div>
            </div>
          </form>
        </WorkspaceModal>
      )}

      {props.overlayMode === 'destroyExpired' && selectedDestroyExpiredSummary && (
        <WorkspaceModal
          title="销毁已过期批次"
          description="会将这些过期批次的剩余量清零，但保留批次历史记录和活动日志。"
          closeLabel="×"
          closeAriaLabel="关闭"
          className="workspace-modal-wide destroy-expired-modal"
          onClose={props.closeOverlay}
        >
          <form className="destroy-expired-form" onSubmit={(event) => void props.submitDestroyExpired(event)}>
            <div className="destroy-expired-scroll">
              <section className="ingredients-restock-identity-card destroy-expired-summary-card">
                <div className="ingredients-restock-identity-media">
                  <img src={selectedDestroyExpiredPreview} alt={selectedDestroyExpiredSummary.ingredient.name} />
                </div>
                <div className="ingredients-restock-identity-copy">
                  <div className="ingredients-restock-identity-head">
                    <div>
                      <h4>{selectedDestroyExpiredSummary.ingredient.name}</h4>
                      <p>{selectedDestroyExpiredMeta.join(' · ')}</p>
                    </div>
                    <div className="destroy-expired-summary-badges">
                      <Badge>{destroyExpiredItems.length} 条待销毁</Badge>
                      <Badge>{destroyExpiredPresentation?.headline ?? '未登记'}</Badge>
                    </div>
                  </div>
                  <div className="destroy-expired-summary-grid">
                    <article className="destroy-expired-summary-metric is-primary">
                      <span>本次处理范围</span>
                      <strong>{destroyExpiredItems.length} 条过期批次</strong>
                      <p>仅包含已经过期且当前仍有剩余量的批次。</p>
                    </article>
                    <article className="destroy-expired-summary-metric">
                      <span>处理结果</span>
                      <strong>清零剩余量</strong>
                      <p>批次记录、备注和活动日志都会继续保留。</p>
                    </article>
                  </div>
                </div>
              </section>

              <section className="ingredients-restock-field-group destroy-expired-list-section">
                <div className="ingredients-restock-field-head">
                  <span>将要销毁的批次</span>
                  <p className="subtle">
                    只列出到期日早于今天的剩余批次；今天到期和未来到期不会出现在这里。
                  </p>
                </div>
                {destroyExpiredItems.length > 0 ? (
                  <div className="destroy-expired-list">
                    {destroyExpiredItems.map((item) => (
                      <article key={item.id} className="destroy-expired-item">
                        <div className="destroy-expired-item-head">
                          <div className="destroy-expired-item-title">
                            <strong>{item.remainingLabel}</strong>
                            <span>{item.storageLocation}</span>
                          </div>
                          <div className="destroy-expired-item-badges">
                            <Badge className="destroy-expired-item-badge is-danger">
                              已过期 {formatRelativeDays(item.expiryDate)}
                            </Badge>
                            <Badge>{INVENTORY_STATUS_LABELS[item.status]}</Badge>
                          </div>
                        </div>
                        <div className="destroy-expired-item-meta">
                          <span>购买于 {formatDate(item.purchaseDate)}</span>
                          <span>到期日 {formatDate(item.expiryDate)}</span>
                        </div>
                        <p className="destroy-expired-item-note" title={item.notes || '当前没有备注'}>
                          {item.notes || '当前没有备注'}
                        </p>
                      </article>
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    title="当前没有可销毁的批次"
                    description="这份食材现在没有“已过期且仍有剩余量”的批次，可以直接关闭这个面板。"
                  />
                )}
              </section>
            </div>

            <div className="destroy-expired-footer-bar">
              <div className="destroy-expired-footer-summary">
                <span>确认后将处理</span>
                <strong>{destroyExpiredItems.length} 条过期批次</strong>
                <p>
                  {destroyExpiredItems.length > 0
                    ? '系统会把这些批次的剩余量清零，并在刷新后同步库存状态。'
                    : '当前没有可销毁的过期批次。'}
                </p>
              </div>
              <div className="workspace-overlay-actions">
                <ActionButton tone="secondary" type="button" onClick={props.closeOverlay}>
                  取消
                </ActionButton>
                <ActionButton
                  tone="primary"
                  type="submit"
                  disabled={props.isDisposingExpiredInventory || destroyExpiredItems.length === 0}
                >
                  {props.isDisposingExpiredInventory ? '销毁中...' : '确认销毁'}
                </ActionButton>
              </div>
            </div>
          </form>
        </WorkspaceModal>
      )}

      {props.overlayMode === 'shopping' && (
        <WorkspaceModal
          title="新增采购项"
          description="把这次要买的数量和原因快速记下来。"
          closeLabel="×"
          closeAriaLabel="关闭"
          className="workspace-modal-wide shopping-quick-modal"
          onClose={props.closeOverlay}
        >
          <form className="shopping-quick-form" onSubmit={(event) => void props.submitShopping(event)}>
            <div className="shopping-quick-scroll">
              {selectedShoppingIngredient ? (
                <section className="ingredients-restock-identity-card">
                  <div className="ingredients-restock-identity-media">
                    <img src={selectedShoppingIngredientPreview} alt={selectedShoppingIngredient.name} />
                  </div>
                  <div className="ingredients-restock-identity-copy">
                    <div className="ingredients-restock-identity-head">
                      <div>
                        <h4>{selectedShoppingIngredient.name}</h4>
                        <p>{selectedShoppingIngredientMeta.join(' · ')}</p>
                      </div>
                      <Badge>档案食材</Badge>
                    </div>
                  </div>
                </section>
              ) : (
                <label className="shopping-quick-name-field">
                  <span>名称</span>
                  <input
                    className="text-input"
                    list="shopping-ingredient-options"
                    placeholder="输入名称或直接选食材"
                    value={props.shoppingForm.title}
                    onChange={(event) => {
                      const nextTitle = event.target.value;
                      const matchedIngredient = props.ingredients.find((item) => item.name === nextTitle) ?? null;
                      props.setShoppingForm({
                        ...props.shoppingForm,
                        title: nextTitle,
                        unit: matchedIngredient
                          ? resolvePreferredIngredientUnit(matchedIngredient, props.shoppingForm.unit) ||
                            matchedIngredient.default_unit
                          : props.shoppingForm.unit,
                      });
                    }}
                  />
                  <datalist id="shopping-ingredient-options">
                    {props.ingredients.map((ingredient) => (
                      <option key={ingredient.id} value={ingredient.name} />
                    ))}
                  </datalist>
                </label>
              )}

              <section className="ingredients-restock-field-group ingredients-restock-quantity-section">
                <div className="ingredients-restock-quantity-row">
                  <TouchStepperField
                    label="数量"
                    value={shoppingQuantityValue}
                    min={shoppingQuantityStep}
                    step={shoppingQuantityStep}
                    quickValues={shoppingQuantityQuickValues}
                    allowCustomInput
                    customInputMode="inline"
                    customInputLabel="直接输入"
                    inputMin={shoppingQuantityStep}
                    inputStep={shoppingQuantityStep}
                    formatValue={(value) => formatNumericString(value)}
                    helper="常见数量点一下就能完成。"
                    onChange={(value) =>
                      props.setShoppingForm({
                        ...props.shoppingForm,
                        quantity: formatNumericString(value),
                      })
                    }
                  />
                  <section className="ingredients-restock-unit-card">
                    <div className="ingredients-restock-unit-card-head">
                      <span>单位</span>
                      <strong>{props.shoppingForm.unit || selectedShoppingIngredient?.default_unit || '个'}</strong>
                    </div>
                    {selectedShoppingIngredient ? (
                      <>
                        <p className="subtle">默认先用主单位，常用副单位点一下就能切换。</p>
                        <div className="ingredients-restock-unit-chip-row">
                          {shoppingIngredientUnitOptions.map((option) => (
                            <button
                              key={`shopping-unit-${option.unit}`}
                              type="button"
                              className={
                                props.shoppingForm.unit === option.unit
                                  ? 'ingredients-choice-chip ingredients-unit-chip active'
                                  : 'ingredients-choice-chip ingredients-unit-chip'
                              }
                              onClick={() =>
                                props.setShoppingForm({
                                  ...props.shoppingForm,
                                  unit: option.unit,
                                })
                              }
                            >
                              {option.unit}
                            </button>
                          ))}
                        </div>
                      </>
                    ) : (
                      <>
                        <p className="subtle">默认值不对时再改。</p>
                        <details className="ingredients-restock-unit-editor">
                          <summary>修改单位</summary>
                          <input
                            className="text-input"
                            list="shopping-unit-options"
                            value={props.shoppingForm.unit}
                            onChange={(event) =>
                              props.setShoppingForm({ ...props.shoppingForm, unit: event.target.value })
                            }
                          />
                          <datalist id="shopping-unit-options">
                            {shoppingUnitOptions.map((unit) => (
                              <option key={unit} value={unit} />
                            ))}
                          </datalist>
                        </details>
                      </>
                    )}
                  </section>
                </div>
              </section>

              <section className="ingredients-restock-field-group">
                <div className="ingredients-restock-field-head">
                  <span>原因</span>
                  <p className="subtle">留一句自己回头能看懂的备注就行。</p>
                </div>
                <input
                  className="text-input"
                  placeholder="例如 备一份新的，替换临期库存"
                  value={props.shoppingForm.reason}
                  onChange={(event) =>
                    props.setShoppingForm({ ...props.shoppingForm, reason: event.target.value })
                  }
                />
              </section>
            </div>

            <div className="shopping-quick-footer-bar">
              <div className="workspace-overlay-actions">
                <ActionButton tone="secondary" type="button" onClick={props.closeOverlay}>
                  取消
                </ActionButton>
                <ActionButton tone="primary" type="submit" disabled={props.isCreatingShopping}>
                  {props.isCreatingShopping ? '保存中...' : '加入清单'}
                </ActionButton>
              </div>
            </div>
          </form>
        </WorkspaceModal>
      )}
    </div>
  );
}
