import type { Dispatch, FormEvent, SetStateAction } from 'react';
import type {
  ConsumeInventoryResponse,
  DisposeExpiredInventoryResponse,
  Food,
  Ingredient,
  InventoryItem,
  ShoppingListItem,
} from '../../api/types';
import type { NoticeTone } from '../../hooks/useNotice';
import { buildDisposableExpiredInventoryItems, type IngredientSummaryViewModel } from './workspaceModel';
import {
  buildConsumeUnitOptions,
  buildInventoryForm,
  buildShoppingForm,
  formatNumericString,
  parsePositiveNumber,
  type ConsumeDialogFormState,
  type InventoryDrawerFormState,
  type ShoppingDialogFormState,
} from './ingredientWorkspaceForms';
import type { PendingShoppingCompletion } from './IngredientWorkspaceOverlayTypes';
import { tracksIngredientQuantity } from '../../lib/ingredientTracking';

type UseIngredientActionStateArgs = {
  ingredientOptions: Ingredient[];
  foodOptions: Food[];
  summaries: IngredientSummaryViewModel[];
  inventoryForm: InventoryDrawerFormState;
  setInventoryForm: Dispatch<SetStateAction<InventoryDrawerFormState>>;
  setInventoryAdvancedOpen: Dispatch<SetStateAction<boolean>>;
  consumeForm: ConsumeDialogFormState;
  shoppingForm: ShoppingDialogFormState;
  setShoppingForm: Dispatch<SetStateAction<ShoppingDialogFormState>>;
  editingShoppingItemId: string | null;
  pendingShoppingToComplete: PendingShoppingCompletion | null;
  destroyExpiredIngredientId: string | null;
  selectedInventoryIngredient: Ingredient | null;
  setSelectedIngredientId: Dispatch<SetStateAction<string | null>>;
  closeOverlay: () => void;
  createInventory: (payload: {
    ingredient_id: string;
    quantity?: number | null;
    unit?: string | null;
    status: InventoryItem['status'];
    purchase_date: string;
    expiry_date?: string;
    storage_location: string;
    notes: string;
    low_stock_threshold?: number;
  }) => Promise<InventoryItem>;
  consumeInventory: (payload: {
    ingredient_id: string;
    quantity?: number | null;
    unit?: string | null;
  }) => Promise<ConsumeInventoryResponse>;
  disposeExpiredInventory: (payload: {
    ingredient_id: string;
    items: Array<{ inventory_item_id: string; expected_row_version: number }>;
  }) => Promise<DisposeExpiredInventoryResponse>;
  createShoppingItem: (payload: {
    title: string;
    quantity?: number | null;
    unit?: string | null;
    ingredient_id?: string | null;
    food_id?: string | null;
    quantity_mode?: ShoppingListItem['quantity_mode'];
    display_label?: string | null;
    reason: string;
  }) => Promise<ShoppingListItem>;
  updateShoppingItem: (payload: {
    itemId: string;
    payload: {
      title?: string;
      quantity?: number | null;
      unit?: string | null;
      ingredient_id?: string | null;
      food_id?: string | null;
      quantity_mode?: ShoppingListItem['quantity_mode'];
      display_label?: string | null;
      reason?: string;
      done?: boolean;
    };
  }) => Promise<ShoppingListItem>;
  showNotice: (notice: { tone: NoticeTone; title: string; message: string }) => void;
  resolveErrorMessage: (reason: unknown, fallback: string) => string;
};

export function useIngredientActionState(args: UseIngredientActionStateArgs) {
  async function submitInventory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!args.inventoryForm.ingredientId) {
      args.showNotice({ tone: 'warning', title: '还不能录入库存', message: '先选中这次补的是哪种食材，再保存这批库存。' });
      return;
    }
    const tracksQuantity = tracksIngredientQuantity(args.selectedInventoryIngredient);
    const quantity = tracksQuantity ? parsePositiveNumber(args.inventoryForm.quantity) : null;
    if (tracksQuantity && quantity === null) {
      args.showNotice({ tone: 'warning', title: '库存数量无效', message: '数量要大于 0，才能把这批库存记进系统。' });
      return;
    }
    if (!args.inventoryForm.purchaseDate) {
      args.showNotice({ tone: 'warning', title: '缺少购买日期', message: '请确认这批食材的购买日期。' });
      return;
    }
    if (!args.inventoryForm.storageLocation.trim()) {
      args.showNotice({ tone: 'warning', title: '缺少存放位置', message: '请确认这批食材放在哪里，后面的提醒才会更准确。' });
      return;
    }
    if (args.inventoryForm.expiryInputMode === 'days' && parsePositiveNumber(args.inventoryForm.expiryDays) === null) {
      args.showNotice({ tone: 'warning', title: '缺少保质期', message: '请填写这批食材大概几天后到期，系统才能自动算出到期日。' });
      return;
    }
    if (args.inventoryForm.expiryInputMode === 'manual_date' && !args.inventoryForm.expiryDate) {
      args.showNotice({ tone: 'warning', title: '缺少到期日期', message: '请填写包装上的到期日期，系统才能继续帮你监控临期。' });
      return;
    }
    try {
      await args.createInventory({
        ingredient_id: args.inventoryForm.ingredientId,
        quantity,
        unit: tracksQuantity
          ? args.inventoryForm.unit.trim() || args.selectedInventoryIngredient?.default_unit || '个'
          : args.selectedInventoryIngredient?.default_unit || args.inventoryForm.unit.trim() || '份',
        status: args.inventoryForm.status,
        purchase_date: args.inventoryForm.purchaseDate,
        expiry_date: args.inventoryForm.expiryDate || undefined,
        storage_location: args.inventoryForm.storageLocation.trim(),
        notes: args.inventoryForm.notes.trim(),
      });
      if (args.pendingShoppingToComplete) {
        try {
          await args.updateShoppingItem({
            itemId: args.pendingShoppingToComplete.itemId,
            payload: { done: true },
          });
        } catch (reason) {
          args.showNotice({
            tone: 'warning',
            title: '库存已登记',
            message:
              reason instanceof Error
                ? `待买项仍未标记完成：${reason.message}`
                : '待买项仍未标记为已买，请稍后再试。',
          });
        }
      }
      args.setSelectedIngredientId(args.inventoryForm.ingredientId);
      args.setInventoryForm(buildInventoryForm(args.ingredientOptions, args.inventoryForm.ingredientId));
      args.setInventoryAdvancedOpen(false);
      args.closeOverlay();
    } catch (reason) {
      args.showNotice({ tone: 'danger', title: '录入库存失败', message: args.resolveErrorMessage(reason, '录入库存失败') });
    }
  }

  async function submitShopping(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!args.shoppingForm.title.trim()) {
      return;
    }
    const selectedShoppingIngredient =
      args.shoppingForm.targetType === 'ingredient'
        ? args.ingredientOptions.find((item) => item.id === args.shoppingForm.ingredientId) ??
          args.ingredientOptions.find((item) => item.name === args.shoppingForm.title.trim()) ??
          null
        : null;
    const selectedShoppingFood =
      args.shoppingForm.targetType === 'food'
        ? args.foodOptions.find((item) => item.id === args.shoppingForm.foodId) ?? null
        : null;
    if (!selectedShoppingIngredient && !selectedShoppingFood) {
      args.showNotice({ tone: 'warning', title: '先选择采购对象', message: '采购清单只能从已有食材或成品速食档案创建。' });
      return;
    }
    const tracksQuantity = selectedShoppingFood ? true : tracksIngredientQuantity(selectedShoppingIngredient);
    const quantity = tracksQuantity ? parsePositiveNumber(args.shoppingForm.quantity) : 1;
    if (tracksQuantity && quantity === null) {
      args.showNotice({ tone: 'warning', title: '待买数量无效', message: '请确认待买数量，至少要大于 0。' });
      return;
    }
    const shoppingQuantity = quantity ?? 1;
    try {
      const payload = {
        title: selectedShoppingFood?.name ?? selectedShoppingIngredient?.name ?? args.shoppingForm.title.trim(),
        quantity: tracksQuantity ? shoppingQuantity : null,
        unit: tracksQuantity
          ? args.shoppingForm.unit.trim() || selectedShoppingFood?.stock_unit || selectedShoppingIngredient?.default_unit || '份'
          : null,
        ingredient_id: selectedShoppingIngredient?.id ?? null,
        food_id: selectedShoppingFood?.id ?? null,
        quantity_mode: tracksQuantity ? 'track_quantity' : 'not_track_quantity',
        display_label: tracksQuantity ? null : '需要补充',
        reason: args.shoppingForm.reason.trim() || (selectedShoppingFood ? '补充成品库存' : !tracksQuantity ? '需要补充' : ''),
      } satisfies Parameters<typeof args.createShoppingItem>[0];
      if (args.editingShoppingItemId) {
        await args.updateShoppingItem({
          itemId: args.editingShoppingItemId,
          payload,
        });
      } else {
        await args.createShoppingItem(payload);
      }
      args.setShoppingForm(buildShoppingForm());
      args.closeOverlay();
    } catch (reason) {
      args.showNotice({
        tone: 'danger',
        title: args.editingShoppingItemId ? '修改采购项失败' : '加入购物清单失败',
        message: args.resolveErrorMessage(reason, args.editingShoppingItemId ? '修改采购项失败' : '加入购物清单失败'),
      });
    }
  }

  async function submitConsume(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!args.consumeForm.ingredientId) {
      args.showNotice({ tone: 'warning', title: '还不能记录消费', message: '先确认是要消费哪种食材。' });
      return;
    }

    const selectedSummary = args.summaries.find((item) => item.ingredient.id === args.consumeForm.ingredientId) ?? null;
    if (!selectedSummary) {
      args.showNotice({ tone: 'warning', title: '食材不可用', message: '这份食材暂时不可用，请稍后再试。' });
      return;
    }
    if (!tracksIngredientQuantity(selectedSummary.ingredient)) {
      args.showNotice({ tone: 'warning', title: '不需要扣数量', message: '这类食材只记录家里有没有，做菜时不会扣减数量。' });
      return;
    }

    const unitOptions = buildConsumeUnitOptions(
      selectedSummary.ingredient,
      selectedSummary.availableInventoryItems,
      selectedSummary.ingredient.default_unit
    );
    const selectedUnitOption = unitOptions.find((item) => item.unit === args.consumeForm.unit) ?? unitOptions[0] ?? null;
    if (!selectedUnitOption) {
      args.showNotice({ tone: 'warning', title: '没有可消费库存', message: '这份食材当前没有可消费的库存。' });
      return;
    }

    const quantity = parsePositiveNumber(args.consumeForm.quantity);
    if (quantity === null) {
      args.showNotice({ tone: 'warning', title: '消费数量无效', message: '请确认这次实际消费了多少。' });
      return;
    }

    if (quantity - selectedUnitOption.available > 0.0001) {
      args.showNotice({
        tone: 'warning',
        title: '超过可用库存',
        message: `当前最多还能消费 ${formatNumericString(selectedUnitOption.available)}${selectedUnitOption.unit}。`,
      });
      return;
    }

    try {
      await args.consumeInventory({
        ingredient_id: args.consumeForm.ingredientId,
        quantity,
        unit: selectedUnitOption.unit,
      });
      args.setSelectedIngredientId(args.consumeForm.ingredientId);
      args.closeOverlay();
    } catch (reason) {
      args.showNotice({ tone: 'danger', title: '记录消费失败', message: args.resolveErrorMessage(reason, '记录消费失败') });
    }
  }

  async function submitDestroyExpired(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!args.destroyExpiredIngredientId) {
      args.showNotice({ tone: 'warning', title: '还不能销毁过期批次', message: '先确认要处理哪种食材。' });
      return;
    }

    const selectedSummary =
      args.summaries.find((item) => item.ingredient.id === args.destroyExpiredIngredientId) ?? null;
    if (!selectedSummary) {
      args.showNotice({ tone: 'warning', title: '食材不可用', message: '这份食材暂时不可用，请稍后再试。' });
      return;
    }

    const expiredItems = buildDisposableExpiredInventoryItems(selectedSummary);
    if (expiredItems.length === 0) {
      args.showNotice({ tone: 'warning', title: '没有可销毁批次', message: '当前没有可销毁的过期批次。' });
      return;
    }

    try {
      await args.disposeExpiredInventory({
        ingredient_id: selectedSummary.ingredient.id,
        items: expiredItems.map((item) => ({
          inventory_item_id: item.id,
          expected_row_version: item.rowVersion,
        })),
      });
      args.setSelectedIngredientId(selectedSummary.ingredient.id);
      args.closeOverlay();
    } catch (reason) {
      args.showNotice({ tone: 'danger', title: '销毁过期批次失败', message: args.resolveErrorMessage(reason, '销毁过期批次失败') });
    }
  }

  return {
    submitInventory,
    submitShopping,
    submitConsume,
    submitDestroyExpired,
  };
}
