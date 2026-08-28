import type {
  InventoryOperationResult,
  InventoryReconciliationRequest,
  InventoryReconciliationResponse,
} from '../../api/types/inventory';
import { useInventoryReconciliationActions } from './useInventoryReconciliationActions';
import { useInventoryReconciliationState } from './useInventoryReconciliationState';
import type { InventoryReconciliationScope } from './inventoryReconciliationScope';

export function useReconciliationController(args: {
  familyId: string;
  userId: string;
  referenceDate: string;
  fetchReconciliation: (args: { scope: InventoryReconciliationScope; storageLocation: string | null }) => Promise<InventoryReconciliationResponse>;
  submitReconciliation: (request: InventoryReconciliationRequest) => Promise<InventoryOperationResult>;
  invalidateAfterInventoryOperation: () => Promise<void>;
  showNotice: (notice: { tone: 'success' | 'warning' | 'danger'; title: string; message: string }) => void;
}) {
  const state = useInventoryReconciliationState();
  const actions = useInventoryReconciliationActions({ ...args, state });
  return { state, actions };
}
