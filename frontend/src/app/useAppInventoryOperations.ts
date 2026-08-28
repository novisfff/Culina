import { useCallback } from 'react';
import type { InventoryOperationDetail } from '../api/types/inventory';

type Args = {
  getDetail: (operationId: string) => Promise<InventoryOperationDetail>;
  setDetail: (detail: InventoryOperationDetail | null) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  errorMessage?: (reason: unknown) => string;
};

export function createInventoryOperationController(args: Args) {
  return {
    async loadDetail(operationId: string) {
      args.setLoading(true);
      args.setError(null);
      try { args.setDetail(await args.getDetail(operationId)); }
      catch (reason) {
        args.setDetail(null);
        args.setError(args.errorMessage?.(reason) ?? (reason instanceof Error ? reason.message : '加载变更详情失败'));
      }
      finally { args.setLoading(false); }
    },
  };
}

/** React boundary for operation-detail side effects; keeps the action stable across App renders. */
export function useAppInventoryOperations(args: Args) {
  const loadDetail = useCallback(async (operationId: string) => {
    args.setLoading(true);
    args.setError(null);
    try { args.setDetail(await args.getDetail(operationId)); }
    catch (reason) {
      args.setDetail(null);
      args.setError(args.errorMessage?.(reason) ?? (reason instanceof Error ? reason.message : '加载变更详情失败'));
    }
    finally { args.setLoading(false); }
  }, [args.errorMessage, args.getDetail, args.setDetail, args.setError, args.setLoading]);
  return { loadDetail };
}
