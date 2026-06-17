import { request } from './request';
import type {
  ConsumeInventoryResponse,
  DisposeInventoryResponse,
  DisposeExpiredInventoryResponse,
  Ingredient,
  InventoryItem,
  ShoppingListItem,
} from './types';

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
  getInventory: () => request<InventoryItem[]>('/api/inventory'),
  createInventory: (payload: {
    ingredient_id: string;
    quantity: number;
    unit: string;
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
  consumeInventory: (payload: { ingredient_id: string; quantity: number; unit: string }) =>
    request<ConsumeInventoryResponse>('/api/inventory/consume', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  disposeExpiredInventory: (payload: { ingredient_id: string; inventory_item_ids: string[] }) =>
    request<DisposeExpiredInventoryResponse>('/api/inventory/dispose-expired', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  disposeInventory: (payload: { inventory_item_id: string; quantity?: number; unit?: string; reason: string }) =>
    request<DisposeInventoryResponse>('/api/inventory/dispose', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getShoppingList: () => request<ShoppingListItem[]>('/api/shopping-list'),
  createShoppingItem: (payload: { title: string; quantity: number; unit: string; reason: string }) =>
    request<ShoppingListItem>('/api/shopping-list', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateShoppingItem: (itemId: string, done: boolean) =>
    request<ShoppingListItem>(`/api/shopping-list/${itemId}`, {
      method: 'PATCH',
      body: JSON.stringify({ done }),
    }),
};
