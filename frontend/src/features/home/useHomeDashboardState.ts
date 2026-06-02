import { useEffect, useState } from 'react';
import type { Food, FoodPlanItem, MealType } from '../../api/types';
import type { FoodPlanDetailFormState } from '../../components/foods/FoodPlanDetailModal';
import { todayKey } from '../../lib/ui';
import { DASHBOARD_TODO_PAGE_SIZE, type HomeRestockFormState } from './homeDashboardModel';

export type HomePlanAddFormState = {
  planDate: string;
  mealType: MealType;
  note: string;
};

function createDefaultPlanAddForm(): HomePlanAddFormState {
  return {
    planDate: todayKey(),
    mealType: 'dinner',
    note: '',
  };
}

function createPlanDetailForm(item?: FoodPlanItem | null): FoodPlanDetailFormState {
  if (!item) {
    return {
      planDate: todayKey(),
      mealType: 'dinner',
      note: '',
    };
  }
  return {
    planDate: item.plan_date < todayKey() ? todayKey() : item.plan_date,
    mealType: item.meal_type,
    note: item.note ?? '',
  };
}

export function getDefaultHomePlanMealType(food: Food, fallback: MealType = 'dinner') {
  return food.suitable_meal_types[0] ?? fallback;
}

export function useHomeDashboardState(input: {
  foodPlanWeekRange: { start: string; end: string };
}) {
  const [dashboardRecommendationPage, setDashboardRecommendationPage] = useState(0);
  const [selectedDashboardPlanDate, setSelectedDashboardPlanDate] = useState(todayKey());
  const [homePlanDetailItemId, setHomePlanDetailItemId] = useState<string | null>(null);
  const [isHomePlanAddDialogOpen, setIsHomePlanAddDialogOpen] = useState(false);
  const [homePlanAddFoodId, setHomePlanAddFoodId] = useState<string | null>(null);
  const [homePlanAddFoodSearch, setHomePlanAddFoodSearch] = useState('');
  const [homePlanAddForm, setHomePlanAddForm] = useState<HomePlanAddFormState>(createDefaultPlanAddForm);
  const [homePlanDetailForm, setHomePlanDetailForm] = useState<FoodPlanDetailFormState>(() => createPlanDetailForm());
  const [isHomePlanDetailEditing, setIsHomePlanDetailEditing] = useState(false);
  const [visibleExpiryCount, setVisibleExpiryCount] = useState(10);
  const [visibleDashboardTodoCount, setVisibleDashboardTodoCount] = useState(DASHBOARD_TODO_PAGE_SIZE);
  const [homeExpiredDisposalIngredientId, setHomeExpiredDisposalIngredientId] = useState<string | null>(null);
  const [homeExpiryReviewItemId, setHomeExpiryReviewItemId] = useState<string | null>(null);
  const [homeRestockShoppingItemId, setHomeRestockShoppingItemId] = useState<string | null>(null);
  const [homeRestockForm, setHomeRestockForm] = useState<HomeRestockFormState | null>(null);
  const [homeMealDetailId, setHomeMealDetailId] = useState<string | null>(null);

  useEffect(() => {
    const defaultDate = todayKey();
    if (defaultDate >= input.foodPlanWeekRange.start && defaultDate <= input.foodPlanWeekRange.end) {
      setSelectedDashboardPlanDate(defaultDate);
      return;
    }
    setSelectedDashboardPlanDate(input.foodPlanWeekRange.start);
  }, [input.foodPlanWeekRange.end, input.foodPlanWeekRange.start]);

  function resetVisibleExpiryCount() {
    setVisibleExpiryCount(10);
  }

  function openHomePlanDetail(item: FoodPlanItem) {
    setHomePlanDetailItemId(item.id);
    setHomePlanDetailForm(createPlanDetailForm(item));
    setIsHomePlanDetailEditing(false);
  }

  function closeHomePlanDetail() {
    setHomePlanDetailItemId(null);
    setIsHomePlanDetailEditing(false);
  }

  function resetHomePlanDetailForm(item?: FoodPlanItem | null) {
    if (!item) return;
    setHomePlanDetailForm(createPlanDetailForm(item));
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
    setHomePlanAddForm(createDefaultPlanAddForm());
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
    visibleExpiryCount,
    setVisibleExpiryCount,
    visibleDashboardTodoCount,
    setVisibleDashboardTodoCount,
    homeExpiredDisposalIngredientId,
    setHomeExpiredDisposalIngredientId,
    homeExpiryReviewItemId,
    setHomeExpiryReviewItemId,
    homeRestockShoppingItemId,
    setHomeRestockShoppingItemId,
    homeRestockForm,
    setHomeRestockForm,
    homeMealDetailId,
    setHomeMealDetailId,
    resetVisibleExpiryCount,
    openHomePlanDetail,
    closeHomePlanDetail,
    resetHomePlanDetailForm,
    openHomePlanAddDialog,
    openHomePlanAddEmptyDialog,
    selectHomePlanAddFood,
    closeHomePlanAddDialog,
  };
}
