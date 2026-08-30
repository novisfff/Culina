import type { ReactNode } from 'react';
import type { AppNavigationTarget } from '../../app/appNavigationModel';
import type { FoodPlanNavigationRequest } from '../../app/useAppGlobalSearchNavigation';
import type {
  CompleteFoodPlanItemPayload,
  MealLog,
  MealLogCandidate,
  RecordMealPayload,
  RecordMealResponse,
  UpdateMealLogPayload,
} from '../../api/types/meal';
import type {
  Food,
  FoodPayload,
  FoodPlanItem,
  FoodScene,
  Ingredient,
  MealType,
  Member,
  Recipe,
  RecipePayload,
  ShoppingListItem,
  UpdateFoodPayload,
} from '../../api/types/food';
import type { UpdateShoppingItemPayload } from '../../api/ingredientsApi';
import type { MealRecordResult } from '../../features/meals/useMealRecordResultState';

export type FoodWorkspaceProps = {
  foods: Food[];
  recipes: Recipe[];
  ingredients: Ingredient[];
  inventoryItems: import('../../api/types/food').InventoryItem[];
  mealLogs: MealLog[];
  members: Member[];
  foodScenes: FoodScene[];
  foodPlanItems: FoodPlanItem[];
  foodPlanWeekRange: { start: string; end: string };
  isPhoneViewport?: boolean;
  notificationCenter?: ReactNode;
  navigationRequest?: { foodId: string; requestId: number; target?: 'detail' | 'edit' | 'quickMeal'; quickMealAction?: 'eat' | 'cook' } | null;
  foodPlanNavigationRequest?: FoodPlanNavigationRequest | null;
  createFood: (payload: FoodPayload) => Promise<Food>;
  updateFood: (foodId: string, payload: UpdateFoodPayload) => Promise<Food>;
  updateFoodFavorite: (foodId: string, favorite: boolean, expectedRowVersion: number) => Promise<Food>;
  createRecipe: (payload: RecipePayload) => Promise<Recipe>;
  updateRecipe: (recipeId: string, payload: RecipePayload) => Promise<Recipe>;
  recordMeal: (payload: RecordMealPayload) => Promise<RecordMealResponse>;
  loadMealCandidates?: (date: string, mealType: MealType) => Promise<MealLogCandidate[]>;
  onRecordSuccess?: (response: RecordMealResponse) => void;
  recordResult?: MealRecordResult | null;
  isRevertingRecord?: boolean;
  recordRevertError?: string | null;
  recordRateError?: string | null;
  onRevertRecord?: () => void | Promise<void>;
  onViewRecord?: () => void;
  onRateRecord?: (rating: number | null | undefined) => void | Promise<void>;
  onDismissRecord?: () => void;
  completeFoodPlanItem: (itemId: string, payload: CompleteFoodPlanItemPayload) => Promise<MealLog>;
  updateMealLog: (mealLogId: string, payload: UpdateMealLogPayload) => Promise<unknown>;
  shoppingItems: ShoppingListItem[];
  createShoppingItem: (payload: {
    title: string; quantity?: number | null; unit?: string | null; ingredient_id?: string | null; food_id?: string | null;
    quantity_mode?: ShoppingListItem['quantity_mode']; display_label?: string | null; reason: string;
  }) => Promise<unknown>;
  updateShoppingItem: (itemId: string, payload: UpdateShoppingItemPayload) => Promise<unknown>;
  createFoodPlanItem: (payload: { food_id: string; plan_date: string; meal_type: MealType; note: string }) => Promise<FoodPlanItem>;
  updateFoodPlanItem: (itemId: string, payload: { food_id?: string; plan_date?: string; meal_type?: MealType; note?: string; status?: 'planned' | 'cooked' | 'skipped' }) => Promise<FoodPlanItem>;
  deleteFoodPlanItem: (itemId: string) => Promise<void>;
  createFoodScene: (payload: { name: string; description: string; image_prompt: string; image_asset_id?: string; hidden: boolean; custom: boolean; sort_order: number }) => Promise<FoodScene>;
  updateFoodScene: (sceneId: string, payload: { name?: string; description?: string; image_prompt?: string; image_asset_id?: string; hidden?: boolean; custom?: boolean; sort_order?: number }) => Promise<FoodScene>;
  deleteFoodScene: (sceneId: string) => Promise<void>;
  onStartRecipe: (recipeId: string, foodPlanItemId?: string) => void;
  navigate?: (target: AppNavigationTarget) => void;
  onOpenLogs: () => void;
  onFoodPlanPreviousWeek: () => void;
  onFoodPlanCurrentWeek: () => void;
  onFoodPlanNextWeek: () => void;
  isSavingFood?: boolean;
  isCreatingRecipe?: boolean;
  isUpdatingRecipe?: boolean;
  isUpdatingFavorite?: boolean;
  isQuickAdding?: boolean;
  isCompletingPlan?: boolean;
  isUpdatingPlan?: boolean;
  isUpdatingScene?: boolean;
  isUpdatingMeal?: boolean;
  isCreatingShopping?: boolean;
};
