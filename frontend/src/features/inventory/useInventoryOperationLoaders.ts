import { useCallback } from 'react';
import { api } from '../../api/client';
import type { InventoryReconciliationResponse } from '../../api/types/inventory';
import type { InventoryReconciliationScope } from './inventoryReconciliationScope';

export function useInventoryOperationLoaders() {
  const fetchReconciliation = useCallback(
    ({ scope, storageLocation }: { scope: InventoryReconciliationScope; storageLocation: string | null }): Promise<InventoryReconciliationResponse> =>
      api.getInventoryReconciliation({ scope, storage_location: storageLocation }),
    [],
  );
  const getOperationDetail = useCallback(
    (operationId: string) => api.getInventoryOperation(operationId),
    [],
  );

  return { fetchReconciliation, getOperationDetail };
}
