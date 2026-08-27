import type { Dispatch, FormEvent, SetStateAction } from 'react';
import type {
  ConsumeInventoryResponse,
  CorrectInventoryExpiryDateRequest,
  DisposeExpiredInventoryRequest,
  DisposeExpiredInventoryResponse,
  Food,
  Ingredient,
  IngredientInventoryState,
  InventoryItem,
  ShoppingListItem,
  SnoozeExpiryAlertsRequest,
  SnoozeExpiryAlertsResponse,
  UpsertIngredientInventoryStateRequest,
  VersionedInventoryItemRef,
} from '../../api/types';
import { isApiError } from '../../api/request';
import type { NoticeTone } from '../../hooks/useNotice';
import type { ExpiryInventoryActionGroup } from '../../features/inventory/inventoryActionModel';
import type { IngredientSummaryViewModel } from './workspaceModel';
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
import type { InventoryActionConflictState } from './IngredientWorkspaceOverlayTypes';
import { tracksIngredientQuantity } from '../../lib/ingredientTracking';
import { resolveShoppingFormSubmission } from './shoppingFormSubmission';

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
  editingShoppingItemRowVersion: number | null;
  inventoryActionIngredientId: string | null;
  inventoryActionGroup: ExpiryInventoryActionGroup | null;
  selectedInventoryIngredient: Ingredient | null;
  setSelectedIngredientId: Dispatch<SetStateAction<string | null>>;
  closeOverlay: () => void;
  setInventoryActionBusy: (busy: boolean) => void;
  setInventoryActionError: (message: string | null) => void;
  setInventoryActionConflict: (state: InventoryActionConflictState) => void;
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
  /** Presence-only ordinary restock (State PUT). Not used for track_quantity. */
  upsertInventoryState: (
    ingredientId: string,
    payload: UpsertIngredientInventoryStateRequest,
  ) => Promise<IngredientInventoryState>;
  consumeInventory: (payload: {
    ingredient_id: string;
    quantity?: number | null;
    unit?: string | null;
  }) => Promise<ConsumeInventoryResponse>;
  disposeExpiredInventory: (payload: DisposeExpiredInventoryRequest) => Promise<DisposeExpiredInventoryResponse | unknown>;
  snoozeInventoryExpiryAlerts: (payload: SnoozeExpiryAlertsRequest) => Promise<SnoozeExpiryAlertsResponse | unknown>;
  correctInventoryExpiryDate: (
    inventoryItemId: string,
    payload: CorrectInventoryExpiryDateRequest,
  ) => Promise<unknown>;
  refreshInventoryActionGroup: (ingredientId: string) => Promise<ExpiryInventoryActionGroup | null>;
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
      expected_row_version: number;
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

function messageOf(reason: unknown, fallback: string) {
  if (reason instanceof Error && reason.message.trim()) {
    return reason.message;
  }
  return fallback;
}

export function useIngredientActionState(args: UseIngredientActionStateArgs) {
  async function submitShopping(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const resolution = resolveShoppingFormSubmission({
      form: args.shoppingForm,
      ingredients: args.ingredientOptions,
      foods: args.foodOptions,
    });
    if (!resolution.ok) {
      args.showNotice({
        tone: 'warning',
        title: resolution.title,
        message: resolution.message,
      });
      return;
    }
    try {
      const payload = resolution.payload satisfies Parameters<typeof args.createShoppingItem>[0];
      if (args.editingShoppingItemId) {
        if (args.editingShoppingItemRowVersion === null) {
          args.showNotice({ tone: 'warning', title: '采购清单已更新', message: '请刷新采购清单后再编辑。' });
          return;
        }
        await args.updateShoppingItem({
          itemId: args.editingShoppingItemId,
          payload: {
            ...payload,
            expected_row_version: args.editingShoppingItemRowVersion,
          },
        });
      } else {
        await args.createShoppingItem(payload);
      }
      args.setShoppingForm(buildShoppingForm());
      args.closeOverlay();
    } catch (reason) {
      args.showNotice({
        tone: 'danger',
        title: args.editingShoppingItemId ? '修改待买内容失败' : '加入采购清单失败',
        message: args.resolveErrorMessage(reason, args.editingShoppingItemId ? '修改待买内容失败' : '加入采购清单失败'),
      });
    }
  }

  async function submitInventory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!args.inventoryForm.ingredientId) {
      args.showNotice({ tone: 'warning', title: '暂时无法加入库存', message: '先选择这次补充的食材，再保存库存。' });
      return;
    }
    const tracksQuantity = tracksIngredientQuantity(args.selectedInventoryIngredient);
    const quantity = tracksQuantity ? parsePositiveNumber(args.inventoryForm.quantity) : null;
    if (tracksQuantity && quantity === null) {
      args.showNotice({ tone: 'warning', title: '库存数量无效', message: '数量必须大于 0，才能保存这份库存。' });
      return;
    }
    if (!args.inventoryForm.purchaseDate) {
      args.showNotice({ tone: 'warning', title: '缺少购买日期', message: '请确认这份库存的购买日期。' });
      return;
    }
    if (!args.inventoryForm.storageLocation.trim()) {
      args.showNotice({ tone: 'warning', title: '缺少存放位置', message: '请确认这份库存放在哪里，后面的提醒才会更准确。' });
      return;
    }
    if (args.inventoryForm.expiryInputMode === 'days' && parsePositiveNumber(args.inventoryForm.expiryDays) === null) {
      args.showNotice({ tone: 'warning', title: '缺少保质期信息', message: '请填写这份库存预计几天后到期，系统才能自动计算到期日。' });
      return;
    }
    if (args.inventoryForm.expiryInputMode === 'manual_date' && !args.inventoryForm.expiryDate) {
      args.showNotice({ tone: 'warning', title: '缺少到期日', message: '请填写包装上的到期日，系统才能继续帮你监控临期。' });
      return;
    }
    try {
      // Ordinary manual restock only. Shopping-origin writes must use shared shopping intake.
      // Presence ingredients use State PUT; exact ingredients keep InventoryItem POST.
      if (!tracksQuantity) {
        const existingState =
          args.summaries.find((item) => item.ingredient.id === args.inventoryForm.ingredientId)?.inventoryState ?? null;
        await args.upsertInventoryState(args.inventoryForm.ingredientId, {
          expected_ingredient_row_version: args.selectedInventoryIngredient?.row_version ?? 1,
          state_id: existingState?.id ?? null,
          expected_state_row_version: existingState?.row_version ?? null,
          // Manual restock confirms household still has the item; match shopping-intake default.
          availability_level: 'sufficient',
          inventory_status: args.inventoryForm.status,
          purchase_date: args.inventoryForm.purchaseDate,
          expiry_date: args.inventoryForm.expiryDate || null,
          storage_location: args.inventoryForm.storageLocation.trim(),
          notes: args.inventoryForm.notes.trim(),
        });
      } else {
        await args.createInventory({
          ingredient_id: args.inventoryForm.ingredientId,
          quantity,
          unit:
            args.inventoryForm.unit.trim() || args.selectedInventoryIngredient?.default_unit || '个',
          status: args.inventoryForm.status,
          purchase_date: args.inventoryForm.purchaseDate,
          expiry_date: args.inventoryForm.expiryDate || undefined,
          storage_location: args.inventoryForm.storageLocation.trim(),
          notes: args.inventoryForm.notes.trim(),
        });
      }
      args.setSelectedIngredientId(args.inventoryForm.ingredientId);
      args.setInventoryForm(buildInventoryForm(args.ingredientOptions, args.inventoryForm.ingredientId));
      args.setInventoryAdvancedOpen(false);
      args.closeOverlay();
    } catch (reason) {
      args.showNotice({ tone: 'danger', title: '保存库存失败', message: args.resolveErrorMessage(reason, '保存库存失败') });
    }
  }

  async function submitConsume(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!args.consumeForm.ingredientId) {
      args.showNotice({ tone: 'warning', title: '还不能记录用量', message: '先确认要记录哪种食材。' });
      return;
    }

    const selectedSummary = args.summaries.find((item) => item.ingredient.id === args.consumeForm.ingredientId) ?? null;
    if (!selectedSummary) {
      args.showNotice({ tone: 'warning', title: '食材不可用', message: '这份食材暂时不可用，请稍后再试。' });
      return;
    }
    if (!tracksIngredientQuantity(selectedSummary.ingredient)) {
      args.showNotice({ tone: 'warning', title: '无需记录数量', message: '这类食材只记录家里有没有，做菜时不会按数量扣减。' });
      return;
    }

    const unitOptions = buildConsumeUnitOptions(
      selectedSummary.ingredient,
      selectedSummary.availableInventoryItems,
      selectedSummary.ingredient.default_unit
    );
    const selectedUnitOption = unitOptions.find((item) => item.unit === args.consumeForm.unit) ?? unitOptions[0] ?? null;
    if (!selectedUnitOption) {
      args.showNotice({ tone: 'warning', title: '没有可用库存', message: '这份食材当前没有可记录用量的库存。' });
      return;
    }

    const quantity = parsePositiveNumber(args.consumeForm.quantity);
    if (quantity === null) {
      args.showNotice({ tone: 'warning', title: '用量无效', message: '请确认这次实际用了多少。' });
      return;
    }

    if (quantity - selectedUnitOption.available > 0.0001) {
      args.showNotice({
        tone: 'warning',
        title: '超过可用库存',
        message: `当前最多还能记录 ${formatNumericString(selectedUnitOption.available)} ${selectedUnitOption.unit}。`,
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
      args.showNotice({ tone: 'danger', title: '记录用量失败', message: args.resolveErrorMessage(reason, '记录用量失败') });
    }
  }

  async function handleInventoryActionConflict(argsLocal: {
    ingredientId: string;
    ingredientName: string;
  }) {
    let surviving: ExpiryInventoryActionGroup | null;
    try {
      surviving = await args.refreshInventoryActionGroup(argsLocal.ingredientId);
    } catch (reason) {
      args.setInventoryActionConflict('review_again');
      args.setInventoryActionError('家人可能刚改动了库存，但页面暂时无法更新，请稍后重试。');
      return;
    }
    if (surviving) {
      args.setInventoryActionConflict('review_again');
      args.setInventoryActionError('家人刚刚改动了库存，请重新选择后再提交。');
      return;
    }
    args.setInventoryActionConflict('none');
    args.setInventoryActionError(null);
    args.closeOverlay();
    args.showNotice({
      tone: 'success',
      title: '库存已由家人处理',
      message: `${argsLocal.ingredientName} 已不在今天的提醒列表中。`,
    });
  }

  async function runInventoryMutation(mutationArgs: {
    ingredientId: string;
    ingredientName: string;
    mutate: () => Promise<unknown>;
    failureTitle: string;
  }) {
    args.setInventoryActionBusy(true);
    args.setInventoryActionError(null);
    let writeSucceeded = false;
    try {
      await mutationArgs.mutate();
      writeSucceeded = true;
    } catch (reason) {
      if (isApiError(reason) && reason.status === 409) {
        await handleInventoryActionConflict({
          ingredientId: mutationArgs.ingredientId,
          ingredientName: mutationArgs.ingredientName,
        });
        return;
      }
      args.setInventoryActionError(messageOf(reason, mutationArgs.failureTitle));
      return;
    } finally {
      if (!writeSucceeded) {
        args.setInventoryActionBusy(false);
      }
    }

    try {
      const remaining = await args.refreshInventoryActionGroup(mutationArgs.ingredientId);
      args.setInventoryActionConflict('none');
      args.setSelectedIngredientId(mutationArgs.ingredientId);
      if (remaining && remaining.batches.length > 0) {
        // Partial success: keep dialog open so the user can continue remaining batches.
        args.setInventoryActionError(null);
        args.showNotice({
          tone: 'success',
          title: `已处理 ${mutationArgs.ingredientName}`,
          message: '还剩部分库存，请继续选择要处理的内容。',
        });
        return;
      }
      args.closeOverlay();
    } catch (reason) {
      args.setInventoryActionConflict('none');
      args.setInventoryActionError(null);
      args.setSelectedIngredientId(mutationArgs.ingredientId);
      args.closeOverlay();
      args.showNotice({
        tone: 'warning',
        title: '操作已完成',
        message: messageOf(reason, '页面暂时没有更新，请刷新后查看最新库存。'),
      });
    } finally {
      args.setInventoryActionBusy(false);
    }
  }

  async function disposeSelectedInventoryBatches(items: VersionedInventoryItemRef[]) {
    const group = args.inventoryActionGroup;
    if (!group || group.kind !== 'expiry') {
      args.showNotice({
        tone: 'warning',
        title: '食材不可用',
        message: '这份食材暂时不可用，请稍后再试。',
      });
      return;
    }
    if (items.length === 0) {
      args.setInventoryActionError('请先选择要丢弃的过期库存。');
      return;
    }

    await runInventoryMutation({
      ingredientId: group.ingredientId,
      ingredientName: group.ingredientName,
      failureTitle: '处理过期库存失败',
      mutate: () =>
        args.disposeExpiredInventory({
          ingredient_id: group.ingredientId,
          items,
        }),
    });
  }

  async function snoozeSelectedInventoryAlerts(snoozeArgs: {
    action: SnoozeExpiryAlertsRequest['action'];
    items: VersionedInventoryItemRef[];
    snoozedUntil: string;
  }) {
    const group = args.inventoryActionGroup;
    if (!group || group.kind !== 'expiry') {
      args.showNotice({
        tone: 'warning',
        title: '食材不可用',
        message: '这份食材暂时不可用，请稍后再试。',
      });
      return;
    }
    if (snoozeArgs.items.length === 0) {
      args.setInventoryActionError(
        snoozeArgs.action === 'retain_expired' ? '请先选择要暂时保留的过期库存。' : '请先选择要稍后提醒的库存。',
      );
      return;
    }

    await runInventoryMutation({
      ingredientId: group.ingredientId,
      ingredientName: group.ingredientName,
      failureTitle: snoozeArgs.action === 'retain_expired' ? '暂时保留失败' : '稍后提醒失败',
      mutate: () =>
        args.snoozeInventoryExpiryAlerts({
          action: snoozeArgs.action,
          ingredient_id: group.ingredientId,
          items: snoozeArgs.items,
          snoozed_until: snoozeArgs.snoozedUntil,
        }),
    });
  }

  async function correctSelectedInventoryExpiryDate(correctArgs: {
    inventoryItemId: string;
    expectedRowVersion: number;
    expiryDate: string;
  }) {
    const group = args.inventoryActionGroup;
    if (!group || group.kind !== 'expiry') {
      args.showNotice({
        tone: 'warning',
        title: '食材不可用',
        message: '这份食材暂时不可用，请稍后再试。',
      });
      return;
    }

    await runInventoryMutation({
      ingredientId: group.ingredientId,
      ingredientName: group.ingredientName,
      failureTitle: '更正到期日失败',
      mutate: () =>
        args.correctInventoryExpiryDate(correctArgs.inventoryItemId, {
          expiry_date: correctArgs.expiryDate,
          expected_row_version: correctArgs.expectedRowVersion,
        }),
    });
  }

  return {
    submitInventory,
    submitShopping,
    submitConsume,
    disposeSelectedInventoryBatches,
    snoozeSelectedInventoryAlerts,
    correctSelectedInventoryExpiryDate,
  };
}
