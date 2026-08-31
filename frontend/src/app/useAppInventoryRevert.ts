import { useCallback, type Dispatch, type SetStateAction } from 'react';
import type { InventoryOperationDetail, InventoryOperationResult, ShoppingIntakeResult } from '../api/types';

type OperationHistory = {
  open: boolean;
  selectedOperationId: string | null;
  setConflict: (value: string | null) => void;
  setError: (value: string | null) => void;
  setDetail: Dispatch<SetStateAction<InventoryOperationDetail | null>>;
};

export function useAppInventoryRevert(args: {
  mutate: (operationId: string) => Promise<InventoryOperationResult>;
  operationHistory: OperationHistory;
  shoppingResult: ShoppingIntakeResult | null;
  setShoppingResult: (result: ShoppingIntakeResult) => void;
  reconciliationResult: InventoryOperationResult | null;
  setReconciliationResult: (result: InventoryOperationResult, familyId: string, userId: string) => void;
  familyId: string;
  userId: string;
  getDetail: (operationId: string) => Promise<InventoryOperationDetail>;
  setRecentBannerOverride: (result: InventoryOperationResult) => void;
  showNotice: (notice: { tone: 'success' | 'danger'; title: string; message: string }) => void;
  errorMessage: (reason: unknown, fallback: string) => string;
}) {
  const {
    mutate,
    operationHistory,
    shoppingResult,
    setShoppingResult,
    reconciliationResult,
    setReconciliationResult,
    familyId,
    userId,
    getDetail,
    setRecentBannerOverride,
    showNotice,
    errorMessage,
  } = args;
  return useCallback(async (operationId: string) => {
    operationHistory.setConflict(null);
    operationHistory.setError(null);
    try {
      const result = await mutate(operationId);
      setRecentBannerOverride(result);
      if (shoppingResult?.operation_id === operationId) {
        setShoppingResult({ ...shoppingResult, ...result });
      }
      if (reconciliationResult?.operation_id === operationId) {
        setReconciliationResult(result, familyId, userId);
      }
      if (operationHistory.selectedOperationId === operationId) {
        try {
          operationHistory.setDetail(await getDetail(operationId));
        } catch {
          operationHistory.setDetail((current) => current && current.operation_id === operationId
            ? { ...current, ...result, actor_display_name: current.actor_display_name, lines: current.lines }
            : current);
        }
      }
      showNotice({ tone: 'success', title: '已撤销本次变更', message: result.summary.description || '库存已恢复到变更前状态。' });
    } catch (reason) {
      const message = errorMessage(reason, '撤销失败，请稍后重试');
      if (operationHistory.open) operationHistory.setConflict(message);
      else showNotice({ tone: 'danger', title: '无法撤销', message });
    }
  }, [errorMessage, familyId, getDetail, mutate, operationHistory, reconciliationResult, setRecentBannerOverride, setReconciliationResult, setShoppingResult, shoppingResult, showNotice, userId]);
}
