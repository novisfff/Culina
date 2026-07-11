import { request } from './request';
import type {
  CorrectStateExpiryDateRequest,
  IngredientInventoryState,
  SetInventoryStateAbsentRequest,
  SnoozeStateExpiryAlertRequest,
  UpsertIngredientInventoryStateRequest,
} from './types';

export const inventoryStatesApi = {
  listInventoryStates: (params: { ingredient_ids?: string[] } = {}) => {
    const search = new URLSearchParams();
    for (const ingredientId of params.ingredient_ids ?? []) {
      if (ingredientId.trim()) {
        search.append('ingredient_ids', ingredientId.trim());
      }
    }
    const suffix = search.size > 0 ? `?${search.toString()}` : '';
    return request<IngredientInventoryState[]>(`/api/inventory/states${suffix}`);
  },
  upsertInventoryState: (ingredientId: string, payload: UpsertIngredientInventoryStateRequest) =>
    request<IngredientInventoryState>(`/api/inventory/states/${ingredientId}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  snoozeStateExpiryAlert: (ingredientId: string, payload: SnoozeStateExpiryAlertRequest) =>
    request<IngredientInventoryState>(`/api/inventory/states/${ingredientId}/snooze-expiry-alert`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  correctStateExpiryDate: (ingredientId: string, payload: CorrectStateExpiryDateRequest) =>
    request<IngredientInventoryState>(`/api/inventory/states/${ingredientId}/expiry-date`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  setInventoryStateAbsent: (ingredientId: string, payload: SetInventoryStateAbsentRequest) =>
    request<IngredientInventoryState>(`/api/inventory/states/${ingredientId}/set-absent`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
};
