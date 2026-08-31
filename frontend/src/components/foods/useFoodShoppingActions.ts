import type { FoodShoppingDialogState, FoodShoppingWrite } from './FoodShoppingModel';
import { buildFoodShoppingWrite } from './FoodShoppingModel';
import { isApiError } from '../../api/request';
import { resolveErrorMessage } from '../recipes/RecipeWorkspaceModel';

type Notice = { tone: 'success' | 'warning' | 'danger'; title: string; message: string };
type Args = {
  dialog: FoodShoppingDialogState | null;
  isSubmitting: boolean;
  setDialog: (value: FoodShoppingDialogState | null) => void;
  setSubmitting: (value: boolean) => void;
  setError: (value: string | null) => void;
  createShoppingItem: (payload: Extract<FoodShoppingWrite, { kind: 'create' }>['payload']) => Promise<unknown>;
  updateShoppingItem: (itemId: string, payload: Extract<FoodShoppingWrite, { kind: 'update' }>['payload']) => Promise<unknown>;
  showNotice: (notice: Notice) => void;
};

export async function submitFoodShoppingAction(args: Args) {
  if (!args.dialog || args.isSubmitting) return;
  let write: FoodShoppingWrite;
  try {
    write = buildFoodShoppingWrite(args.dialog.draft, args.dialog.existingItem);
  } catch (reason) {
    args.setError(resolveErrorMessage(reason, '请确认采购信息。'));
    return;
  }
  args.setSubmitting(true);
  args.setError(null);
  try {
    if (write.kind === 'update') await args.updateShoppingItem(write.itemId, write.payload);
    else await args.createShoppingItem(write.payload);
    const foodName = args.dialog.draft.title;
    args.setDialog(null);
    args.showNotice({
      tone: 'success',
      title: write.kind === 'update' ? '待买内容已更新' : '已加入采购清单',
      message: write.kind === 'update' ? `${foodName} 的待买数量已更新。` : `${foodName} 已加入采购清单。`,
    });
  } catch (reason) {
    args.setError(isApiError(reason) && reason.status === 409 ? '待买内容已发生变化，请刷新后重新确认。' : resolveErrorMessage(reason, '保存待买内容失败，请稍后重试。'));
  } finally {
    args.setSubmitting(false);
  }
}

export function createFoodShoppingSubmit(args: Args) {
  return () => submitFoodShoppingAction(args);
}
