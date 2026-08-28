import type { Dispatch, FormEvent, SetStateAction } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { invalidateAfterFoodChanged } from '../../api/cacheInvalidation';
import { parseUnifiedFoodStockQuantity, resolveUnifiedFoodStockDeductQuantity } from './inventoryOverviewModel';
import type { FoodStockAdjustDialogState, FoodStockDeductDialogState, FoodStockInventoryFollowUpState } from './useIngredientFoodStockState';

type Notice = { tone: 'success' | 'warning'; title: string; message: string };

type Args = {
  queryClient: QueryClient;
  foodStockSubmitting: 'meal' | 'adjust' | null;
  setFoodStockSubmitting: Dispatch<SetStateAction<'meal' | 'adjust' | null>>;
  inventoryFollowUp: FoodStockInventoryFollowUpState | null;
  setInventoryFollowUp: Dispatch<SetStateAction<FoodStockInventoryFollowUpState | null>>;
  foodStockDeductDialog: FoodStockDeductDialogState | null;
  setFoodStockDeductDialog: Dispatch<SetStateAction<FoodStockDeductDialogState | null>>;
  foodStockAdjustDialog: FoodStockAdjustDialogState | null;
  setFoodStockAdjustDialog: Dispatch<SetStateAction<FoodStockAdjustDialogState | null>>;
  showNotice: (notice: Notice) => void;
};

export function useIngredientFoodStockActions(args: Args) {
  async function submitInventoryFollowUp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const current = args.inventoryFollowUp;
    if (!current || args.foodStockSubmitting) return;
    const parsed = parseUnifiedFoodStockQuantity(current.stockQuantity, '扣减数量');
    if (parsed.error || parsed.quantity === null) {
      args.setInventoryFollowUp({ ...current, error: parsed.error ?? '请输入大于 0 的扣减数量。' });
      return;
    }
    const resolved = resolveUnifiedFoodStockDeductQuantity(parsed.quantity, current.item.quantity, current.item.unit || '份');
    if (resolved.error || resolved.quantity === null) {
      args.setInventoryFollowUp({ ...current, error: resolved.error ?? '当前库存不足。' });
      return;
    }
    args.setFoodStockSubmitting('meal');
    try {
      await api.consumeFoodStock(current.item.source_id, { expected_row_version: current.item.row_version, quantity: resolved.quantity, unit: current.item.unit || '份', note: '从库存页扣减成品库存' });
      invalidateAfterFoodChanged(args.queryClient);
      args.setInventoryFollowUp(null);
      args.showNotice({ tone: 'success', title: '已扣减库存', message: `${current.item.title} 已扣减 ${resolved.quantity} ${current.item.unit || '份'}。` });
    } catch (error) {
      args.setInventoryFollowUp({ ...current, error: error instanceof Error ? error.message : '扣减库存失败，请稍后再试。' });
    } finally {
      args.setFoodStockSubmitting(null);
    }
  }

  async function submitFoodStockDeductDialog(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const current = args.foodStockDeductDialog;
    if (!current || args.foodStockSubmitting) return;
    const parsed = parseUnifiedFoodStockQuantity(current.stockQuantity, '扣减数量');
    if (parsed.error || parsed.quantity === null) {
      args.setFoodStockDeductDialog({ ...current, error: parsed.error ?? '请输入大于 0 的扣减数量。' });
      return;
    }
    const resolved = resolveUnifiedFoodStockDeductQuantity(parsed.quantity, current.item.quantity, current.item.unit || '份');
    if (resolved.error || resolved.quantity === null) {
      args.setFoodStockDeductDialog({ ...current, error: resolved.error ?? '当前库存不足。' });
      return;
    }
    args.setFoodStockSubmitting('meal');
    try {
      await api.consumeFoodStock(current.item.source_id, { expected_row_version: current.item.row_version, quantity: resolved.quantity, unit: current.item.unit || '份', note: '从库存页扣减成品库存' });
      invalidateAfterFoodChanged(args.queryClient);
      args.setFoodStockDeductDialog(null);
      args.showNotice({ tone: 'success', title: '已扣减库存', message: `${current.item.title} 已扣减 ${resolved.quantity} ${current.item.unit || '份'}。` });
    } catch (error) {
      args.setFoodStockDeductDialog({ ...current, error: error instanceof Error ? error.message : '扣减库存失败，请稍后再试。' });
    } finally {
      args.setFoodStockSubmitting(null);
    }
  }

  async function submitFoodStockAdjustDialog(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const current = args.foodStockAdjustDialog;
    if (!current || args.foodStockSubmitting) return;
    const parsed = parseUnifiedFoodStockQuantity(current.quantity);
    if (parsed.error || parsed.quantity === null) {
      args.setFoodStockAdjustDialog({ ...current, error: parsed.error ?? '请输入大于 0 的数量。' });
      return;
    }
    const payload = { expected_row_version: current.item.row_version, quantity: parsed.quantity, unit: current.unit || current.item.unit || '份', expiry_date: current.expiryDate || null, purchase_source: current.purchaseSource || null, note: '从库存页补充成品库存' };
    args.setFoodStockSubmitting('adjust');
    try {
      await api.restockFoodStock(current.item.source_id, payload);
      invalidateAfterFoodChanged(args.queryClient);
      args.setFoodStockAdjustDialog(null);
      args.showNotice({ tone: 'success', title: '库存已补充', message: `${current.item.title} 已补充 ${parsed.quantity} ${payload.unit}。` });
    } catch (error) {
      args.setFoodStockAdjustDialog({ ...current, error: error instanceof Error ? error.message : '库存调整失败，请稍后再试。' });
    } finally {
      args.setFoodStockSubmitting(null);
    }
  }

  return { submitInventoryFollowUp, submitFoodStockDeductDialog, submitFoodStockAdjustDialog };
}
