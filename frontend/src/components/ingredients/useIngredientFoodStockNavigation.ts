import type { Dispatch, SetStateAction } from 'react';
import type { Food, InventoryOverviewItem } from '../../api/types';
import type { NoticeState } from '../../hooks/useNotice';
import type { FoodQuickRecordState, FoodStockAdjustDialogState, FoodStockDeductDialogState } from './useIngredientFoodStockState';
import { createClientRequestId, getDefaultFoodStockMealType, resolveErrorMessage } from './ingredientWorkspaceHelpers';

type Args = {
  unifiedInventoryItems: InventoryOverviewItem[];
  foods: Food[];
  readyFoodOptions: Food[];
  lookupFood: (title: string, foodId: string) => Promise<Food | null>;
  setFoodStockAdjustDialog: Dispatch<SetStateAction<FoodStockAdjustDialogState | null>>;
  setFoodStockDeductDialog: Dispatch<SetStateAction<FoodStockDeductDialogState | null>>;
  setQuickRecord: Dispatch<SetStateAction<FoodQuickRecordState | null>>;
  setTransientShoppingFood?: (food: Food | null) => void;
  mealBusinessDate: string;
  showNotice: (notice: NoticeState) => void;
  openShoppingOverlay: (options: { food: Food; reason: string }) => void;
};

export function useIngredientFoodStockNavigation(args: Args) {
  const findItem = (sourceId: string) => args.unifiedInventoryItems.find((item) => item.source_id === sourceId);

  function handleOpenFoodStockFromInventory(foodId: string) {
    const item = findItem(foodId);
    if (!item) {
      args.showNotice({ tone: 'warning', title: '暂时无法补充库存', message: '这项成品库存还没有加载完成，请稍后再试。' });
      return;
    }
    args.setFoodStockAdjustDialog({ item, quantity: '1', unit: item.unit || '份', expiryDate: item.expiry_date ?? '', purchaseSource: item.purchase_source ?? '', error: null });
  }

  function handleRecordFoodStockMeal(foodId: string) {
    const item = findItem(foodId);
    if (!item) {
      args.showNotice({ tone: 'warning', title: '暂时无法打开扣减流程', message: '这项成品库存还没有加载完成，请稍后再试。' });
      return;
    }
    const food = args.foods.find((entry) => entry.id === foodId) ?? args.readyFoodOptions.find((entry) => entry.id === foodId) ?? null;
    if (!food) {
      args.setFoodStockDeductDialog({ item, stockQuantity: item.quantity && item.quantity > 0 ? '1' : '', error: null });
      return;
    }
    args.setQuickRecord({ food, item, date: args.mealBusinessDate, mealType: getDefaultFoodStockMealType(), target: { kind: 'new' }, selectedCandidateId: null, candidateMode: 'none', candidates: [], candidateResolution: { status: 'loading' }, targetTouchedByUser: false, clientRequestId: createClientRequestId(), busy: false, error: null });
  }

  async function handleAddFoodShopping(foodId: string) {
    let food = args.readyFoodOptions.find((item) => item.id === foodId) ?? null;
    if (!food) {
      const item = findItem(foodId);
      if (!item) {
        args.showNotice({ tone: 'warning', title: '暂时无法加入采购清单', message: '这项成品信息还没有加载完成，请稍后再试。' });
        return;
      }
      try {
        food = await args.lookupFood(item.title, foodId);
      } catch (error) {
        args.showNotice({ tone: 'warning', title: '暂时无法加入采购清单', message: resolveErrorMessage(error, '这项成品信息暂时没有查到，请稍后再试。') });
        return;
      }
      if (food) args.setTransientShoppingFood?.(food);
    }
    if (!food) {
      args.showNotice({ tone: 'warning', title: '暂时无法加入采购清单', message: '这项成品信息暂时没有查到，请稍后再试。' });
      return;
    }
    args.openShoppingOverlay({ food, reason: '补充成品库存' });
  }

  return { handleOpenFoodStockFromInventory, handleRecordFoodStockMeal, handleAddFoodShopping };
}
