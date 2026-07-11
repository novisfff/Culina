import { request } from './request';
import type {
  ConsumeInventoryResponse,
  CorrectInventoryExpiryDateRequest,
  DisposeExpiredInventoryRequest,
  DisposeInventoryResponse,
  DisposeExpiredInventoryResponse,
  Ingredient,
  IngredientTrackingModeTransitionRequest,
  InventoryOverview,
  InventoryOverviewScope,
  InventoryItem,
  ShoppingListItem,
  SnoozeExpiryAlertsRequest,
  SnoozeExpiryAlertsResponse,
} from './types';

export type UpdateShoppingItemPayload = {
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

export const ingredientsApi = {
  getIngredients: (params: { q?: string; limit?: number; offset?: number } = {}) => {
    const search = new URLSearchParams();
    if (params.q?.trim()) search.set('q', params.q.trim());
    if (params.limit !== undefined) search.set('limit', String(params.limit));
    if (params.offset !== undefined) search.set('offset', String(params.offset));
    const suffix = search.size > 0 ? `?${search.toString()}` : '';
    return request<Ingredient[]>(`/api/ingredients${suffix}`);
  },
  createIngredient: (payload: {
    name: string;
    category: string;
    default_unit: string;
    unit_conversions: Array<{ unit: string; ratio_to_default: number }>;
    quantity_tracking_mode?: Ingredient['quantity_tracking_mode'];
    default_storage: string;
    default_expiry_mode: string;
    default_expiry_days?: number | null;
    default_low_stock_threshold?: number | null;
    notes: string;
    media_ids: string[];
    pending_image_job_id?: string | null;
  }) =>
    request<Ingredient>('/api/ingredients', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateIngredient: (
    ingredientId: string,
    payload: {
      name: string;
      category: string;
      default_unit: string;
      unit_conversions: Array<{ unit: string; ratio_to_default: number }>;
      quantity_tracking_mode?: Ingredient['quantity_tracking_mode'];
      default_storage: string;
      default_expiry_mode: string;
      default_expiry_days?: number | null;
      default_low_stock_threshold?: number | null;
      notes: string;
      media_ids: string[];
      pending_image_job_id?: string | null;
    }
  ) =>
    request<Ingredient>(`/api/ingredients/${ingredientId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  transitionIngredientTrackingMode: (ingredientId: string, payload: IngredientTrackingModeTransitionRequest) =>
    request<Ingredient>(`/api/ingredients/${ingredientId}/tracking-mode`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  getInventory: (params: { q?: string } = {}) => {
    const search = new URLSearchParams();
    if (params.q?.trim()) search.set('q', params.q.trim());
    const suffix = search.size > 0 ? `?${search.toString()}` : '';
    return request<InventoryItem[]>(`/api/inventory${suffix}`);
  },
  getInventoryOverview: (params: { scope?: InventoryOverviewScope; q?: string } = {}) => {
    const search = new URLSearchParams();
    if (params.scope && params.scope !== 'all') search.set('scope', params.scope);
    if (params.q?.trim()) search.set('q', params.q.trim());
    const suffix = search.size > 0 ? `?${search.toString()}` : '';
    return request<InventoryOverview>(`/api/inventory/overview${suffix}`);
  },
  createInventory: (payload: {
    ingredient_id: string;
    quantity?: number | null;
    unit?: string | null;
    status: string;
    purchase_date: string;
    expiry_date?: string;
    storage_location: string;
    notes: string;
    low_stock_threshold?: number;
  }) =>
    request<InventoryItem>('/api/inventory', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  consumeInventory: (payload: { ingredient_id: string; quantity?: number | null; unit?: string | null }) =>
    request<ConsumeInventoryResponse>('/api/inventory/consume', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  disposeExpiredInventory: (payload: DisposeExpiredInventoryRequest) =>
    request<DisposeExpiredInventoryResponse>('/api/inventory/dispose-expired', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  snoozeInventoryExpiryAlerts: (payload: SnoozeExpiryAlertsRequest) =>
    request<SnoozeExpiryAlertsResponse>('/api/inventory/snooze-expiry-alerts', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  correctInventoryExpiryDate: (inventoryItemId: string, payload: CorrectInventoryExpiryDateRequest) =>
    request<InventoryItem>(`/api/inventory/${inventoryItemId}/expiry-date`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  disposeInventory: (payload: { inventory_item_id: string; quantity?: number; unit?: string; reason: string }) =>
    request<DisposeInventoryResponse>('/api/inventory/dispose', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getShoppingList: () => request<ShoppingListItem[]>('/api/shopping-list'),
  createShoppingItem: (payload: {
    title: string;
    quantity?: number | null;
    unit?: string | null;
    ingredient_id?: string | null;
    food_id?: string | null;
    quantity_mode?: ShoppingListItem['quantity_mode'];
    display_label?: string | null;
    reason: string;
  }) =>
    request<ShoppingListItem>('/api/shopping-list', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateShoppingItem: (itemId: string, payload: UpdateShoppingItemPayload) =>
    request<ShoppingListItem>(`/api/shopping-list/${itemId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  deleteShoppingItem: (itemId: string) =>
    request<void>(`/api/shopping-list/${itemId}`, {
      method: 'DELETE',
    }),
};
