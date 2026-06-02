import { useMemo, useState, type FormEvent } from 'react';
import type {
  Food,
  FoodPlanItem,
  FoodPayload,
  FoodRecommendationItem,
  FoodRecommendations,
  FoodScene,
  FoodType,
  Ingredient,
  InventoryItem,
  MealLog,
  MealType,
  Recipe,
  RecipePayload,
} from '../../api/types';
import { resolveAssetUrl } from '../../lib/assets';
import { addDateKeyDays } from '../../lib/date';
import {
  ActionButton,
  Badge,
  EmptyState,
  ImageComposer,
  SegmentedTabs,
  WorkspaceModal,
} from '../ui-kit';
import { FoodPlanDetailModal } from './FoodPlanDetailModal';
import { FoodPlanDialog } from './FoodPlanDialog';
import { FoodSceneDialogs } from './FoodSceneDialogs';
import { FoodHubView } from './FoodHubView';
import { FOOD_TYPE_LABELS, MEAL_TYPE_LABELS, emptyImages, formatDate, getFoodCover, getImagePreview, splitTags, todayKey } from '../../lib/ui';
import {
  IDLE_IMAGE_GENERATION_STATE,
  useImageComposer,
} from '../../hooks/useImageComposer';
import { useNotice } from '../../hooks/useNotice';
import { DIFFICULTY_LABELS, buildRecipeCards, type RecipeCardViewModel } from '../recipes/workspaceModel';
import { RecipeEditorView } from '../recipes/RecipeEditorView';
import { RecipeDetailView } from '../recipes/RecipeDetailView';
import { useRecipeEditorState } from '../recipes/useRecipeEditorState';
import {
  buildRecipeImagePayload,
  buildRecipePayload,
  getRecipeDraftGenerationButtonLabel,
  resolveErrorMessage,
  resolveRecipeDifficulty,
} from '../recipes/RecipeWorkspaceModel';
import { FoodRatingInput, FoodUiIcon } from './FoodWorkspacePrimitives';
import {
  FOOD_CREATE_TYPE_DETAILS,
  FOOD_CREATE_TYPE_OPTIONS,
  FOOD_GOVERNANCE_ISSUE_OPTIONS,
  FOOD_LENS_COPY,
  FOOD_TYPE_OPTIONS,
  MEAL_OPTIONS,
  type FoodGovernanceIssue,
  type FoodWorkspaceLens,
} from './FoodWorkspaceOptions';
import {
  getFoodFormCompletionItems,
  getFoodImagePayload,
  type FoodFormState,
} from './FoodWorkspaceModel';
import { useFoodPlanState } from './useFoodPlanState';
import { useFoodSceneState } from './useFoodSceneState';
import { useFoodWorkspaceState } from './useFoodWorkspaceState';
import { FoodDetailDrawer } from './FoodDetailDrawer';
import { FoodEditorForm } from './FoodEditorForm';
import { FoodMobileView } from './FoodMobileView';

export { FOOD_CREATE_TYPE_OPTIONS, type FoodGovernanceIssue } from './FoodWorkspaceOptions';
export { buildFoodPayloadFromForm, type FoodFormState } from './FoodWorkspaceModel';

type NormalizedFoodType = Exclude<FoodType, 'packaged'>;

export type TodayFoodRecommendation = {
  food: Food;
  mealType: MealType;
  score: number;
  reasons: string[];
};

export type FoodRelationFact = {
  label: string;
  value: string;
};

export type FoodRelationViewModel = {
  linkedRecipeCard: RecipeCardViewModel | null;
  usage: {
    count: number;
    last: string | null;
  };
  lastMealLog: MealLog | null;
  relationFacts: FoodRelationFact[];
  shortagePreview: string[];
  summary: string;
  detail: string;
};

type Props = {
  foods: Food[];
  recipes: Recipe[];
  ingredients: Ingredient[];
  inventoryItems: InventoryItem[];
  mealLogs: MealLog[];
  foodRecommendations?: FoodRecommendations | null;
  foodScenes: FoodScene[];
  foodPlanItems: FoodPlanItem[];
  foodPlanWeekRange: { start: string; end: string };
  createFood: (payload: FoodPayload) => Promise<Food>;
  updateFood: (foodId: string, payload: FoodPayload) => Promise<Food>;
  updateFoodFavorite: (foodId: string, favorite: boolean) => Promise<Food>;
  updateRecipe: (recipeId: string, payload: RecipePayload) => Promise<Recipe>;
  quickAddMeal: (payload: { food_id: string; date: string; meal_type: MealType; servings: number; note: string; food_plan_item_id?: string }) => Promise<MealLog>;
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
  onOpenRecipes: () => void;
  onStartRecipe: (recipeId: string, foodPlanItemId?: string) => void;
  onOpenLogs: () => void;
  onFoodPlanPreviousWeek: () => void;
  onFoodPlanCurrentWeek: () => void;
  onFoodPlanNextWeek: () => void;
  isSavingFood?: boolean;
  isUpdatingRecipe?: boolean;
  isUpdatingFavorite?: boolean;
  isQuickAdding?: boolean;
  isUpdatingPlan?: boolean;
  isUpdatingScene?: boolean;
};

type RecommendationCardViewModel = {
  food: Food;
  mealType: MealType;
  score: number;
  reasons: string[];
  primaryAction: 'cook_recipe' | 'quick_add_meal' | 'review_food';
  recipeAvailability?: FoodRecommendationItem['recipe_availability'];
};

type QuickMealDialogState = {
  action: 'cook' | 'eat';
  date: string;
  food: Food;
  mealType: MealType;
  recipeId?: string;
};

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

function resolveFoodAssetUrl(url: string) {
  return resolveAssetUrl(url) ?? url;
}

function getDaysUntil(dateValue?: string | null) {
  if (!dateValue) return null;
  const target = new Date(`${dateValue}T00:00:00`).getTime();
  const today = new Date(`${todayKey()}T00:00:00`).getTime();
  return Math.round((target - today) / 86_400_000);
}

function getDaysSince(dateValue: string, todayValue = todayKey()) {
  const target = new Date(`${dateValue}T00:00:00`).getTime();
  const today = new Date(`${todayValue}T00:00:00`).getTime();
  return Math.round((today - target) / 86_400_000);
}

export function getSuggestedMealTypeForHour(hour = new Date().getHours()): MealType {
  if (hour < 10) return 'breakfast';
  if (hour < 15) return 'lunch';
  if (hour < 22) return 'dinner';
  return 'snack';
}

function describeExpiry(food: Food) {
  const days = getDaysUntil(food.expiry_date);
  if (days == null) return null;
  if (days < 0) return `已过期 ${Math.abs(days)} 天`;
  if (days === 0) return '今天到期';
  if (days <= 7) return `${days} 天后到期`;
  return `${formatDate(food.expiry_date ?? '')} 到期`;
}

function normalizeFoodType(food: Food): NormalizedFoodType {
  return food.type === 'packaged' ? 'readyMade' : food.type;
}

function normalizeFormFoodType(foodType: FoodType): NormalizedFoodType {
  return foodType === 'packaged' ? 'readyMade' : foodType;
}

function isReadyLikeFood(food: Food) {
  const normalizedType = normalizeFoodType(food);
  return normalizedType === 'readyMade' || normalizedType === 'instant';
}

function isReadyLikeType(foodType: FoodType) {
  const normalizedType = normalizeFormFoodType(foodType);
  return normalizedType === 'readyMade' || normalizedType === 'instant';
}

function isOutsideFood(food: Food) {
  const normalizedType = normalizeFoodType(food);
  return normalizedType === 'takeout' || normalizedType === 'diningOut';
}

function isOutsideType(foodType: FoodType) {
  const normalizedType = normalizeFormFoodType(foodType);
  return normalizedType === 'takeout' || normalizedType === 'diningOut';
}

function getFoodSceneTags(food: Food) {
  return food.scene_tags ?? [];
}

function isFoodExpiring(food: Food) {
  return isReadyLikeFood(food) && (getDaysUntil(food.expiry_date) ?? 99) <= 7;
}

export function getFoodGovernanceIssues(food: Food, recipes: Recipe[] = []): FoodGovernanceIssue[] {
  const issues: FoodGovernanceIssue[] = [];
  if (!getFoodCover(food, recipes)) issues.push('image');
  if (food.suitable_meal_types.length === 0) issues.push('meal');
  if (!food.routine_note.trim() && !food.notes.trim() && !food.scene.trim() && getFoodSceneTags(food).length === 0) issues.push('note');
  if (normalizeFoodType(food) !== 'selfMade' && !food.source_name.trim() && !food.purchase_source.trim()) issues.push('source');
  if (isReadyLikeFood(food) && (food.stock_quantity == null || !food.stock_unit.trim() || !food.expiry_date)) issues.push('stock');
  return issues;
}

function getFoodGovernanceIssueLabels(food: Food, recipes: Recipe[] = []) {
  const labels = new Map(FOOD_GOVERNANCE_ISSUE_OPTIONS.map((item) => [item.value, item.label]));
  return getFoodGovernanceIssues(food, recipes).map((issue) => labels.get(issue) ?? issue);
}

function isFoodMissingDecisionInfo(food: Food, recipes: Recipe[] = []) {
  return getFoodGovernanceIssues(food, recipes).length > 0;
}

function getFoodStatus(food: Food, usage: ReturnType<typeof getMealUsage>, expiry: string | null, recipes: Recipe[] = []) {
  if (isFoodExpiring(food)) {
    return { label: expiry ?? '临期', detail: '优先处理', tone: 'warning' };
  }
  if (isFoodMissingDecisionInfo(food, recipes)) {
    return { label: '待完善', detail: '补资料', tone: 'attention' };
  }
  if (food.favorite || usage.count >= 2) {
    return { label: '常复吃', detail: usage.count > 0 ? `${usage.count} 次` : '已收藏', tone: 'good' };
  }
  if (usage.count === 0) {
    return { label: '新食物', detail: '待记录', tone: 'quiet' };
  }
  return { label: '已记录', detail: `${usage.count} 次`, tone: 'neutral' };
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

function getMealUsage(food: Food, mealLogs: MealLog[]) {
  const logs = mealLogs.filter((log) => log.food_entries.some((entry) => entry.food_id === food.id));
  const sortedDates = logs.map((log) => log.date).sort((a, b) => b.localeCompare(a));
  return {
    count: logs.length,
    last: sortedDates[0] ?? null,
  };
}

function getDefaultMealType(food: Food): MealType {
  if (food.suitable_meal_types.includes('dinner')) return 'dinner';
  if (food.suitable_meal_types.includes('lunch')) return 'lunch';
  return food.suitable_meal_types[0] ?? 'dinner';
}

function getQuickDefaultMealType(food: Food, suggestedMealType: MealType): MealType {
  if (food.suitable_meal_types.includes(suggestedMealType)) return suggestedMealType;
  if (food.suitable_meal_types.length === 0) return suggestedMealType;
  return getDefaultMealType(food);
}

function getPrimaryFoodActionLabel(food: Food) {
  const normalizedType = normalizeFoodType(food);
  if (normalizedType === 'takeout' || normalizedType === 'diningOut') return '再吃一次';
  if (normalizedType === 'readyMade' || normalizedType === 'instant') return '记到今天';
  return '记到今天';
}

function getFoodCardPrimaryActionLabel(food: Food) {
  if (normalizeFoodType(food) === 'selfMade' && food.recipe_id) return '开始做';
  return getPrimaryFoodActionLabel(food);
}

function getRecommendationPrimaryActionLabel(item: RecommendationCardViewModel) {
  if (item.primaryAction === 'cook_recipe') return '开始做';
  if (item.primaryAction === 'quick_add_meal') return getPrimaryFoodActionLabel(item.food);
  return '查看详情';
}

function getSecondaryFoodActionLabel(food: Food) {
  if (normalizeFoodType(food) === 'selfMade') return '编辑档案';
  if (isReadyLikeFood(food)) return '更新库存';
  if (isOutsideFood(food)) return '编辑评价';
  return '编辑资料';
}

function getRepurchaseLabel(food: Food) {
  if (food.repurchase == null) return '未记录';
  return food.repurchase ? '愿意复购' : '暂不复购';
}

function getFoodFactRows(food: Food, usage: ReturnType<typeof getMealUsage>, expiry: string | null) {
  const normalizedType = normalizeFoodType(food);
  const mealText = food.suitable_meal_types.map((meal) => MEAL_TYPE_LABELS[meal]).join('、') || '未设置';
  if (normalizedType === 'selfMade') {
    return [
      { label: '菜谱', value: food.recipe_id ? '已关联' : '待关联' },
      { label: '复吃', value: usage.count > 0 ? `${usage.count} 次` : '还未记录' },
      { label: '餐别', value: mealText },
    ];
  }
  if (isOutsideFood(food)) {
    return [
      { label: normalizedType === 'takeout' ? '店铺' : '餐厅', value: food.source_name || food.purchase_source || '待补充' },
      { label: '价格', value: food.price == null ? '未记录' : `¥${food.price}` },
      { label: '复购', value: getRepurchaseLabel(food) },
    ];
  }
  return [
    { label: '库存', value: food.stock_quantity == null ? '未记录' : `${food.stock_quantity}${food.stock_unit}` },
    { label: '到期', value: expiry ?? '未记录' },
    { label: '渠道', value: food.purchase_source || food.source_name || '待补充' },
  ];
}

function getFoodMealHistory(food: Food, mealLogs: MealLog[]) {
  return mealLogs
    .filter((log) => log.food_entries.some((entry) => entry.food_id === food.id))
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date) || b.created_at.localeCompare(a.created_at))
    .slice(0, 5)
    .map((log) => ({
      log,
      entry: log.food_entries.find((entry) => entry.food_id === food.id),
    }));
}

function getLastMealLogForFood(food: Food, mealLogs: MealLog[]) {
  return mealLogs
    .filter((log) => log.food_entries.some((entry) => entry.food_id === food.id))
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date) || b.created_at.localeCompare(a.created_at))[0] ?? null;
}

function formatFoodStock(food: Food) {
  if (food.stock_quantity == null) return '未记录';
  return `${food.stock_quantity}${food.stock_unit || '份'}`;
}

function buildFoodRelationViewModelFromRecipeCards(
  food: Food,
  recipeCards: RecipeCardViewModel[],
  mealLogs: MealLog[]
): FoodRelationViewModel {
  const usage = getMealUsage(food, mealLogs);
  const lastMealLog = getLastMealLogForFood(food, mealLogs);
  const normalizedType = normalizeFoodType(food);
  const linkedRecipeCard = food.recipe_id ? recipeCards.find((card) => card.recipe.id === food.recipe_id) ?? null : null;
  const recordValue = usage.count > 0 ? `${usage.count} 次` : '还未记录';
  const lastValue = lastMealLog ? formatDate(lastMealLog.date) : '还没有';

  if (normalizedType === 'selfMade') {
    const shortagePreview = linkedRecipeCard?.shortages
      .slice(0, 3)
      .map((item) => `${item.ingredientName} ${item.missingQuantity}${item.unit}`) ?? [];
    return {
      linkedRecipeCard,
      usage,
      lastMealLog,
      relationFacts: [
        { label: '关联菜谱', value: linkedRecipeCard?.recipe.title ?? '未关联' },
        { label: '可做程度', value: linkedRecipeCard?.availabilityLabel ?? '无法判断' },
        { label: '餐食记录', value: recordValue },
        { label: '最近一次', value: lastValue },
      ],
      shortagePreview,
      summary: linkedRecipeCard ? `${linkedRecipeCard.recipe.title} · ${linkedRecipeCard.availabilityLabel}` : '未关联菜谱',
      detail: linkedRecipeCard
        ? shortagePreview.length > 0
          ? `缺 ${shortagePreview.join('、')}`
          : linkedRecipeCard.availabilityDetail
        : '关联菜谱后可以判断缺哪些食材。',
    };
  }

  if (isOutsideFood(food)) {
    return {
      linkedRecipeCard: null,
      usage,
      lastMealLog,
      relationFacts: [
        { label: '餐食记录', value: recordValue },
        { label: '最近一次', value: lastValue },
        { label: '复购评分', value: food.rating == null ? getRepurchaseLabel(food) : `${food.rating} 分 · ${getRepurchaseLabel(food)}` },
      ],
      shortagePreview: [],
      summary: `${recordValue}记录 · ${lastMealLog ? `上次 ${lastValue}` : '还没吃过'}`,
      detail: `${food.source_name || food.purchase_source || '未记录来源'} · ${getRepurchaseLabel(food)}`,
    };
  }

  const stockValue = formatFoodStock(food);
  return {
    linkedRecipeCard: null,
    usage,
    lastMealLog,
    relationFacts: [
      { label: '库存剩余', value: stockValue },
      { label: '到期', value: describeExpiry(food) ?? '未记录' },
      { label: '餐食记录', value: recordValue },
      { label: '最近一次', value: lastValue },
    ],
    shortagePreview: [],
    summary: `${stockValue}库存 · ${usage.count > 0 ? `吃过 ${usage.count} 次` : '还未记录'}`,
    detail: food.stock_quantity == null
      ? '库存未记录，补齐后会更适合做备用餐判断。'
      : `${food.purchase_source || food.source_name || '未记录来源'} · ${describeExpiry(food) ?? '未记录到期'}`,
  };
}

export function buildFoodRelationViewModel(
  food: Food,
  recipes: Recipe[],
  ingredients: Ingredient[],
  inventoryItems: InventoryItem[],
  mealLogs: MealLog[],
  foods: Food[]
): FoodRelationViewModel {
  return buildFoodRelationViewModelFromRecipeCards(
    food,
    buildRecipeCards(recipes, ingredients, inventoryItems, mealLogs, foods),
    mealLogs
  );
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

function getFoodAudienceText(food: Food, mealLogs: MealLog[]) {
  const history = getFoodMealHistory(food, mealLogs);
  const participantCount = Math.max(...history.map(({ log }) => log.participant_user_ids.length), 0);
  if (participantCount > 0) return `最近记录里最多 ${participantCount} 位成员一起吃`;
  if (food.suitable_meal_types.includes('snack')) return '适合临时加餐或小份分享';
  return '适合家庭成员共同安排';
}

function getFoodEditorProfile(foodType: FoodType) {
  const normalizedType = normalizeFormFoodType(foodType);
  if (normalizedType === 'selfMade') {
    return {
      title: '家常菜核心资料',
      description: '重点确认关联菜谱、适合餐别和家庭备注，做法本身在菜谱页维护。',
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
  recipes: Recipe[] = []
) {
  const keyword = search.trim().toLowerCase();
  return foods.filter((food) => {
    const normalizedType = normalizeFoodType(food);
    const text = [food.name, food.category, food.source_name, food.purchase_source, food.scene, food.notes, food.routine_note, ...getFoodSceneTags(food)].join(' ').toLowerCase();
    const searchMatch = !keyword || text.includes(keyword);
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
    recommendationPage,
    setRecommendationPage,
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
    quickAdd,
    clearFoodFilters,
    openGovernanceIssue,
  } = useFoodWorkspaceState({
    foods: props.foods,
    foodScenes: props.foodScenes,
    recipes: props.recipes,
    createFood: props.createFood,
    updateFood: props.updateFood,
    createFoodScene: props.createFoodScene,
    quickAddMeal: props.quickAddMeal,
    onOpenRecipes: props.onOpenRecipes,
  });
  const { notice, showNotice, clearNotice } = useNotice();
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
    planDateOptions,
    planDetailForm,
    planFoodOptions,
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
    showNotice,
    setFeedback,
    getDefaultMealType,
    createFoodPlanItem: props.createFoodPlanItem,
    updateFoodPlanItem: props.updateFoodPlanItem,
    deleteFoodPlanItem: props.deleteFoodPlanItem,
    quickAddMeal: props.quickAddMeal,
    onStartRecipe: props.onStartRecipe,
  });
  const recipeEditor = useRecipeEditorState({ ingredients: props.ingredients });

  const foodUsageCards = useMemo(
    () => props.foods.map((food) => ({ food, usage: getMealUsage(food, props.mealLogs) })),
    [props.foods, props.mealLogs]
  );
  const recipeCards = useMemo(
    () => buildRecipeCards(props.recipes, props.ingredients, props.inventoryItems, props.mealLogs, props.foods),
    [props.foods, props.ingredients, props.inventoryItems, props.mealLogs, props.recipes]
  );
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
  const todayRecommendations = useMemo(
    () => buildTodayFoodRecommendations(props.foods, props.mealLogs, { mealType: suggestedMealType, recipes: props.recipes }),
    [props.foods, props.mealLogs, props.recipes, suggestedMealType]
  );
  const recommendationCards = useMemo<RecommendationCardViewModel[]>(() => {
    if (props.foodRecommendations?.items.length) {
      return props.foodRecommendations.items.map((item) => ({
        food: item.food,
        mealType: props.foodRecommendations?.target_meal_type ?? suggestedMealType,
        score: item.score,
        reasons: item.reasons,
        primaryAction: item.primary_action,
        recipeAvailability: item.recipe_availability,
      }));
    }
    return todayRecommendations.map((item) => ({
      food: item.food,
      mealType: item.mealType,
      score: item.score,
      reasons: item.reasons,
      primaryAction: normalizeFoodType(item.food) === 'selfMade' && item.food.recipe_id ? 'cook_recipe' : 'quick_add_meal',
      recipeAvailability: null,
    }));
  }, [props.foodRecommendations, suggestedMealType, todayRecommendations]);
  const recommendationPageCount = Math.max(1, Math.ceil(recommendationCards.length / 3));
  const visibleRecommendations = recommendationCards.slice((recommendationPage % recommendationPageCount) * 3, (recommendationPage % recommendationPageCount) * 3 + 3);
  const repeatFoods = useMemo(
    () =>
      foodUsageCards
        .filter(({ food, usage }) => food.favorite || usage.count >= 2)
        .sort((a, b) => Number(b.food.favorite) - Number(a.food.favorite) || b.usage.count - a.usage.count)
        .slice(0, 3),
    [foodUsageCards]
  );
  const filteredFoods = useMemo(() => {
    return filterFoodWorkspaceItems(props.foods, search, typeFilter, mealFilter, lensFilter, props.recipes)
      .filter((food) => sceneFilter === 'all' || getFoodSceneTags(food).includes(sceneFilter))
      .filter((food) => lensFilter !== 'needsInfo' || governanceIssueFilter === 'all' || getFoodGovernanceIssues(food, props.recipes).includes(governanceIssueFilter))
      .slice()
      .sort((a, b) => getFoodPriority(b, props.mealLogs, lensFilter, props.recipes) - getFoodPriority(a, props.mealLogs, lensFilter, props.recipes));
  }, [governanceIssueFilter, lensFilter, mealFilter, props.foods, props.mealLogs, props.recipes, search, sceneFilter, typeFilter]);
  const currentLensCopy = FOOD_LENS_COPY[lensFilter];
  const detailFood = detailFoodId ? props.foods.find((food) => food.id === detailFoodId) ?? null : null;
  const repeatFoodCount = foodUsageCards.filter(({ food, usage }) => food.favorite || usage.count >= 2).length;
  const managementIssueCount = new Set([...expiringFoods, ...needsInfoFoods].map((food) => food.id)).size;
  const nextGovernanceFood = governanceQueue[0] ?? null;
  const nextGovernanceSummary = nextGovernanceFood ? `${nextGovernanceFood.name} · ${getFoodGovernanceIssueLabels(nextGovernanceFood, props.recipes).join('、')}` : '资料已够完整';
  const hasFoodFilters = Boolean(search.trim()) || typeFilter !== 'all' || mealFilter !== 'all' || lensFilter !== 'all' || sceneFilter !== 'all' || governanceIssueFilter !== 'all';
  const todayDate = todayKey();
  const [quickMealDialog, setQuickMealDialog] = useState<QuickMealDialogState | null>(null);
  const [isFoodRecipeEditorOpen, setIsFoodRecipeEditorOpen] = useState(false);
  const [activeFoodRecipeDetailCard, setActiveFoodRecipeDetailCard] = useState<RecipeCardViewModel | null>(null);
  const quickMealDateOptions = useMemo(
    () => Array.from({ length: 7 }, (_, index) => addDateKeyDays(todayDate, index)),
    [todayDate]
  );
  const mobileDefaultSceneCards = [
    {
      key: 'protein',
      title: '高蛋白',
      count: props.foods.filter((food) => [food.name, food.category, food.notes, food.routine_note, ...getFoodSceneTags(food)].join(' ').includes('蛋白')).length || props.foods.filter((food) => normalizeFoodType(food) === 'selfMade').length,
      imageFood: props.foods.find((food) => [food.name, food.category, food.notes, food.routine_note, ...getFoodSceneTags(food)].join(' ').includes('蛋白')) ?? props.foods.find((food) => normalizeFoodType(food) === 'selfMade') ?? props.foods[0],
      onClick: () => {
        setLensFilter('all');
        setTypeFilter('all');
        setMealFilter('all');
        setSearch('高蛋白');
      },
    },
    {
      key: 'dinner',
      title: '工作日晚餐',
      count: props.foods.filter((food) => food.suitable_meal_types.includes('dinner')).length,
      imageFood:
        props.foods.find((food) => food.suitable_meal_types.includes('dinner') && food.id !== props.foods[0]?.id && ![food.name, ...getFoodSceneTags(food)].join(' ').includes('蛋白')) ??
        props.foods.find((food) => food.suitable_meal_types.includes('dinner') && food.id !== props.foods[0]?.id) ??
        props.foods[1] ??
        props.foods[0],
      onClick: () => {
        setLensFilter('today');
        setTypeFilter('all');
        setMealFilter('dinner');
        setSearch('');
      },
    },
    {
      key: 'kid',
      title: '孩子也能吃',
      count: props.foods.filter((food) => [food.notes, food.routine_note, ...getFoodSceneTags(food)].join(' ').includes('孩子')).length,
      imageFood: props.foods.find((food) => [food.notes, food.routine_note, ...getFoodSceneTags(food)].join(' ').includes('孩子')) ?? props.foods[2] ?? props.foods[1] ?? props.foods[0],
      onClick: () => {
        setLensFilter('all');
        setTypeFilter('all');
        setMealFilter('all');
        setSearch('孩子');
      },
    },
    {
      key: 'light',
      title: '周末轻食',
      count: props.foods.filter((food) => [food.name, food.category, food.notes, food.routine_note, ...getFoodSceneTags(food)].join(' ').includes('轻食')).length || props.foods.filter((food) => food.suitable_meal_types.includes('snack')).length,
      imageFood:
        props.foods.find((food) => [food.name, food.category, food.notes, food.routine_note, ...getFoodSceneTags(food)].join(' ').includes('轻食')) ??
        props.foods.find((food) => food.suitable_meal_types.includes('snack')) ??
        props.foods.find((food) => !['selfMade', 'takeout'].includes(normalizeFoodType(food))) ??
        props.foods[3] ??
        props.foods[0],
      onClick: () => {
        setLensFilter('all');
        setTypeFilter('all');
        setMealFilter('snack');
        setSearch('');
      },
    },
  ];
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
        onClick: () => {
          setSceneFilter(scene.name);
          setLensFilter('all');
          setTypeFilter('all');
          setMealFilter('all');
          setSearch('');
        },
      })),
  ];
  const mobileScenePages = Array.from({ length: Math.ceil(mobileSceneExploreCards.length / 4) || 1 }, (_, index) =>
    mobileSceneExploreCards.slice(index * 4, index * 4 + 4)
  );
  const mobileLibraryFoods = filteredFoods.slice(0, 4);
  const mobileFilterTabs = [
    {
      label: '全部',
      active: lensFilter === 'all' && typeFilter === 'all' && mealFilter === 'all' && sceneFilter === 'all' && governanceIssueFilter === 'all',
      onClick: clearFoodFilters,
    },
    {
      label: '家常菜',
      active: typeFilter === 'selfMade',
      onClick: () => {
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
        setLensFilter('all');
        setTypeFilter('takeout');
        setMealFilter('all');
        setSceneFilter('all');
        setGovernanceIssueFilter('all');
      },
    },
    {
      label: '临期待补',
      active: lensFilter === 'expiring' || lensFilter === 'needsInfo',
      onClick: () => {
        setLensFilter(expiringFoods.length > 0 ? 'expiring' : 'needsInfo');
        setTypeFilter('all');
        setMealFilter('all');
        setSceneFilter('all');
        setGovernanceIssueFilter('all');
      },
    },
    {
      label: '收藏',
      active: lensFilter === 'favorite',
      onClick: () => {
        setLensFilter('favorite');
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
  const canSubmit = !props.isSavingFood && !imageComposer.state.isGenerating;
  const sceneTagOptions = useMemo(() => {
    const names = new Set<string>();
    props.foodScenes.filter((scene) => !scene.hidden).forEach((scene) => names.add(scene.name));
    props.foods.forEach((food) => getFoodSceneTags(food).forEach((tag) => names.add(tag)));
    editorSceneTags.forEach((tag) => names.add(tag));
    return Array.from(names).sort((left, right) => left.localeCompare(right, 'zh-CN'));
  }, [editorSceneTags, props.foodScenes, props.foods]);
  const availableSceneTagOptions = sceneTagOptions.filter((tag) => !editorSceneTags.includes(tag));
  const editorFoodTitle = isSelfMade ? currentRecipe?.title || form.name || '选择一个菜谱' : form.name || '新的食物';
  const editorRecipeCover = currentRecipe?.images[0]?.url ?? (editingFood ? getFoodCover(editingFood, props.recipes) : undefined);
  const editorRecipeMeta = currentRecipe ? `${currentRecipe.ingredient_items.length} 个原料 · ${currentRecipe.steps.length} 个步骤` : '还没有关联菜谱';
  const recipeEditorIngredientCount = recipeEditor.ingredientRows.filter((item) => item.ingredient_id || item.ingredient_name.trim()).length;
  const recipeEditorStepCount = recipeEditor.form.steps.filter((step) => step.text.trim()).length;
  const recipeEditorSceneTags = splitTags(recipeEditor.form.sceneTags);
  const recipeEditorCoverAsset = getImagePreview(recipeEditor.form.images);
  const recipeEditorCoverUrl = resolveAssetUrl(recipeEditorCoverAsset?.url);
  const recipeEditorReferenceUrl = resolveAssetUrl(recipeEditor.form.images.referenceAsset?.url);
  const recipeEditorGeneratedUrl = resolveAssetUrl(recipeEditor.form.images.generatedAsset?.url);
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
  const recipeEditorAiSourceSummary = [
    { label: '菜名', value: recipeEditor.form.title.trim() || '未填写' },
    { label: '份量', value: `${recipeEditor.form.servings || '2'} 人份` },
    { label: '时长', value: recipeEditor.form.prepMinutes ? `${recipeEditor.form.prepMinutes} 分钟` : '未填写' },
    { label: '难度', value: recipeEditor.form.difficulty ? DIFFICULTY_LABELS[resolveRecipeDifficulty(recipeEditor.form.difficulty)] : '未填写' },
    { label: '标签', value: recipeEditorSceneTags.join('、') || '未填写' },
  ];
  const recipeEditorImagePayload = buildRecipeImagePayload(recipeEditor.form, recipeEditor.ingredientRows, props.ingredients);
  const recipeEditorImageComposer = useImageComposer({
    value: recipeEditor.form.images,
    payload: recipeEditorImagePayload,
    onChange: (images) => recipeEditor.setForm((current) => ({ ...current, images })),
    uploadErrorMessage: '参考图上传或 AI 主图生成失败',
    generateErrorMessage: 'AI 主图生成失败',
  });
  const recipeEditorSubmitDisabled = Boolean(props.isUpdatingRecipe || recipeEditorImageComposer.state.isGenerating);

  function handleOpenCreate(type: FoodType = 'takeout') {
    imageComposer.setState(IDLE_IMAGE_GENERATION_STATE);
    openCreate(type);
  }

  function handleOpenEdit(food: Food) {
    imageComposer.setState(IDLE_IMAGE_GENERATION_STATE);
    openEdit(food);
  }

  function handleOpenRecipeEditor() {
    if (!currentRecipeCard) {
      showNotice({ tone: 'warning', title: '还没有关联菜谱', message: '请先在菜谱页创建并关联菜谱。' });
      return;
    }
    recipeEditorImageComposer.setState(IDLE_IMAGE_GENERATION_STATE);
    recipeEditor.openEdit(currentRecipeCard);
    setIsFoodRecipeEditorOpen(true);
  }

  function closeFoodRecipeEditor() {
    setIsFoodRecipeEditorOpen(false);
    recipeEditorImageComposer.setState(IDLE_IMAGE_GENERATION_STATE);
  }

  function openFoodRecipeDetail(card: RecipeCardViewModel | null) {
    if (!card) {
      showNotice({ tone: 'warning', title: '还没有关联菜谱', message: '这份食物还没有可查看的菜谱详情。' });
      return;
    }
    setActiveFoodRecipeDetailCard(card);
  }

  function closeFoodRecipeDetail() {
    setActiveFoodRecipeDetailCard(null);
  }

  async function handleSubmitFood(event: Parameters<typeof submitFood>[0]) {
    await submitFood(event, canSubmit);
    imageComposer.setState(IDLE_IMAGE_GENERATION_STATE);
  }

  async function submitFoodRecipeEditor(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!recipeEditor.selectedRecipeId) return;
    const payload = buildRecipePayload(recipeEditor.form, recipeEditor.ingredientRows, props.ingredients);
    if (!payload.title || payload.ingredient_items.length === 0) {
      showNotice({ tone: 'warning', title: '还不能保存菜谱', message: '菜谱至少要有标题和一个食材。' });
      return;
    }
    try {
      await props.updateRecipe(recipeEditor.selectedRecipeId, payload);
      setIsFoodRecipeEditorOpen(false);
      recipeEditorImageComposer.setState(IDLE_IMAGE_GENERATION_STATE);
      showNotice({ tone: 'success', title: '菜谱已更新', message: `${payload.title} 的菜谱信息已保存。` });
    } catch (reason) {
      showNotice({ tone: 'danger', title: '更新菜谱失败', message: resolveErrorMessage(reason, '更新菜谱失败') });
    }
  }

  function openQuickMealDialog(food: Food, mealType: MealType, action: QuickMealDialogState['action']) {
    setQuickMealDialog({
      action,
      date: todayKey(),
      food,
      mealType,
      recipeId: action === 'cook' ? food.recipe_id ?? undefined : undefined,
    });
  }

  function updateQuickMealDialog(patch: Partial<Pick<QuickMealDialogState, 'date' | 'mealType'>>) {
    setQuickMealDialog((current) => (current ? { ...current, ...patch } : current));
  }

  async function submitQuickMealDialog(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!quickMealDialog) return;
    const current = quickMealDialog;
    if (current.action === 'cook' && current.recipeId) {
      const planItem = await props.createFoodPlanItem({
        food_id: current.food.id,
        plan_date: current.date,
        meal_type: current.mealType,
        note: '',
      });
      setFeedback(`${current.food.name} 已安排到${current.date === todayKey() ? '今天' : formatDate(current.date)}${MEAL_TYPE_LABELS[current.mealType]}`);
      setQuickMealDialog(null);
      props.onStartRecipe(current.recipeId, planItem.id);
      return;
    }
    await quickAdd(current.food, current.mealType, current.date);
    setQuickMealDialog(null);
  }

  function handleRecommendationPrimaryAction(item: RecommendationCardViewModel) {
    if (item.primaryAction === 'cook_recipe' && item.food.recipe_id) {
      openQuickMealDialog(item.food, item.mealType, 'cook');
      return;
    }
    if (item.primaryAction === 'quick_add_meal') {
      openQuickMealDialog(item.food, item.mealType, 'eat');
      return;
    }
    openDetail(item.food);
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

  if (view !== 'list') {
    return (
      <>
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
        <FoodEditorForm
          availableSceneTagOptions={availableSceneTagOptions}
          canSubmit={canSubmit}
          completionItems={editorCompletionItems}
          completionPercent={editorCompletionPercent}
          currentRecipe={currentRecipe}
          editorFoodTitle={editorFoodTitle}
          editorProfile={editorProfile}
          editorRecipeCover={editorRecipeCover}
          editorRecipeMeta={editorRecipeMeta}
          form={form}
          imageState={imageComposer.state}
          isSavingFood={props.isSavingFood}
          isSceneTagPickerOpen={isSceneTagPickerOpen}
          isSelfMade={isSelfMade}
          isUpdatingScene={props.isUpdatingScene}
          newSceneTagName={newSceneTagName}
          sceneTags={editorSceneTags}
          view={view}
          onAddSceneTag={addSceneTag}
          onBack={() => setView('list')}
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
        {isFoodRecipeEditorOpen && (
          <div className="workspace-overlay-root">
            <div className="workspace-overlay-backdrop" onClick={closeFoodRecipeEditor} />
            <WorkspaceModal
              title="编辑菜谱"
              description={currentRecipe ? `正在编辑「${currentRecipe.title}」` : undefined}
              eyebrow="食物关联菜谱"
              className="food-recipe-editor-modal"
              closeLabel="关闭"
              onClose={closeFoodRecipeEditor}
            >
              <RecipeEditorView
                isEditing
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
                stepKeyPointSlots={recipeEditor.stepKeyPointSlots}
                editorCoverUrl={recipeEditorCoverUrl}
                editorReferenceUrl={recipeEditorReferenceUrl}
                editorGeneratedUrl={recipeEditorGeneratedUrl}
                editorCoverAsset={recipeEditorCoverAsset}
                editorIngredientCount={recipeEditorIngredientCount}
                editorStepCount={recipeEditorStepCount}
                editorCompletionItems={recipeEditorCompletionItems}
                editorCompletionPercent={recipeEditorCompletionPercent}
                aiSourceSummary={recipeEditorAiSourceSummary}
                recipeDraftError={recipeEditor.recipeDraftError}
                isRecipeDraftBusy={false}
                recipeImageState={recipeEditorImageComposer.state}
                recipeDraftGenerationStage={recipeEditor.recipeDraftGenerationStage}
                recipeDraftButtonLabel={getRecipeDraftGenerationButtonLabel(recipeEditor.recipeDraftGenerationStage)}
                recipeImagePayload={recipeEditorImagePayload}
                submitDisabled={recipeEditorSubmitDisabled}
                isUpdatingRecipe={props.isUpdatingRecipe}
                showAiDraftAction={false}
                showDeleteAction={false}
                compactHeader
                onBack={closeFoodRecipeEditor}
                onSubmit={(event) => void submitFoodRecipeEditor(event)}
                onDelete={() => undefined}
                onOpenDraftDialog={() => undefined}
                updateIngredientRow={recipeEditor.updateIngredientRow}
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
            </WorkspaceModal>
          </div>
        )}
      </>
    );
  }

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
      <FoodHubView
        mobileView={
          <FoodMobileView
            recipes={props.recipes}
            mealLogs={props.mealLogs}
            visibleRecommendations={visibleRecommendations}
            recommendationCardCount={recommendationCards.length}
            managementIssueCount={managementIssueCount}
            mobileScenePages={mobileScenePages}
            mobileLibraryFoods={mobileLibraryFoods}
            hasFoodFilters={hasFoodFilters}
            search={search}
            emptyTitle={currentLensCopy.emptyTitle}
            isQuickAdding={props.isQuickAdding}
            isUpdatingFavorite={props.isUpdatingFavorite}
            resolveFoodAssetUrl={resolveFoodAssetUrl}
            getFoodCardPrimaryActionLabel={getFoodCardPrimaryActionLabel}
            getRecommendationPrimaryActionLabel={getRecommendationPrimaryActionLabel}
            getDefaultMealType={getDefaultMealType}
            getFoodSceneTags={getFoodSceneTags}
            onSearchChange={setSearch}
            onRotateRecommendation={() => setRecommendationPage((current) => (current + 1) % recommendationPageCount)}
            onOpenGovernanceIssue={() => openGovernanceIssue('all')}
            onOpenSceneManager={() => setIsSceneManagerOpen(true)}
            onOpenDetail={openDetail}
            onOpenPlanDialog={openPlanDialog}
            onHandleRecommendationPrimaryAction={handleRecommendationPrimaryAction}
            onHandleFoodCardPrimaryAction={handleFoodCardPrimaryAction}
            onToggleFavorite={(food) => void props.updateFoodFavorite(food.id, !food.favorite)}
            onOpenCreate={() => handleOpenCreate('takeout')}
            onClearFoodFilters={clearFoodFilters}
            filterTabs={mobileFilterTabs}
          />
        }
        heroActions={
          <div className="hero-actions">
            <ActionButton tone="primary" type="button" onClick={() => handleOpenCreate('takeout')}>
              <FoodUiIcon name="plus" />
              <span>新增外卖/成品</span>
            </ActionButton>
            <ActionButton tone="secondary" type="button" onClick={props.onOpenLogs}>
              <FoodUiIcon name="receipt" />
              <span>完整记一餐</span>
            </ActionButton>
          </div>
        }
        recommendationSection={<section className="food-quick-strip" aria-label="食物智能推荐">
        <div className="food-quick-head">
          <div className="food-quick-title">
            <strong>今日推荐</strong>
          </div>
          <div className="food-quick-actions">
            <button
              type="button"
              aria-label="换一换"
              title="换一换"
              onClick={() => setRecommendationPage((current) => (current + 1) % recommendationPageCount)}
              disabled={recommendationCards.length <= 3}
            >
              <FoodUiIcon name="refresh" />
              <span>换一换</span>
            </button>
          </div>
        </div>
        {visibleRecommendations.length > 0 ? (
          <div className="food-recommendation-grid">
            {visibleRecommendations.map((item) => {
              const cover = getFoodCover(item.food, props.recipes);
              const normalizedType = normalizeFoodType(item.food);
              return (
                <article key={item.food.id} className={`food-recommendation-card tone-${normalizedType}`}>
                  <div className="food-recommendation-media">
                    {cover ? <img src={resolveFoodAssetUrl(cover)} alt="" /> : <span>{item.food.name.slice(0, 2)}</span>}
                  </div>
                  <div className="food-recommendation-body">
                    <div className="food-recommendation-heading">
                      <h4>{item.food.name}</h4>
                      <span className="food-recommendation-type">{FOOD_TYPE_LABELS[normalizedType]}</span>
                    </div>
                    <div className="food-recommendation-reasons">
                      {item.reasons.map((reason) => <Badge key={reason}>{reason}</Badge>)}
                    </div>
                    <div className="food-recommendation-actions">
                      <button
                        className="primary"
                        type="button"
                        title={getRecommendationPrimaryActionLabel(item)}
                        disabled={props.isQuickAdding}
                        onClick={() => handleRecommendationPrimaryAction(item)}
                      >
                        {getRecommendationPrimaryActionLabel(item)}
                      </button>
                      <button className="icon-only" type="button" aria-label={`查看详情：${item.food.name}`} title="查看详情" onClick={() => openDetail(item.food)}>
                        <FoodUiIcon name="list" />
                      </button>
                      <button className="icon-only" type="button" aria-label={`加入菜单：${item.food.name}`} title="加入菜单" onClick={() => openPlanDialog(item.food)}>
                        <FoodUiIcon name="calendar" />
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="food-recommendation-empty">
            <strong>还没有可推荐食物</strong>
            <span>先新增外卖、成品或去菜谱页沉淀家常菜。</span>
            <button type="button" onClick={() => handleOpenCreate('takeout')}>新增可吃项</button>
          </div>
        )}
      </section>}
        filtersSection={<section className="food-filter-shell">
          <div className="food-library-main">
            <div className="food-library-head">
              <div className="workspace-toolbar-copy">
                <h3>食物库</h3>
              </div>
              <label className="food-search-field">
                <FoodUiIcon name="search" />
                <input className="text-input" placeholder="搜索食物、来源、口味或备注..." value={search} onChange={(event) => setSearch(event.target.value)} />
              </label>
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
              <div className="food-toolbar-controls">
                <div className="food-filter-group">
                  <span>类型</span>
                  <SegmentedTabs
                    options={[{ value: 'all', label: '全部' }, ...FOOD_TYPE_OPTIONS.map((item) => ({ value: item.value, label: item.label }))]}
                    value={typeFilter}
                    onChange={(value) => setTypeFilter(value)}
                  />
                </div>
                <div className="food-filter-group">
                  <span>餐别</span>
                  <SegmentedTabs
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
                  <div className="food-governance-chips">
                    <button
                      type="button"
                      className={governanceIssueFilter === 'all' ? 'active' : ''}
                      onClick={() => openGovernanceIssue('all')}
                    >
                      <span>全部待补</span>
                      <strong>{needsInfoFoods.length}</strong>
                    </button>
                    {governanceIssueSummaries.map((item) => (
                      <button
                        key={item.value}
                        type="button"
                        className={governanceIssueFilter === item.value ? 'active' : ''}
                        onClick={() => openGovernanceIssue(item.value)}
                        title={item.description}
                      >
                        <span>{item.label}</span>
                        <strong>{item.count}</strong>
                      </button>
                    ))}
                  </div>
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
          <section className="food-card-grid">
          {filteredFoods.map((food) => {
            const usage = getMealUsage(food, props.mealLogs);
            const cover = getFoodCover(food, props.recipes);
            const expiry = describeExpiry(food);
            const normalizedType = normalizeFoodType(food);
            const defaultMealType = getDefaultMealType(food);
            const status = getFoodStatus(food, usage, expiry, props.recipes);
            const governanceIssueLabels = getFoodGovernanceIssueLabels(food, props.recipes);
            const compactLabels = governanceIssueLabels.length > 0
              ? governanceIssueLabels.slice(0, 2)
              : [...getFoodSceneTags(food).slice(0, 2), food.rating != null ? `${food.rating} 分` : null].filter((item): item is string => Boolean(item));
            return (
              <article key={food.id} className={`food-work-card tone-${normalizedType}`}>
                <div className="food-work-card-media">
                  {cover ? <img src={resolveFoodAssetUrl(cover)} alt={food.name} /> : <span>{food.name.slice(0, 4)}</span>}
                  <span className="food-type-overlay">{FOOD_TYPE_LABELS[normalizedType]}</span>
                  <button
                    className={food.favorite ? 'food-favorite-chip active' : 'food-favorite-chip'}
                    type="button"
                    aria-label={food.favorite ? '取消收藏' : '收藏食物'}
                    disabled={props.isUpdatingFavorite}
                    onClick={() => void props.updateFoodFavorite(food.id, !food.favorite)}
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
                  <div className="food-card-actions">
                    <ActionButton tone="primary" size="compact" className="food-card-primary-action" type="button" disabled={props.isQuickAdding} onClick={() => handleFoodCardPrimaryAction(food, defaultMealType)}>
                      <FoodUiIcon name="plus" />
                      <span>{getFoodCardPrimaryActionLabel(food)}</span>
                    </ActionButton>
                    <button className="food-card-detail-button" type="button" aria-label={`查看详情：${food.name}`} title="查看详情" onClick={() => openDetail(food)}>
                      <FoodUiIcon name="list" />
                    </button>
                    <button className="food-card-detail-button" type="button" aria-label={`加入菜单：${food.name}`} title="加入菜单" onClick={() => openPlanDialog(food)}>
                      <FoodUiIcon name="calendar" />
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
          </section>
        ) : (
          <EmptyState
            title={currentLensCopy.emptyTitle}
            description={search || typeFilter !== 'all' || mealFilter !== 'all' || sceneFilter !== 'all' ? '当前视角里还有额外筛选条件，可以先清空筛选再看。' : currentLensCopy.emptyDescription}
            action={
              search || typeFilter !== 'all' || mealFilter !== 'all' || sceneFilter !== 'all' ? (
                <ActionButton tone="secondary" type="button" onClick={clearFoodFilters}>清空筛选</ActionButton>
              ) : lensFilter === 'selfMade' ? (
                <ActionButton tone="primary" type="button" onClick={props.onOpenRecipes}>去新增菜谱</ActionButton>
              ) : (
                <ActionButton tone="primary" type="button" onClick={() => handleOpenCreate('takeout')}>新增食物</ActionButton>
              )
            }
          />
        )}
        sidebar={<aside className="food-task-sidebar" aria-label="食物页辅助操作">
          <div className="food-task-sidebar-head">
            <span className="eyebrow">辅助操作</span>
            <strong>食物管理</strong>
          </div>
          <div className="food-sidebar-section">
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
          <div className="food-sidebar-section">
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
          <div className="food-sidebar-section">
            <div className="food-sidebar-section-head">
              <strong>菜单计划</strong>
              <span>{props.foodPlanWeekRange.start.slice(5).replace('-', '/')} - {props.foodPlanWeekRange.end.slice(5).replace('-', '/')}</span>
            </div>
            <div className="recipe-plan-switcher food-plan-switcher" aria-label="切换菜单周">
              <button type="button" onClick={props.onFoodPlanPreviousWeek}>
                <FoodUiIcon name="arrowLeft" />
                上一周
              </button>
              <button type="button" onClick={props.onFoodPlanCurrentWeek}>
                本周
              </button>
              <button type="button" onClick={props.onFoodPlanNextWeek}>
                下一周
                <FoodUiIcon name="arrowRight" />
              </button>
            </div>
            <ActionButton tone="primary" type="button" size="compact" className="recipe-plan-add-button food-plan-add-button" onClick={() => openPlanDialog()} disabled={props.isUpdatingPlan || props.foods.length === 0}>
              <FoodUiIcon name="plus" />
              加食物
            </ActionButton>
            <div className="recipe-plan-week food-plan-week">
              {foodPlanDays.map((day) => (
                <div key={day.date} className="recipe-plan-day expanded">
                  <button className="recipe-plan-day-head" type="button">
                    <strong>{day.label}</strong>
                    <span>{day.items.length > 0 ? `${day.items.length} 项` : '未安排'}</span>
                  </button>
                  {day.items.length > 0 ? (
                    day.items.map((item) => (
                      <article key={item.id} className="recipe-plan-item" role="button" tabIndex={0} onClick={() => openPlanDetail(item)}>
                        <div className="recipe-plan-item-summary">
                          <strong>{item.food_name}</strong>
                          <span>{MEAL_TYPE_LABELS[item.meal_type]}{item.status === 'cooked' ? ' · 已完成' : ''}</span>
                        </div>
                        <button
                          className="recipe-plan-item-detail-button"
                          type="button"
                          aria-label={`${item.recipe_id ? '开始做' : '记到今天'}：${item.food_name}`}
                          disabled={props.isQuickAdding || item.status === 'cooked'}
                          onClick={(event) => {
                            event.stopPropagation();
                            void completePlanItem(item);
                          }}
                        >
                          <FoodUiIcon name={item.recipe_id ? 'bowl' : 'check'} />
                        </button>
                      </article>
                    ))
                  ) : (
                    <div className="recipe-plan-empty-row">未安排</div>
                  )}
                </div>
              ))}
            </div>
          </div>
          <div className="food-sidebar-section">
            <div className="food-sidebar-section-head">
              <strong>按场景探索</strong>
              <span>从食物场景标签中整理</span>
            </div>
            <div className="food-sidebar-scene-list" aria-label="按场景探索">
              {sceneCards.length > 0 ? (
                sceneCards.map((scene) => (
                  <button
                    key={scene.name}
                    className={sceneFilter === scene.name ? 'active' : ''}
                    type="button"
                    onClick={() => setSceneFilter(sceneFilter === scene.name ? 'all' : scene.name)}
                  >
                    <span className="food-sidebar-scene-thumb">
                      {scene.imageUrl ? <img src={resolveFoodAssetUrl(scene.imageUrl)} alt="" /> : <FoodUiIcon name="star" />}
                    </span>
                    <span className="food-sidebar-scene-copy">
                      <strong>{scene.name}</strong>
                      <span>{scene.description || (scene.count > 0 ? `${scene.count} 份食物` : '推荐场景')}</span>
                    </span>
                  </button>
                ))
              ) : (
                <span className="food-sidebar-empty">暂无场景标签</span>
              )}
            </div>
          </div>
        </aside>}
      />

      {quickMealDialog && (() => {
        const cover = getFoodCover(quickMealDialog.food, props.recipes);
        const isCookAction = quickMealDialog.action === 'cook' && quickMealDialog.recipeId;
        const title = isCookAction ? '开始做这道菜' : getPrimaryFoodActionLabel(quickMealDialog.food);
        const isSubmitting = Boolean(props.isQuickAdding || (isCookAction && props.isUpdatingPlan));

        return (
          <div className="workspace-overlay-root">
            <div className="workspace-overlay-backdrop" onClick={() => setQuickMealDialog(null)} />
            <WorkspaceModal
              title={title}
              description="确认日期和餐次，点一下就完成。"
              eyebrow="快速操作"
              className="food-quick-meal-modal"
              onClose={() => setQuickMealDialog(null)}
            >
              <form className="food-quick-meal-form" onSubmit={submitQuickMealDialog}>
                <div className="food-quick-meal-hero">
                  <span className="food-quick-meal-cover">
                    {cover ? <img src={resolveFoodAssetUrl(cover)} alt="" /> : <span>{quickMealDialog.food.name.slice(0, 2)}</span>}
                  </span>
                  <span className="food-quick-meal-copy">
                    <strong>{quickMealDialog.food.name}</strong>
                    <small>
                      {FOOD_TYPE_LABELS[normalizeFoodType(quickMealDialog.food)]}
                      {quickMealDialog.food.source_name || quickMealDialog.food.purchase_source ? ` · ${quickMealDialog.food.source_name || quickMealDialog.food.purchase_source}` : ''}
                    </small>
                  </span>
                </div>

                <div className="food-quick-meal-field">
                  <span>日期</span>
                  <div className="food-quick-meal-date-strip" role="listbox" aria-label="选择日期">
                    {quickMealDateOptions.map((dateKey, index) => {
                      const parts = getFoodPlanDateParts(dateKey);
                      const label = index === 0 ? '今天' : index === 1 ? '明天' : parts.weekday;
                      return (
                        <button
                          key={dateKey}
                          type="button"
                          className={quickMealDialog.date === dateKey ? 'active' : ''}
                          onClick={() => updateQuickMealDialog({ date: dateKey })}
                        >
                          <span>{label}</span>
                          <strong>{parts.month}/{parts.day}</strong>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="food-quick-meal-field">
                  <span>餐次</span>
                  <div className="food-quick-meal-segments" role="radiogroup" aria-label="选择餐次">
                    {MEAL_OPTIONS.map((meal) => (
                      <button
                        key={meal.value}
                        type="button"
                        className={quickMealDialog.mealType === meal.value ? 'active' : ''}
                        onClick={() => updateQuickMealDialog({ mealType: meal.value })}
                      >
                        {meal.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="workspace-overlay-actions food-quick-meal-actions">
                  <ActionButton tone="secondary" type="button" onClick={() => setQuickMealDialog(null)}>
                    取消
                  </ActionButton>
                  <ActionButton tone="primary" type="submit" disabled={isSubmitting}>
                    {isCookAction ? '开始做' : '记这一餐'}
                  </ActionButton>
                </div>
              </form>
            </WorkspaceModal>
          </div>
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
        const cover = getFoodCover(detailFood, props.recipes);
        const detailMealOptions = detailFood.suitable_meal_types.length > 0
          ? MEAL_OPTIONS.filter((meal) => detailFood.suitable_meal_types.includes(meal.value))
          : MEAL_OPTIONS;

        return (
          <FoodDetailDrawer
            food={detailFood}
            audienceText={getFoodAudienceText(detailFood, props.mealLogs)}
            cover={cover}
            detailMealOptions={detailMealOptions}
            expiry={expiry}
            factRows={factRows}
            history={history}
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
            onOpenLogs={props.onOpenLogs}
            onOpenPlanDialog={openPlanDialog}
            onOpenRecipeDetail={openFoodRecipeDetail}
            onQuickAdd={(food, mealType) => openQuickMealDialog(food, mealType, 'eat')}
            resolveAssetUrl={resolveFoodAssetUrl}
          />
        );
      })()}

      {activeFoodRecipeDetailCard && (
        <div className="workspace-overlay-root">
          <div className="workspace-overlay-backdrop" onClick={closeFoodRecipeDetail} />
          <WorkspaceModal
            title={activeFoodRecipeDetailCard.recipe.title}
            description={`${activeFoodRecipeDetailCard.recipe.prep_minutes} 分钟 · ${activeFoodRecipeDetailCard.recipe.servings} 人份`}
            eyebrow="关联菜谱"
            className="food-recipe-detail-modal"
            closeLabel="关闭"
            onClose={closeFoodRecipeDetail}
          >
            <RecipeDetailView
              selectedCard={activeFoodRecipeDetailCard}
              selectedReadyCount={activeFoodRecipeDetailCard.ingredientAvailability.filter((item) => item.ready).length}
              selectedIngredientCount={activeFoodRecipeDetailCard.ingredientAvailability.length}
              selectedShortageCount={activeFoodRecipeDetailCard.shortages.length}
              isSelectedFavorite={false}
              selectedRecentCookLog={
                activeFoodRecipeDetailCard.recipe.cook_logs
                  .slice()
                  .sort((left, right) => right.cook_date.localeCompare(left.cook_date))[0] ?? null
              }
              selectedRecipePlanItems={[]}
              compactHeader
              showPlanAction={false}
              showShoppingAction={false}
              showFavoriteAction={false}
              showDeleteAction={false}
              onBack={closeFoodRecipeDetail}
              onCook={(card) => {
                closeFoodRecipeDetail();
                closeDetail();
                props.onStartRecipe(card.recipe.id);
              }}
              onPlan={() => undefined}
              onShopping={() => undefined}
              onToggleFavorite={() => undefined}
              onEdit={(card) => {
                closeFoodRecipeDetail();
                recipeEditorImageComposer.setState(IDLE_IMAGE_GENERATION_STATE);
                recipeEditor.openEdit(card);
                setIsFoodRecipeEditorOpen(true);
              }}
              onDelete={() => undefined}
            />
          </WorkspaceModal>
        </div>
      )}

      <FoodPlanDialog
        isOpen={isPlanDialogOpen}
        selectedPlanFood={selectedPlanFood}
        recipes={props.recipes}
        planFoodOptions={planFoodOptions}
        planFoodSearch={planFoodSearch}
        planForm={planForm}
        todayDate={todayDate}
        planDateOptions={planDateOptions}
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
        getDefaultMealType={getDefaultMealType}
        getPlanDateParts={getFoodPlanDateParts}
        normalizeFoodType={normalizeFoodType}
      />

      {activePlanDetailItem && (
        <FoodPlanDetailModal
          item={activePlanDetailItem}
          food={activePlanDetailFood}
          recipes={props.recipes}
          form={planDetailForm}
          isEditing={isPlanDetailEditing}
          isUpdatingPlan={props.isUpdatingPlan}
          isCompleting={props.isQuickAdding}
          onClose={closePlanDetail}
          onChangeForm={setPlanDetailForm}
          onEditingChange={setIsPlanDetailEditing}
          onResetEdit={resetPlanDetailForm}
          onSubmit={submitPlanDetail}
          onComplete={() => void completePlanItem(activePlanDetailItem)}
          onDelete={() => void deletePlanDetail(activePlanDetailItem)}
          resolveAssetUrl={resolveFoodAssetUrl}
        />
      )}

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
