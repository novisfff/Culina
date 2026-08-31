import type {
  Food,
  Ingredient,
  IngredientInventoryState,
  InventoryConfirmationStatus,
  InventoryItem,
  ShoppingListItem,
} from '../../api/types';
import type { ExpiryInventoryActionGroup } from '../../features/inventory/inventoryActionModel';

export type IngredientWorkspaceView = 'hub' | 'catalog' | 'detail' | 'create';
export type IngredientOverlayMode = 'inventory' | 'shopping' | 'consume' | 'inventoryAction' | null;
export type IngredientWorkspacePanel = 'catalog' | 'inventory' | 'shopping';

export type IngredientAlertViewModel = {
  id: string;
  ingredientId: string;
  ingredientName: string;
  title: string;
  detail: string;
  tone: 'warning' | 'danger';
  kind: 'lowStock' | 'expiry';
  /** Present for expiry alerts; sourced from shared inventory action severity. */
  severity?: ExpiryInventoryActionGroup['severity'];
  storageLocation: string;
};

export type QuantitySummaryViewModel = { unit: string; total: number; label: string };

export type IngredientSummaryViewModel = {
  ingredient: Ingredient;
  inventoryItems: InventoryItem[];
  availableInventoryItems: InventoryItem[];
  /** Presence-only current fact; null for exact-tracked ingredients or absent/default. */
  inventoryState: IngredientInventoryState | null;
  alerts: IngredientAlertViewModel[];
  quantitySummaries: QuantitySummaryViewModel[];
  hasMultipleUnits: boolean;
  primaryStorage: string;
  storageLocations: string[];
  recipeReferences: Array<{ id: string; title: string }>;
  latestPurchaseDate: string | null;
  latestUpdatedAt: string;
  /** First-version confirmation freshness: never_confirmed | current | stale. */
  confirmationStatus: InventoryConfirmationStatus;
  confirmationLabel: string;
  confirmationTone: InventoryConfirmationTone;
  lastConfirmedAt: string | null;
};

export type StorageGroupViewModel = {
  key: string;
  label: string;
  items: IngredientSummaryViewModel[];
  totalBatches: number;
  alertCount: number;
};

export type InventoryCardTone = 'stable' | 'warning' | 'danger' | 'empty';
export type IngredientAlertTone = 'warning' | 'danger';
export type CatalogCardStatusTone = 'stable' | 'warning' | 'danger' | 'empty';

export type InventoryCardStatusViewModel = {
  label: '库存正常' | '库存偏低' | '临期或过期' | '还没有可用库存';
  tone: InventoryCardTone;
  detail: string;
  priority: number;
};

export type InventoryCardExpiryTone = 'neutral' | 'warning' | 'danger';
export type InventoryConfirmationTone = 'neutral' | 'current' | 'stale';

export type InventoryCardPresentationViewModel = {
  headline: string;
  secondary: string;
  footerNote: string;
  hasExpiryInfo: boolean;
  expiryLabel: string | null;
  expiryDateLabel: string | null;
  expiryTone: InventoryCardExpiryTone | null;
  confirmationStatus: InventoryConfirmationStatus;
  confirmationLabel: string;
  confirmationTone: InventoryConfirmationTone;
  lastConfirmedAt: string | null;
};

export type DisposableExpiredInventoryItemViewModel = {
  id: string;
  ingredientId: string;
  ingredientName: string;
  remainingQuantity: number;
  remainingLabel: string;
  unit: string;
  purchaseDate: string;
  expiryDate: string;
  storageLocation: string;
  notes: string;
  status: InventoryItem['status'];
  createdAt: string;
  rowVersion: number;
  expiryAlertSnoozedUntil: string | null;
  expiryReviewedAt: string | null;
  expiryReviewedBy: string | null;
};

export type InventoryStorageOverviewTone = 'stable' | 'warning' | 'danger' | 'muted';

export type InventoryStorageOverviewViewModel = {
  key: string;
  label: string;
  ingredientCount: number;
  totalBatches: number;
  alertCount: number;
  tone: InventoryStorageOverviewTone;
  statusLabel: string;
};

export type InventoryBatchItemViewModel = {
  id: string;
  ingredientId: string;
  ingredientName: string;
  ingredientImageUrl?: string;
  quantityLabel: string;
  status: InventoryItem['status'];
  purchaseDate: string;
  expiryDate?: string | null;
  storageLocation: string;
  notes: string;
  alerts: IngredientAlertViewModel[];
};

export type InventoryBatchGroupViewModel = {
  key: string;
  label: string;
  items: InventoryBatchItemViewModel[];
};

export type IngredientCategoryPreset = {
  label: string;
  defaultUnit: string;
  defaultStorage: string;
  quantityTrackingMode?: Ingredient['quantity_tracking_mode'];
  icon: string;
};

export type ShoppingCardFocus = 'all' | 'attention' | 'linked' | 'freeform';
export type ShoppingCardTone = 'attention' | 'linked' | 'freeform';
export type ShoppingCardStatusTone = 'stable' | 'warning' | 'danger' | 'muted';
export type ShoppingOverviewTone = 'stable' | 'warning' | 'linked' | 'freeform' | 'muted';

export type ShoppingCardViewModel = {
  shoppingItem: ShoppingListItem;
  linkedSummary: IngredientSummaryViewModel | null;
  linkedFood: Food | null;
  title: string;
  headline: string;
  quantityLabel: string;
  subline: string;
  contextTags: string[];
  reasonLabel: string;
  contextLine: string;
  inventoryLabel: string;
  inventoryNote: string;
  footerNote: string;
  statusLabel: string;
  statusTone: ShoppingCardStatusTone;
  sourceLabel: '关联食材' | '成品速食' | '其他采购';
  tone: ShoppingCardTone;
  isLinked: boolean;
  hasAttention: boolean;
  updatedAt: string;
  searchText: string;
};

export type ShoppingOverviewViewModel = {
  key: ShoppingCardFocus;
  label: string;
  count: number;
  tone: ShoppingOverviewTone;
  detail: string;
};
