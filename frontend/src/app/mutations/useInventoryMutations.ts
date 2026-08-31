import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { invalidateAfterInventoryChanged, invalidateAfterInventoryOperation } from '../../api/cacheInvalidation';
export function useInventoryMutations() {
  const queryClient = useQueryClient();
  const changed = async () => invalidateAfterInventoryChanged(queryClient);
  const operation = async () => invalidateAfterInventoryOperation(queryClient);
  const createInventoryMutation = useMutation({ mutationFn: api.createInventory, onSuccess: changed });
  const consumeInventoryMutation = useMutation({ mutationFn: api.consumeInventory, onSuccess: changed });
  const disposeExpiredInventoryMutation = useMutation({ mutationFn: api.disposeExpiredInventory, onSuccess: changed });
  const snoozeInventoryExpiryAlertsMutation = useMutation({ mutationFn: api.snoozeInventoryExpiryAlerts, onSuccess: changed });
  const correctInventoryExpiryDateMutation = useMutation({ mutationFn: ({ inventoryItemId, payload }: { inventoryItemId: string; payload: Parameters<typeof api.correctInventoryExpiryDate>[1] }) => api.correctInventoryExpiryDate(inventoryItemId, payload), onSuccess: changed });
  const upsertInventoryStateMutation = useMutation({ mutationFn: ({ ingredientId, payload }: { ingredientId: string; payload: Parameters<typeof api.upsertInventoryState>[1] }) => api.upsertInventoryState(ingredientId, payload), retry: false, onSuccess: operation });
  const snoozeStateExpiryAlertMutation = useMutation({ mutationFn: ({ ingredientId, payload }: { ingredientId: string; payload: Parameters<typeof api.snoozeStateExpiryAlert>[1] }) => api.snoozeStateExpiryAlert(ingredientId, payload), retry: false, onSuccess: operation });
  const correctStateExpiryDateMutation = useMutation({ mutationFn: ({ ingredientId, payload }: { ingredientId: string; payload: Parameters<typeof api.correctStateExpiryDate>[1] }) => api.correctStateExpiryDate(ingredientId, payload), retry: false, onSuccess: operation });
  const setInventoryStateAbsentMutation = useMutation({ mutationFn: ({ ingredientId, payload }: { ingredientId: string; payload: Parameters<typeof api.setInventoryStateAbsent>[1] }) => api.setInventoryStateAbsent(ingredientId, payload), retry: false, onSuccess: operation });
  const submitShoppingIntakeMutation = useMutation({ mutationFn: api.submitShoppingIntake, retry: false, onSuccess: operation });
  const submitInventoryReconciliationMutation = useMutation({ mutationFn: api.submitInventoryReconciliation, retry: false, onSuccess: operation });
  const revertInventoryOperationMutation = useMutation({ mutationFn: api.revertInventoryOperation, retry: false, onSuccess: operation });
  return { createInventoryMutation, consumeInventoryMutation, disposeExpiredInventoryMutation, snoozeInventoryExpiryAlertsMutation, correctInventoryExpiryDateMutation, upsertInventoryStateMutation, snoozeStateExpiryAlertMutation, correctStateExpiryDateMutation, setInventoryStateAbsentMutation, submitShoppingIntakeMutation, submitInventoryReconciliationMutation, revertInventoryOperationMutation };
}
