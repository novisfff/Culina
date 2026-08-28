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
  return useCallback(async (operationId: string) => {
    args.operationHistory.setConflict(null);
    args.operationHistory.setError(null);
    try {
      const result = await args.mutate(operationId);
      args.setRecentBannerOverride(result);
      if (args.shoppingResult?.operation_id === operationId) {
        args.setShoppingResult({ ...args.shoppingResult, ...result });
      }
      if (args.reconciliationResult?.operation_id === operationId) {
        args.setReconciliationResult(result, args.familyId, args.userId);
      }
      if (args.operationHistory.selectedOperationId === operationId) {
        try {
          args.operationHistory.setDetail(await args.getDetail(operationId));
        } catch {
          args.operationHistory.setDetail((current) => current && current.operation_id === operationId
            ? { ...current, ...result, actor_display_name: current.actor_display_name, lines: current.lines }
            : current);
        }
      }
      args.showNotice({ tone: 'success', title: '已撤销本次变更', message: result.summary.description || '库存已恢复到变更前状态。' });
    } catch (reason) {
      const message = args.errorMessage(reason, '撤销失败，请稍后重试');
      if (args.operationHistory.open) args.operationHistory.setConflict(message);
      else args.showNotice({ tone: 'danger', title: '无法撤销', message });
    }
  }, [args]);
}
