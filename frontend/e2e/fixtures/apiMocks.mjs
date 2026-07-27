
const now = '2026-06-01T08:00:00.000Z';
const today = '2026-06-01';
const homeToday = '2026-07-12';

const user = {
  id: 'user-smoke',
  username: 'smoke',
  display_name: 'Smoke User',
  email: 'smoke@example.com',
  phone: null,
  avatar_seed: 'Smoke User',
  avatar_image: null,
};

const membership = {
  id: 'membership-smoke',
  family_id: 'family-smoke',
  user_id: user.id,
  role: 'Owner',
  status: 'active',
};

const family = {
  id: 'family-smoke',
  name: 'Smoke 家庭厨房',
  motto: '固定前端 smoke fixture',
  location: '上海',
  food_preferences: [],
  food_avoidances: [],
  image: null,
  created_at: now,
  updated_at: now,
  ai_recommendations: [],
};

const member = {
  ...user,
  role: membership.role,
  status: membership.status,
};

const ingredient = {
  id: 'ingredient-egg',
  family_id: family.id,
  name: '鸡蛋',
  category: '蛋奶',
  default_unit: '个',
  unit_conversions: [],
  default_storage: '冷藏',
  default_expiry_mode: 'days',
  default_expiry_days: 14,
  default_low_stock_threshold: 4,
  notes: 'smoke fixture',
  image: null,
  quantity_tracking_mode: 'track_quantity',
  row_version: 3,
  created_at: now,
  updated_at: now,
  created_by: user.id,
  updated_by: user.id,
};

const tomatoIngredient = {
  id: 'ingredient-tomato',
  family_id: family.id,
  name: '番茄',
  category: '蔬菜',
  default_unit: '个',
  unit_conversions: [],
  default_storage: '冷藏',
  default_expiry_mode: 'days',
  default_expiry_days: 7,
  default_low_stock_threshold: null,
  notes: 'smoke fixture tomato',
  image: null,
  quantity_tracking_mode: 'track_quantity',
  row_version: 2,
  created_at: now,
  updated_at: now,
  created_by: user.id,
  updated_by: user.id,
};

const milkIngredient = {
  id: 'ingredient-milk',
  family_id: family.id,
  name: '牛奶',
  category: '蛋奶',
  default_unit: '盒',
  unit_conversions: [],
  default_storage: '冷藏',
  default_expiry_mode: 'days',
  default_expiry_days: 5,
  default_low_stock_threshold: 2,
  notes: 'smoke fixture milk',
  image: null,
  quantity_tracking_mode: 'track_quantity',
  row_version: 1,
  created_at: now,
  updated_at: now,
  created_by: user.id,
  updated_by: user.id,
};


const saltIngredient = {
  id: 'ingredient-salt',
  family_id: family.id,
  name: '盐',
  category: '调味',
  default_unit: '袋',
  unit_conversions: [],
  quantity_tracking_mode: 'not_track_quantity',
  default_storage: '常温',
  default_expiry_mode: 'none',
  default_expiry_days: null,
  default_low_stock_threshold: null,
  notes: 'smoke fixture presence salt',
  image: null,
  row_version: 2,
  created_at: now,
  updated_at: now,
  created_by: user.id,
  updated_by: user.id,
};

function inventoryFixture(overrides) {
  return {
    family_id: family.id,
    consumed_quantity: 0,
    entered_quantity: overrides.quantity ?? overrides.remaining_quantity ?? 1,
    entered_unit: overrides.unit ?? '个',
    status: 'fresh',
    purchase_date: '2026-05-20',
    storage_location: '冷藏',
    notes: '',
    low_stock_threshold: null,
    created_at: now,
    updated_at: now,
    created_by: user.id,
    updated_by: user.id,
    row_version: 1,
    expiry_alert_snoozed_until: null,
    expiry_reviewed_at: null,
    expiry_reviewed_by: null,
    ...overrides,
  };
}

// Exact adapter: two refrigerated batches for 鸡蛋 (fresh + expired) and one out-of-scope room batch.
const eggColdFresh = inventoryFixture({
  id: 'inventory-egg-cold-fresh',
  ingredient_id: ingredient.id,
  ingredient_name: ingredient.name,
  quantity: 6,
  remaining_quantity: 6,
  unit: '个',
  expiry_date: '2026-08-15',
  low_stock_threshold: 4,
  row_version: 1,
  last_confirmed_at: null,
  last_confirmed_by: null,
  last_confirmation_source: null,
  quantity_tracking_mode: 'track_quantity',
});

const eggColdExpired = inventoryFixture({
  id: 'inventory-egg-cold-expired',
  ingredient_id: ingredient.id,
  ingredient_name: ingredient.name,
  quantity: 3,
  remaining_quantity: 3,
  unit: '个',
  purchase_date: '2026-04-01',
  expiry_date: '2026-05-10',
  notes: '过期批次',
  row_version: 2,
  last_confirmed_at: '2026-05-01T08:00:00.000Z',
  last_confirmed_by: user.id,
  last_confirmation_source: 'manual_entry',
  quantity_tracking_mode: 'track_quantity',
});

const eggRoomOutOfScope = inventoryFixture({
  id: 'inventory-egg-room',
  ingredient_id: ingredient.id,
  ingredient_name: ingredient.name,
  quantity: 4,
  remaining_quantity: 4,
  unit: '个',
  purchase_date: '2026-05-25',
  expiry_date: '2026-08-01',
  storage_location: '常温',
  notes: 'out-of-scope for refrigerated recon',
  row_version: 1,
  last_confirmed_at: '2026-05-28T08:00:00.000Z',
  last_confirmed_by: user.id,
  last_confirmation_source: 'reconciliation',
  quantity_tracking_mode: 'track_quantity',
});

const inventoryItem = eggColdFresh;

const tomatoExpiredA = inventoryFixture({
  id: 'inventory-tomato-a',
  ingredient_id: tomatoIngredient.id,
  ingredient_name: tomatoIngredient.name,
  quantity: 3,
  remaining_quantity: 3,
  unit: '个',
  expiry_date: '2026-05-28',
  row_version: 2,
  last_confirmed_at: '2026-05-01T08:00:00.000Z',
  last_confirmation_source: 'manual_entry',
  quantity_tracking_mode: 'track_quantity',
});

const tomatoExpiredB = inventoryFixture({
  id: 'inventory-tomato-b',
  ingredient_id: tomatoIngredient.id,
  ingredient_name: tomatoIngredient.name,
  quantity: 2,
  remaining_quantity: 2,
  unit: '个',
  expiry_date: '2026-05-30',
  row_version: 1,
  last_confirmed_at: null,
  quantity_tracking_mode: 'track_quantity',
});

const milkToday = inventoryFixture({
  id: 'inventory-milk',
  ingredient_id: milkIngredient.id,
  ingredient_name: milkIngredient.name,
  quantity: 2,
  remaining_quantity: 2,
  unit: '盒',
  expiry_date: today,
  row_version: 1,
  last_confirmed_at: '2026-05-28T08:00:00.000Z',
  last_confirmed_by: user.id,
  last_confirmation_source: 'shopping_intake',
  quantity_tracking_mode: 'track_quantity',
});

const inventoryItems = [
  eggColdFresh,
  eggColdExpired,
  eggRoomOutOfScope,
  tomatoExpiredA,
  tomatoExpiredB,
  milkToday,
];

const saltState = {
  id: 'state-salt',
  family_id: family.id,
  ingredient_id: saltIngredient.id,
  availability_level: 'sufficient',
  inventory_status: 'fresh',
  purchase_date: '2026-04-01',
  expiry_date: null,
  storage_location: '常温',
  notes: 'presence adapter fixture',
  expiry_alert_snoozed_until: null,
  expiry_reviewed_at: null,
  expiry_reviewed_by: null,
  last_confirmed_at: '2026-05-01T08:00:00.000Z',
  last_confirmed_by: user.id,
  last_confirmation_source: 'manual_entry',
  row_version: 1,
  created_at: now,
  updated_at: now,
};

const inventoryStates = [saltState];

const pendingEggShopping = {
  id: 'shopping-egg-pending',
  family_id: family.id,
  ingredient_id: ingredient.id,
  food_id: null,
  target_type: 'ingredient',
  title: '鸡蛋',
  quantity: 10,
  unit: '个',
  quantity_mode: 'track_quantity',
  display_label: '鸡蛋',
  reason: '补货',
  done: false,
  created_at: now,
  updated_at: now,
  created_by: user.id,
  updated_by: user.id,
  row_version: 1,
};

const shoppingItems = [pendingEggShopping];

const recipe = {
  id: 'recipe-egg',
  family_id: family.id,
  title: '番茄炒蛋',
  servings: 2,
  prep_minutes: 15,
  difficulty: 'easy',
  ingredient_items: [
    {
      id: 'recipe-ingredient-egg',
      ingredient_id: ingredient.id,
      ingredient_name: ingredient.name,
      quantity: 2,
      unit: '个',
      note: '',
    },
  ],
  steps: [
    {
      id: 'step-1',
      title: '炒制',
      text: '热锅后下蛋液和番茄。',
      icon: 'pan',
      summary: '快速翻炒',
      estimated_minutes: 10,
      tip: '',
      key_points: [],
    },
  ],
  tips: '出锅前调味。',
  scene_tags: ['家常'],
  images: [
    {
      id: 'media-food-egg',
      name: '番茄炒蛋.svg',
      url: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160"%3E%3Crect width="160" height="160" fill="%23f7e8cf"/%3E%3Cellipse cx="80" cy="88" rx="58" ry="42" fill="%23fffaf2"/%3E%3Cpath d="M42 88c16-35 65-40 82-6-16 38-65 45-82 6Z" fill="%23e85d36"/%3E%3Cpath d="M52 78c11-20 29-24 41-8-3 22-27 31-41 8Zm41 16c11-21 27-20 34-5-8 22-25 25-34 5Z" fill="%23f5c84c"/%3E%3C/svg%3E',
      source: 'upload',
      alt: '番茄炒蛋',
      created_at: now,
    },
  ],
  cook_logs: [],
  created_at: now,
  updated_at: now,
  created_by: user.id,
  updated_by: user.id,
};

const food = {
  id: 'food-egg',
  family_id: family.id,
  name: '番茄炒蛋',
  type: 'selfMade',
  category: '家常菜',
  flavor_tags: ['咸鲜'],
  scene_tags: ['家常'],
  suitable_meal_types: ['lunch', 'dinner'],
  source_name: '家里做',
  purchase_source: '',
  scene: '日常',
  images: recipe.images,
  notes: '',
  routine_note: '',
  price: null,
  rating: 4,
  repurchase: true,
  expiry_date: '2026-06-02',
  stock_quantity: 2,
  stock_unit: '份',
  storage_location: '冷藏',
  favorite: true,
  recipe_id: recipe.id,
  row_version: 1,
  inventory_last_confirmed_at: '2026-05-28T08:00:00.000Z',
  inventory_last_confirmed_by: user.id,
  inventory_confirmation_source: 'reconciliation',
  created_at: now,
  updated_at: now,
  created_by: user.id,
  updated_by: user.id,
};

const inventoryOverview = {
  scope: 'all',
  query: '',
  summary: {
    total_count: 5,
    ingredient_count: 3,
    food_count: 1,
    alert_count: 2,
    expiring_count: 3,
    empty_count: 0,
  },
  items: [
    {
      id: 'ingredient:inventory-egg',
      source_type: 'ingredient',
      source_id: ingredient.id,
      inventory_item_id: inventoryItem.id,
      title: ingredient.name,
      category: ingredient.category,
      image: null,
      quantity: inventoryItem.remaining_quantity,
      unit: inventoryItem.unit,
      quantity_label: `${inventoryItem.remaining_quantity}${inventoryItem.unit}`,
      quantity_tracking_mode: 'track_quantity',
      status: inventoryItem.status,
      tone: 'stable',
      expiry_date: inventoryItem.expiry_date,
      days_until_expiry: 14,
      storage_location: inventoryItem.storage_location,
      purchase_source: null,
      updated_at: inventoryItem.updated_at,
      primary_action: 'consume',
      search_text: `${ingredient.name} ${ingredient.category} ${inventoryItem.storage_location}`,
    },
    {
      id: 'ingredient:inventory-tomato-a',
      source_type: 'ingredient',
      source_id: tomatoIngredient.id,
      inventory_item_id: tomatoExpiredA.id,
      title: tomatoIngredient.name,
      category: tomatoIngredient.category,
      image: null,
      quantity: tomatoExpiredA.remaining_quantity,
      unit: tomatoExpiredA.unit,
      quantity_label: `${tomatoExpiredA.remaining_quantity}${tomatoExpiredA.unit}`,
      quantity_tracking_mode: 'track_quantity',
      status: tomatoExpiredA.status,
      tone: 'danger',
      expiry_date: tomatoExpiredA.expiry_date,
      days_until_expiry: -4,
      storage_location: tomatoExpiredA.storage_location,
      purchase_source: null,
      updated_at: tomatoExpiredA.updated_at,
      primary_action: 'consume',
      search_text: `${tomatoIngredient.name} ${tomatoIngredient.category} ${tomatoExpiredA.storage_location}`,
    },
    {
      id: 'food:food-egg',
      source_type: 'food',
      source_id: food.id,
      inventory_item_id: null,
      title: food.name,
      category: food.category,
      image: null,
      quantity: 2,
      unit: food.stock_unit,
      quantity_label: `2${food.stock_unit}`,
      quantity_tracking_mode: 'track_quantity',
      status: null,
      tone: 'warning',
      expiry_date: '2026-06-02',
      days_until_expiry: 1,
      storage_location: '冷藏',
      purchase_source: '家里做',
      updated_at: now,
      primary_action: 'record_meal',
      search_text: `${food.name} ${food.category} 冷藏 ${food.source_name} ${food.purchase_source}`,
    },
  ],
};
const reconciliationResult = {
  operation_id: 'op-recon-smoke-1',
  operation_type: 'reconciliation',
  status: 'applied',
  applied_at: '2026-06-01T08:05:00.000Z',
  revertible_until: '2026-06-01T08:20:00.000Z',
  can_revert: true,
  summary: {
    title: '本次盘点已完成',
    description: '确认 1 项 · 调整 1 项 · 标记少量 1 项',
    confirmed_count: 1,
    adjusted_count: 1,
    completed_count: 3,
    partial_count: 0,
  },
};

const inventoryOperations = [
  {
    ...reconciliationResult,
    actor_display_name: 'Smoke User',
  },
];

const authResponse = {
  access_token: 'smoke-token',
  user,
  membership,
  family,
};

function makeHighlight(id, kind, summary, createdAt) {
  return {
    id,
    kind,
    summary,
    actor_id: user.id,
    actor_name: user.display_name,
    created_at: createdAt,
  };
}

const activityHighlightsFixture = {
  items: [
    makeHighlight('highlight-5', 'shopping', '完成 5 项采购入库', '2026-07-12T08:42:00Z'),
    makeHighlight('highlight-4', 'inventory', '完成库存盘点并修正 3 项', '2026-07-12T08:10:00Z'),
    makeHighlight('highlight-3', 'meal_plan', '安排了周日晚餐', '2026-07-11T11:30:00Z'),
    makeHighlight('highlight-2', 'meal', '完成番茄炒蛋并记录用餐', '2026-07-11T10:00:00Z'),
    makeHighlight('highlight-1', 'family', '邀请爸爸加入家庭', '2026-07-10T09:00:00Z'),
  ],
  week_highlight_count: 9,
};

function makeRecommendationFood(index) {
  if (index === 0) return food;
  return {
    ...food,
    id: `food-rec-${index + 1}`,
    name: `推荐菜 ${index + 1}`,
    recipe_id: null,
    notes: `smoke recommendation ${index + 1}`,
  };
}

const recommendationFoods = [0, 1, 2, 3, 4].map(makeRecommendationFood);
const recommendationItems = recommendationFoods.map((item, index) => ({
  food: item,
  score: 0.9 - index * 0.05,
  reasons: [`适合今天安排 · ${index + 1}`],
  primary_action: item.recipe_id ? 'cook_recipe' : 'quick_add_meal',
}));
const planItemOutsideWeek = {
  id: 'plan-outside-week',
  family_id: family.id,
  user_id: user.id,
  food_id: food.id,
  food_name: food.name,
  food_type: food.type,
  recipe_id: recipe.id,
  recipe_title: recipe.title,
  plan_date: '2026-06-15',
  meal_type: 'dinner',
  note: 'smoke non-current-week plan',
  status: 'planned',
  meal_log_id: null,
  created_at: now,
  updated_at: now,
};

const riceFood = {
  ...food,
  id: 'food-rice',
  name: '米饭',
  recipe_id: null,
  category: '主食',
  images: [],
};

const soupFood = {
  ...food,
  id: 'food-soup',
  name: '冬瓜汤',
  recipe_id: null,
  category: '汤羹',
  images: [],
};

const recordedDinner = {
  id: 'meal-home-dinner',
  family_id: family.id,
  date: homeToday,
  meal_type: 'dinner',
  food_entries: [
    {
      id: 'entry-home-tomato',
      food_id: food.id,
      food_name: food.name,
      servings: 1,
      note: '',
      rating: null,
    },
  ],
  participant_user_ids: [member.id],
  notes: '',
  mood: '',
  photos: [],
  deduction_suggestions: [],
  row_version: 1,
  created_at: `${homeToday}T12:00:00.000Z`,
  updated_at: `${homeToday}T12:00:00.000Z`,
};

const homePlanItems = [
  {
    ...planItemOutsideWeek,
    id: 'plan-home-tomato',
    plan_date: homeToday,
    note: '少油',
    status: 'cooked',
    meal_log_id: recordedDinner.id,
    completed_at: `${homeToday}T12:00:00.000Z`,
  },
  {
    ...planItemOutsideWeek,
    id: 'plan-home-rice',
    food_id: riceFood.id,
    food_name: riceFood.name,
    food_type: riceFood.type,
    recipe_id: null,
    recipe_title: '',
    plan_date: homeToday,
    note: '',
    status: 'planned',
    meal_log_id: null,
  },
  {
    ...planItemOutsideWeek,
    id: 'plan-home-soup',
    food_id: soupFood.id,
    food_name: soupFood.name,
    food_type: soupFood.type,
    recipe_id: null,
    recipe_title: '',
    plan_date: homeToday,
    note: '',
    status: 'planned',
    meal_log_id: null,
  },
  {
    ...planItemOutsideWeek,
    id: 'plan-home-snack-recipe',
    plan_date: homeToday,
    meal_type: 'snack',
    note: '',
    status: 'planned',
    meal_log_id: null,
  },
];

const p0Fixtures = {
  '/api/activity-highlights': activityHighlightsFixture,
  '/api/auth/me': authResponse,
  '/api/family': family,
  '/api/food-plan': homePlanItems,
  '/api/food-scenes': [],
  '/api/foods': [...recommendationFoods, riceFood, soupFood],
  '/api/foods/recommendations': {
    target_meal_type: 'dinner',
    target_date: today,
    items: recommendationItems,
  },
  '/api/ingredients': [ingredient, tomatoIngredient, milkIngredient, saltIngredient],
  '/api/inventory': inventoryItems,
  '/api/inventory/operations': inventoryOperations,
  '/api/inventory/overview': inventoryOverview,
  '/api/inventory/states': inventoryStates,
  '/api/meal-logs': [recordedDinner],
  '/api/meal-logs/candidates': [],
  '/api/meal-logs/insights': [],
  '/api/meal-logs/record-operations': [],
  '/api/media/ai-render/active': [],
  '/api/members': [member],
  '/api/recipes': [recipe],
  '/api/search/index-jobs/active': [],
  '/api/shopping-list': shoppingItems,
};

export async function installApiMocks(context, unexpectedRequests, options = {}) {
  const requestedApiPaths = options.requestedApiPaths ?? null;

  await context.route('https://fonts.googleapis.com/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/css',
      body: '',
    });
  });
  await context.route('https://fonts.gstatic.com/**', async (route) => {
    await route.abort();
  });

  await context.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (url.pathname.startsWith('/api/') && requestedApiPaths) {
      requestedApiPaths.push(url.pathname);
    }

    if (request.method() === 'OPTIONS') {
      await route.fulfill({
        status: 204,
        headers: corsHeaders(),
      });
      return;
    }

    if (request.method() === 'POST' && url.pathname === '/api/auth/login') {
      await fulfillJson(route, authResponse);
      return;
    }

    if (request.method() === 'POST' && url.pathname === '/api/meal-logs/record') {
      let body = {};
      try {
        body = request.postDataJSON() ?? {};
      } catch {
        body = {};
      }
      const createdEntries = (body.entries ?? []).map((entry, index) => {
        const selectedFood = p0Fixtures['/api/foods'].find(
          (item) => item.id === entry.food_id,
        );
        return {
          id: `entry-p0-${index + 1}`,
          food_id: entry.food_id ?? entry.client_food_id ?? `food-p0-${index + 1}`,
          food_name: selectedFood?.name ?? 'P0 测试食物',
          servings: entry.servings ?? 1,
          note: '',
          rating: null,
        };
      });
      await fulfillJson(route, {
        meal_log: {
          id: 'meal-p0-recorded',
          family_id: family.id,
          date: body.date ?? homeToday,
          meal_type: body.meal_type ?? 'breakfast',
          food_entries: createdEntries,
          participant_user_ids: [member.id],
          notes: '',
          mood: '',
          photos: [],
          deduction_suggestions: [],
          row_version: 1,
          created_at: '2026-07-12T01:00:00.000Z',
          updated_at: '2026-07-12T01:00:00.000Z',
          created_by: user.id,
          updated_by: user.id,
        },
        created_foods: [],
        outcome: 'created',
        operation: {
          id: 'operation-p0-recorded',
          status: 'applied',
          revertible_until: '2026-07-12T01:15:00.000Z',
          can_revert: true,
          created_entry_ids: createdEntries.map((entry) => entry.id),
        },
        completed_plan_item_ids: [],
      });
      return;
    }

    const fixture = request.method() === 'GET' ? p0Fixtures[url.pathname] : undefined;
    if (fixture !== undefined) {
      await fulfillJson(route, fixture);
      return;
    }

    unexpectedRequests.push(
      request.method() + ' ' + url.pathname + url.search,
    );
    await fulfillJson(route, { detail: 'Unhandled P0 API: ' + url.pathname }, 404);
  });

  return { requestedApiPaths };
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization,content-type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  };
}

async function fulfillJson(route, body, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    headers: corsHeaders(),
    body: JSON.stringify(body),
  });
}
