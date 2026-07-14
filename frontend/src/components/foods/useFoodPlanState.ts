import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Food, FoodPlanItem, MealLog, MealType } from '../../api/types';
import type { FoodPlanNavigationRequest } from '../../app/useAppGlobalSearchNavigation';
import type { NoticeState } from '../../hooks/useNotice';
import { addDateKeyDays, todayKey } from '../../lib/date';
import type { FoodPlanDetailFormState } from './FoodPlanDetailModal';

type PlanFormState = {
  foodId: string;
  planDate: string;
  mealType: MealType;
  note: string;
};

function resolveErrorMessage(reason: unknown, fallback: string) {
  if (reason instanceof Error && reason.message.trim()) {
    return reason.message;
  }
  return fallback;
}

export function useFoodPlanState(input: {
  foods: Food[];
  foodPlanItems: FoodPlanItem[];
  foodPlanWeekRange: { start: string; end: string };
  navigationRequest?: FoodPlanNavigationRequest | null;
  onNavigateToWeek: (planDate: string) => void;
  showNotice: (notice: NoticeState) => void;
  setFeedback: (message: string) => void;
  getDefaultMealType: (food: Food) => MealType;
  createFoodPlanItem: (payload: { food_id: string; plan_date: string; meal_type: MealType; note: string }) => Promise<FoodPlanItem>;
  updateFoodPlanItem: (itemId: string, payload: { food_id?: string; plan_date?: string; meal_type?: MealType; note?: string; status?: 'planned' | 'cooked' | 'skipped' }) => Promise<FoodPlanItem>;
  deleteFoodPlanItem: (itemId: string) => Promise<void>;
  quickAddMeal: (payload: { food_id: string; date: string; meal_type: MealType; servings: number; note: string; food_plan_item_id?: string }) => Promise<MealLog>;
  onMealRecorded?: (meal: MealLog, planItem: FoodPlanItem) => void;
  onStartRecipe: (recipeId: string, foodPlanItemId?: string) => void;
}) {
  const [isPlanDialogOpen, setIsPlanDialogOpen] = useState(false);
  const [planFoodSearch, setPlanFoodSearch] = useState('');
  const [planForm, setPlanForm] = useState<PlanFormState>(() => ({
    foodId: '',
    planDate: todayKey(),
    mealType: 'dinner',
    note: '',
  }));
  const [planDetailItemId, setPlanDetailItemId] = useState<string | null>(null);
  const [planDetailForm, setPlanDetailForm] = useState<FoodPlanDetailFormState>(() => ({
    planDate: todayKey(),
    mealType: 'dinner',
    note: '',
  }));
  const [isPlanDetailEditing, setIsPlanDetailEditing] = useState(false);
  const handledNavigationRequestIdRef = useRef<number | null>(null);

  const todayDate = todayKey();
  const activePlanItems = input.foodPlanItems.filter((item) => item.status !== 'skipped');
  const activePlanDetailItem = planDetailItemId
    ? input.foodPlanItems.find((item) => item.id === planDetailItemId) ?? null
    : null;
  const activePlanDetailFood = activePlanDetailItem
    ? input.foods.find((food) => food.id === activePlanDetailItem.food_id) ?? null
    : null;
  const foodPlanDays = Array.from({ length: 7 }, (_, index) => {
    const date = addDateKeyDays(input.foodPlanWeekRange.start, index);
    const items = activePlanItems.filter((item) => item.plan_date === date);
    return {
      date,
      label: date === todayDate ? '今天' : date,
      items,
    };
  });
  const planDateOptions = Array.from({ length: 90 }, (_, index) => addDateKeyDays(todayDate, index));
  const selectedPlanFood = planForm.foodId ? input.foods.find((food) => food.id === planForm.foodId) ?? null : null;

  function openPlanDialog(food?: Food) {
    setPlanForm({
      foodId: food?.id ?? '',
      planDate: todayKey(),
      mealType: food ? input.getDefaultMealType(food) : 'dinner',
      note: '',
    });
    setPlanFoodSearch(food?.name ?? '');
    setIsPlanDialogOpen(true);
  }

  function clearPlanFoodSelection() {
    setPlanForm((current) => ({ ...current, foodId: '' }));
    setPlanFoodSearch('');
  }

  function closePlanDialog() {
    setIsPlanDialogOpen(false);
    setPlanFoodSearch('');
  }

  async function submitPlanItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!planForm.foodId) {
      input.showNotice({
        tone: 'warning',
        title: '还不能加入菜单',
        message: '请选择要加入菜单的食物。',
      });
      return;
    }
    try {
      await input.createFoodPlanItem({
        food_id: planForm.foodId,
        plan_date: planForm.planDate,
        meal_type: planForm.mealType,
        note: planForm.note.trim(),
      });
      closePlanDialog();
    } catch (reason) {
      input.showNotice({
        tone: 'danger',
        title: '添加菜单计划失败',
        message: resolveErrorMessage(reason, '添加菜单计划失败'),
      });
    }
  }

  function openPlanDetail(item: FoodPlanItem) {
    setPlanDetailItemId(item.id);
    setPlanDetailForm({ planDate: item.plan_date < todayKey() ? todayKey() : item.plan_date, mealType: item.meal_type, note: item.note ?? '' });
    setIsPlanDetailEditing(false);
  }

  useEffect(() => {
    const request = input.navigationRequest;
    if (!request || handledNavigationRequestIdRef.current === request.requestId) return;
    if (request.planDate < input.foodPlanWeekRange.start || request.planDate > input.foodPlanWeekRange.end) return;

    if (request.target === 'week') {
      input.onNavigateToWeek(request.planDate);
      handledNavigationRequestIdRef.current = request.requestId;
      return;
    }

    const item = input.foodPlanItems.find((entry) => entry.id === request.itemId);
    if (!item) return;
    openPlanDetail(item);
    handledNavigationRequestIdRef.current = request.requestId;
  }, [
    input.foodPlanItems,
    input.foodPlanWeekRange.end,
    input.foodPlanWeekRange.start,
    input.navigationRequest,
    input.onNavigateToWeek,
  ]);

  function closePlanDetail() {
    setPlanDetailItemId(null);
    setIsPlanDetailEditing(false);
  }

  function resetPlanDetailForm() {
    if (!activePlanDetailItem) return;
    setPlanDetailForm({
      planDate: activePlanDetailItem.plan_date < todayKey() ? todayKey() : activePlanDetailItem.plan_date,
      mealType: activePlanDetailItem.meal_type,
      note: activePlanDetailItem.note ?? '',
    });
    setIsPlanDetailEditing(false);
  }

  async function submitPlanDetail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activePlanDetailItem) return;
    try {
      await input.updateFoodPlanItem(activePlanDetailItem.id, {
        plan_date: planDetailForm.planDate,
        meal_type: planDetailForm.mealType,
        note: planDetailForm.note.trim(),
      });
      setIsPlanDetailEditing(false);
    } catch (reason) {
      input.showNotice({
        tone: 'danger',
        title: '更新菜单计划失败',
        message: resolveErrorMessage(reason, '更新菜单计划失败'),
      });
    }
  }

  async function deletePlanDetail(item: FoodPlanItem) {
    try {
      await input.deleteFoodPlanItem(item.id);
      closePlanDetail();
    } catch (reason) {
      input.showNotice({
        tone: 'danger',
        title: '删除菜单计划失败',
        message: resolveErrorMessage(reason, '删除菜单计划失败'),
      });
    }
  }

  async function completePlanItem(item: FoodPlanItem) {
    if (item.recipe_id) {
      input.onStartRecipe(item.recipe_id, item.id);
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
      input.setFeedback(`${item.food_name} 已完成菜单计划`);
      closePlanDetail();
      input.onMealRecorded?.(createdMeal, item);
    } catch (reason) {
      input.showNotice({
        tone: 'danger',
        title: '完成菜单计划失败',
        message: resolveErrorMessage(reason, '完成菜单计划失败'),
      });
    }
  }

  return {
    activePlanItems,
    activePlanDetailFood,
    activePlanDetailItem,
    clearPlanFoodSelection,
    closePlanDetail,
    closePlanDialog,
    completePlanItem,
    deletePlanDetail,
    foodPlanDays,
    isPlanDetailEditing,
    isPlanDialogOpen,
    openPlanDetail,
    openPlanDialog,
    planDateOptions,
    planDetailForm,
    planFoodSearch,
    planForm,
    resetPlanDetailForm,
    selectedPlanFood,
    setIsPlanDetailEditing,
    setPlanDetailForm,
    setPlanFoodSearch,
    setPlanForm,
    submitPlanDetail,
    submitPlanItem,
  };
}
