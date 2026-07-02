import type { Food, FoodType, Ingredient, InventoryItem, MealLog, MealType, Recipe } from '../../api/types';
import { todayKey } from '../../lib/date';
import { FOOD_TYPE_LABELS, MEAL_TYPE_LABELS, formatDate, getFoodCover } from '../../lib/ui';
import { buildRecipeCards, type RecipeCardViewModel } from '../recipes/workspaceModel';
import { FOOD_GOVERNANCE_ISSUE_OPTIONS, type FoodGovernanceIssue } from './FoodWorkspaceOptions';

export type NormalizedFoodType = Exclude<FoodType, 'packaged'>;

export type FoodRelationViewModel = {
  linkedRecipeCard: RecipeCardViewModel | null;
  usage: { count: number; last: string | null };
  lastMealLog: MealLog | null;
  relationFacts: Array<{ label: string; value: string }>;
  shortagePreview: string[];
  summary: string;
  detail: string;
};

export type FoodCookingSummary = {
  linkedRecipeCard: RecipeCardViewModel | null;
  title: string;
  availabilityLabel: string;
  availabilityDetail: string;
  metaLabel: string;
  shortagePreview: string[];
  isReady: boolean;
};

export function getDaysUntil(dateValue?: string | null) {
  if (!dateValue) return null;
  const target = new Date(`${dateValue}T00:00:00`).getTime();
  const today = new Date(`${todayKey()}T00:00:00`).getTime();
  return Math.round((target - today) / 86_400_000);
}

export function getDaysSince(dateValue: string, todayValue = todayKey()) {
  const target = new Date(`${dateValue}T00:00:00`).getTime();
  const today = new Date(`${todayValue}T00:00:00`).getTime();
  return Math.round((today - target) / 86_400_000);
}

export function describeExpiry(food: Food) {
  const days = getDaysUntil(food.expiry_date);
  if (days == null) return null;
  if (days < 0) return `已过期 ${Math.abs(days)} 天`;
  if (days === 0) return '今天到期';
  if (days <= 7) return `${days} 天后到期`;
  return `${formatDate(food.expiry_date ?? '')} 到期`;
}

export function normalizeFoodType(food: Food): NormalizedFoodType {
  return food.type === 'packaged' ? 'readyMade' : food.type;
}

export function isReadyLikeFood(food: Food) {
  const normalizedType = normalizeFoodType(food);
  return normalizedType === 'readyMade' || normalizedType === 'instant';
}

export function isOutsideFood(food: Food) {
  const normalizedType = normalizeFoodType(food);
  return normalizedType === 'takeout' || normalizedType === 'diningOut';
}

export function getFoodSceneTags(food: Food) {
  return food.scene_tags ?? [];
}

export function isFoodExpiring(food: Food) {
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

export function getFoodGovernanceIssueLabels(food: Food, recipes: Recipe[] = []) {
  const labels = new Map(FOOD_GOVERNANCE_ISSUE_OPTIONS.map((item) => [item.value, item.label]));
  return getFoodGovernanceIssues(food, recipes).map((issue) => labels.get(issue) ?? issue);
}

export function isFoodMissingDecisionInfo(food: Food, recipes: Recipe[] = []) {
  return getFoodGovernanceIssues(food, recipes).length > 0;
}

export function getFoodStatus(food: Food, usage: ReturnType<typeof getMealUsage>, expiry: string | null, recipes: Recipe[] = []) {
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

export function getMealUsage(food: Food, mealLogs: MealLog[]) {
  const logs = mealLogs.filter((log) => log.food_entries.some((entry) => entry.food_id === food.id));
  const sortedDates = logs.map((log) => log.date).sort((a, b) => b.localeCompare(a));
  return {
    count: logs.length,
    last: sortedDates[0] ?? null,
  };
}

export function getDefaultMealType(food: Food): MealType {
  if (food.suitable_meal_types.includes('dinner')) return 'dinner';
  if (food.suitable_meal_types.includes('lunch')) return 'lunch';
  return food.suitable_meal_types[0] ?? 'dinner';
}

export function getPrimaryFoodActionLabel(food: Food) {
  const normalizedType = normalizeFoodType(food);
  if (normalizedType === 'takeout' || normalizedType === 'diningOut') return '再吃一次';
  if (normalizedType === 'readyMade' || normalizedType === 'instant') return '记到今天';
  return '记到今天';
}

export function getSecondaryFoodActionLabel(food: Food) {
  if (normalizeFoodType(food) === 'selfMade') return '编辑档案';
  if (isReadyLikeFood(food)) return '更新库存';
  if (isOutsideFood(food)) return '编辑评价';
  return '编辑资料';
}

export function getRepurchaseLabel(food: Food) {
  if (food.repurchase == null) return '未记录';
  return food.repurchase ? '愿意复购' : '暂不复购';
}

export function getFoodFactRows(food: Food, usage: ReturnType<typeof getMealUsage>, expiry: string | null) {
  const normalizedType = normalizeFoodType(food);
  const mealText = food.suitable_meal_types.map((meal) => MEAL_TYPE_LABELS[meal]).join('、') || '未设置';
  if (normalizedType === 'selfMade') {
    return [
      { label: '菜谱', value: food.recipe_id ? '已完善' : '待完善' },
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

export function getFoodMealHistory(food: Food, mealLogs: MealLog[]) {
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

export function getLastMealLogForFood(food: Food, mealLogs: MealLog[]) {
  return mealLogs
    .filter((log) => log.food_entries.some((entry) => entry.food_id === food.id))
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date) || b.created_at.localeCompare(a.created_at))[0] ?? null;
}

export function buildFoodRelationViewModelFromRecipeCards(
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
        { label: '菜谱', value: linkedRecipeCard?.recipe.title ?? '待完善' },
        { label: '可做程度', value: linkedRecipeCard?.availabilityLabel ?? '无法判断' },
        { label: '餐食记录', value: recordValue },
        { label: '最近一次', value: lastValue },
      ],
      shortagePreview,
      summary: linkedRecipeCard ? `${linkedRecipeCard.recipe.title} · ${linkedRecipeCard.availabilityLabel}` : '待完善菜谱',
      detail: linkedRecipeCard
        ? shortagePreview.length > 0
          ? `缺 ${shortagePreview.join('、')}`
          : linkedRecipeCard.availabilityDetail
        : '补充菜谱与用料后可以判断缺哪些食材。',
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

  const stockValue = food.stock_quantity == null ? '未记录' : `${food.stock_quantity}${food.stock_unit || '份'}`;
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

export function buildFoodCookingSummaryFromRecipeCards(
  food: Food,
  recipeCards: RecipeCardViewModel[]
): FoodCookingSummary | null {
  if (normalizeFoodType(food) !== 'selfMade' || !food.recipe_id) return null;
  const linkedRecipeCard = recipeCards.find((card) => card.recipe.id === food.recipe_id) ?? null;
  const recipe = linkedRecipeCard?.recipe ?? null;
  if (!recipe) return null;
  const shortagePreview = linkedRecipeCard?.shortages
    .slice(0, 3)
    .map((item) => `${item.ingredientName} ${item.missingQuantity}${item.unit}`) ?? [];
  const metaLabel = `${recipe.ingredient_items.length} 原料 · ${recipe.steps.length} 步`;
  return {
    linkedRecipeCard,
    title: recipe.title,
    availabilityLabel: linkedRecipeCard?.availabilityLabel ?? metaLabel,
    availabilityDetail: linkedRecipeCard?.availabilityDetail || recipe.tips || '这份家常菜谱已经保存到食物里。',
    metaLabel,
    shortagePreview,
    isReady: Boolean(linkedRecipeCard && linkedRecipeCard.shortages.length === 0),
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

export function getFoodAudienceText(food: Food, mealLogs: MealLog[]) {
  const history = getFoodMealHistory(food, mealLogs);
  const participantCount = Math.max(...history.map(({ log }) => log.participant_user_ids.length), 0);
  if (participantCount > 0) return `最近记录里最多 ${participantCount} 位成员一起吃`;
  if (food.suitable_meal_types.includes('snack')) return '适合临时加餐或小份分享';
  return '适合家庭成员共同安排';
}
