import type { InventoryOperationDetail } from '../api/types';

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
