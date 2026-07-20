import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { isApiError } from '../../api/request';
import type { UpdateShoppingItemPayload } from '../../api/ingredientsApi';
import { queryKeys } from '../../api/queryKeys';
import type {
  CompleteFoodPlanItemPayload,
  Food,
  FoodPlanItem,
  FoodPayload,
  FoodScene,
  FoodType,
  Ingredient,
  InventoryItem,
  MealLog,
  MealLogCandidate,
  MealType,
  MediaAsset,
  Member,
  RecordMealPayload,
  RecordMealResponse,
  RecordMealTarget,
  Recipe,
  RecipePayload,
  ShoppingListItem,
  UpdateFoodPayload,
  UpdateMealLogPayload,
} from '../../api/types';
import type { AppNavigationTarget } from '../../app/appNavigationModel';
import type { FoodPlanNavigationRequest } from '../../app/useAppGlobalSearchNavigation';
import { buildMediaSizes, buildMediaSrcSet, resolveAssetUrl, resolveMediaUrl } from '../../lib/assets';
import { getMediaIds, getPendingImageJobId } from '../../lib/aiImages';
import { parseOptionalFoodStockQuantity } from '../../lib/foodStockQuantity';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
import {
  ActionButton,
  EmptyState,
  FormActions,
  OptionChipGroup,
  SearchField,
  WorkspaceModal,
  WorkspaceOverlayFrame,
} from '../ui-kit';
import { FoodPlanDetailModal } from './FoodPlanDetailModal';
import { FoodPlanDialog } from './FoodPlanDialog';
import { FoodQuickMealDialog, type FoodQuickMealDialogState } from './FoodQuickMealDialog';
import { FoodRecipeEditorDialog } from './FoodRecipeEditorDialog';
import { FoodSceneDialogs } from './FoodSceneDialogs';
import { FoodDiscoverSurface } from './FoodDiscoverSurface';
import { FoodHubView } from './FoodHubView';
import { FoodPlanSurface, type FoodPlanSurfaceProps } from './FoodPlanSurface';
import { FoodPlanWeekMobilePage } from './FoodPlanWeekMobilePage';
import { MealCandidateSelector } from '../../features/meals/MealCandidateSelector';
import {
  buildRecordMealPayload,
  canSubmitWithCandidateResolution,
  createMealBusinessDate,
  createMealRecordDateOptions,
  deriveCandidatePresentation,
  type MealCandidateResolution,
  type MealComposerFood,
} from '../../features/meals/MealComposerModel';
import {
  extractMealRecordErrorCode,
  messageFromMealRecordReason,
} from '../../features/meals/mealRecordErrors';
import { FoodTabletSupportSurface } from './FoodTabletSupportSurface';
import { MealEnrichmentModal } from '../../features/meals/MealEnrichmentModal';
import { MealQuickRecordView } from '../../features/meals/MealQuickRecordView';
import { MealRecordResultBar } from '../../features/meals/MealRecordResultBar';
import { useMealCandidateData } from '../../features/meals/useMealCandidateData';
import type { MealRecordResult } from '../../features/meals/useMealRecordResultState';
import { FOOD_TYPE_LABELS, MEAL_TYPE_LABELS, formatDate, getFoodCover, getFoodCoverAsset, getImagePreview, splitTags, todayKey } from '../../lib/ui';
import {
  IDLE_IMAGE_GENERATION_STATE,
  useImageComposer,
} from '../../hooks/useImageComposer';
import { useDebouncedSearchValue, useSearchCompositionState } from '../../hooks/useDebouncedValue';
import { usePagedList } from '../../hooks/usePagedList';
import { useNotice } from '../../hooks/useNotice';
import { buildRecipeCards } from '../recipes/workspaceModel';
import { RecipeEditorView } from '../recipes/RecipeEditorView';
import { useRecipeEditorState } from '../recipes/useRecipeEditorState';
import {
  buildRecipeImagePayload,
  buildRecipePayload,
  getRecipeDraftGenerationButtonLabel,
  resolveErrorMessage,
} from '../recipes/RecipeWorkspaceModel';
import { FoodUiIcon } from './FoodWorkspacePrimitives';
import {
  FOOD_CREATE_TYPE_OPTIONS,
  FOOD_GOVERNANCE_ISSUE_OPTIONS,
  FOOD_LENS_COPY,
  FOOD_TYPE_OPTIONS,
  MEAL_OPTIONS,
  type FoodGovernanceIssue,
  type FoodWorkspaceLens,
} from './FoodWorkspaceOptions';
import {
  buildDirectCookTarget,
  getFoodFormCompletionItems,
  getFoodImagePayload,
  buildFoodPayloadFromForm,
  type FoodFormState,
} from './FoodWorkspaceModel';
import { useFoodPlanState } from './useFoodPlanState';
import { useFoodSceneState, type FoodSceneCardView } from './useFoodSceneState';
import { useFoodWorkspaceState } from './useFoodWorkspaceState';
import { FoodDetailDrawer } from './FoodDetailDrawer';
import { FoodEditorForm } from './FoodEditorForm';
import { FoodMobileView } from './FoodMobileView';
import { FoodShoppingDialog } from './FoodShoppingDialog';
import {
  buildFoodShoppingDialogState,
  buildFoodShoppingWrite,
  type FoodShoppingDialogState,
} from './FoodShoppingModel';
import { RecipeShoppingDialog } from '../recipes/RecipeShoppingDialog';
import { useRecipeShoppingState } from '../recipes/useRecipeShoppingState';
import { SHOPPING_UNIT_OPTIONS } from '../recipes/RecipeWorkspaceOptions';
import { resolveIngredientImageUrl } from '../recipes/RecipeWorkspaceModel';
import {
  NormalizedFoodType,
  normalizeFoodType,
  isReadyLikeFood,
  isOutsideFood,
  getFoodSceneTags,
  describeExpiry,
  getFoodStatus,
  getFoodInventoryConfirmation,
  getMealUsage,
  getDefaultMealType,
  getPrimaryFoodActionLabel,
  getSecondaryFoodActionLabel,
  getRepurchaseLabel,
  getFoodFactRows,
  getFoodMealHistory,
  getFoodAudienceText,
  getDaysUntil,
  getDaysSince,
  isFoodExpiring,
  getFoodGovernanceIssues,
  getFoodGovernanceIssueLabels,
  isFoodMissingDecisionInfo,
  buildFoodRelationViewModelFromRecipeCards,
  buildFoodCookingSummaryFromRecipeCards,
  chunkFoodCardPages,
  formatFoodStockQuantity,
  type FoodCookingSummary,
} from './FoodWorkspaceHelpers';

const FOOD_EDITOR_FORM_ID = 'food-editor-form';

export { FOOD_CREATE_TYPE_OPTIONS, type FoodGovernanceIssue } from './FoodWorkspaceOptions';
export { buildFoodPayloadFromForm, type FoodFormState } from './FoodWorkspaceModel';

export type TodayFoodRecommendation = {
  food: Food;
  mealType: MealType;
  score: number;
  reasons: string[];
};

type FoodWorkspaceNavigationRequest = NonNullable<Props['navigationRequest']>;

type FoodNavigationRequestAction =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'edit'; food: Food; requestId: number }
  | { kind: 'quickMeal'; food: Food; requestId: number; quickMealAction: 'eat' | 'cook' };

export function resolveFoodNavigationRequestAction(args: {
  foods: Food[];
  navigationRequest?: FoodWorkspaceNavigationRequest | null;
  handledRequestId: number | null;
}): FoodNavigationRequestAction {
  const { foods, navigationRequest, handledRequestId } = args;
  if (!navigationRequest || navigationRequest.target === 'detail' || handledRequestId === navigationRequest.requestId) {
    return { kind: 'idle' };
  }
  const food = foods.find((item) => item.id === navigationRequest.foodId);
  if (!food) {
    return { kind: 'pending' };
  }
  if (navigationRequest.target === 'edit') {
    return { kind: 'edit', food, requestId: navigationRequest.requestId };
  }
  return {
    kind: 'quickMeal',
    food,
    requestId: navigationRequest.requestId,
    quickMealAction: navigationRequest.quickMealAction ?? 'eat',
  };
}

type Props = {
  foods: Food[];
  recipes: Recipe[];
  ingredients: Ingredient[];
  inventoryItems: InventoryItem[];
  mealLogs: MealLog[];
  members: Member[];
  foodScenes: FoodScene[];
  foodPlanItems: FoodPlanItem[];
  foodPlanWeekRange: { start: string; end: string };
  isPhoneViewport?: boolean;
  notificationCenter?: ReactNode;
  navigationRequest?: {
    foodId: string;
    requestId: number;
    target?: 'detail' | 'edit' | 'quickMeal';
    quickMealAction?: 'eat' | 'cook';
  } | null;
  foodPlanNavigationRequest?: FoodPlanNavigationRequest | null;
  createFood: (payload: FoodPayload) => Promise<Food>;
  updateFood: (foodId: string, payload: UpdateFoodPayload) => Promise<Food>;
  updateFoodFavorite: (foodId: string, favorite: boolean, expectedRowVersion: number) => Promise<Food>;
  createRecipe: (payload: RecipePayload) => Promise<Recipe>;
  updateRecipe: (recipeId: string, payload: RecipePayload) => Promise<Recipe>;
  /** Ordinary Food card / takeout / dining-out record owner (Task 15). */
  recordMeal: (payload: RecordMealPayload) => Promise<RecordMealResponse>;
  /** Injectable candidate loader for compact record. */
  loadMealCandidates?: (date: string, mealType: MealType) => Promise<MealLogCandidate[]>;
  /** Publish ordinary record result into App-level shared state. */
  onRecordSuccess?: (response: RecordMealResponse) => void;
  /** Shared ordinary-record result bar contract from App. */
  recordResult?: MealRecordResult | null;
  isRevertingRecord?: boolean;
  recordRevertError?: string | null;
  recordRateError?: string | null;
  onRevertRecord?: () => void | Promise<void>;
  onViewRecord?: () => void;
  onRateRecord?: (rating: number | null | undefined) => void | Promise<void>;
  onDismissRecord?: () => void;
  /** Non-Recipe Food workspace plan completion owner. */
  completeFoodPlanItem: (itemId: string, payload: CompleteFoodPlanItemPayload) => Promise<MealLog>;
  updateMealLog: (mealLogId: string, payload: UpdateMealLogPayload) => Promise<unknown>;
  shoppingItems: ShoppingListItem[];
  createShoppingItem: (payload: {
    title: string;
    quantity?: number | null;
    unit?: string | null;
    ingredient_id?: string | null;
    food_id?: string | null;
    quantity_mode?: ShoppingListItem['quantity_mode'];
    display_label?: string | null;
    reason: string;
  }) => Promise<unknown>;
  updateShoppingItem: (itemId: string, payload: UpdateShoppingItemPayload) => Promise<unknown>;
  createFoodPlanItem: (payload: { food_id: string; plan_date: string; meal_type: MealType; note: string }) => Promise<FoodPlanItem>;
  updateFoodPlanItem: (itemId: string, payload: { food_id?: string; plan_date?: string; meal_type?: MealType; note?: string; status?: 'planned' | 'cooked' | 'skipped' }) => Promise<FoodPlanItem>;
  deleteFoodPlanItem: (itemId: string) => Promise<void>;
  createFoodScene: (payload: {
    name: string;
    description: string;
    image_prompt: string;
    image_asset_id?: string;
    hidden: boolean;
    custom: boolean;
    sort_order: number;
  }) => Promise<FoodScene>;
  updateFoodScene: (
    sceneId: string,
    payload: {
      name?: string;
      description?: string;
      image_prompt?: string;
      image_asset_id?: string;
      hidden?: boolean;
      custom?: boolean;
      sort_order?: number;
    }
  ) => Promise<FoodScene>;
  deleteFoodScene: (sceneId: string) => Promise<void>;
  onStartRecipe: (recipeId: string, foodPlanItemId?: string) => void;
  /** Semantic navigation for direct Cook (no implicit plan creation). */
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

type MobileCookingFilter = 'all' | 'ready' | 'shortage';

type FoodQuickRecordState = {
  food: Food;
  date: string;
  mealType: MealType;
  target: RecordMealTarget;
  selectedCandidateId: string | null;
  candidateMode: 'none' | 'single' | 'multi';
  candidates: MealLogCandidate[];
  candidateResolution: MealCandidateResolution;
  targetTouchedByUser: boolean;
  clientRequestId: string;
  busy: boolean;
  error: string | null;
};

function createClientRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `meal-record-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getFoodPlanDateParts(dateKey: string) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(year, (month || 1) - 1, day || 1);
  return {
    day: String(day || 1),
    month: String(month || 1),
    weekday: new Intl.DateTimeFormat('zh-CN', { weekday: 'short' }).format(date),
  };
}

const FOOD_QUICK_VIEW_OPTIONS: Array<{ value: FoodWorkspaceLens; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'selfMade', label: '家常菜' },
  { value: 'outside', label: '外卖外食' },
  { value: 'ready', label: '成品速食' },
];

const MOBILE_DEFAULT_FOOD_SCENES = [
  { key: 'protein', title: '高蛋白', fallbackIndex: 0 },
  { key: 'dinner', title: '工作日晚餐', fallbackIndex: 1 },
  { key: 'kid', title: '孩子也能吃', fallbackIndex: 2 },
  { key: 'light', title: '周末轻食', fallbackIndex: 3 },
];

function resolveFoodAssetUrl(url: string) {
  return resolveAssetUrl(url) ?? url;
}

export function getSuggestedMealTypeForHour(hour = new Date().getHours()): MealType {
  if (hour < 10) return 'breakfast';
  if (hour < 15) return 'lunch';
  if (hour < 22) return 'dinner';
  return 'snack';
}

function normalizeFormFoodType(foodType: FoodType): NormalizedFoodType {
  return foodType === 'packaged' ? 'readyMade' : foodType;
}

function isReadyLikeType(foodType: FoodType) {
  const normalizedType = normalizeFormFoodType(foodType);
  return normalizedType === 'readyMade' || normalizedType === 'instant';
}

function isOutsideType(foodType: FoodType) {
  const normalizedType = normalizeFormFoodType(foodType);
  return normalizedType === 'takeout' || normalizedType === 'diningOut';
}

function getFoodPriority(food: Food, mealLogs: MealLog[], lensFilter: FoodWorkspaceLens, recipes: Recipe[] = []) {
  const usage = getMealUsage(food, mealLogs);
  const daysUntilExpiry = getDaysUntil(food.expiry_date);
  const expiryScore = isFoodExpiring(food) ? 500 - Math.max(daysUntilExpiry ?? 0, -30) : 0;
  const missingScore = isFoodMissingDecisionInfo(food, recipes) ? 120 : 0;
  const favoriteScore = food.favorite ? 80 : 0;
  const usageScore = usage.count * 12;
  const recentScore = usage.last ? Number(usage.last.replace(/-/g, '')) / 10_000_000 : 0;
  const lensBoost =
    lensFilter === 'expiring'
      ? expiryScore * 2
      : lensFilter === 'needsInfo'
        ? missingScore * 2
        : lensFilter === 'favorite'
          ? favoriteScore + usageScore
          : 0;
  return lensBoost + expiryScore + missingScore + favoriteScore + usageScore + recentScore;
}

function getQuickDefaultMealType(food: Food, suggestedMealType: MealType): MealType {
  if (food.suitable_meal_types.includes(suggestedMealType)) return suggestedMealType;
  if (food.suitable_meal_types.length === 0) return suggestedMealType;
  return getDefaultMealType(food);
}

function openFoodDetailFromCard(event: KeyboardEvent<HTMLElement>, onOpenDetail: () => void) {
  if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
  event.preventDefault();
  onOpenDetail();
}

function getFoodCardPrimaryActionLabel(food: Food) {
  if (normalizeFoodType(food) === 'selfMade' && food.recipe_id) return '开始做';
  return getPrimaryFoodActionLabel(food);
}

function isFoodShoppingEligible(food: Food) {
  return isReadyLikeFood(food) || (normalizeFoodType(food) === 'selfMade' && Boolean(food.recipe_id));
}

function formatFoodStock(food: Food) {
  return formatFoodStockQuantity(food);
}

export function buildTodayFoodRecommendations(
  foods: Food[],
  mealLogs: MealLog[],
  options: { mealType?: MealType; today?: string; recipes?: Recipe[] } = {}
): TodayFoodRecommendation[] {
  const mealType = options.mealType ?? getSuggestedMealTypeForHour();
  const today = options.today ?? todayKey();
  const recipes = options.recipes ?? [];
  const foodsById = new Map(foods.map((food) => [food.id, food]));
  const recentTypeCounts = new Map<NormalizedFoodType, number>();

  mealLogs
    .filter((log) => {
      const daysSince = getDaysSince(log.date, today);
      return daysSince >= 0 && daysSince <= 3;
    })
    .forEach((log) => {
      log.food_entries.forEach((entry) => {
        const food = foodsById.get(entry.food_id);
        if (!food) return;
        const type = normalizeFoodType(food);
        recentTypeCounts.set(type, (recentTypeCounts.get(type) ?? 0) + 1);
      });
    });

  const dominantRecentType = Array.from(recentTypeCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const scored = foods
    .map((food) => {
      const usage = getMealUsage(food, mealLogs);
      const normalizedType = normalizeFoodType(food);
      const reasons: string[] = [];
      let score = 0;

      if (food.suitable_meal_types.includes(mealType)) {
        score += 130;
        reasons.push(`适合${MEAL_TYPE_LABELS[mealType]}`);
      } else if (food.suitable_meal_types.some((meal) => meal === 'lunch' || meal === 'dinner')) {
        score += 45;
        reasons.push('适合正餐');
      } else if (food.suitable_meal_types.length === 0) {
        score -= 70;
        reasons.push('未设置餐别');
      }

      const daysUntilExpiry = getDaysUntil(food.expiry_date);
      const expiring = isFoodExpiring(food);
      if (expiring) {
        const expiryScore = daysUntilExpiry == null ? 0 : daysUntilExpiry <= 0 ? 250 : daysUntilExpiry <= 3 ? 220 : 170;
        score += expiryScore;
        reasons.push(daysUntilExpiry == null || daysUntilExpiry > 0 ? '临期优先' : '今天需处理');
      }

      if (usage.last) {
        const daysSinceLast = getDaysSince(usage.last, today);
        const recentPenalty = daysSinceLast < 0 ? 0 : daysSinceLast <= 1 ? 160 : daysSinceLast <= 3 ? 90 : daysSinceLast <= 5 ? 45 : 0;
        if (recentPenalty > 0) {
          score -= expiring ? Math.round(recentPenalty * 0.45) : recentPenalty;
          reasons.push('最近吃过已降权');
        }
      }

      if (food.favorite) {
        score += 55;
        reasons.push('收藏');
      }
      if (usage.count >= 3) {
        score += 35;
        reasons.push('常复吃');
      } else if (usage.count > 0) {
        score += usage.count * 8;
      }
      if (food.rating != null) {
        score += food.rating >= 4 ? 55 : food.rating >= 3 ? 25 : -20;
        if (food.rating >= 4) reasons.push('高评分');
      }
      if (food.repurchase === true) {
        score += 45;
        reasons.push('愿意复购');
      }
      if (food.repurchase === false) {
        score -= 90;
        reasons.push('暂不复购');
      }
      if (dominantRecentType && normalizedType === dominantRecentType && !expiring) {
        score -= 35;
      } else if (dominantRecentType && normalizedType !== dominantRecentType) {
        score += 20;
        reasons.push('换个类型');
      }
      if (isFoodMissingDecisionInfo(food, recipes)) {
        score -= 25;
      }

      return {
        food,
        mealType: food.suitable_meal_types.includes(mealType) ? mealType : getDefaultMealType(food),
        score,
        reasons: (reasons.length > 0 ? reasons : ['可作为备选']).slice(0, 4),
      };
    })
    .sort((a, b) => b.score - a.score || b.food.updated_at.localeCompare(a.food.updated_at));

  const diverse: TodayFoodRecommendation[] = [];
  scored.forEach((item) => {
    if (diverse.length >= 3) return;
    const type = normalizeFoodType(item.food);
    if (diverse.length === 0 || !diverse.some((selected) => normalizeFoodType(selected.food) === type)) {
      diverse.push(item);
    }
  });

  scored.forEach((item) => {
    if (diverse.length >= 3) return;
    if (!diverse.some((selected) => selected.food.id === item.food.id)) {
      diverse.push(item);
    }
  });

  return diverse;
}



function getFoodEditorProfile(foodType: FoodType) {
  const normalizedType = normalizeFormFoodType(foodType);
  if (normalizedType === 'selfMade') {
    return {
      title: '家常菜核心资料',
      description: '重点确认菜谱与用料、适合餐别和家庭备注。',
    };
  }
  if (normalizedType === 'takeout' || normalizedType === 'diningOut') {
    return {
      title: normalizedType === 'takeout' ? '外卖复吃判断' : '外食复吃判断',
      description: '把店铺/餐厅、价格、评分和复购意愿补齐，下次就能快速判断要不要再吃。',
    };
  }
  return {
    title: '成品与速食库存',
    description: '优先维护购买渠道、剩余数量和到期日期，这类食物会进入临期提醒。',
  };
}

export function filterFoodWorkspaceItems(
  foods: Food[],
  search: string,
  typeFilter: 'all' | FoodType,
  mealFilter: 'all' | MealType,
  lensFilter: FoodWorkspaceLens = 'all',
  recipes: Recipe[] = [],
  matchedFoodIds: readonly string[] = []
) {
  const keyword = search.trim().toLowerCase();
  const matchedIdSet = new Set(matchedFoodIds);
  return foods.filter((food) => {
    const normalizedType = normalizeFoodType(food);
    const text = [food.name, food.category, food.source_name, food.purchase_source, food.scene, food.notes, food.routine_note, ...getFoodSceneTags(food)].join(' ').toLowerCase();
    const searchMatch = !keyword || matchedIdSet.has(food.id) || text.includes(keyword);
    const typeMatch = typeFilter === 'all' || normalizedType === typeFilter;
    const mealMatch = mealFilter === 'all' || food.suitable_meal_types.includes(mealFilter);
    const lensMatch =
      lensFilter === 'all' ||
      (lensFilter === 'today' && food.suitable_meal_types.some((meal) => meal === 'lunch' || meal === 'dinner')) ||
      (lensFilter === 'selfMade' && normalizedType === 'selfMade') ||
      (lensFilter === 'outside' && isOutsideFood(food)) ||
      (lensFilter === 'ready' && isReadyLikeFood(food)) ||
      (lensFilter === 'expiring' && isFoodExpiring(food)) ||
      (lensFilter === 'favorite' && food.favorite) ||
      (lensFilter === 'needsInfo' && isFoodMissingDecisionInfo(food, recipes));
    return searchMatch && typeMatch && mealMatch && lensMatch;
  });
}

export function getMobileFoodSceneFilterState(sceneName: string) {
  return {
    search: '',
    lensFilter: 'all' as const,
    typeFilter: 'all' as const,
    mealFilter: 'all' as const,
    sceneFilter: sceneName,
    governanceIssueFilter: 'all' as const,
  };
}

export function getMobileDefaultFoodSceneCardMedia(
  sceneName: string,
  foods: Food[],
  sceneCards: Array<Pick<FoodSceneCardView, 'name' | 'count' | 'imageUrl' | 'imageAsset'>>,
  fallbackIndex: number
): {
  count: number;
  imageFood?: Food;
  imageUrl?: string;
  imageAsset?: MediaAsset | null;
} {
  const managedScene = sceneCards.find((scene) => scene.name === sceneName);
  return {
    count: managedScene?.count ?? foods.filter((food) => getFoodSceneTags(food).includes(sceneName)).length,
    imageFood: foods.find((food) => getFoodSceneTags(food).includes(sceneName)) ?? foods[fallbackIndex] ?? foods[0],
    imageUrl: managedScene?.imageUrl,
    imageAsset: managedScene?.imageAsset,
  };
}

/** Plan detail with candidate confirmation for non-Recipe complete (Task 15). */
function FoodPlanDetailWithCandidates(props: {
  item: FoodPlanItem;
  food: Food | null;
  recipes: Recipe[];
  form: import('./FoodPlanDetailModal').FoodPlanDetailFormState;
  isEditing: boolean;
  isUpdatingPlan?: boolean;
  isCompleting?: boolean;
  onClose: () => void;
  onChangeForm: (form: import('./FoodPlanDetailModal').FoodPlanDetailFormState) => void;
  onEditingChange: (editing: boolean) => void;
  onResetEdit: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onComplete: (target?: {
    target_meal_log_id?: string | null;
    expected_meal_log_row_version?: number | null;
  }) => void;
  onDelete: () => void;
  resolveAssetUrl: (url: string) => string;
}) {
  const needsPlanCompleteCandidates = Boolean(
    props.item && !props.item.recipe_id && props.item.status !== 'cooked',
  );
  const planCandidateQuery = useMealCandidateData({
    open: needsPlanCompleteCandidates,
    date: props.item.plan_date,
    mealType: props.item.meal_type,
  });
  const planCandidates = planCandidateQuery.candidates;
  const planCandidatesFetched = planCandidateQuery.query.isFetched;
  const planCandidateIdsKey = planCandidates
    .map((candidate) => `${candidate.meal_log_id}:${candidate.row_version}`)
    .join(',');
  const [planCompleteTarget, setPlanCompleteTarget] = useState<RecordMealTarget>({ kind: 'new' });
  const [planCompleteSelectedCandidateId, setPlanCompleteSelectedCandidateId] = useState<string | null>(
    null,
  );
  const [planCompleteCandidateMode, setPlanCompleteCandidateMode] = useState<'none' | 'single' | 'multi'>(
    'none',
  );

  useEffect(() => {
    if (!needsPlanCompleteCandidates) {
      setPlanCompleteTarget((current) => (current.kind === 'new' ? current : { kind: 'new' }));
      setPlanCompleteSelectedCandidateId(null);
      setPlanCompleteCandidateMode('none');
      return;
    }
    if (!planCandidatesFetched) return;
    const presentation = deriveCandidatePresentation(planCandidates, props.item.meal_type);
    setPlanCompleteTarget(presentation.target);
    setPlanCompleteSelectedCandidateId(presentation.selectedCandidateId);
    setPlanCompleteCandidateMode(presentation.mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    needsPlanCompleteCandidates,
    props.item.id,
    props.item.plan_date,
    props.item.meal_type,
    planCandidateIdsKey,
    planCandidatesFetched,
  ]);

  const planCompleteDraftFoods: MealComposerFood[] = [
    {
      kind: 'existing',
      food_id: props.item.food_id,
      name: props.item.food_name,
      servings: 1,
      cover: null,
    },
  ];

  const planCompleteExtras =
    needsPlanCompleteCandidates ? (
      <MealCandidateSelector
        mode={planCompleteCandidateMode}
        mealType={props.item.meal_type}
        candidates={planCandidates}
        selectedCandidateId={planCompleteSelectedCandidateId}
        target={planCompleteTarget}
        draftFoods={planCompleteDraftFoods}
        disabled={props.isCompleting}
        className="food-plan-detail-candidates"
        onTargetChange={(target, selectedCandidateId) => {
          setPlanCompleteTarget(target);
          setPlanCompleteSelectedCandidateId(selectedCandidateId ?? null);
        }}
      />
    ) : null;

  function handleComplete() {
    if (props.item.recipe_id) {
      props.onComplete();
      return;
    }
    const target =
      planCompleteTarget.kind === 'existing'
        ? {
            target_meal_log_id: planCompleteTarget.meal_log_id,
            expected_meal_log_row_version: planCompleteTarget.expected_row_version,
          }
        : undefined;
    props.onComplete(target);
  }

  return (
    <FoodPlanDetailModal
      item={props.item}
      food={props.food}
      recipes={props.recipes}
      form={props.form}
      isEditing={props.isEditing}
      isUpdatingPlan={props.isUpdatingPlan}
      isCompleting={props.isCompleting}
      completeExtras={planCompleteExtras}
      onClose={props.onClose}
      onChangeForm={props.onChangeForm}
      onEditingChange={props.onEditingChange}
      onResetEdit={props.onResetEdit}
      onSubmit={props.onSubmit}
      onComplete={handleComplete}
      onDelete={props.onDelete}
      resolveAssetUrl={props.resolveAssetUrl}
      overlayRootClassName="food-workspace-overlay-root"
    />
  );
}

export function FoodWorkspace(props: Props) {
  const {
    view,
    setView,
    editingFood,
    detailFoodId,
    closeDetail,
    form,
    setForm,
    search,
    setSearch,
    lensFilter,
    setLensFilter,
    governanceIssueFilter,
    setGovernanceIssueFilter,
    typeFilter,
    setTypeFilter,
    mealFilter,
    setMealFilter,
    sceneFilter,
    setSceneFilter,
    isSceneTagPickerOpen,
    setIsSceneTagPickerOpen,
    newSceneTagName,
    setNewSceneTagName,
    feedback,
    setFeedback,
    editorSceneTags,
    openCreate,
    openEdit,
    openDetail,
    submitFood,
    toggleMealType,
    removeSceneTag,
    addSceneTag,
    createAndAddSceneTag,
    clearFoodFilters,
    openGovernanceIssue,
  } = useFoodWorkspaceState({
    foods: props.foods,
    foodScenes: props.foodScenes,
    recipes: props.recipes,
    navigationRequest: props.navigationRequest,
    createFood: props.createFood,
    updateFood: props.updateFood,
    createFoodScene: props.createFoodScene,
  });
  const { notice, showNotice, clearNotice } = useNotice();
  const recipeShopping = useRecipeShoppingState({
    ingredients: props.ingredients,
    createShoppingItem: props.createShoppingItem,
    showRecipeNotice: showNotice,
  });
  const foodPlanWeekRef = useRef<HTMLDivElement | null>(null);
  const [mobileWeekPlanDate, setMobileWeekPlanDate] = useState<string | null>(null);
  const [planMealEnrichment, setPlanMealEnrichment] = useState<{
    meal: MealLog;
    planItem: FoodPlanItem;
  } | null>(null);
  const [foodShoppingDialog, setFoodShoppingDialog] = useState<FoodShoppingDialogState | null>(null);
  const [foodShoppingError, setFoodShoppingError] = useState<string | null>(null);
  const [isFoodShoppingSubmitting, setIsFoodShoppingSubmitting] = useState(false);

  const handleNavigateToWeek = useCallback((planDate: string) => {
    if (props.isPhoneViewport) {
      setMobileWeekPlanDate(planDate);
      return;
    }
    requestAnimationFrame(() => {
      foodPlanWeekRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
      foodPlanWeekRef.current?.focus({ preventScroll: true });
    });
  }, [props.isPhoneViewport]);

  const {
    closeSceneForm,
    deleteScene,
    generateFoodSceneImage,
    isSceneManagerOpen,
    openCreateScene,
    openEditScene,
    sceneCards,
    sceneDraft,
    sceneFormMode,
    sceneImageState,
    setIsSceneManagerOpen,
    setSceneDraft,
    submitScene,
  } = useFoodSceneState({
    foods: props.foods,
    foodScenes: props.foodScenes,
    createFoodScene: props.createFoodScene,
    updateFoodScene: props.updateFoodScene,
    deleteFoodScene: props.deleteFoodScene,
  });
  const {
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
  } = useFoodPlanState({
    foods: props.foods,
    foodPlanItems: props.foodPlanItems,
    foodPlanWeekRange: props.foodPlanWeekRange,
    navigationRequest: props.foodPlanNavigationRequest,
    onNavigateToWeek: handleNavigateToWeek,
    showNotice,
    setFeedback,
    getDefaultMealType,
    createFoodPlanItem: props.createFoodPlanItem,
    updateFoodPlanItem: props.updateFoodPlanItem,
    deleteFoodPlanItem: props.deleteFoodPlanItem,
    completeFoodPlanItem: props.completeFoodPlanItem,
    // Plan complete must never publish ordinary record undo.
    publishRecordResult: undefined,
    onMealRecorded: (meal, planItem) => setPlanMealEnrichment({ meal, planItem }),
    onStartRecipe: props.onStartRecipe,
  });
  const recipeEditor = useRecipeEditorState({ ingredients: props.ingredients });
  const normalizedFoodSearch = search.trim();
  const foodSearchComposition = useSearchCompositionState();
  const foodSearchValue = useDebouncedSearchValue(search, { isComposing: foodSearchComposition.isComposing });
  const foodSearchQuery = useQuery({
    queryKey: queryKeys.foodSearch(foodSearchValue),
    queryFn: () => api.getFoods({ q: foodSearchValue, limit: 100 }),
    enabled: Boolean(foodSearchValue),
    placeholderData: keepPreviousData,
  });
  const [appliedFoodSearch, setAppliedFoodSearch] = useState('');
  const [appliedFoodResults, setAppliedFoodResults] = useState<Food[]>([]);
  useEffect(() => {
    if (!normalizedFoodSearch) {
      setAppliedFoodSearch('');
      setAppliedFoodResults([]);
      return;
    }
    if (foodSearchValue && !foodSearchQuery.isPlaceholderData && foodSearchQuery.data) {
      setAppliedFoodSearch(foodSearchValue);
      setAppliedFoodResults(foodSearchQuery.data);
    }
  }, [foodSearchQuery.data, foodSearchQuery.isPlaceholderData, foodSearchValue, normalizedFoodSearch]);
  const matchedFoodIds = useMemo(
    () => (appliedFoodSearch ? Array.from(new Set(appliedFoodResults.map((food) => food.id))) : []),
    [appliedFoodResults, appliedFoodSearch]
  );
  const searchAwareFoods = appliedFoodSearch ? appliedFoodResults : props.foods;
  const isFoodSearchFetching =
    Boolean(normalizedFoodSearch) &&
    !foodSearchComposition.isComposing &&
    (appliedFoodSearch !== normalizedFoodSearch || foodSearchQuery.isFetching);

  const foodUsageCards = useMemo(
    () => props.foods.map((food) => ({ food, usage: getMealUsage(food, props.mealLogs) })),
    [props.foods, props.mealLogs]
  );
  const recipeCards = useMemo(
    () => buildRecipeCards(props.recipes, props.ingredients, props.inventoryItems, props.mealLogs, props.foods),
    [props.foods, props.ingredients, props.inventoryItems, props.mealLogs, props.recipes]
  );
  const getFoodCookingSummary = (food: Food): FoodCookingSummary | null => buildFoodCookingSummaryFromRecipeCards(food, recipeCards);
  const expiringFoods = useMemo(() => props.foods.filter(isFoodExpiring), [props.foods]);
  const needsInfoFoods = useMemo(() => props.foods.filter((food) => isFoodMissingDecisionInfo(food, props.recipes)), [props.foods, props.recipes]);
  const governanceIssueSummaries = useMemo(
    () =>
      FOOD_GOVERNANCE_ISSUE_OPTIONS.map((item) => ({
        ...item,
        count: props.foods.filter((food) => getFoodGovernanceIssues(food, props.recipes).includes(item.value)).length,
      })),
    [props.foods, props.recipes]
  );
  const governanceQueue = useMemo(
    () =>
      needsInfoFoods
        .filter((food) => governanceIssueFilter === 'all' || getFoodGovernanceIssues(food, props.recipes).includes(governanceIssueFilter))
        .slice()
        .sort((a, b) => getFoodGovernanceIssues(b, props.recipes).length - getFoodGovernanceIssues(a, props.recipes).length || b.updated_at.localeCompare(a.updated_at)),
    [governanceIssueFilter, needsInfoFoods, props.recipes]
  );
  const suggestedMealType = useMemo(() => getSuggestedMealTypeForHour(), []);
  const repeatFoods = useMemo(
    () =>
      foodUsageCards
        .filter(({ food, usage }) => food.favorite || usage.count >= 2)
        .sort((a, b) => Number(b.food.favorite) - Number(a.food.favorite) || b.usage.count - a.usage.count)
        .slice(0, 3),
    [foodUsageCards]
  );
  const filteredFoods = useMemo(() => {
    const items = filterFoodWorkspaceItems(searchAwareFoods, appliedFoodSearch, typeFilter, mealFilter, lensFilter, props.recipes, matchedFoodIds)
      .filter((food) => sceneFilter === 'all' || getFoodSceneTags(food).includes(sceneFilter))
      .filter((food) => lensFilter !== 'needsInfo' || governanceIssueFilter === 'all' || getFoodGovernanceIssues(food, props.recipes).includes(governanceIssueFilter));
    if (appliedFoodSearch) {
      return items;
    }
    return items
      .slice()
      .sort((a, b) => getFoodPriority(b, props.mealLogs, lensFilter, props.recipes) - getFoodPriority(a, props.mealLogs, lensFilter, props.recipes));
  }, [appliedFoodSearch, governanceIssueFilter, lensFilter, matchedFoodIds, mealFilter, props.mealLogs, props.recipes, searchAwareFoods, sceneFilter, typeFilter]);
  const foodCardPager = usePagedList({
    itemCount: filteredFoods.length,
    resetKey: [
      appliedFoodSearch,
      typeFilter,
      mealFilter,
      lensFilter,
      sceneFilter,
      governanceIssueFilter,
    ].join('|'),
  });
  const visibleFoods = filteredFoods.slice(0, foodCardPager.visibleCount);
  const foodCardPages = chunkFoodCardPages(visibleFoods);
  const currentLensCopy = FOOD_LENS_COPY[lensFilter];
  const detailFood = detailFoodId ? props.foods.find((food) => food.id === detailFoodId) ?? null : null;
  const repeatFoodCount = foodUsageCards.filter(({ food, usage }) => food.favorite || usage.count >= 2).length;
  const managementIssueCount = new Set([...expiringFoods, ...needsInfoFoods].map((food) => food.id)).size;
  const nextGovernanceFood = governanceQueue[0] ?? null;
  const nextGovernanceSummary = nextGovernanceFood ? `${nextGovernanceFood.name} · ${getFoodGovernanceIssueLabels(nextGovernanceFood, props.recipes).join('、')}` : '资料已够完整';
  const hasFoodFilters = Boolean(search.trim()) || typeFilter !== 'all' || mealFilter !== 'all' || lensFilter !== 'all' || sceneFilter !== 'all' || governanceIssueFilter !== 'all';
  const todayDate = todayKey();
  const mealBusinessDate = createMealBusinessDate();
  // Recipe cook confirmation still uses FoodQuickMealDialog (no stock fields).
  const [quickMealDialog, setQuickMealDialog] = useState<FoodQuickMealDialogState | null>(null);
  // Non-Recipe Food card / takeout / dining-out uses compact prefilled MealQuickRecordView.
  const [quickRecord, setQuickRecord] = useState<FoodQuickRecordState | null>(null);
  const [isFoodRecipeEditorOpen, setIsFoodRecipeEditorOpen] = useState(false);
  const [mobileCookingFilter, setMobileCookingFilter] = useState<MobileCookingFilter>('all');
  const quickMealDateOptions = useMemo(
    () => createMealRecordDateOptions(mealBusinessDate),
    [mealBusinessDate]
  );
  function selectMobileFoodScene(sceneName: string) {
    const nextFilters = getMobileFoodSceneFilterState(sceneName);
    setSearch(nextFilters.search);
    setLensFilter(nextFilters.lensFilter);
    setTypeFilter(nextFilters.typeFilter);
    setMealFilter(nextFilters.mealFilter);
    setSceneFilter(nextFilters.sceneFilter);
    setGovernanceIssueFilter(nextFilters.governanceIssueFilter);
  }

  const mobileDefaultSceneCards = MOBILE_DEFAULT_FOOD_SCENES.map((scene) => ({
    key: scene.key,
    title: scene.title,
    ...getMobileDefaultFoodSceneCardMedia(scene.title, props.foods, sceneCards, scene.fallbackIndex),
    onClick: () => selectMobileFoodScene(scene.title),
  }));
  const mobileSceneExploreCards = [
    ...mobileDefaultSceneCards,
    ...sceneCards
      .filter((scene) => !mobileDefaultSceneCards.some((card) => card.title === scene.name))
      .map((scene) => ({
        key: `scene-${scene.name}`,
        title: scene.name,
        count: scene.count,
        imageFood: props.foods.find((food) => getFoodSceneTags(food).includes(scene.name)) ?? props.foods[0],
        imageUrl: scene.imageUrl,
        imageAsset: scene.imageAsset,
        onClick: () => selectMobileFoodScene(scene.name),
      })),
  ];
  const mobileScenePages = Array.from({ length: Math.ceil(mobileSceneExploreCards.length / 2) || 1 }, (_, index) =>
    mobileSceneExploreCards.slice(index * 2, index * 2 + 2)
  );
  const mobileLibraryFoods = filteredFoods.filter((food) => {
    if (mobileCookingFilter === 'all') return true;
    const summary = getFoodCookingSummary(food);
    if (!summary) return false;
    return mobileCookingFilter === 'ready' ? summary.isReady : summary.shortagePreview.length > 0;
  });
  const mobileLibraryResetKey = [appliedFoodSearch, typeFilter, mealFilter, lensFilter, sceneFilter, governanceIssueFilter, mobileCookingFilter].join('|');
  const mobileFilterTabs = [
    {
      label: '全部',
      active: lensFilter === 'all' && typeFilter === 'all' && mealFilter === 'all' && sceneFilter === 'all' && governanceIssueFilter === 'all' && mobileCookingFilter === 'all',
      onClick: () => {
        clearFoodFilters();
        setMobileCookingFilter('all');
      },
    },
    {
      label: '家常',
      active: typeFilter === 'selfMade',
      onClick: () => {
        setMobileCookingFilter('all');
        setLensFilter('all');
        setTypeFilter('selfMade');
        setMealFilter('all');
        setSceneFilter('all');
        setGovernanceIssueFilter('all');
      },
    },
    {
      label: '外卖',
      active: typeFilter === 'takeout',
      onClick: () => {
        setMobileCookingFilter('all');
        setLensFilter('all');
        setTypeFilter('takeout');
        setMealFilter('all');
        setSceneFilter('all');
        setGovernanceIssueFilter('all');
      },
    },
    {
      label: '收藏',
      active: lensFilter === 'favorite',
      onClick: () => {
        setMobileCookingFilter('all');
        setLensFilter('favorite');
        setTypeFilter('all');
        setMealFilter('all');
        setSceneFilter('all');
        setGovernanceIssueFilter('all');
      },
    },
    {
      label: '可做',
      active: mobileCookingFilter === 'ready',
      onClick: () => {
        setMobileCookingFilter('ready');
        setLensFilter('all');
        setTypeFilter('all');
        setMealFilter('all');
        setSceneFilter('all');
        setGovernanceIssueFilter('all');
      },
    },
    {
      label: '缺料',
      active: mobileCookingFilter === 'shortage',
      onClick: () => {
        setMobileCookingFilter('shortage');
        setLensFilter('all');
        setTypeFilter('all');
        setMealFilter('all');
        setSceneFilter('all');
        setGovernanceIssueFilter('all');
      },
    },
  ];

  const imagePayload = getFoodImagePayload(form, props.recipes);
  const imageComposer = useImageComposer({
    value: form.images,
    payload: imagePayload,
    onChange: (next) => setForm((current) => ({ ...current, images: next })),
    uploadErrorMessage: '图片上传成功，但生成主图失败。',
    generateErrorMessage: '生成主图失败，请稍后再试。',
  });
  const currentRecipe = props.recipes.find((recipe) => recipe.id === form.recipeId);
  const currentRecipeCard = currentRecipe ? recipeCards.find((card) => card.recipe.id === currentRecipe.id) ?? null : null;
  const isSelfMade = form.type === 'selfMade';
  const editorProfile = getFoodEditorProfile(form.type);
  const editorCompletionItems = getFoodFormCompletionItems(form, editingFood, props.recipes);
  const editorCompletedCount = editorCompletionItems.filter((item) => item.done).length;
  const editorCompletionPercent = Math.round((editorCompletedCount / editorCompletionItems.length) * 100);
  const sceneTagOptions = useMemo(() => {
    const names = new Set<string>();
    props.foodScenes.filter((scene) => !scene.hidden).forEach((scene) => names.add(scene.name));
    props.foods.forEach((food) => getFoodSceneTags(food).forEach((tag) => names.add(tag)));
    editorSceneTags.forEach((tag) => names.add(tag));
    return Array.from(names).sort((left, right) => left.localeCompare(right, 'zh-CN'));
  }, [editorSceneTags, props.foodScenes, props.foods]);
  const availableSceneTagOptions = sceneTagOptions.filter((tag) => !editorSceneTags.includes(tag));
  const editorRecipeCover = currentRecipe?.images[0]?.url ?? (editingFood ? getFoodCover(editingFood, props.recipes) : undefined);
  const editorRecipeMeta = currentRecipe ? `${currentRecipe.ingredient_items.length} 个原料 · ${currentRecipe.steps.length} 个步骤` : '还没有菜谱';
  const recipeEditorIngredientCount = recipeEditor.ingredientRows.filter((item) => item.ingredient_id || item.ingredient_name.trim()).length;
  const recipeEditorStepCount = recipeEditor.form.steps.filter((step) => step.text.trim()).length;
  const canSaveRecipeEditorDraft = Boolean(recipeEditor.form.title.trim() && recipeEditorIngredientCount > 0);
  const canSubmit = !props.isSavingFood && !props.isCreatingRecipe && !props.isUpdatingRecipe && (!isSelfMade || Boolean(form.recipeId) || canSaveRecipeEditorDraft);
  const foodEditorSubmitLabel = isSelfMade
    ? view === 'create'
      ? '保存家常菜谱'
      : '保存菜谱和资料'
    : view === 'create'
      ? '保存食物'
      : '保存修改';
  const recipeEditorSceneTags = splitTags(recipeEditor.form.sceneTags);
  const recipeEditorCoverAsset = getImagePreview(recipeEditor.form.images);
  const recipeEditorCoverUrl = resolveAssetUrl(recipeEditorCoverAsset?.url);
  const recipeEditorCompletionItems = [
    { label: '已填写基础信息', done: Boolean(recipeEditor.form.title.trim() && Number(recipeEditor.form.servings) > 0) },
    { label: '已添加原料', done: recipeEditorIngredientCount > 0 },
    { label: '已添加步骤', done: recipeEditorStepCount > 0 },
    { label: '已设置封面', done: Boolean(recipeEditorCoverAsset) },
  ];
  const recipeEditorCompletionPercent = Math.round(
    (recipeEditorCompletionItems.filter((item) => item.done).length / recipeEditorCompletionItems.length) * 100
  );
  const recipeEditorSceneSelectOptions = useMemo(() => {
    const names = new Set<string>();
    props.foodScenes.filter((scene) => !scene.hidden).forEach((scene) => names.add(scene.name));
    props.recipes.forEach((recipe) => recipe.scene_tags?.forEach((tag) => names.add(tag)));
    return Array.from(names).sort((left, right) => left.localeCompare(right, 'zh-CN'));
  }, [props.foodScenes, props.recipes]);
  const recipeEditorImagePayload = buildRecipeImagePayload(recipeEditor.form, recipeEditor.ingredientRows, props.ingredients);
  const recipeEditorImageComposer = useImageComposer({
    value: recipeEditor.form.images,
    payload: recipeEditorImagePayload,
    onChange: (images) => recipeEditor.setForm((current) => ({ ...current, images })),
    uploadErrorMessage: '参考图上传或 AI 主图生成失败',
    generateErrorMessage: 'AI 主图生成失败',
  });
  const recipeEditorSubmitDisabled = Boolean(props.isCreatingRecipe || props.isUpdatingRecipe);

  function handleOpenCreate(type: FoodType = 'takeout') {
    imageComposer.setState(IDLE_IMAGE_GENERATION_STATE);
    recipeEditorImageComposer.setState(IDLE_IMAGE_GENERATION_STATE);
    if (type === 'selfMade') {
      recipeEditor.openCreate();
    }
    openCreate(type);
  }

  function handleOpenEdit(food: Food) {
    imageComposer.setState(IDLE_IMAGE_GENERATION_STATE);
    recipeEditorImageComposer.setState(IDLE_IMAGE_GENERATION_STATE);
    if (normalizeFoodType(food) === 'selfMade' && food.recipe_id) {
      const card = recipeCards.find((item) => item.recipe.id === food.recipe_id);
      if (card) {
        recipeEditor.openEdit(card);
      }
    }
    openEdit(food);
  }

  function handleOpenRecipeEditor() {
    if (!currentRecipeCard) {
      if (view === 'create' && isSelfMade) {
        recipeEditor.openCreate();
        setIsFoodRecipeEditorOpen(true);
        return;
      }
      showNotice({ tone: 'warning', title: '还没有菜谱', message: '请先补一份菜谱与用料。' });
      return;
    }
    recipeEditorImageComposer.setState(IDLE_IMAGE_GENERATION_STATE);
    recipeEditor.openEdit(currentRecipeCard);
    setIsFoodRecipeEditorOpen(true);
  }

  function handleOpenRecipeEditorDirectly(food: Food) {
    if (food.recipe_id) {
      const card = recipeCards.find((item) => item.recipe.id === food.recipe_id);
      if (card) {
        recipeEditorImageComposer.setState(IDLE_IMAGE_GENERATION_STATE);
        recipeEditor.openEdit(card);
        setIsFoodRecipeEditorOpen(true);
        closeDetail();
      } else {
        showNotice({ tone: 'warning', title: '没有找到对应菜谱', message: '请确认该菜谱是否存在。' });
      }
    } else {
      showNotice({ tone: 'warning', title: '没有绑定菜谱', message: '这份食物目前没有关联的菜谱。' });
    }
  }

  function closeFoodRecipeEditor() {
    setIsFoodRecipeEditorOpen(false);
    recipeEditorImageComposer.setState(IDLE_IMAGE_GENERATION_STATE);
  }

  function closeFoodRecipeEditorIfAllowed() {
    if (!props.isCreatingRecipe && !props.isUpdatingRecipe) {
      closeFoodRecipeEditor();
    }
  }

  function closeFoodEditorIfAllowed() {
    if (!props.isSavingFood) {
      setView('list');
    }
  }

  async function handleSubmitFood(event: Parameters<typeof submitFood>[0]) {
    event.preventDefault();
    if (!canSubmit) return;
    if (isReadyLikeType(form.type)) {
      const stockQuantity = parseOptionalFoodStockQuantity(form.stockQuantity, '剩余数量');
      if (stockQuantity.error) {
        showNotice({ tone: 'warning', title: '库存数量格式不对', message: stockQuantity.error });
        return;
      }
    }
    if (isSelfMade) {
      const recipePayload = buildRecipePayload(
        recipeEditor.form,
        recipeEditor.ingredientRows,
        props.ingredients,
        getPendingImageJobId(recipeEditor.form.images)
      );
      if (!recipePayload.title || recipePayload.ingredient_items.length === 0) {
        showNotice({ tone: 'warning', title: '还不能保存菜谱', message: '家常菜谱至少要有名称和一个食材。' });
        return;
      }
      try {
        let recipeId = form.recipeId || recipeEditor.selectedRecipeId;
        if (recipeId) {
          await props.updateRecipe(recipeId, recipePayload);
          const payload = buildFoodPayloadFromForm(
            { ...form, recipeId, name: recipePayload.title },
            props.recipes,
            getMediaIds(form.images),
            getPendingImageJobId(form.images)
          );
          await submitFood(event, true, payload);
          showNotice({ tone: 'success', title: '家常菜谱已更新', message: `${recipePayload.title} 的菜谱和食物资料已保存。` });
        } else {
          await props.createRecipe(recipePayload);
          setView('list');
          showNotice({ tone: 'success', title: '家常菜谱已保存', message: `${recipePayload.title} 已出现在食物库。` });
        }
        imageComposer.setState(IDLE_IMAGE_GENERATION_STATE);
        recipeEditorImageComposer.setState(IDLE_IMAGE_GENERATION_STATE);
      } catch (reason) {
        showNotice({ tone: 'danger', title: '保存菜谱失败', message: resolveErrorMessage(reason, '保存菜谱失败') });
      }
      return;
    }
    await submitFood(event, true);
    imageComposer.setState(IDLE_IMAGE_GENERATION_STATE);
  }

  async function submitFoodRecipeEditor(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const payload = buildRecipePayload(
      recipeEditor.form,
      recipeEditor.ingredientRows,
      props.ingredients,
      getPendingImageJobId(recipeEditor.form.images)
    );
    if (!payload.title || payload.ingredient_items.length === 0) {
      showNotice({ tone: 'warning', title: '还不能保存菜谱', message: '家常菜谱至少要有名称和一个食材。' });
      return;
    }
    try {
      const recipeId = recipeEditor.selectedRecipeId || form.recipeId;
      if (recipeId) {
        await props.updateRecipe(recipeId, payload);
        setForm((current) => ({ ...current, recipeId, name: current.name || payload.title }));
      } else {
        const created = await props.createRecipe(payload);
        setForm((current) => ({ ...current, recipeId: created.id, name: current.name || created.title }));
        if (view === 'create' && isSelfMade) {
          setView('list');
        }
      }
      setIsFoodRecipeEditorOpen(false);
      recipeEditorImageComposer.setState(IDLE_IMAGE_GENERATION_STATE);
      showNotice({ tone: 'success', title: '菜谱已保存', message: `${payload.title} 的用料和步骤已保存。` });
    } catch (reason) {
      showNotice({ tone: 'danger', title: '保存菜谱失败', message: resolveErrorMessage(reason, '保存菜谱失败') });
    }
  }

  function openCookConfirmDialog(food: Food, mealType: MealType, options?: { date?: string }) {
    const recipeId = food.recipe_id ?? undefined;
    const recipeServings =
      recipeId != null
        ? props.recipes.find((recipe) => recipe.id === recipeId)?.servings
        : undefined;
    setQuickMealDialog({
      action: 'cook',
      date: options?.date ?? mealBusinessDate,
      food,
      mealType,
      recipeId,
      servings: recipeServings && recipeServings > 0 ? recipeServings : 1,
    });
  }

  function openCompactRecord(
    food: Food,
    fallbackMealType?: MealType,
    options?: { date?: string },
  ) {
    const mealType = getQuickDefaultMealType(food, fallbackMealType ?? suggestedMealType);
    setQuickRecord({
      food,
      date: options?.date ?? mealBusinessDate,
      mealType,
      target: { kind: 'new' },
      selectedCandidateId: null,
      candidateMode: 'none',
      candidates: [],
      candidateResolution: { status: 'loading' },
      targetTouchedByUser: false,
      clientRequestId: createClientRequestId(),
      busy: false,
      error: null,
    });
  }

  /** Recipe foods open cook confirm; ordinary foods open compact recordMeal. */
  function openQuickMealDialog(
    food: Food,
    mealType: MealType,
    action: FoodQuickMealDialogState['action'],
    options?: { date?: string },
  ) {
    if (action === 'cook' && food.recipe_id) {
      openCookConfirmDialog(food, mealType, options);
      return;
    }
    openCompactRecord(food, mealType, options);
  }

  function openFoodShoppingDialog(food: Food) {
    if (!isReadyLikeFood(food)) return;
    setFoodShoppingError(null);
    setFoodShoppingDialog(buildFoodShoppingDialogState(food, props.shoppingItems));
  }

  function openFoodShopping(food: Food) {
    if (normalizeFoodType(food) === 'selfMade' && food.recipe_id) {
      const card = recipeCards.find((entry) => entry.recipe.id === food.recipe_id);
      if (!card) {
        showNotice({ tone: 'warning', title: '菜谱暂不可用', message: '没有找到这道家常菜的菜谱原料，请刷新后再试。' });
        return;
      }
      recipeShopping.openShoppingDialog(card, () => undefined, 'all');
      return;
    }
    openFoodShoppingDialog(food);
  }

  async function submitFoodShopping() {
    if (!foodShoppingDialog || isFoodShoppingSubmitting) return;
    let write;
    try {
      write = buildFoodShoppingWrite(foodShoppingDialog.draft, foodShoppingDialog.existingItem);
    } catch (reason) {
      setFoodShoppingError(resolveErrorMessage(reason, '请确认采购信息。'));
      return;
    }
    setIsFoodShoppingSubmitting(true);
    setFoodShoppingError(null);
    try {
      if (write.kind === 'update') {
        await props.updateShoppingItem(write.itemId, write.payload);
      } else {
        await props.createShoppingItem(write.payload);
      }
      const foodName = foodShoppingDialog.draft.title;
      setFoodShoppingDialog(null);
      showNotice({
        tone: 'success',
        title: write.kind === 'update' ? '采购项已更新' : '已加入采购',
        message: write.kind === 'update'
          ? `${foodName} 的采购数量已更新。`
          : `${foodName} 已加入采购清单。`,
      });
    } catch (reason) {
      setFoodShoppingError(
        isApiError(reason) && reason.status === 409
          ? '采购项已发生变化，请刷新后重新确认。'
          : resolveErrorMessage(reason, '保存采购项失败，请稍后重试。'),
      );
    } finally {
      setIsFoodShoppingSubmitting(false);
    }
  }

  function updateQuickMealDialog(
    patch: Partial<Pick<FoodQuickMealDialogState, 'date' | 'mealType' | 'servings'>>,
  ) {
    setQuickMealDialog((current) => (current ? { ...current, ...patch } : current));
  }

  async function submitCookConfirmDialog(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!quickMealDialog) return;
    const current = quickMealDialog;
    if (!(current.action === 'cook' && current.recipeId)) return;
    // Direct Cook: never create a plan item just to start cooking.
    const servings =
      current.servings != null && current.servings > 0
        ? current.servings
        : props.recipes.find((recipe) => recipe.id === current.recipeId)?.servings || 1;
    const target = buildDirectCookTarget({
      foodId: current.food.id,
      recipeId: current.recipeId,
      date: current.date,
      mealType: current.mealType,
      servings,
    });
    setQuickMealDialog(null);
    if (props.navigate) {
      props.navigate(target);
    } else {
      // Legacy fallback when navigate is not composed (older tests).
      props.onStartRecipe(current.recipeId);
    }
  }

  // Load authoritative candidates when compact record date/mealType change.
  useEffect(() => {
    if (!quickRecord) return;
    let cancelled = false;
    const { date, mealType } = quickRecord;
    const loader = props.loadMealCandidates;
    if (!loader) {
      setQuickRecord((current) =>
        current && current.date === date && current.mealType === mealType
          ? {
              ...current,
              candidates: [],
              candidateMode: 'none',
              candidateResolution: { status: 'ready' },
            }
          : current,
      );
      return;
    }
    setQuickRecord((current) =>
      current && current.date === date && current.mealType === mealType
        ? { ...current, candidateResolution: { status: 'loading' }, error: null }
        : current,
    );
    void (async () => {
      try {
        const candidates = await loader(date, mealType);
        if (cancelled) return;
        const presentation = deriveCandidatePresentation(candidates, mealType);
        setQuickRecord((current) => {
          if (!current || current.date !== date || current.mealType !== mealType) return current;
          return {
            ...current,
            candidates,
            candidateMode: presentation.mode,
            candidateResolution: { status: 'ready' },
            ...(current.targetTouchedByUser
              ? {}
              : {
                  target: presentation.target,
                  selectedCandidateId: presentation.selectedCandidateId,
                }),
          };
        });
      } catch (reason) {
        if (cancelled) return;
        const message =
          reason instanceof Error && reason.message.trim()
            ? reason.message
            : '加载候选失败，请重试';
        setQuickRecord((current) =>
          current && current.date === date && current.mealType === mealType
            ? {
                ...current,
                candidateResolution: { status: 'error', message },
                error: message,
              }
            : current,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
    // Only re-run when open identity / date / mealType / loader change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quickRecord?.food.id, quickRecord?.date, quickRecord?.mealType, props.loadMealCandidates]);

  async function submitCompactRecord() {
    if (!quickRecord || quickRecord.busy) return;
    if (!canSubmitWithCandidateResolution(quickRecord.candidateResolution)) {
      setQuickRecord((current) =>
        current
          ? {
              ...current,
              error:
                current.candidateResolution.status === 'error'
                  ? current.candidateResolution.message || '加载候选失败，请重试'
                  : '正在确认是否有可加入的餐食…',
            }
          : current,
      );
      return;
    }
    const cover = getFoodCoverAsset(quickRecord.food, props.recipes) ?? null;
    let payload: RecordMealPayload;
    try {
      payload = buildRecordMealPayload({
        clientRequestId: quickRecord.clientRequestId,
        date: quickRecord.date,
        mealType: quickRecord.mealType,
        target: quickRecord.target,
        foods: [
          {
            kind: 'existing',
            food_id: quickRecord.food.id,
            name: quickRecord.food.name,
            servings: 1,
            cover,
          },
        ],
      });
    } catch (reason) {
      setQuickRecord((current) =>
        current
          ? {
              ...current,
              error: reason instanceof Error && reason.message.trim()
                ? reason.message
                : '记录失败，请重试',
            }
          : current,
      );
      return;
    }

    setQuickRecord((current) => (current ? { ...current, busy: true, error: null } : current));
    try {
      const response = await props.recordMeal(payload);
      setQuickRecord(null);
      props.onRecordSuccess?.(response);
      setFeedback(
        `${quickRecord.food.name} 已记录到${
          quickRecord.date === mealBusinessDate ? '今天' : formatDate(quickRecord.date)
        }${MEAL_TYPE_LABELS[quickRecord.mealType]}`,
      );
    } catch (reason) {
      const code = extractMealRecordErrorCode(reason);
      if (code === 'meal_log_stale' && props.loadMealCandidates) {
        try {
          const refreshed = await props.loadMealCandidates(quickRecord.date, quickRecord.mealType);
          const presentation = deriveCandidatePresentation(refreshed, quickRecord.mealType);
          setQuickRecord((current) =>
            current
              ? {
                  ...current,
                  busy: false,
                  candidates: refreshed,
                  candidateMode: presentation.mode,
                  candidateResolution: { status: 'ready' },
                  target: presentation.target,
                  selectedCandidateId: presentation.selectedCandidateId,
                  targetTouchedByUser: false,
                  error: '这顿饭刚被家人更新，请重新确认',
                }
              : current,
          );
          return;
        } catch {
          // fall through
        }
      }
      if (code === 'idempotency_key_reused' || code === 'record_operation_reverted') {
        setQuickRecord((current) =>
          current
            ? {
                ...current,
                busy: false,
                clientRequestId: createClientRequestId(),
                error:
                  code === 'record_operation_reverted'
                    ? '上次记录已撤销，请再试一次'
                    : '记录内容已变化，请再试一次',
              }
            : current,
        );
        return;
      }
      setQuickRecord((current) =>
        current
          ? {
              ...current,
              busy: false,
              error: messageFromMealRecordReason(reason, '记录失败，请重试'),
            }
          : current,
      );
    }
  }

  function handleFoodCardPrimaryAction(food: Food, mealType: MealType) {
    const initialMealType = getQuickDefaultMealType(food, suggestedMealType);
    if (normalizeFoodType(food) === 'selfMade' && food.recipe_id) {
      openQuickMealDialog(food, initialMealType, 'cook');
      return;
    }
    openQuickMealDialog(food, initialMealType, 'eat');
  }

  function openNextGovernanceFood() {
    const nextFood = governanceQueue[0];
    if (!nextFood) return;
    handleOpenEdit(nextFood);
  }

  const handledNavigationRequestIdRef = useRef<number | null>(null);

  useEffect(() => {
    const action = resolveFoodNavigationRequestAction({
      foods: props.foods,
      navigationRequest: props.navigationRequest,
      handledRequestId: handledNavigationRequestIdRef.current,
    });
    if (action.kind === 'edit') {
      handledNavigationRequestIdRef.current = action.requestId;
      handleOpenEdit(action.food);
      return;
    }
    if (action.kind === 'quickMeal') {
      handledNavigationRequestIdRef.current = action.requestId;
      openQuickMealDialog(action.food, getDefaultMealType(action.food), action.quickMealAction);
    }
  }, [props.foods, props.navigationRequest]);

  const planSurfaceProps: FoodPlanSurfaceProps = {
      weekRange: props.foodPlanWeekRange,
      days: foodPlanDays,
      getPlanItemCoverAsset: (item) => {
        const food = props.foods.find((candidate) => candidate.id === item.food_id);
        return food ? getFoodCoverAsset(food, props.recipes) : null;
      },
      weekSectionRef: foodPlanWeekRef,
      isUpdatingPlan: props.isUpdatingPlan,
      isStartingPlanItem: Boolean(props.isCompletingPlan || props.isQuickAdding),
      canCreatePlan: props.foods.length > 0,
      mobileWeekPage:
        mobileWeekPlanDate ? (
          <FoodPlanWeekMobilePage
            weekRange={props.foodPlanWeekRange}
            days={foodPlanDays}
            selectedDate={mobileWeekPlanDate}
            onSelectDate={setMobileWeekPlanDate}
            onOpenItem={(item) => {
              setMobileWeekPlanDate(null);
              openPlanDetail(item);
            }}
            onBack={() => setMobileWeekPlanDate(null)}
          />
        ) : null,
      onPreviousWeek: props.onFoodPlanPreviousWeek,
      onCurrentWeek: props.onFoodPlanCurrentWeek,
      onNextWeek: props.onFoodPlanNextWeek,
      onCreatePlan: (defaults) => openPlanDialog(undefined, defaults),
      onOpenPlanItem: openPlanDetail,
      onStartPlanItem: (item: FoodPlanItem) => {
        void completePlanItem(item);
      },
    };

    const discoverDesktopContent = (
      <FoodHubView
        heroActions={
          <div className="hero-actions">
            <ActionButton tone="primary" type="button" onClick={() => handleOpenCreate('takeout')}>
              <FoodUiIcon name="plus" />
              <span>新增外卖/成品</span>
            </ActionButton>
            <ActionButton tone="secondary" type="button" onClick={props.onOpenLogs}>
              <FoodUiIcon name="receipt" />
              <span>吃过的</span>
            </ActionButton>
          </div>
        }
        filtersSection={<section className="food-filter-shell">
          <div className="food-library-main">
            <div className="food-library-head">
              <div className="workspace-toolbar-copy">
                <h3>食物库</h3>
              </div>
              <div className="food-library-search-row">
                <SearchField
                  className="food-search-field"
                  ariaLabel="搜索食物"
                  placeholder="搜索食物、来源、口味或备注..."
                  value={search}
                  loading={isFoodSearchFetching}
                  leadingIcon={<FoodUiIcon name="search" />}
                  onChange={setSearch}
                  onClear={() => setSearch('')}
                  onCompositionStart={foodSearchComposition.onCompositionStart}
                  onCompositionEnd={foodSearchComposition.onCompositionEnd}
                />
                <div className="food-library-head-actions">
                  <p className="workspace-toolbar-summary">显示 {filteredFoods.length} / {props.foods.length} 份食物</p>
                  {hasFoodFilters && (
                    <button className="food-clear-filters-button" type="button" onClick={clearFoodFilters}>
                      <FoodUiIcon name="refresh" />
                      <span>清空筛选</span>
                    </button>
                  )}
                </div>
              </div>
            </div>
              <div className="food-toolbar-controls">
                <div className="food-filter-group">
                  <span>类型</span>
                  <OptionChipGroup
                    ariaLabel="食物类型"
                    size="small"
                    className="food-filter-chip-group"
                    options={[{ value: 'all', label: '全部' }, ...FOOD_TYPE_OPTIONS.map((item) => ({ value: item.value, label: item.label }))]}
                    value={typeFilter}
                    onChange={(value) => setTypeFilter(value)}
                  />
                </div>
                <div className="food-filter-group">
                  <span>餐别</span>
                  <OptionChipGroup
                    ariaLabel="适合餐别"
                    size="small"
                    className="food-filter-chip-group"
                    options={[{ value: 'all', label: '全餐别' }, ...MEAL_OPTIONS.map((item) => ({ value: item.value, label: item.label }))]}
                    value={mealFilter}
                    onChange={(value) => setMealFilter(value)}
                  />
                </div>
              </div>
              {lensFilter === 'needsInfo' && (
                <section className="food-governance-panel" aria-label="待完善补资料模式">
                  <div className="food-governance-head">
                    <div>
                      <span className="eyebrow">补资料</span>
                      <h4>{governanceQueue.length > 0 ? `还有 ${governanceQueue.length} 份会影响推荐` : '资料已够完整'}</h4>
                      <p>{nextGovernanceFood ? nextGovernanceSummary : '当前没有需要补齐的食物。'}</p>
                    </div>
                    <button
                      type="button"
                      disabled={governanceQueue.length === 0}
                      onClick={openNextGovernanceFood}
                    >
                      下一条
                    </button>
                  </div>
                  <OptionChipGroup
                    ariaLabel="待完善类型"
                    value={governanceIssueFilter}
                    className="food-governance-options"
                    options={[
                      { value: 'all', label: '全部待补', description: `${needsInfoFoods.length}` },
                      ...governanceIssueSummaries.map((item) => ({
                        value: item.value,
                        label: item.label,
                        description: `${item.count}`,
                      })),
                    ]}
                    onChange={(issue) => openGovernanceIssue(issue as 'all' | FoodGovernanceIssue)}
                  />
                </section>
              )}
          </div>
      </section>}
        feedbackSection={feedback ? (
          <div className="food-feedback">
            <span>{feedback}</span>
            <button type="button" onClick={props.onOpenLogs}>去补详情</button>
          </div>
        ) : null}
        gridSection={filteredFoods.length > 0 ? (
          <div className="food-card-library">
            <section className="food-card-grid" aria-label="食物卡片分页">
            {foodCardPages.map((page, pageIndex) => (
              <div className="food-card-page" key={page[0]?.id ?? `food-card-page-${pageIndex}`}>
              {page.map((food) => {
            const usage = getMealUsage(food, props.mealLogs);
            const coverAsset = getFoodCoverAsset(food, props.recipes);
            const cover = resolveMediaUrl(coverAsset, 'card');
            const expiry = describeExpiry(food);
            const normalizedType = normalizeFoodType(food);
            const defaultMealType = getDefaultMealType(food);
            const status = getFoodStatus(food, usage, expiry, props.recipes);
            const governanceIssueLabels = getFoodGovernanceIssueLabels(food, props.recipes);
            const compactLabels = governanceIssueLabels.length > 0
              ? governanceIssueLabels
              : [...getFoodSceneTags(food), food.rating != null ? `${food.rating} 分` : null].filter((item): item is string => Boolean(item));
            return (
              <article
                key={food.id}
                className={`food-work-card tone-${normalizedType}`}
                role="button"
                tabIndex={0}
                aria-label={`查看详情：${food.name}`}
                onClick={() => openDetail(food)}
                onKeyDown={(event) => openFoodDetailFromCard(event, () => openDetail(food))}
              >
                <div className="food-work-card-media">
                  <MediaWithPlaceholder
                    src={cover}
                    srcSet={buildMediaSrcSet(coverAsset)}
                    sizes={buildMediaSizes('card')}
                    alt={food.name}
                  />
                  <span className="food-type-overlay">{FOOD_TYPE_LABELS[normalizedType]}</span>
                  <button
                    className={food.favorite ? 'food-favorite-chip active' : 'food-favorite-chip'}
                    type="button"
                    aria-label={food.favorite ? '取消收藏' : '收藏食物'}
                    disabled={props.isUpdatingFavorite}
                    onClick={(event) => {
                      event.stopPropagation();
                      void props.updateFoodFavorite(food.id, !food.favorite, food.row_version);
                    }}
                  >
                    <FoodUiIcon name={food.favorite ? 'heartFilled' : 'heart'} />
                  </button>
                </div>
                <div className="food-work-card-body">
                  <div className="food-card-title-row">
                    <div>
                      <h3>{food.name}</h3>
                    </div>
                    {food.price != null && <strong className="food-price">¥{food.price}</strong>}
                  </div>
                  <p className="food-card-meta">
                    {[food.source_name || food.purchase_source, food.category, usage.count > 0 ? `吃过 ${usage.count} 次` : '还未记录'].filter(Boolean).join(' · ')}
                  </p>
                  <div className="food-card-status-row">
                    <span className={`food-card-status tone-${status.tone}`}>
                      <strong>{status.label}</strong>
                      <small>{status.detail}</small>
                    </span>
                    {food.suitable_meal_types.length > 0 && (
                      <span className="food-card-meal-summary">
                        {food.suitable_meal_types.map((meal) => MEAL_TYPE_LABELS[meal]).join(' / ')}
                      </span>
                    )}
                  </div>
                  {compactLabels.length > 0 && (
                    <div className="food-card-issue-row" aria-label="待完善项目">
                      {compactLabels.map((label) => <span key={label}>{label}</span>)}
                    </div>
                  )}
                  <div className={`food-card-actions${isFoodShoppingEligible(food) ? ' has-shopping-action' : ''}`}>
                    <ActionButton
                      tone="primary"
                      size="compact"
                      className="food-card-primary-action"
                      type="button"
                      disabled={props.isQuickAdding}
                      onClick={(event) => {
                        event.stopPropagation();
                        handleFoodCardPrimaryAction(food, defaultMealType);
                      }}
                    >
                      <FoodUiIcon name="plus" />
                      <span>{getFoodCardPrimaryActionLabel(food)}</span>
                    </ActionButton>
                    {isFoodShoppingEligible(food) && (
                      <button
                        className="food-card-icon-button"
                        type="button"
                        aria-label={`加入采购：${food.name}`}
                        title="加入采购"
                        onClick={(event) => {
                          event.stopPropagation();
                          openFoodShopping(food);
                        }}
                      >
                        <FoodUiIcon name="clipboard" />
                      </button>
                    )}
                    <button
                      className="food-card-icon-button"
                      type="button"
                      aria-label={`加入菜单：${food.name}`}
                      title="加入菜单"
                      onClick={(event) => {
                        event.stopPropagation();
                        openPlanDialog(food);
                      }}
                    >
                      <FoodUiIcon name="calendar" />
                    </button>
                  </div>
                </div>
              </article>
            );
              })}
              </div>
            ))}
            </section>
            <div className="paged-list-status" ref={foodCardPager.sentinelRef}>
              {foodCardPager.hasMore ? (
                <button className="paged-list-load-more" type="button" onClick={foodCardPager.loadMore}>
                  继续加载食物
                </button>
              ) : (
                <span>已加载全部食物</span>
              )}
            </div>
          </div>
        ) : (
          <EmptyState
            title={currentLensCopy.emptyTitle}
            description={search || typeFilter !== 'all' || mealFilter !== 'all' || sceneFilter !== 'all' ? '当前视角里还有额外筛选条件，可以先清空筛选再看。' : currentLensCopy.emptyDescription}
            action={
              search || typeFilter !== 'all' || mealFilter !== 'all' || sceneFilter !== 'all' ? (
                <ActionButton tone="secondary" type="button" onClick={clearFoodFilters}>清空筛选</ActionButton>
              ) : lensFilter === 'selfMade' ? (
                <ActionButton tone="primary" type="button" onClick={() => handleOpenCreate('selfMade')}>添加家常菜谱</ActionButton>
              ) : (
                <ActionButton tone="primary" type="button" onClick={() => handleOpenCreate('takeout')}>新增食物</ActionButton>
              )
            }
          />
        )}
        sidebar={<>
        <aside className="food-task-sidebar" aria-label="食物页辅助操作">
          <div className="food-task-sidebar-head">
            <strong>食物管理</strong>
            <span className="eyebrow">视角、待办与菜单计划</span>
          </div>
          <div className="food-sidebar-section food-sidebar-quick-section">
            <div className="food-sidebar-section-head">
              <strong>常用视角</strong>
            </div>
            <div className="food-library-insight" aria-label="食物快速视角">
              <button type="button" onClick={() => setLensFilter('favorite')} title={repeatFoods.map(({ food }) => food.name).join('、') || '常吃清单'}>
                <span>常吃清单</span>
                <strong>{repeatFoodCount}</strong>
              </button>
              <button type="button" onClick={() => (expiringFoods.length > 0 ? setLensFilter('expiring') : openGovernanceIssue('all'))}>
                <span>临期/待补</span>
                <strong>{managementIssueCount}</strong>
              </button>
              <button type="button" onClick={() => openGovernanceIssue('all')}>
                <span>待完善</span>
                <strong>{needsInfoFoods.length}</strong>
              </button>
            </div>
          </div>
          <div className="food-sidebar-section food-sidebar-management-section">
            <div className="food-sidebar-section-head">
              <strong>管理</strong>
            </div>
            <div className="food-library-insight" aria-label="食物管理入口">
              <button type="button" onClick={() => setIsSceneManagerOpen(true)}>
                <span>场景管理</span>
                <strong>{props.foodScenes.filter((scene) => !scene.hidden).length}</strong>
              </button>
            </div>
            <div className="food-library-next-task">
              <span>{nextGovernanceFood ? '下一条' : '待办'}</span>
              <strong>{nextGovernanceSummary}</strong>
              <button type="button" disabled={!nextGovernanceFood} onClick={openNextGovernanceFood}>
                处理下一条
              </button>
            </div>
          </div>
          <FoodPlanSurface {...planSurfaceProps} mobileWeekPage={null} />
          <div className="food-sidebar-section food-sidebar-scenes-section">
            <div className="food-sidebar-section-head">
              <strong>按场景探索</strong>
              <span>从食物场景标签中整理</span>
            </div>
            <div className="food-sidebar-scene-list" aria-label="按场景探索">
              {sceneCards.length > 0 ? (
                sceneCards.map((scene) => {
                  const sceneImageUrl = resolveMediaUrl(scene.imageAsset, 'thumb') ?? (scene.imageUrl ? resolveFoodAssetUrl(scene.imageUrl) : undefined);
                  return (
                  <button
                    key={scene.name}
                    className={sceneFilter === scene.name ? 'active' : ''}
                    type="button"
                    onClick={() => setSceneFilter(sceneFilter === scene.name ? 'all' : scene.name)}
                  >
                    <span className="food-sidebar-scene-thumb">
                      <MediaWithPlaceholder
                        src={sceneImageUrl}
                        srcSet={buildMediaSrcSet(scene.imageAsset)}
                        sizes={buildMediaSizes('thumb')}
                        alt=""
                      />
                    </span>
                    <span className="food-sidebar-scene-copy">
                      <strong>{scene.name}</strong>
                      <span>{scene.description || (scene.count > 0 ? `${scene.count} 份食物` : '推荐场景')}</span>
                    </span>
                  </button>
                  );
                })
              ) : (
                <span className="food-sidebar-empty">暂无场景标签</span>
              )}
            </div>
          </div>
        </aside>
        <FoodTabletSupportSurface
          metrics={[
            {
              label: '常吃清单',
              value: repeatFoodCount,
              title: repeatFoods.map(({ food }) => food.name).join('、') || '常吃清单',
              onClick: () => setLensFilter('favorite'),
            },
            {
              label: '临期/待补',
              value: managementIssueCount,
              onClick: () => (expiringFoods.length > 0 ? setLensFilter('expiring') : openGovernanceIssue('all')),
            },
            {
              label: '待完善',
              value: needsInfoFoods.length,
              onClick: () => openGovernanceIssue('all'),
            },
            {
              label: '场景管理',
              value: props.foodScenes.filter((scene) => !scene.hidden).length,
              onClick: () => setIsSceneManagerOpen(true),
            },
          ]}
          nextTaskLabel={nextGovernanceFood ? '下一条待办' : '待办'}
          nextTaskSummary={nextGovernanceSummary}
          canOpenNextTask={Boolean(nextGovernanceFood)}
          onOpenNextTask={openNextGovernanceFood}
          plan={planSurfaceProps}
          scenes={sceneCards.map((scene) => ({
            name: scene.name,
            description: scene.description || (scene.count > 0 ? `${scene.count} 份食物` : '推荐场景'),
            imageUrl: resolveMediaUrl(scene.imageAsset, 'thumb') ?? (scene.imageUrl ? resolveFoodAssetUrl(scene.imageUrl) : undefined),
            imageSrcSet: buildMediaSrcSet(scene.imageAsset),
            active: sceneFilter === scene.name,
            onSelect: () => setSceneFilter(sceneFilter === scene.name ? 'all' : scene.name),
          }))}
        />
        </>}
      />
    );

    const discoverMobileContent = (
      <FoodMobileView
        recipes={props.recipes}
        mealLogs={props.mealLogs}
        managementIssueCount={managementIssueCount}
        mobileScenePages={mobileScenePages}
        mobileLibraryFoods={mobileLibraryFoods}
        mobileLibraryResetKey={mobileLibraryResetKey}
        hasFoodFilters={hasFoodFilters}
        search={search}
        isSearchFetching={isFoodSearchFetching}
        emptyTitle={currentLensCopy.emptyTitle}
        isQuickAdding={props.isQuickAdding}
        isUpdatingFavorite={props.isUpdatingFavorite}
        notificationCenter={props.notificationCenter}
        weekPage={
          mobileWeekPlanDate ? (
            <FoodPlanWeekMobilePage
              weekRange={props.foodPlanWeekRange}
              days={foodPlanDays}
              selectedDate={mobileWeekPlanDate}
              onSelectDate={setMobileWeekPlanDate}
              onOpenItem={(item) => {
                setMobileWeekPlanDate(null);
                openPlanDetail(item);
              }}
              onBack={() => setMobileWeekPlanDate(null)}
            />
          ) : null
        }
        resolveFoodAssetUrl={resolveFoodAssetUrl}
        getFoodCardPrimaryActionLabel={getFoodCardPrimaryActionLabel}
        getDefaultMealType={getDefaultMealType}
        getFoodSceneTags={getFoodSceneTags}
        getFoodCookingSummary={getFoodCookingSummary}
        onSearchChange={setSearch}
        onSearchCompositionStart={foodSearchComposition.onCompositionStart}
        onSearchCompositionEnd={foodSearchComposition.onCompositionEnd}
        onOpenGovernanceIssue={() => openGovernanceIssue('all')}
        onOpenSceneManager={() => setIsSceneManagerOpen(true)}
        onOpenDetail={openDetail}
        onOpenPlanDialog={openPlanDialog}
        onHandleFoodCardPrimaryAction={handleFoodCardPrimaryAction}
        onToggleFavorite={(food) => void props.updateFoodFavorite(food.id, !food.favorite, food.row_version)}
        onOpenShopping={openFoodShopping}
        onOpenCreate={() => handleOpenCreate('takeout')}
        onOpenLogs={props.onOpenLogs}
        onClearFoodFilters={() => {
          clearFoodFilters();
          setMobileCookingFilter('all');
        }}
        filterTabs={mobileFilterTabs}
      />
    );

    const discoverSurfaceProps = {
      desktopContent: discoverDesktopContent,
      mobileContent: discoverMobileContent,
      loading: false,
      errorMessage: null as string | null,
      isEmpty: false,
      onCreateFood: () => handleOpenCreate('takeout'),
    };

    const surfaceContent = <FoodDiscoverSurface {...discoverSurfaceProps} />;

    return (
    <main className="food-workspace">
      {notice && (
        <div className={`recipe-notice-toast tone-${notice.tone}`} role={notice.tone === 'danger' ? 'alert' : 'status'} aria-live="polite">
          <span className="recipe-notice-icon">
            <FoodUiIcon name={notice.tone === 'success' ? 'check' : 'bell'} />
          </span>
          <span className="recipe-notice-copy">
            <strong>{notice.title}</strong>
            <small>{notice.message}</small>
          </span>
          <button type="button" onClick={clearNotice} aria-label="关闭提示">
            ×
          </button>
        </div>
      )}
      {surfaceContent}
      {foodShoppingDialog ? (
        <FoodShoppingDialog
          food={props.foods.find((item) => item.id === foodShoppingDialog.draft.foodId) ?? props.foods[0]}
          draft={foodShoppingDialog.draft}
          existingItem={foodShoppingDialog.existingItem}
          busy={isFoodShoppingSubmitting}
          errorMessage={foodShoppingError}
          onDraftChange={(draft) => setFoodShoppingDialog((current) => current ? { ...current, draft } : current)}
          onSubmit={() => void submitFoodShopping()}
          onClose={() => {
            if (!isFoodShoppingSubmitting) {
              setFoodShoppingDialog(null);
              setFoodShoppingError(null);
            }
          }}
        />
      ) : null}

      {recipeShopping.shoppingDialogCard ? (
        <RecipeShoppingDialog
          card={recipeShopping.shoppingDialogCard}
          ingredients={props.ingredients}
          drafts={recipeShopping.shoppingDrafts}
          customForm={recipeShopping.shoppingCustomForm}
          isIngredientPickerOpen={recipeShopping.isShoppingIngredientPickerOpen}
          isCreatingShopping={props.isCreatingShopping}
          unitOptions={SHOPPING_UNIT_OPTIONS}
          resolveIngredientImageUrl={resolveIngredientImageUrl}
          onClose={recipeShopping.closeShoppingDialog}
          onUpdateDraft={recipeShopping.updateShoppingDraft}
          onAdjustDraftQuantity={recipeShopping.adjustShoppingDraftQuantity}
          onRemoveDraft={recipeShopping.removeShoppingDraft}
          onAddRecipeIngredient={recipeShopping.addRecipeIngredientToShoppingDraft}
          onChangeCustomForm={recipeShopping.setShoppingCustomForm}
          onSetIngredientPickerOpen={recipeShopping.setIsShoppingIngredientPickerOpen}
          onSelectIngredientOption={recipeShopping.selectShoppingIngredientOption}
          onAdjustCustomQuantity={recipeShopping.adjustCustomShoppingQuantity}
          onAddCustomDraft={recipeShopping.addCustomShoppingDraft}
          onSubmit={() => void recipeShopping.submitShoppingDrafts()}
        />
      ) : null}

      {view !== 'list' && !isFoodRecipeEditorOpen && (
        <WorkspaceOverlayFrame
          rootClassName="food-workspace-overlay-root"
          onClose={closeFoodEditorIfAllowed}
          busy={Boolean(props.isSavingFood)}
          closeOnBackdrop={!props.isSavingFood}
        >
          <WorkspaceModal
            title={view === 'create' ? '新增食物' : '编辑食物'}
            description={isSelfMade ? '家常菜的菜谱、用料和日常记录都放在食物里维护。' : '补充来源、价格、复购和保质信息，让常吃食物更容易再次安排。'}
            eyebrow="食物资料"
            className="food-editor-modal"
            closeLabel="关闭"
            busy={Boolean(props.isSavingFood)}
            footerInfo={(
              <>
                <strong>已完成 {editorCompletedCount} / {editorCompletionItems.length} 项资料</strong>
                <span>保存后仍可继续补充</span>
              </>
            )}
            footerActions={(
              <FormActions
                primaryLabel={foodEditorSubmitLabel}
                submittingLabel="保存中..."
                primaryType="submit"
                primaryForm={FOOD_EDITOR_FORM_ID}
                primaryDisabled={!canSubmit}
                isSubmitting={Boolean(props.isSavingFood)}
                secondaryLabel={props.isPhoneViewport ? undefined : '取消'}
                onSecondary={closeFoodEditorIfAllowed}
              />
            )}
            onClose={closeFoodEditorIfAllowed}
          >
            <FoodEditorForm
              embedded
              availableSceneTagOptions={availableSceneTagOptions}
              canSubmit={canSubmit}
              completionItems={editorCompletionItems}
              completionPercent={editorCompletionPercent}
              currentRecipe={currentRecipe}
              editorProfile={editorProfile}
              editorRecipeCover={editorRecipeCover}
              editorRecipeMeta={editorRecipeMeta}
              formId={FOOD_EDITOR_FORM_ID}
              form={form}
              imageState={imageComposer.state}
              isSavingFood={props.isSavingFood}
              isSceneTagPickerOpen={isSceneTagPickerOpen}
              isSelfMade={isSelfMade}
              isUpdatingScene={props.isUpdatingScene}
              newSceneTagName={newSceneTagName}
              sceneTags={editorSceneTags}
              showActions={false}
              submitLabel={foodEditorSubmitLabel}
              view={view}
              onAddSceneTag={addSceneTag}
              onBack={closeFoodEditorIfAllowed}
              onCreateAndAddSceneTag={() => void createAndAddSceneTag()}
              onFormChange={setForm}
              onGenerateImage={(mode) => void imageComposer.generate(mode)}
              onEditRecipe={handleOpenRecipeEditor}
              onRemoveSceneTag={removeSceneTag}
              onResetImage={imageComposer.reset}
              onSceneTagPickerToggle={() => setIsSceneTagPickerOpen((current) => !current)}
              onSubmit={(event) => void handleSubmitFood(event)}
              onToggleMealType={toggleMealType}
              onUploadImage={(files) => void imageComposer.upload(files)}
              resolveAssetUrl={resolveFoodAssetUrl}
              setNewSceneTagName={setNewSceneTagName}
            />
          </WorkspaceModal>
        </WorkspaceOverlayFrame>
      )}

      {isFoodRecipeEditorOpen && (
        <FoodRecipeEditorDialog
          currentRecipeTitle={currentRecipe?.title}
          isEditing={Boolean(recipeEditor.selectedRecipeId || form.recipeId)}
          isSaving={Boolean(props.isCreatingRecipe || props.isUpdatingRecipe)}
          onClose={closeFoodRecipeEditor}
        >
          <RecipeEditorView
            isEditing={Boolean(recipeEditor.selectedRecipeId || form.recipeId)}
            entityLabel="菜谱"
            submitLabel="保存菜谱"
            previewLabel="回到食物"
            summaryCreateHint="保存后回到食物库"
            backLabel="回到食物"
            isRecipeAiApplied={false}
            selectedRecipeId={recipeEditor.selectedRecipeId}
            form={recipeEditor.form}
            setForm={recipeEditor.setForm}
            ingredientRows={recipeEditor.ingredientRows}
            ingredients={props.ingredients}
            sceneTagDraft={recipeEditor.sceneTagDraft}
            setSceneTagDraft={recipeEditor.setSceneTagDraft}
            sceneSelectOptions={recipeEditorSceneSelectOptions}
            editorSceneTags={recipeEditorSceneTags}
            visibleStepTips={recipeEditor.visibleStepTips}
            editorCoverUrl={recipeEditorCoverUrl}
            editorCoverAsset={recipeEditorCoverAsset}
            editorIngredientCount={recipeEditorIngredientCount}
            editorStepCount={recipeEditorStepCount}
            editorCompletionItems={recipeEditorCompletionItems}
            editorCompletionPercent={recipeEditorCompletionPercent}
            recipeDraftError={recipeEditor.recipeDraftError}
            isRecipeDraftBusy={false}
            recipeImageState={recipeEditorImageComposer.state}
            recipeDraftButtonLabel={getRecipeDraftGenerationButtonLabel(recipeEditor.recipeDraftGenerationStage)}
            submitDisabled={recipeEditorSubmitDisabled}
            isCreatingRecipe={props.isCreatingRecipe}
            isUpdatingRecipe={props.isUpdatingRecipe}
            showAiDraftAction={false}
            showDeleteAction={false}
            compactHeader
            onBack={closeFoodRecipeEditorIfAllowed}
            onSubmit={(event) => void submitFoodRecipeEditor(event)}
            onDelete={() => undefined}
            onOpenDraftDialog={() => undefined}
            updateIngredientRow={recipeEditor.updateIngredientRow}
            selectIngredientRow={recipeEditor.selectIngredientRow}
            updateIngredientNote={recipeEditor.updateIngredientNote}
            updateIngredientRequirement={recipeEditor.updateIngredientRequirement}
            addIngredientRow={recipeEditor.addIngredientRow}
            removeIngredientRow={recipeEditor.removeIngredientRow}
            updateStepDraft={recipeEditor.updateStepDraft}
            getStepKeyPointValues={recipeEditor.getStepKeyPointValues}
            getStepKeyPointRowCount={recipeEditor.getStepKeyPointRowCount}
            addStepTip={recipeEditor.addStepTip}
            addStepKeyPoint={recipeEditor.addStepKeyPoint}
            updateStepKeyPoint={recipeEditor.updateStepKeyPoint}
            removeStepKeyPoint={recipeEditor.removeStepKeyPoint}
            commitSceneTagDraft={recipeEditor.commitSceneTagDraft}
            handleRecipeImageUpload={(files) => recipeEditorImageComposer.upload(files)}
            handleRecipeImageGenerate={(mode) => recipeEditorImageComposer.generate(mode)}
            resetRecipeImageInput={recipeEditorImageComposer.reset}
          />
        </FoodRecipeEditorDialog>
      )}

      {/* Shared ordinary-record result bar from App props (no local mutation state). */}
      <MealRecordResultBar
        result={props.recordResult ?? null}
        isReverting={props.isRevertingRecord}
        revertError={props.recordRevertError}
        rateError={props.recordRateError}
        onRevert={props.onRevertRecord}
        onView={props.onViewRecord}
        onRate={props.onRateRecord}
        onDismiss={props.onDismissRecord}
      />

      {quickRecord ? (
        <MealQuickRecordView
          open
          prefilledFood={{
            food_id: quickRecord.food.id,
            name: quickRecord.food.name,
            cover: getFoodCoverAsset(quickRecord.food, props.recipes) ?? null,
            servings: 1,
          }}
          date={quickRecord.date}
          mealType={quickRecord.mealType}
          dateOptions={quickMealDateOptions}
          candidates={quickRecord.candidates}
          selectedCandidateId={quickRecord.selectedCandidateId}
          candidateMode={quickRecord.candidateMode}
          target={quickRecord.target}
          busy={quickRecord.busy || Boolean(props.isQuickAdding)}
          submitDisabled={!canSubmitWithCandidateResolution(quickRecord.candidateResolution)}
          error={quickRecord.error}
          overlayRootClassName="food-workspace-overlay-root"
          onClose={() => {
            if (!quickRecord.busy) setQuickRecord(null);
          }}
          onDateChange={(date) => {
            setQuickRecord((current) =>
              current
                ? {
                    ...current,
                    date,
                    target: { kind: 'new' },
                    selectedCandidateId: null,
                    candidateMode: 'none',
                    candidates: [],
                    candidateResolution: { status: 'loading' },
                    targetTouchedByUser: false,
                    error: null,
                  }
                : current,
            );
          }}
          onMealTypeChange={(mealType) => {
            setQuickRecord((current) =>
              current
                ? {
                    ...current,
                    mealType,
                    target: { kind: 'new' },
                    selectedCandidateId: null,
                    candidateMode: 'none',
                    candidates: [],
                    candidateResolution: { status: 'loading' },
                    targetTouchedByUser: false,
                    error: null,
                  }
                : current,
            );
          }}
          onTargetChange={(target, selectedCandidateId) => {
            setQuickRecord((current) =>
              current
                ? {
                    ...current,
                    target,
                    selectedCandidateId:
                      selectedCandidateId ??
                      (target.kind === 'existing' ? target.meal_log_id : null),
                    targetTouchedByUser: true,
                    error: null,
                  }
                : current,
            );
          }}
          onSubmit={() => {
            void submitCompactRecord();
          }}
        />
      ) : null}

      {quickMealDialog && (() => {
        const isCookAction = quickMealDialog.action === 'cook' && quickMealDialog.recipeId;
        const isSubmitting = Boolean(props.isQuickAdding || (isCookAction && props.isUpdatingPlan));

        return (
          <FoodQuickMealDialog
            dialog={quickMealDialog}
            dateOptions={quickMealDateOptions}
            isSubmitting={isSubmitting}
            recipes={props.recipes}
            onChange={updateQuickMealDialog}
            onClose={() => setQuickMealDialog(null)}
            onSubmit={submitCookConfirmDialog}
          />
        );
      })()}

      {detailFood && (() => {
        const usage = getMealUsage(detailFood, props.mealLogs);
        const expiry = describeExpiry(detailFood);
        const normalizedType = normalizeFoodType(detailFood);
        const status = getFoodStatus(detailFood, usage, expiry, props.recipes);
        const factRows = getFoodFactRows(detailFood, usage, expiry);
        const history = getFoodMealHistory(detailFood, props.mealLogs);
        const relation = buildFoodRelationViewModelFromRecipeCards(detailFood, recipeCards, props.mealLogs);
        const linkedRecipeCard = relation.linkedRecipeCard;
        const recipe = linkedRecipeCard?.recipe ?? (detailFood.recipe_id ? props.recipes.find((item) => item.id === detailFood.recipe_id) ?? null : null);
        const coverAsset = getFoodCoverAsset(detailFood, props.recipes);
        const cover = coverAsset?.url;
        const detailMealOptions = detailFood.suitable_meal_types.length > 0
          ? MEAL_OPTIONS.filter((meal) => detailFood.suitable_meal_types.includes(meal.value))
          : MEAL_OPTIONS;

        return (
          <FoodDetailDrawer
            food={detailFood}
            audienceText={getFoodAudienceText(detailFood, props.mealLogs)}
            cover={cover}
            coverAsset={coverAsset}
            detailMealOptions={detailMealOptions}
            expiry={expiry}
            factRows={factRows}
            history={history}
            inventoryConfirmation={isReadyLikeFood(detailFood) ? getFoodInventoryConfirmation(detailFood, todayDate) : null}
            isOutsideFood={isOutsideFood(detailFood)}
            isQuickAdding={props.isQuickAdding}
            isReadyLikeFood={isReadyLikeFood(detailFood)}
            normalizedType={normalizedType}
            recipe={recipe}
            relation={relation}
            status={status}
            usage={usage}
            getDefaultMealType={getDefaultMealType}
            getPrimaryFoodActionLabel={getPrimaryFoodActionLabel}
            getRepurchaseLabel={getRepurchaseLabel}
            getSceneTags={getFoodSceneTags}
            getSecondaryFoodActionLabel={getSecondaryFoodActionLabel}
            onClose={closeDetail}
            onEdit={handleOpenEdit}
            onEditRecipe={handleOpenRecipeEditorDirectly}
            onOpenPlanDialog={openPlanDialog}
            onStartCook={() => {
              // Route through the same date/meal/servings dialog as Discover primary cook.
              openQuickMealDialog(detailFood, getDefaultMealType(detailFood), 'cook');
            }}
            onQuickAdd={(food, mealType) => openQuickMealDialog(food, mealType, 'eat')}
            resolveAssetUrl={resolveFoodAssetUrl}
            overlayRootClassName="food-workspace-overlay-root"
          />
        );
      })()}

      <FoodPlanDialog
        isOpen={isPlanDialogOpen}
        selectedPlanFood={selectedPlanFood}
        foods={props.foods}
        recipes={props.recipes}
        planFoodSearch={planFoodSearch}
        planForm={planForm}
        todayDate={todayDate}
        isUpdatingPlan={props.isUpdatingPlan}
        onClose={closePlanDialog}
        onSubmit={submitPlanItem}
        onClearPlanFoodSelection={clearPlanFoodSelection}
        onPlanFoodSearchChange={setPlanFoodSearch}
        onSelectPlanFood={(food) => {
          setPlanForm((current) => ({ ...current, foodId: food.id, mealType: getDefaultMealType(food) }));
          setPlanFoodSearch(food.name);
        }}
        onPlanDateChange={(value) => setPlanForm({ ...planForm, planDate: value })}
        onMealTypeChange={(value) => setPlanForm({ ...planForm, mealType: value })}
        onPlanNoteChange={(value) => setPlanForm({ ...planForm, note: value })}
        resolveFoodAssetUrl={resolveFoodAssetUrl}
        getFoodCover={getFoodCover}
        getFoodCoverAsset={getFoodCoverAsset}
        getDefaultMealType={getDefaultMealType}
        getPlanDateParts={getFoodPlanDateParts}
        normalizeFoodType={normalizeFoodType}
      />

      {activePlanDetailItem && (
        <FoodPlanDetailWithCandidates
          item={activePlanDetailItem}
          food={activePlanDetailFood}
          recipes={props.recipes}
          form={planDetailForm}
          isEditing={isPlanDetailEditing}
          isUpdatingPlan={props.isUpdatingPlan}
          isCompleting={Boolean(props.isCompletingPlan || props.isQuickAdding)}
          onClose={closePlanDetail}
          onChangeForm={setPlanDetailForm}
          onEditingChange={setIsPlanDetailEditing}
          onResetEdit={resetPlanDetailForm}
          onSubmit={submitPlanDetail}
          onComplete={(target) => void completePlanItem(activePlanDetailItem, target)}
          onDelete={() => void deletePlanDetail(activePlanDetailItem)}
          resolveAssetUrl={resolveFoodAssetUrl}
        />
      )}

      <MealEnrichmentModal
        open={Boolean(planMealEnrichment)}
        meal={planMealEnrichment?.meal ?? null}
        members={props.members}
        isUpdating={Boolean(props.isUpdatingMeal)}
        updateMealLog={props.updateMealLog}
        onClose={() => setPlanMealEnrichment(null)}
        overlayRootClassName="food-workspace-overlay-root"
        formId="food-plan-meal-enrichment-form"
      />

      <FoodSceneDialogs
        isSceneManagerOpen={isSceneManagerOpen}
        sceneFormMode={sceneFormMode}
        sceneCards={sceneCards}
        sceneDraft={sceneDraft}
        sceneImageState={sceneImageState}
        isUpdatingScene={props.isUpdatingScene}
        onCloseManager={() => setIsSceneManagerOpen(false)}
        onOpenCreateScene={() => openCreateScene()}
        onOpenEditScene={openEditScene}
        onDeleteScene={(sceneId) => void deleteScene(sceneId)}
        onCloseSceneForm={closeSceneForm}
        onSubmitScene={submitScene}
        onGenerateSceneImage={() => void generateFoodSceneImage()}
        onSceneDraftChange={setSceneDraft}
        resolveFoodAssetUrl={resolveFoodAssetUrl}
      />
    </main>
  );
}
