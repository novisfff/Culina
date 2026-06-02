import type { FormEvent } from 'react';
import type {
  CreateFoodPlanItemPayload,
  Food,
  FoodPlanItem,
  Ingredient,
  InventoryItem,
  MealLog,
  QuickAddMealLogPayload,
  ShoppingListItem,
  UpdateFoodPlanItemPayload,
} from '../../api/types';
import type {
  DisposableExpiredInventoryItemViewModel,
  IngredientSummaryViewModel,
} from '../../components/ingredients/workspaceModel';
import type { NoticeState } from '../../hooks/useNotice';
import { parsePositiveNumber, type HomeRestockFormState } from './homeDashboardModel';
import type { HomePlanAddFormState } from './useHomeDashboardState';

type CreateInventoryPayload = {
  ingredient_id: string;
  quantity: number;
  unit: string;
  status: InventoryItem['status'];
  purchase_date: string;
  expiry_date?: string;
  storage_location: string;
  notes: string;
};

export type HomeMealEnrichmentOpenRequest = {
  mealLogId: string;
  mealLog?: MealLog;
  planItem?: FoodPlanItem;
};

export function useHomeDashboardActions(input: {
  showNotice: (notice: NoticeState) => void;
  homeExpiredDisposalSummary: IngredientSummaryViewModel | null;
  homeExpiredDisposalItems: DisposableExpiredInventoryItemViewModel[];
  homeRestockShoppingItem: ShoppingListItem | null;
  homeRestockForm: HomeRestockFormState | null;
  homeRestockIngredient: Ingredient | null;
  homePlanDetailItem: FoodPlanItem | null;
  homePlanDetailForm: { planDate: string; mealType: FoodPlanItem['meal_type']; note: string };
  homePlanAddFood: Food | null;
  homePlanAddForm: HomePlanAddFormState;
  createInventory: (payload: CreateInventoryPayload) => Promise<unknown>;
  updateShoppingDone: (itemId: string, done: boolean) => Promise<unknown>;
  disposeExpiredInventory: (payload: { ingredient_id: string; inventory_item_ids: string[] }) => Promise<unknown>;
  updateFoodPlanItem: (itemId: string, payload: UpdateFoodPlanItemPayload) => Promise<unknown>;
  deleteFoodPlanItem: (itemId: string) => Promise<unknown>;
  createFoodPlanItem: (payload: CreateFoodPlanItemPayload) => Promise<unknown>;
  quickAddMeal: (payload: QuickAddMealLogPayload) => Promise<MealLog>;
  closeHomeRestock: () => void;
  closeHomeExpiredDisposal: () => void;
  closeHomePlanDetail: () => void;
  closeHomePlanAddDialog: () => void;
  setIsHomePlanDetailEditing: (isEditing: boolean) => void;
  startRecipeCook: (recipeId: string, foodPlanItemId: string) => void;
  openMealLogEnrichment: (request: HomeMealEnrichmentOpenRequest) => void;
}) {
  async function startHomePlanDetailCook(item: FoodPlanItem) {
    input.closeHomePlanDetail();
    if (item.recipe_id) {
      input.startRecipeCook(item.recipe_id, item.id);
      return;
    }
    try {
      await input.quickAddMeal({
        food_id: item.food_id,
        date: item.plan_date,
        meal_type: item.meal_type,
        servings: 1,
        note: item.note || '来自菜单计划',
        food_plan_item_id: item.id,
      });
    } catch (reason) {
      input.showNotice({ tone: 'danger', title: '完成菜单计划失败', message: reason instanceof Error ? reason.message : '完成菜单计划失败' });
    }
  }

  async function supplementHomePlanDetailRecord(item: FoodPlanItem) {
    input.closeHomePlanDetail();
    if (item.meal_log_id) {
      input.openMealLogEnrichment({ mealLogId: item.meal_log_id, planItem: item });
      return;
    }

    try {
      const mealLog = await input.quickAddMeal({
        food_id: item.food_id,
        date: item.plan_date,
        meal_type: item.meal_type,
        servings: 1,
        note: item.note || '来自菜单计划',
        food_plan_item_id: item.id,
      });
      input.openMealLogEnrichment({ mealLogId: mealLog.id, mealLog, planItem: item });
    } catch (reason) {
      input.showNotice({ tone: 'danger', title: '打开补充记录失败', message: reason instanceof Error ? reason.message : '打开补充记录失败' });
    }
  }

  async function submitHomeExpiredDisposal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!input.homeExpiredDisposalSummary) {
      input.showNotice({ tone: 'warning', title: '食材不可用', message: '这份食材暂时不可用，请稍后再试。' });
      return;
    }
    if (input.homeExpiredDisposalItems.length === 0) {
      input.showNotice({ tone: 'warning', title: '没有可销毁批次', message: '当前没有可销毁的过期批次。' });
      return;
    }

    try {
      await input.disposeExpiredInventory({
        ingredient_id: input.homeExpiredDisposalSummary.ingredient.id,
        inventory_item_ids: input.homeExpiredDisposalItems.map((item) => item.id),
      });
      input.closeHomeExpiredDisposal();
    } catch (reason) {
      input.showNotice({ tone: 'danger', title: '销毁过期批次失败', message: reason instanceof Error ? reason.message : '销毁过期批次失败' });
    }
  }

  async function submitHomeRestock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!input.homeRestockShoppingItem || !input.homeRestockForm) {
      input.showNotice({ tone: 'warning', title: '还不能登记库存', message: '先选择要登记的采购项。' });
      return;
    }
    if (!input.homeRestockForm.ingredientId) {
      input.showNotice({ tone: 'warning', title: '缺少食材档案', message: '请先匹配一份食材档案，再登记库存。' });
      return;
    }
    const quantity = parsePositiveNumber(input.homeRestockForm.quantity);
    if (quantity === null) {
      input.showNotice({ tone: 'warning', title: '库存数量无效', message: '数量要大于 0，才能把这批库存记进系统。' });
      return;
    }
    if (!input.homeRestockForm.purchaseDate) {
      input.showNotice({ tone: 'warning', title: '缺少购买日期', message: '请确认这批食材的购买日期。' });
      return;
    }
    if (!input.homeRestockForm.storageLocation.trim()) {
      input.showNotice({ tone: 'warning', title: '缺少存放位置', message: '请确认这批食材放在哪里。' });
      return;
    }
    if (input.homeRestockForm.expiryInputMode === 'days' && parsePositiveNumber(input.homeRestockForm.expiryDays) === null) {
      input.showNotice({ tone: 'warning', title: '缺少保质期', message: '请填写这批食材大概几天后到期。' });
      return;
    }
    if (input.homeRestockForm.expiryInputMode === 'manual_date' && !input.homeRestockForm.expiryDate) {
      input.showNotice({ tone: 'warning', title: '缺少到期日期', message: '请填写包装上的到期日期。' });
      return;
    }

    try {
      await input.createInventory({
        ingredient_id: input.homeRestockForm.ingredientId,
        quantity,
        unit: input.homeRestockForm.unit.trim() || input.homeRestockIngredient?.default_unit || '个',
        status: input.homeRestockForm.status,
        purchase_date: input.homeRestockForm.purchaseDate,
        expiry_date: input.homeRestockForm.expiryDate || undefined,
        storage_location: input.homeRestockForm.storageLocation.trim(),
        notes: input.homeRestockForm.notes.trim(),
      });
      try {
        await input.updateShoppingDone(input.homeRestockShoppingItem.id, true);
      } catch (reason) {
        input.showNotice({
          tone: 'warning',
          title: '库存已登记',
          message: reason instanceof Error
            ? `待买项仍未标记完成：${reason.message}`
            : '待买项仍未标记为已买，请稍后再试。',
        });
      }
      input.closeHomeRestock();
    } catch (reason) {
      input.showNotice({ tone: 'danger', title: '录入库存失败', message: reason instanceof Error ? reason.message : '录入库存失败' });
    }
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
      input.showNotice({ tone: 'danger', title: '更新菜单计划失败', message: reason instanceof Error ? reason.message : '更新菜单计划失败' });
    }
  }

  async function deleteHomePlanDetail(item: FoodPlanItem) {
    try {
      await input.deleteFoodPlanItem(item.id);
      input.closeHomePlanDetail();
    } catch (reason) {
      input.showNotice({ tone: 'danger', title: '删除菜单计划失败', message: reason instanceof Error ? reason.message : '删除菜单计划失败' });
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
      input.showNotice({ tone: 'danger', title: '加入菜单失败', message: reason instanceof Error ? reason.message : '加入菜单失败' });
    }
  }

  return {
    startHomePlanDetailCook,
    supplementHomePlanDetailRecord,
    submitHomeExpiredDisposal,
    submitHomeRestock,
    submitHomePlanDetail,
    deleteHomePlanDetail,
    submitHomePlanAdd,
  };
}
