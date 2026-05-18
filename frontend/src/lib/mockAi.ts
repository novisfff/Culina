import {
  AI_MODE_LABELS,
  FOOD_TYPE_LABELS,
  buildInventoryAlerts,
  createId,
  lookupFood,
  lookupRecipeByFood,
  todayKey
} from './helpers';
import type {
  AIConversation,
  AIRecommendation,
  AiMode,
  AppState,
  Food,
  Ingredient,
  InventoryItem
} from './types';

function getInventorySnapshot(state: AppState): string[] {
  return state.inventoryItems
    .map((item) => {
      const ingredient = state.ingredients.find((entry) => entry.id === item.ingredientId);
      return ingredient ? `${ingredient.name}${item.quantity}${item.unit}` : null;
    })
    .filter((item): item is string => Boolean(item));
}

function availabilityScore(
  ingredientIds: Array<string | undefined>,
  inventoryItems: InventoryItem[]
): number {
  const resolved = ingredientIds.filter((id): id is string => Boolean(id));
  if (resolved.length === 0) {
    return 0;
  }
  const matched = resolved.filter((id) => inventoryItems.some((item) => item.ingredientId === id));
  return matched.length / resolved.length;
}

function pickRecommendation(state: AppState): AIRecommendation {
  const todayMeals = state.mealLogs.filter((log) => log.date === todayKey());
  const eatenFoodIds = new Set(todayMeals.flatMap((log) => log.foodEntries.map((entry) => entry.foodId)));

  const candidates = state.foods
    .filter((food) => food.type === 'selfMade' && !eatenFoodIds.has(food.id))
    .map((food) => {
      const recipe = lookupRecipeByFood(state, food.id);
      const score = availabilityScore(
        recipe?.ingredientItems.map((item) => item.ingredientId) ?? [],
        state.inventoryItems
      );
      return { food, recipe, score };
    })
    .sort((left, right) => right.score - left.score);

  const best = candidates[0] ?? { food: state.foods[0], recipe: undefined, score: 0 };
  const inventoryAlerts = buildInventoryAlerts(state.inventoryItems, state.ingredients);

  return {
    id: createId('recommendation'),
    familyId: state.family.id,
    title: best.food ? `今晚推荐：${best.food.name}` : '今晚推荐一份轻松晚餐',
    detail: best.food
      ? `匹配库存度 ${Math.round(best.score * 100)}%，${best.recipe ? `建议准备 ${best.recipe.prepMinutes} 分钟。` : '适合直接安排。'}${inventoryAlerts[0] ? ` 另外别忘了优先处理：${inventoryAlerts[0].title}。` : ''}`
      : '先补齐常用食材后，系统会给出更准确的推荐。',
    createdAt: new Date().toISOString()
  };
}

function formatIngredientList(ingredients: Ingredient[]): string {
  return ingredients.map((item) => item.name).join('、');
}

function buildFoodAnswer(state: AppState, food: Food | undefined, prompt: string): string {
  if (!food) {
    return '我还没有找到这道菜的上下文，可以先在食物或菜谱里完善信息后再问我。';
  }
  const recipe = lookupRecipeByFood(state, food.id);
  if (!recipe) {
    return `${food.name} 当前记录为${FOOD_TYPE_LABELS[food.type]}，建议补充来源、口味和备注。我也可以结合你的描述帮你整理成标准菜谱。`;
  }

  const lighterTip = prompt.includes('清淡')
    ? '如果要更清淡，可以把油量减到平时的 70%，并增加蒸/焯步骤。'
    : '可以优先保留这道菜的核心步骤，再根据家庭口味调整调味。';

  return `${food.name} 适合 ${recipe.sceneTags.join('、') || '家庭日常'} 场景，当前难度是 ${recipe.difficulty}，准备约 ${recipe.prepMinutes} 分钟。${lighterTip} 现有原料包括 ${recipe.ingredientItems
    .map((item) => `${item.ingredientName}${item.quantity}${item.unit}`)
    .join('、')}。`;
}

function buildInventoryAnswer(state: AppState): string {
  const alerts = buildInventoryAlerts(state.inventoryItems, state.ingredients);
  const snapshot = getInventorySnapshot(state);

  if (alerts.length === 0) {
    return `当前库存状态平稳，主要食材有：${snapshot.slice(0, 6).join('、')}。可以优先安排 1 道自做菜和 1 份轻主食组合。`;
  }

  return `目前最需要关注的是：${alerts
    .map((item) => item.title)
    .join('、')}。现有库存里可以优先消耗 ${snapshot.slice(0, 5).join('、')}。如果你愿意，我下一步可以直接给你一顿晚餐搭配建议。`;
}

function buildRecipeDraft(state: AppState, ingredientIds: string[], prompt: string): string {
  const selectedIngredients = state.ingredients.filter((item) => ingredientIds.includes(item.id));
  if (selectedIngredients.length === 0) {
    return '先选择 2-4 个现有食材，我就能生成更贴近家庭库存的菜谱草稿。';
  }

  const title = `${selectedIngredients[0].name}${selectedIngredients[1] ? `搭配${selectedIngredients[1].name}` : ''}快手家常菜`;
  return `菜谱草稿《${title}》：1. 主料使用 ${formatIngredientList(selectedIngredients)}。2. 先处理容易出水的食材，再加入主调味。3. 控制总时长在 20 分钟内。${prompt ? ` 你提到“${prompt}”，我会优先按这个方向调整口味。` : ''}`;
}

export function runAiConversation(
  state: AppState,
  mode: AiMode,
  prompt: string,
  userId: string,
  context: {
    foodId?: string;
    ingredientIds?: string[];
  }
): { conversation: AIConversation; recommendation?: AIRecommendation } {
  let response = '';
  let recommendation: AIRecommendation | undefined;

  if (mode === 'foodQa') {
    response = buildFoodAnswer(state, context.foodId ? lookupFood(state, context.foodId) : undefined, prompt);
  }

  if (mode === 'inventoryQa') {
    response = buildInventoryAnswer(state);
  }

  if (mode === 'recommendation') {
    recommendation = pickRecommendation(state);
    response = `${recommendation.title}。${recommendation.detail}`;
  }

  if (mode === 'recipeDraft') {
    response = buildRecipeDraft(state, context.ingredientIds ?? [], prompt);
  }

  return {
    conversation: {
      id: createId('conversation'),
      familyId: state.family.id,
      mode,
      prompt: prompt || AI_MODE_LABELS[mode],
      response,
      createdAt: new Date().toISOString(),
      createdBy: userId,
      context
    },
    recommendation
  };
}

export function buildStarterRecommendations(state: AppState): AIRecommendation[] {
  return [
    pickRecommendation(state),
    {
      id: createId('recommendation'),
      familyId: state.family.id,
      title: '库存优先提醒',
      detail: buildInventoryAnswer(state),
      createdAt: new Date().toISOString()
    }
  ];
}
