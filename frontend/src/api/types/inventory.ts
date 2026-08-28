/** Inventory and reconciliation contracts. */
import type { IngredientUnitConversion, MediaAsset } from './media';
import type { IngredientExpiryMode, InventoryStatus } from './primitives';
import type { UserSummary } from './shell';
export type { IngredientExpiryMode, InventoryStatus } from './primitives';

export type IngredientQuantityTrackingMode = 'track_quantity' | 'not_track_quantity';

export interface Ingredient {
  id: string;
  family_id: string;
  name: string;
  category: string;
  default_unit: string;
  unit_conversions: IngredientUnitConversion[];
  quantity_tracking_mode?: IngredientQuantityTrackingMode;
  default_storage: string;
  default_expiry_mode: IngredientExpiryMode;
  default_expiry_days?: number | null;
  default_low_stock_threshold?: number | null;
  notes: string;
  image?: MediaAsset | null;
  row_version?: number;
  created_at: string;
  updated_at: string;
  created_by?: string | null;
  updated_by?: string | null;
}

export interface InventoryItem {
  id: string;
  family_id: string;
  ingredient_id: string;
  ingredient_name: string;
  quantity_tracking_mode?: IngredientQuantityTrackingMode;
  quantity: number;
  consumed_quantity?: number;
  disposed_quantity?: number;
  remaining_quantity?: number;
  unit: string;
  entered_quantity?: number | null;
  entered_unit?: string | null;
  status: InventoryStatus;
  purchase_date: string;
  expiry_date?: string | null;
  storage_location: string;
  notes: string;
  low_stock_threshold: number;
  created_at: string;
  updated_at: string;
  created_by?: string | null;
  updated_by?: string | null;
  row_version: number;
  expiry_alert_snoozed_until?: string | null;
  expiry_reviewed_at?: string | null;
  expiry_reviewed_by?: string | null;
  last_confirmed_at?: string | null;
  last_confirmed_by?: string | null;
  last_confirmation_source?: InventoryConfirmationSource | null;
}


export type InventoryAvailabilityLevel = 'present_unknown' | 'low' | 'sufficient' | 'absent';
export type InventoryConfirmationSource = 'manual_entry' | 'reconciliation' | 'shopping_intake';
export type InventoryConfirmationStatus = 'never_confirmed' | 'current' | 'stale';

export interface IngredientInventoryState {
  id: string;
  family_id: string;
  ingredient_id: string;
  availability_level: InventoryAvailabilityLevel;
  inventory_status: InventoryStatus;
  purchase_date: string | null;
  expiry_date: string | null;
  storage_location: string | null;
  notes: string;
  expiry_alert_snoozed_until: string | null;
  expiry_reviewed_at: string | null;
  expiry_reviewed_by: string | null;
  last_confirmed_at: string | null;
  last_confirmed_by: string | null;
  last_confirmation_source: InventoryConfirmationSource | null;
  row_version: number;
  created_at: string;
  updated_at: string;
}

export type UpsertIngredientInventoryStateRequest = {
  expected_ingredient_row_version: number;
  state_id?: string | null;
  expected_state_row_version?: number | null;
  availability_level: InventoryAvailabilityLevel;
  inventory_status: InventoryStatus;
  purchase_date?: string | null;
  expiry_date?: string | null;
  storage_location?: string | null;
  notes?: string;
};

export type SnoozeStateExpiryAlertRequest = {
  action: 'retain_expired' | 'snooze_upcoming';
  state_id: string;
  expected_row_version: number;
  snoozed_until: string;
};

export type CorrectStateExpiryDateRequest = {
  state_id: string;
  expected_row_version: number;
  expiry_date: string;
};

export type SetInventoryStateAbsentRequest = {
  state_id: string;
  expected_row_version: number;
};

export type ShoppingIntakeItemRequest =
  | {
      shopping_item_id: string;
      expected_shopping_item_row_version: number;
      action: 'stock_and_fulfill';
      target_kind: 'exact_ingredient';
      target_id: string;
      expected_ingredient_row_version: number;
      actual_quantity: number;
      unit: string;
      inventory_status: InventoryStatus;
      expiry_date: string | null;
      storage_location: string;
      notes: string;
    }
  | {
      shopping_item_id: string;
      expected_shopping_item_row_version: number;
      action: 'stock_and_fulfill';
      target_kind: 'presence_ingredient';
      target_id: string;
      expected_ingredient_row_version: number;
      state_id: string | null;
      expected_state_row_version: number | null;
      resulting_availability_level: Exclude<InventoryAvailabilityLevel, 'absent'>;
      inventory_status: InventoryStatus;
      expiry_date: string | null;
      storage_location: string;
      notes: string;
    }
  | {
      shopping_item_id: string;
      expected_shopping_item_row_version: number;
      action: 'stock_and_fulfill';
      target_kind: 'food';
      target_id: string;
      expected_food_row_version: number;
      actual_quantity: number;
      unit: string;
      expiry_date: string | null;
      storage_location: string;
    }
  | {
      shopping_item_id: string;
      expected_shopping_item_row_version: number;
      action: 'complete_without_inventory';
      target_kind: 'none';
      target_id: null;
    };

export interface ShoppingIntakeRequest {
  client_request_id: string;
  purchase_date: string;
  items: ShoppingIntakeItemRequest[];
}

export interface ShoppingIntakeItemResult {
  shopping_item_id: string;
  result: 'completed' | 'partial' | 'stocked' | 'completed_without_inventory';
  remaining_planned_quantity: number | null;
  inventory_item_id: string | null;
  state_id: string | null;
  food_id: string | null;
}

export interface InventoryOperationDisplaySummary {
  title: string;
  description: string;
  confirmed_count: number;
  adjusted_count: number;
  completed_count: number;
  partial_count: number;
}

export interface InventoryOperationResult {
  operation_id: string;
  operation_type: 'reconciliation' | 'shopping_intake';
  status: 'applied' | 'reverted';
  applied_at: string;
  revertible_until: string;
  can_revert: boolean;
  summary: InventoryOperationDisplaySummary;
}

export interface InventoryOperationSummary extends InventoryOperationResult {
  actor_display_name: string;
}

export type InventoryOperationEntityType =
  | 'ingredient'
  | 'inventory_item'
  | 'non_tracked_ingredient_state'
  | 'food'
  | 'shopping_list_item';

export type InventoryOperationChangeType = 'create' | 'update' | 'delete';

export interface InventoryOperationLineDisplay {
  sequence: number;
  entity_type: InventoryOperationEntityType;
  change_type: InventoryOperationChangeType;
  title: string;
  description: string;
}

export interface InventoryOperationDetail extends InventoryOperationSummary {
  lines: InventoryOperationLineDisplay[];
}

export interface ShoppingIntakeResult extends InventoryOperationResult {
  items: ShoppingIntakeItemResult[];
}

export interface ReconciliationSummary {
  total_groups: number;
  never_confirmed: number;
  stale: number;
  expired_physical_batches: number;
}

export interface ReconciliationBatch {
  inventory_item_id: string;
  row_version: number;
  remaining_quantity: number;
  unit: string;
  status: InventoryStatus;
  purchase_date: string;
  expiry_date: string | null;
  storage_location: string;
  notes: string;
  confirmation_status: InventoryConfirmationStatus;
  last_confirmed_at: string | null;
}

export interface ExactIngredientReconciliationGroup {
  kind: 'exact_ingredient';
  ingredient_id: string;
  ingredient_name: string;
  ingredient_row_version: number;
  default_unit?: string;
  unit_conversions?: IngredientUnitConversion[];
  confirmation_status: InventoryConfirmationStatus;
  last_confirmed_at: string | null;
  batches: ReconciliationBatch[];
  pending_shopping_item_id: string | null;
}

export interface PresenceIngredientReconciliationGroup {
  kind: 'presence_ingredient';
  ingredient_id: string;
  ingredient_name: string;
  ingredient_row_version: number;
  state: IngredientInventoryState;
  confirmation_status: InventoryConfirmationStatus;
  pending_shopping_item_id: string | null;
}

export interface FoodReconciliationGroup {
  kind: 'food';
  food_id: string;
  food_name: string;
  row_version: number;
  stock_quantity: number;
  stock_unit: string;
  expiry_date: string | null;
  storage_location: string | null;
  confirmation_status: InventoryConfirmationStatus;
  last_confirmed_at: string | null;
}

export type InventoryReconciliationGroup =
  | ExactIngredientReconciliationGroup
  | PresenceIngredientReconciliationGroup
  | FoodReconciliationGroup;

export interface InventoryReconciliationResponse {
  business_date: string;
  business_timezone: 'Asia/Shanghai';
  generated_at: string;
  summary: ReconciliationSummary;
  groups: InventoryReconciliationGroup[];
}

export interface VersionedObservedBatchRequest {
  inventory_item_id: string;
  expected_row_version: number;
}

export interface InventoryBatchUpdateRequest {
  inventory_item_id: string;
  expected_row_version: number;
  actual_remaining_quantity: number;
  inventory_status: InventoryStatus;
  purchase_date: string;
  expiry_date: string | null;
  storage_location: string;
  notes: string;
}

export interface InventoryBatchCreateRequest {
  client_line_id: string;
  actual_remaining_quantity: number;
  unit: string;
  inventory_status: InventoryStatus;
  purchase_date: string;
  expiry_date: string | null;
  storage_location: string;
  notes: string;
}

export type InventoryReconciliationGroupRequest =
  | {
      kind: 'exact_ingredient';
      ingredient_id: string;
      expected_ingredient_row_version: number;
      action: 'confirm_all' | 'set_absent' | 'adjust_batches';
      observed_batches: VersionedObservedBatchRequest[];
      updates: InventoryBatchUpdateRequest[];
      creates: InventoryBatchCreateRequest[];
    }
  | {
      kind: 'presence_ingredient';
      ingredient_id: string;
      state_id: string | null;
      expected_ingredient_row_version: number;
      expected_state_row_version: number | null;
      availability_level: InventoryAvailabilityLevel;
      inventory_status: InventoryStatus;
      purchase_date: string | null;
      expiry_date: string | null;
      storage_location: string | null;
      notes: string;
    }
  | {
      kind: 'food';
      food_id: string;
      expected_row_version: number;
      action: 'confirm' | 'set_stock';
      stock_quantity: number | null;
      stock_unit: string | null;
      expiry_date: string | null;
      storage_location: string | null;
    };

export interface InventoryReconciliationRequest {
  client_request_id: string;
  scope: 'suggested' | 'refrigerated' | 'frozen' | 'room_temperature' | 'all';
  storage_location: string | null;
  groups: InventoryReconciliationGroupRequest[];
}

export type InventoryOverviewScope = 'all' | 'ingredient' | 'food';
export type InventoryOverviewSourceType = 'ingredient' | 'food';
export type InventoryOverviewTone = 'stable' | 'warning' | 'danger' | 'empty';
export type InventoryOverviewPrimaryAction = 'restock' | 'consume' | 'dispose' | 'record_meal' | 'edit_food_stock';

export interface InventoryOverviewItem {
  id: string;
  source_type: InventoryOverviewSourceType;
  source_id: string;
  row_version: number;
  inventory_item_id?: string | null;
  title: string;
  category: string;
  image?: MediaAsset | null;
  quantity?: number | null;
  unit: string;
  quantity_label: string;
  quantity_tracking_mode: IngredientQuantityTrackingMode;
  status?: InventoryStatus | null;
  tone: InventoryOverviewTone;
  expiry_date?: string | null;
  days_until_expiry?: number | null;
  storage_location: string;
  purchase_source?: string | null;
  updated_at: string;
  primary_action: InventoryOverviewPrimaryAction;
  search_text: string;
}

export interface InventoryOverview {
  scope: InventoryOverviewScope;
  query: string;
  summary: {
    total_count: number;
    ingredient_count: number;
    food_count: number;
    alert_count: number;
    expiring_count: number;
    empty_count: number;
  };
  items: InventoryOverviewItem[];
}

export interface FoodStockChangePayload {
  expected_row_version: number;
  quantity: number;
  unit?: string | null;
  expiry_date?: string | null;
  purchase_source?: string | null;
  storage_location?: string | null;
  note?: string;
  reason?: string;
}

export interface ShoppingListItem {
  id: string;
  family_id: string;
  ingredient_id?: string | null;
  food_id?: string | null;
  target_type?: 'ingredient' | 'food' | 'free_text';
  title: string;
  quantity: number;
  unit: string;
  quantity_mode?: IngredientQuantityTrackingMode;
  display_label?: string | null;
  reason: string;
  done: boolean;
  created_at: string;
  updated_at: string;
  created_by?: string | null;
  updated_by?: string | null;
  row_version: number;
}

export interface ConsumeInventoryResponse {
  ingredient_id: string;
  unit: string;
  consumed_quantity: number;
  affected_item_ids: string[];
}

export interface DisposeInventoryResponse {
  ingredient_id: string;
  inventory_item_id: string;
  unit: string;
  disposed_quantity: number;
  remaining_quantity: number;
}

export type VersionedInventoryItemRef = {
  inventory_item_id: string;
  expected_row_version: number;
};

export type PresenceTransitionResolution = {
  availability_level: InventoryAvailabilityLevel;
  inventory_status: InventoryStatus;
  purchase_date?: string | null;
  expiry_date?: string | null;
  storage_location?: string | null;
  notes?: string;
  mark_inventory_confirmed?: boolean;
};

export type ExactTransitionResolution = {
  confirm_absent: boolean;
  quantity?: number | null;
  unit?: string | null;
  inventory_status?: InventoryStatus | null;
  purchase_date?: string | null;
  expiry_date?: string | null;
  storage_location?: string | null;
  notes?: string;
};

export type IngredientTrackingModeTransitionRequest = {
  expected_ingredient_row_version: number;
  target_mode: IngredientQuantityTrackingMode;
  expected_state_row_version?: number | null;
  observed_batches?: VersionedInventoryItemRef[];
  presence_resolution?: PresenceTransitionResolution | null;
  exact_resolution?: ExactTransitionResolution | null;
};

export type DisposeExpiredInventoryRequest = {
  ingredient_id: string;
  items: VersionedInventoryItemRef[];
};

export type SnoozeExpiryAlertsAction = 'retain_expired' | 'snooze_upcoming';

export type SnoozeExpiryAlertsRequest = {
  action: SnoozeExpiryAlertsAction;
  ingredient_id: string;
  items: VersionedInventoryItemRef[];
  snoozed_until: string;
};

export type SnoozeExpiryAlertsResponse = {
  ingredient_id: string;
  snoozed_item_ids: string[];
  snoozed_count: number;
  reviewed_expired_count: number;
  snoozed_until: string;
};

export type CorrectInventoryExpiryDateRequest = {
  expiry_date: string;
  expected_row_version: number;
};

export interface DisposeExpiredInventoryResponse {
  ingredient_id: string;
  disposed_item_ids: string[];
  disposed_count: number;
}
