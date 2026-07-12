import { request } from './request';
import type {
  InventoryOperationDetail,
  InventoryOperationResult,
  InventoryOperationSummary,
  InventoryReconciliationRequest,
  InventoryReconciliationResponse,
  ShoppingIntakeRequest,
  ShoppingIntakeResult,
} from './types';

export type InventoryReconciliationScope =
  | 'suggested'
  | 'refrigerated'
  | 'frozen'
  | 'room_temperature'
  | 'all';

export const inventoryOperationsApi = {
  getInventoryReconciliation: (params: {
    scope?: InventoryReconciliationScope;
    storage_location?: string | null;
  } = {}) => {
    const search = new URLSearchParams();
    if (params.scope) {
      search.set('scope', params.scope);
    }
    if (params.storage_location?.trim()) {
      search.set('storage_location', params.storage_location.trim());
    }
    const suffix = search.size > 0 ? `?${search.toString()}` : '';
    return request<InventoryReconciliationResponse>(`/api/inventory/reconciliation${suffix}`);
  },
  submitInventoryReconciliation: (payload: InventoryReconciliationRequest) =>
    request<InventoryOperationResult>('/api/inventory/reconciliations', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  submitShoppingIntake: (payload: ShoppingIntakeRequest) =>
    request<ShoppingIntakeResult>('/api/shopping-list/intakes', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  listInventoryOperations: (params: { limit?: number } = {}) => {
    const search = new URLSearchParams();
    if (params.limit !== undefined) {
      search.set('limit', String(params.limit));
    }
    const suffix = search.size > 0 ? `?${search.toString()}` : '';
    return request<InventoryOperationSummary[]>(`/api/inventory/operations${suffix}`);
  },
  getInventoryOperation: (operationId: string) =>
    request<InventoryOperationDetail>(`/api/inventory/operations/${operationId}`),
  revertInventoryOperation: (operationId: string) =>
    request<InventoryOperationResult>(`/api/inventory/operations/${operationId}/revert`, {
      method: 'POST',
    }),
};
