import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { MealType, RecipePlanItem } from '../../api/types';
import { todayKey } from '../../lib/ui';
import type { RecipeCardViewModel } from './workspaceModel';
import { resolveErrorMessage } from './RecipeWorkspaceModel';

type RecipeNotice = {
  tone: 'success' | 'warning' | 'danger';
  title: string;
  message: string;
};

export function useRecipePlanState(args: {
  recipePlanWeekRange: { start: string; end: string };
  recipePlanItems: RecipePlanItem[];
  cards: RecipeCardViewModel[];
  showRecipeNotice: (notice: RecipeNotice) => void;
  createRecipePlanItem: (payload: { recipe_id: string; plan_date: string; meal_type: MealType; note: string }) => Promise<RecipePlanItem>;
  updateRecipePlanItem: (itemId: string, payload: { recipe_id?: string; plan_date?: string; meal_type?: MealType; note?: string }) => Promise<RecipePlanItem>;
  deleteRecipePlanItem: (itemId: string) => Promise<void>;
  onStartCookFromPlan: (item: RecipePlanItem) => void;
}) {
  const [planForm, setPlanForm] = useState<{ recipeId: string; planDate: string; mealType: MealType; note: string }>(() => {
    return { recipeId: '', planDate: todayKey(), mealType: 'dinner', note: '' };
  });
  const [planDialogCard, setPlanDialogCard] = useState<RecipeCardViewModel | null>(null);
  const [isPlanDialogOpen, setIsPlanDialogOpen] = useState(false);
  const [planRecipeSearch, setPlanRecipeSearch] = useState('');
  const [isPlanRecipePickerOpen, setIsPlanRecipePickerOpen] = useState(false);
  const [expandedPlanDates, setExpandedPlanDates] = useState<Set<string>>(() => new Set([todayKey()]));
  const [planDetailItemId, setPlanDetailItemId] = useState<string | null>(null);
  const [planDetailForm, setPlanDetailForm] = useState<{ planDate: string; mealType: MealType; note: string }>(() => ({
    planDate: '',
    mealType: 'dinner',
    note: '',
  }));

  const activePlanDetailItem = useMemo(
    () => (planDetailItemId ? args.recipePlanItems.find((item) => item.id === planDetailItemId) ?? null : null),
    [planDetailItemId, args.recipePlanItems]
  );
  const activePlanDetailCard = useMemo(
    () => (activePlanDetailItem ? args.cards.find((entry) => entry.recipe.id === activePlanDetailItem.recipe_id) ?? null : null),
    [activePlanDetailItem, args.cards]
  );

  useEffect(() => {
    const today = todayKey();
    setExpandedPlanDates(today >= args.recipePlanWeekRange.start && today <= args.recipePlanWeekRange.end ? new Set([today]) : new Set());
  }, [args.recipePlanWeekRange.start, args.recipePlanWeekRange.end]);

  useEffect(() => {
    if (!activePlanDetailItem) {
      if (planDetailItemId) setPlanDetailItemId(null);
      return;
    }
    setPlanDetailForm({
      planDate: activePlanDetailItem.plan_date,
      mealType: activePlanDetailItem.meal_type,
      note: activePlanDetailItem.note ?? '',
    });
  }, [activePlanDetailItem?.id, activePlanDetailItem?.plan_date, activePlanDetailItem?.meal_type, activePlanDetailItem?.note, planDetailItemId]);

  function defaultPlanDateForSelectedWeek() {
    const today = todayKey();
    return today >= args.recipePlanWeekRange.start && today <= args.recipePlanWeekRange.end ? today : args.recipePlanWeekRange.start;
  }

  function openPlanDialog(card?: RecipeCardViewModel) {
    setPlanDialogCard(card ?? null);
    setPlanRecipeSearch('');
    setIsPlanRecipePickerOpen(false);
    setPlanForm({
      recipeId: card?.recipe.id ?? '',
      planDate: defaultPlanDateForSelectedWeek(),
      mealType: 'dinner',
      note: '',
    });
    setIsPlanDialogOpen(true);
  }

  function closePlanDialog() {
    setIsPlanDialogOpen(false);
    setPlanDialogCard(null);
    setPlanRecipeSearch('');
    setIsPlanRecipePickerOpen(false);
  }

  function openPlanDetail(item: RecipePlanItem) {
    setPlanDetailItemId(item.id);
    setPlanDetailForm({
      planDate: item.plan_date,
      mealType: item.meal_type,
      note: item.note ?? '',
    });
  }

  function closePlanDetail() {
    setPlanDetailItemId(null);
  }

  function togglePlanDay(date: string) {
    setExpandedPlanDates((current) => {
      const next = new Set(current);
      if (next.has(date)) {
        next.delete(date);
      } else {
        next.add(date);
      }
      return next;
    });
  }

  function startPlanDetailCook(item: RecipePlanItem) {
    const card = args.cards.find((entry) => entry.recipe.id === item.recipe_id);
    if (!card) {
      args.showRecipeNotice({ tone: 'warning', title: '找不到菜谱', message: '这条计划关联的菜谱不在当前列表里。' });
      return;
    }
    closePlanDetail();
    args.onStartCookFromPlan(item);
  }

  function selectPlanRecipe(card: RecipeCardViewModel) {
    setPlanForm((current) => ({ ...current, recipeId: card.recipe.id }));
    setPlanDialogCard(card);
    setPlanRecipeSearch('');
    setIsPlanRecipePickerOpen(false);
  }

  async function submitPlanItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!planForm.recipeId) {
      args.showRecipeNotice({
        tone: 'warning',
        title: '还不能加入菜单',
        message: args.cards.length === 0 ? '先新增一份菜谱，再安排菜单计划。' : '请选择要加入菜单的菜谱。',
      });
      return;
    }
    try {
      await args.createRecipePlanItem({
        recipe_id: planForm.recipeId,
        plan_date: planForm.planDate,
        meal_type: planForm.mealType,
        note: planForm.note.trim(),
      });
      closePlanDialog();
      setPlanForm((current) => ({ ...current, recipeId: '', planDate: defaultPlanDateForSelectedWeek(), note: '' }));
    } catch (reason) {
      args.showRecipeNotice({ tone: 'danger', title: '添加菜单计划失败', message: resolveErrorMessage(reason, '添加菜单计划失败') });
    }
  }

  async function updatePlanDate(item: RecipePlanItem, planDate: string) {
    try {
      await args.updateRecipePlanItem(item.id, { plan_date: planDate });
    } catch (reason) {
      args.showRecipeNotice({ tone: 'danger', title: '更新计划日期失败', message: resolveErrorMessage(reason, '更新计划日期失败') });
    }
  }

  async function updatePlanMealType(item: RecipePlanItem, mealType: MealType) {
    try {
      await args.updateRecipePlanItem(item.id, { meal_type: mealType });
    } catch (reason) {
      args.showRecipeNotice({ tone: 'danger', title: '更新计划餐次失败', message: resolveErrorMessage(reason, '更新计划餐次失败') });
    }
  }

  async function deletePlanItem(item: RecipePlanItem) {
    try {
      await args.deleteRecipePlanItem(item.id);
    } catch (reason) {
      args.showRecipeNotice({ tone: 'danger', title: '删除菜单计划失败', message: resolveErrorMessage(reason, '删除菜单计划失败') });
    }
  }

  async function submitPlanDetail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activePlanDetailItem) return;
    try {
      await args.updateRecipePlanItem(activePlanDetailItem.id, {
        plan_date: planDetailForm.planDate,
        meal_type: planDetailForm.mealType,
        note: planDetailForm.note.trim(),
      });
      closePlanDetail();
    } catch (reason) {
      args.showRecipeNotice({ tone: 'danger', title: '更新菜单计划失败', message: resolveErrorMessage(reason, '更新菜单计划失败') });
    }
  }

  async function deletePlanDetailItem(item: RecipePlanItem) {
    try {
      await args.deleteRecipePlanItem(item.id);
      closePlanDetail();
    } catch (reason) {
      args.showRecipeNotice({ tone: 'danger', title: '删除菜单计划失败', message: resolveErrorMessage(reason, '删除菜单计划失败') });
    }
  }

  return {
    planForm,
    setPlanForm,
    planDialogCard,
    isPlanDialogOpen,
    planRecipeSearch,
    setPlanRecipeSearch,
    isPlanRecipePickerOpen,
    setIsPlanRecipePickerOpen,
    expandedPlanDates,
    activePlanDetailItem,
    activePlanDetailCard,
    planDetailForm,
    setPlanDetailForm,
    openPlanDialog,
    closePlanDialog,
    openPlanDetail,
    closePlanDetail,
    togglePlanDay,
    startPlanDetailCook,
    selectPlanRecipe,
    submitPlanItem,
    updatePlanDate,
    updatePlanMealType,
    deletePlanItem,
    submitPlanDetail,
    deletePlanDetailItem,
  };
}
