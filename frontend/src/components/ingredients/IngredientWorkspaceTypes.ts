import type { ReactNode } from 'react';
import type {
  ConsumeInventoryResponse,
  CorrectInventoryExpiryDateRequest,
  DisposeExpiredInventoryRequest,
  DisposeExpiredInventoryResponse,
  Food,
  Ingredient,
  IngredientExpiryMode,
  IngredientInventoryState,
  IngredientUnitConversion,
  InventoryItem,
  InventoryStatus,
  MealType,
  Recipe,
  ShoppingListItem,
  SnoozeExpiryAlertsRequest,
  UpsertIngredientInventoryStateRequest,
} from '../../api/types';

export type IngredientWorkspaceProps = {
  ingredients: Ingredient[];
  foods: Food[];
  inventoryItems: InventoryItem[];
  inventoryStates?: IngredientInventoryState[];
  recipes: Recipe[];
  shoppingItems: ShoppingListItem[];
  recordMeal?: (payload: import('../../api/types').RecordMealPayload) => Promise<import('../../api/types').RecordMealResponse>;
  loadMealCandidates?: (date: string, mealType: MealType) => Promise<import('../../api/types').MealLogCandidate[]>;
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
    },
  ) => Promise<Ingredient>;
  transitionIngredientTrackingMode?: (
    ingredientId: string,
    payload: import('../../api/types').IngredientTrackingModeTransitionRequest,
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
  upsertInventoryState: (ingredientId: string, payload: UpsertIngredientInventoryStateRequest) => Promise<IngredientInventoryState>;
  consumeInventory: (payload: { ingredient_id: string; quantity?: number | null; unit?: string | null }) => Promise<ConsumeInventoryResponse>;
  disposeExpiredInventory: (payload: DisposeExpiredInventoryRequest) => Promise<DisposeExpiredInventoryResponse | unknown>;
  snoozeInventoryExpiryAlerts: (payload: SnoozeExpiryAlertsRequest) => Promise<unknown>;
  correctInventoryExpiryDate: (inventoryItemId: string, payload: CorrectInventoryExpiryDateRequest) => Promise<unknown>;
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
