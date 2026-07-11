import { useEffect, useMemo, useState } from 'react';
import type { Food, FoodPlanItem, MealType } from '../../api/types';
import type { FoodPlanDetailFormState } from '../../components/foods/FoodPlanDetailModal';
import type { InventoryActionGroup } from '../inventory/inventoryActionModel';
import { todayKey } from '../../lib/ui';
import type { HomeRestockFormState } from './homeDashboardModel';

export type HomePlanAddFormState = {
  planDate: string;
  mealType: MealType;
  note: string;
};

export type HomeActionCompletionSummary = {
  title: string;
  message: string;
  secondaryActionLabel?: string;
  secondaryActionIngredientId?: string;
};

export type ActionDialogConflictState = 'none' | 'review_again';

function createDefaultPlanAddForm(businessDateKey: string): HomePlanAddFormState {
  return {
    planDate: businessDateKey,
    mealType: 'dinner',
    note: '',
  };
}

function createPlanDetailForm(businessDateKey: string, item?: FoodPlanItem | null): FoodPlanDetailFormState {
  if (!item) {
    return {
      planDate: businessDateKey,
      mealType: 'dinner',
      note: '',
    };
  }
  return {
    planDate: item.plan_date < businessDateKey ? businessDateKey : item.plan_date,
    mealType: item.meal_type,
    note: item.note ?? '',
  };
}

export function getDefaultHomePlanMealType(food: Food, fallback: MealType = 'dinner') {
  return food.suitable_meal_types[0] ?? fallback;
}

function groupsKeyOf(groups: InventoryActionGroup[]) {
  return groups.map((group) => group.id).join('\0');
}

const EMPTY_ACTION_GROUPS: InventoryActionGroup[] = [];

export function useHomeDashboardState(input: {
  foodPlanWeekRange: { start: string; end: string };
  homeEligibleInventoryActionGroups?: InventoryActionGroup[];
  /** Shanghai business date key for home plan/date defaults. Falls back to device today only if omitted. */
  businessDateKey?: string;
}) {
  const businessDateKey = input.businessDateKey ?? todayKey();
  const [dashboardRecommendationPage, setDashboardRecommendationPage] = useState(0);
  const [selectedDashboardPlanDate, setSelectedDashboardPlanDate] = useState(businessDateKey);
  const [homePlanDetailItemId, setHomePlanDetailItemId] = useState<string | null>(null);
  const [isHomePlanAddDialogOpen, setIsHomePlanAddDialogOpen] = useState(false);
  const [homePlanAddFoodId, setHomePlanAddFoodId] = useState<string | null>(null);
  const [homePlanAddFoodSearch, setHomePlanAddFoodSearch] = useState('');
  const [homePlanAddForm, setHomePlanAddForm] = useState<HomePlanAddFormState>(() =>
    createDefaultPlanAddForm(businessDateKey),
  );
  const [homePlanDetailForm, setHomePlanDetailForm] = useState<FoodPlanDetailFormState>(() =>
    createPlanDetailForm(businessDateKey),
  );
  const [isHomePlanDetailEditing, setIsHomePlanDetailEditing] = useState(false);
  const [selectedActionGroupId, setSelectedActionGroupId] = useState<string | null>(null);
  const [completionSummary, setCompletionSummary] = useState<HomeActionCompletionSummary | null>(null);
  const [completedIngredientId, setCompletedIngredientId] = useState<string | null>(null);
  const [nextGroupId, setNextGroupId] = useState<string | null>(null);
  const [groupsKeyAtCompletion, setGroupsKeyAtCompletion] = useState<string | null>(null);
  const [actionDialogBusy, setActionDialogBusy] = useState(false);
  const [actionDialogError, setActionDialogError] = useState<string | null>(null);
  const [actionDialogConflict, setActionDialogConflict] = useState<ActionDialogConflictState>('none');
  const [homeRestockShoppingItemId, setHomeRestockShoppingItemId] = useState<string | null>(null);
  const [homeRestockForm, setHomeRestockForm] = useState<HomeRestockFormState | null>(null);
  const [homeMealDetailId, setHomeMealDetailId] = useState<string | null>(null);

  const eligibleGroups = input.homeEligibleInventoryActionGroups ?? EMPTY_ACTION_GROUPS;
  const groupsKey = useMemo(() => groupsKeyOf(eligibleGroups), [eligibleGroups]);

  useEffect(() => {
    if (businessDateKey >= input.foodPlanWeekRange.start && businessDateKey <= input.foodPlanWeekRange.end) {
      setSelectedDashboardPlanDate(businessDateKey);
      return;
    }
    setSelectedDashboardPlanDate(input.foodPlanWeekRange.start);
  }, [businessDateKey, input.foodPlanWeekRange.end, input.foodPlanWeekRange.start]);

  useEffect(() => {
    if (!completedIngredientId || groupsKeyAtCompletion === null) {
      return;
    }
    // Offer next only after query invalidation produces a refreshed projection.
    if (groupsKey === groupsKeyAtCompletion) {
      setNextGroupId(null);
      return;
    }
    const next = eligibleGroups.find((group) => group.ingredientId !== completedIngredientId) ?? null;
    setNextGroupId(next?.id ?? null);
  }, [completedIngredientId, eligibleGroups, groupsKey, groupsKeyAtCompletion]);

  function openActionGroup(groupId: string) {
    setSelectedActionGroupId(groupId);
    setActionDialogBusy(false);
    setActionDialogError(null);
    setActionDialogConflict('none');
  }

  function closeActionGroup() {
    setSelectedActionGroupId(null);
    setActionDialogBusy(false);
    setActionDialogError(null);
    setActionDialogConflict('none');
  }

  function completeActionGroup(args: {
    ingredientId: string;
    summary: HomeActionCompletionSummary;
  }) {
    setSelectedActionGroupId(null);
    setActionDialogBusy(false);
    setActionDialogError(null);
    setActionDialogConflict('none');
    setCompletedIngredientId(args.ingredientId);
    setCompletionSummary(args.summary);
    setGroupsKeyAtCompletion(groupsKey);
    // nextGroupId is chosen only after eligible groups refresh via the effect above.
    setNextGroupId(null);
  }

  /**
   * Opens the next household action after completion.
   * Expiry groups select the inventory dialog; low_stock does not (caller should route to shopping).
   * Returns the next group so App can mirror list primary-action routing.
   */
  function openNextActionGroup(): InventoryActionGroup | null {
    if (!nextGroupId) {
      return null;
    }
    const group = eligibleGroups.find((item) => item.id === nextGroupId) ?? null;
    setCompletionSummary(null);
    setCompletedIngredientId(null);
    setGroupsKeyAtCompletion(null);
    setNextGroupId(null);
    setActionDialogBusy(false);
    setActionDialogError(null);
    setActionDialogConflict('none');
    if (group?.kind === 'expiry') {
      setSelectedActionGroupId(group.id);
    } else {
      // low_stock (or missing): never leave a non-expiry selection that mounts no dialog.
      setSelectedActionGroupId(null);
    }
    return group;
  }

  function dismissCompletionSummary() {
    setCompletionSummary(null);
    setCompletedIngredientId(null);
    setGroupsKeyAtCompletion(null);
    setNextGroupId(null);
  }

  function openHomePlanDetail(item: FoodPlanItem) {
    setHomePlanDetailItemId(item.id);
    setHomePlanDetailForm(createPlanDetailForm(businessDateKey, item));
    setIsHomePlanDetailEditing(false);
  }

  function closeHomePlanDetail() {
    setHomePlanDetailItemId(null);
    setIsHomePlanDetailEditing(false);
  }

  function resetHomePlanDetailForm(item?: FoodPlanItem | null) {
    if (!item) return;
    setHomePlanDetailForm(createPlanDetailForm(businessDateKey, item));
    setIsHomePlanDetailEditing(false);
  }

  function openHomePlanAddDialog(food: Food, fallbackMealType: MealType = 'dinner') {
    setIsHomePlanAddDialogOpen(true);
    setHomePlanAddFoodId(food.id);
    setHomePlanAddFoodSearch(food.name);
    setHomePlanAddForm({
      planDate: selectedDashboardPlanDate,
      mealType: getDefaultHomePlanMealType(food, fallbackMealType),
      note: '',
    });
  }

  function openHomePlanAddEmptyDialog(planDate: string, mealType: MealType) {
    setIsHomePlanAddDialogOpen(true);
    setHomePlanAddFoodId(null);
    setHomePlanAddFoodSearch('');
    setHomePlanAddForm({ planDate, mealType, note: '' });
  }

  function selectHomePlanAddFood(food: Food) {
    setHomePlanAddFoodId(food.id);
    setHomePlanAddFoodSearch(food.name);
  }

  function closeHomePlanAddDialog() {
    setIsHomePlanAddDialogOpen(false);
    setHomePlanAddFoodId(null);
    setHomePlanAddFoodSearch('');
    setHomePlanAddForm(createDefaultPlanAddForm(businessDateKey));
  }

  return {
    dashboardRecommendationPage,
    setDashboardRecommendationPage,
    selectedDashboardPlanDate,
    setSelectedDashboardPlanDate,
    homePlanDetailItemId,
    setHomePlanDetailItemId,
    isHomePlanAddDialogOpen,
    setIsHomePlanAddDialogOpen,
    homePlanAddFoodId,
    setHomePlanAddFoodId,
    homePlanAddFoodSearch,
    setHomePlanAddFoodSearch,
    homePlanAddForm,
    setHomePlanAddForm,
    homePlanDetailForm,
    setHomePlanDetailForm,
    isHomePlanDetailEditing,
    setIsHomePlanDetailEditing,
    selectedActionGroupId,
    setSelectedActionGroupId,
    completionSummary,
    completedIngredientId,
    nextGroupId,
    actionDialogBusy,
    actionDialogError,
    actionDialogConflict,
    setActionDialogBusy,
    setActionDialogError,
    setActionDialogConflict,
    openActionGroup,
    closeActionGroup,
    completeActionGroup,
    openNextActionGroup,
    dismissCompletionSummary,
    homeRestockShoppingItemId,
    setHomeRestockShoppingItemId,
    homeRestockForm,
    setHomeRestockForm,
    homeMealDetailId,
    setHomeMealDetailId,
    openHomePlanDetail,
    closeHomePlanDetail,
    resetHomePlanDetailForm,
    openHomePlanAddDialog,
    openHomePlanAddEmptyDialog,
    selectHomePlanAddFood,
    closeHomePlanAddDialog,
  };
}

export type UseHomeDashboardStateResult = ReturnType<typeof useHomeDashboardState>;
