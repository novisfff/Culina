import { request } from './request';
import type {
  ConsumeInventoryResponse,
  DisposeExpiredInventoryResponse,
  Ingredient,
  InventoryItem,
  ShoppingListItem,
} from './types';

export const ingredientsApi = {
  getIngredients: () => request<Ingredient[]>('/api/ingredients'),
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
