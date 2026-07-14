import type { FormEvent } from 'react';
import type {
  CorrectInventoryExpiryDateRequest,
  CorrectStateExpiryDateRequest,
  CreateFoodPlanItemPayload,
  DisposeExpiredInventoryRequest,
  Food,
  FoodPlanItem,
  MealLog,
  QuickAddMealLogPayload,
  SetInventoryStateAbsentRequest,
  SnoozeExpiryAlertsRequest,
  SnoozeStateExpiryAlertRequest,
  UpdateFoodPlanItemPayload,
  VersionedInventoryItemRef,
} from '../../api/types';
import { isApiError } from '../../api/request';
import type { NoticeState } from '../../hooks/useNotice';
import type { InventoryActionGroup } from '../inventory/inventoryActionModel';
import type { HomeActionCompletionSummary, HomePlanAddFormState } from './useHomeDashboardState';

/**
 * Home long-unconfirmed inventory actions should open reconciliation with scope=suggested.
 * This pure helper keeps the navigation target stable for callers/tests.
 */
export function homeLongUnconfirmedReconciliationTarget(): {
  scope: 'suggested';
} {
  return { scope: 'suggested' };
}


export type HomeMealEnrichmentOpenRequest = {
  mealLogId?: string;
  mealLog?: MealLog;
  planItem?: FoodPlanItem;
};

function messageOf(reason: unknown, fallback: string) {
  if (reason instanceof Error && reason.message.trim()) {
    return reason.message;
  }
  return fallback;
}

export type InventoryActionOutcome =
  | 'dispose'
  | 'retain_expired'
  | 'snooze_upcoming'
  | 'correct_date';

function successMessageFor(outcome: InventoryActionOutcome, presenceOnly = false): string {
  switch (outcome) {
    case 'dispose':
      return presenceOnly ? '已标记为没有' : '过期批次已销毁';
    case 'retain_expired':
      return '已暂时保留，到提醒日会再出现';
    case 'snooze_upcoming':
      return '临期提醒已延后';
    case 'correct_date':
      return '到期日已更正';
  }
}

function buildSuccessSummary(
  ingredientName: string,
  ingredientId: string,
  refreshedGroups: InventoryActionGroup[],
  outcome: InventoryActionOutcome,
  presenceOnly = false,
): HomeActionCompletionSummary {
  const lowStock = refreshedGroups.find(
    (group) => group.kind === 'low_stock' && group.ingredientId === ingredientId,
  );
  return {
    title: `已处理${ingredientName}`,
    message: successMessageFor(outcome, presenceOnly),
    ...(lowStock
      ? {
          secondaryActionLabel: `${ingredientName}库存已不足，加入采购`,
          secondaryActionIngredientId: ingredientId,
        }
      : {}),
  };
}

export function useHomeDashboardActions(input: {
  showNotice: (notice: NoticeState) => void;
  selectedActionGroup: InventoryActionGroup | null;
  homePlanDetailItem: FoodPlanItem | null;
  homePlanDetailForm: { planDate: string; mealType: FoodPlanItem['meal_type']; note: string };
  homePlanAddFood: Food | null;
  homePlanAddForm: HomePlanAddFormState;
  disposeExpiredInventory: (payload: DisposeExpiredInventoryRequest) => Promise<unknown>;
  snoozeInventoryExpiryAlerts: (payload: SnoozeExpiryAlertsRequest) => Promise<unknown>;
  correctInventoryExpiryDate: (
    inventoryItemId: string,
    payload: CorrectInventoryExpiryDateRequest,
  ) => Promise<unknown>;
  snoozeStateExpiryAlert: (
    ingredientId: string,
    payload: SnoozeStateExpiryAlertRequest,
  ) => Promise<unknown>;
  correctStateExpiryDate: (
    ingredientId: string,
    payload: CorrectStateExpiryDateRequest,
  ) => Promise<unknown>;
  setInventoryStateAbsent: (
    ingredientId: string,
    payload: SetInventoryStateAbsentRequest,
  ) => Promise<unknown>;
  refreshInventoryActions: () => Promise<InventoryActionGroup[]>;
  completeActionGroup: (args: {
    ingredientId: string;
    summary: HomeActionCompletionSummary;
    refreshedGroups?: InventoryActionGroup[];
  }) => void;
  closeActionGroup: () => void;
  setActionDialogBusy: (busy: boolean) => void;
  setActionDialogError: (message: string | null) => void;
  setActionDialogConflict: (state: 'none' | 'review_again') => void;
  updateFoodPlanItem: (itemId: string, payload: UpdateFoodPlanItemPayload) => Promise<unknown>;
  deleteFoodPlanItem: (itemId: string) => Promise<unknown>;
  createFoodPlanItem: (payload: CreateFoodPlanItemPayload) => Promise<unknown>;
  quickAddMeal: (payload: QuickAddMealLogPayload) => Promise<MealLog>;
  closeHomePlanDetail: () => void;
  closeHomePlanAddDialog: () => void;
  setIsHomePlanDetailEditing: (isEditing: boolean) => void;
  startPlanRecipe: (input: {
    foodId: string;
    recipeId: string;
    foodPlanItemId: string;
    planDate: string;
    mealType: FoodPlanItem['meal_type'];
    servings?: number;
    planItemBaseUpdatedAt: string;
  }) => void;
  openMealLogEnrichment: (request: HomeMealEnrichmentOpenRequest) => void;
}) {
  async function startHomePlanDetailCook(item: FoodPlanItem) {
    if (item.recipe_id) {
      input.closeHomePlanDetail();
      input.startPlanRecipe({
        foodId: item.food_id,
        recipeId: item.recipe_id,
        foodPlanItemId: item.id,
        planDate: item.plan_date,
        mealType: item.meal_type,
        servings: 1,
        planItemBaseUpdatedAt: item.updated_at,
      });
      return;
    }
    try {
      const createdMeal = await input.quickAddMeal({
        food_id: item.food_id,
        date: item.plan_date,
        meal_type: item.meal_type,
        servings: 1,
        note: item.note || '来自菜单计划',
        food_plan_item_id: item.id,
      });
      input.closeHomePlanDetail();
      input.openMealLogEnrichment({ mealLog: createdMeal, planItem: item });
    } catch (reason) {
      input.showNotice({
        tone: 'danger',
        title: '完成菜单计划失败',
        message: messageOf(reason, '完成菜单计划失败'),
      });
    }
  }

  async function handleInventoryActionConflict(args: {
    ingredientId: string;
    ingredientName: string;
  }) {
    let refreshed: InventoryActionGroup[];
    try {
      refreshed = await input.refreshInventoryActions();
    } catch (reason) {
      // Conflict is real; recovery refresh failed — keep dialog open with actionable guidance.
      input.setActionDialogConflict('review_again');
      input.setActionDialogError('家人可能改动了这批库存，但刷新失败，请稍后重试。');
      return;
    }
    const surviving = refreshed.find(
      (group) => group.kind === 'expiry' && group.ingredientId === args.ingredientId,
    );
    if (surviving) {
      // Surviving group: keep dialog open, clear selection/confirmation via conflictState, require review.
      input.setActionDialogConflict('review_again');
      input.setActionDialogError('家人刚刚改动了这批库存，请重新选择后再提交。');
      return;
    }
    input.setActionDialogConflict('none');
    input.setActionDialogError(null);
    input.closeActionGroup();
    input.showNotice({
      tone: 'success',
      title: '这批库存已由家人处理',
      message: `${args.ingredientName} 已不在今天要处理列表中。`,
    });
  }

  async function runInventoryMutation(args: {
    ingredientId: string;
    ingredientName: string;
    mutate: () => Promise<unknown>;
    failureTitle: string;
    outcome: InventoryActionOutcome;
    presenceOnly?: boolean;
  }) {
    input.setActionDialogBusy(true);
    input.setActionDialogError(null);
    let writeSucceeded = false;
    try {
      await args.mutate();
      writeSucceeded = true;
    } catch (reason) {
      if (isApiError(reason) && reason.status === 409) {
        await handleInventoryActionConflict({
          ingredientId: args.ingredientId,
          ingredientName: args.ingredientName,
        });
        return;
      }
      // Network/business errors preserve current dialog inputs.
      input.setActionDialogError(messageOf(reason, args.failureTitle));
      return;
    } finally {
      if (!writeSucceeded) {
        input.setActionDialogBusy(false);
      }
    }

    // Write succeeded — never report as write failure if only the projection refresh fails.
    try {
      const refreshed = await input.refreshInventoryActions();
      input.setActionDialogConflict('none');
      input.completeActionGroup({
        ingredientId: args.ingredientId,
        summary: buildSuccessSummary(
          args.ingredientName,
          args.ingredientId,
          refreshed,
          args.outcome,
          Boolean(args.presenceOnly),
        ),
        refreshedGroups: refreshed,
      });
    } catch (reason) {
      input.setActionDialogConflict('none');
      input.setActionDialogError(null);
      input.closeActionGroup();
      input.showNotice({
        tone: 'warning',
        title: '操作已完成，但数据刷新失败',
        message: messageOf(reason, '请下拉刷新首页后再继续处理。'),
      });
    } finally {
      input.setActionDialogBusy(false);
    }
  }

  async function disposeSelectedInventoryBatches(items: VersionedInventoryItemRef[]) {
    const group = input.selectedActionGroup;
    if (!group || group.kind !== 'expiry') {
      input.showNotice({
        tone: 'warning',
        title: '食材不可用',
        message: '这份食材暂时不可用，请稍后再试。',
      });
      return;
    }
    if (items.length === 0) {
      const presenceOnly = group.targetKind === 'ingredient_inventory_state';
      input.setActionDialogError(presenceOnly ? '请先确认这份食材是否还在。' : '请先选择要销毁的过期批次。');
      return;
    }

    const presenceOnly = group.targetKind === 'ingredient_inventory_state';
    await runInventoryMutation({
      ingredientId: group.ingredientId,
      ingredientName: group.ingredientName,
      failureTitle: presenceOnly ? '标记为没有失败' : '销毁过期批次失败',
      outcome: 'dispose',
      presenceOnly,
      mutate: () => {
        if (presenceOnly) {
          const target = group.batches[0]?.target;
          if (!target || target.targetKind !== 'ingredient_inventory_state') {
            throw new Error('库存状态不可用');
          }
          return input.setInventoryStateAbsent(group.ingredientId, {
            state_id: target.stateId,
            expected_row_version: target.expectedRowVersion,
          });
        }
        return input.disposeExpiredInventory({
          ingredient_id: group.ingredientId,
          items,
        });
      },
    });
  }

  async function snoozeSelectedInventoryAlerts(args: {
    action: SnoozeExpiryAlertsRequest['action'];
    items: VersionedInventoryItemRef[];
    snoozedUntil: string;
  }) {
    const group = input.selectedActionGroup;
    if (!group || group.kind !== 'expiry') {
      input.showNotice({
        tone: 'warning',
        title: '食材不可用',
        message: '这份食材暂时不可用，请稍后再试。',
      });
      return;
    }
    if (args.items.length === 0) {
      input.setActionDialogError(
        args.action === 'retain_expired' ? '请先选择要暂时保留的过期批次。' : '请先选择要稍后提醒的批次。',
      );
      return;
    }

    const presenceOnly = group.targetKind === 'ingredient_inventory_state';
    await runInventoryMutation({
      ingredientId: group.ingredientId,
      ingredientName: group.ingredientName,
      failureTitle: args.action === 'retain_expired' ? '暂时保留失败' : '稍后提醒失败',
      outcome: args.action,
      presenceOnly,
      mutate: () => {
        if (presenceOnly) {
          const target = group.batches[0]?.target;
          if (!target || target.targetKind !== 'ingredient_inventory_state') {
            throw new Error('库存状态不可用');
          }
          return input.snoozeStateExpiryAlert(group.ingredientId, {
            action: args.action,
            state_id: target.stateId,
            expected_row_version: target.expectedRowVersion,
            snoozed_until: args.snoozedUntil,
          });
        }
        return input.snoozeInventoryExpiryAlerts({
          action: args.action,
          ingredient_id: group.ingredientId,
          items: args.items,
          snoozed_until: args.snoozedUntil,
        });
      },
    });
  }

  async function correctSelectedInventoryExpiryDate(args: {
    inventoryItemId: string;
    expectedRowVersion: number;
    expiryDate: string;
  }) {
    const group = input.selectedActionGroup;
    if (!group || group.kind !== 'expiry') {
      input.showNotice({
        tone: 'warning',
        title: '食材不可用',
        message: '这份食材暂时不可用，请稍后再试。',
      });
      return;
    }

    const presenceOnly = group.targetKind === 'ingredient_inventory_state';
    await runInventoryMutation({
      ingredientId: group.ingredientId,
      ingredientName: group.ingredientName,
      failureTitle: '更正到期日失败',
      outcome: 'correct_date',
      presenceOnly,
      mutate: () => {
        if (presenceOnly) {
          const batch = group.batches.find((item) => item.inventoryItemId === args.inventoryItemId) ?? group.batches[0];
          const target = batch?.target;
          if (!target || target.targetKind !== 'ingredient_inventory_state') {
            throw new Error('库存状态不可用');
          }
          return input.correctStateExpiryDate(group.ingredientId, {
            state_id: target.stateId,
            expected_row_version: target.expectedRowVersion,
            expiry_date: args.expiryDate,
          });
        }
        return input.correctInventoryExpiryDate(args.inventoryItemId, {
          expiry_date: args.expiryDate,
          expected_row_version: args.expectedRowVersion,
        });
      },
    });
  }

  async function submitHomePlanDetail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!input.homePlanDetailItem) {
      return;
    }
    try {
      await input.updateFoodPlanItem(input.homePlanDetailItem.id, {
        plan_date: input.homePlanDetailForm.planDate,
        meal_type: input.homePlanDetailForm.mealType,
        note: input.homePlanDetailForm.note.trim(),
      });
      input.setIsHomePlanDetailEditing(false);
    } catch (reason) {
      input.showNotice({ tone: 'danger', title: '更新菜单计划失败', message: messageOf(reason, '更新菜单计划失败') });
    }
  }

  async function deleteHomePlanDetail(item: FoodPlanItem) {
    try {
      await input.deleteFoodPlanItem(item.id);
      input.closeHomePlanDetail();
    } catch (reason) {
      input.showNotice({ tone: 'danger', title: '删除菜单计划失败', message: messageOf(reason, '删除菜单计划失败') });
    }
  }

  async function submitHomePlanAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!input.homePlanAddFood) {
      input.showNotice({ tone: 'warning', title: '还不能加入菜单', message: '请选择要加入菜单的食物。' });
      return;
    }
    try {
      await input.createFoodPlanItem({
        food_id: input.homePlanAddFood.id,
        plan_date: input.homePlanAddForm.planDate,
        meal_type: input.homePlanAddForm.mealType,
        note: input.homePlanAddForm.note.trim(),
      });
      input.closeHomePlanAddDialog();
    } catch (reason) {
      input.showNotice({ tone: 'danger', title: '加入菜单失败', message: messageOf(reason, '加入菜单失败') });
    }
  }

  return {
    startHomePlanDetailCook,
    disposeSelectedInventoryBatches,
    snoozeSelectedInventoryAlerts,
    correctSelectedInventoryExpiryDate,
    submitHomePlanDetail,
    deleteHomePlanDetail,
    submitHomePlanAdd,
  };
}
