import { useCallback, useState } from 'react';
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

export function useAppInventoryOperationHistory(
  args: Pick<Args, 'getDetail' | 'errorMessage'> & { isRevertPending?: boolean },
) {
  const [open, setOpen] = useState(false);
  const [selectedOperationId, setSelectedOperationId] = useState<string | null>(null);
  const [initialOperationId, setInitialOperationId] = useState<string | null>(null);
  const [detail, setDetail] = useState<InventoryOperationDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const operations = useAppInventoryOperations({
    getDetail: args.getDetail,
    errorMessage: args.errorMessage,
    setDetail,
    setLoading: setDetailLoading,
    setError: setDetailError,
  });

  const openHistory = useCallback((operationId?: string) => {
    setOpen(true);
    setError(null);
    setConflict(null);
    setInitialOperationId(operationId ?? null);
    if (operationId) setSelectedOperationId(operationId);
  }, []);

  const closeHistory = useCallback(() => {
    if (args.isRevertPending) return;
    setOpen(false);
    setInitialOperationId(null);
    setConflict(null);
  }, [args.isRevertPending]);

  return {
    open,
    selectedOperationId,
    initialOperationId,
    detail,
    detailLoading,
    detailError,
    error,
    conflict,
    setSelectedOperationId,
    setError,
    setConflict,
    setDetail,
    openHistory,
    closeHistory,
    loadDetail: operations.loadDetail,
  };
}
