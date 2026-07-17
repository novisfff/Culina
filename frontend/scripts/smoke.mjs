import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const frontendRoot = resolve(__dirname, '..');
const distDir = resolve(frontendRoot, 'dist');

const now = '2026-06-01T08:00:00.000Z';
const today = '2026-06-01';
const homeToday = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date());

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


function makeReconciliationBatch(item, confirmationStatus) {
  return {
    inventory_item_id: item.id,
    row_version: item.row_version,
    remaining_quantity: item.remaining_quantity,
    unit: item.unit,
    status: item.status,
    purchase_date: item.purchase_date,
    expiry_date: item.expiry_date,
    storage_location: item.storage_location,
    notes: item.notes,
    confirmation_status: confirmationStatus,
    last_confirmed_at: item.last_confirmed_at ?? null,
  };
}

const reconExactEggGroup = {
  kind: 'exact_ingredient',
  ingredient_id: ingredient.id,
  ingredient_name: ingredient.name,
  ingredient_row_version: 3,
  confirmation_status: 'never_confirmed',
  last_confirmed_at: null,
  batches: [
    makeReconciliationBatch(eggColdFresh, 'never_confirmed'),
    makeReconciliationBatch(eggColdExpired, 'stale'),
    makeReconciliationBatch(eggRoomOutOfScope, 'current'),
  ],
  pending_shopping_item_id: pendingEggShopping.id,
};

const reconPresenceSaltGroup = {
  kind: 'presence_ingredient',
  ingredient_id: saltIngredient.id,
  ingredient_name: saltIngredient.name,
  ingredient_row_version: saltIngredient.row_version,
  state: saltState,
  confirmation_status: 'stale',
  pending_shopping_item_id: null,
};

const reconFoodGroup = {
  kind: 'food',
  food_id: food.id,
  food_name: food.name,
  row_version: food.row_version,
  stock_quantity: food.stock_quantity,
  stock_unit: food.stock_unit,
  expiry_date: food.expiry_date,
  storage_location: food.storage_location,
  confirmation_status: 'current',
  last_confirmed_at: food.inventory_last_confirmed_at,
};

function buildReconciliationResponse(scope) {
  let groups = [reconExactEggGroup, reconPresenceSaltGroup, reconFoodGroup];
  if (scope === 'refrigerated') {
    groups = [
      {
        ...reconExactEggGroup,
        batches: reconExactEggGroup.batches.filter((batch) => batch.storage_location === '冷藏'),
      },
      reconFoodGroup,
    ];
  } else if (scope === 'room_temperature') {
    groups = [
      {
        ...reconExactEggGroup,
        batches: reconExactEggGroup.batches.filter((batch) => batch.storage_location === '常温'),
      },
      reconPresenceSaltGroup,
    ];
  } else if (scope === 'frozen') {
    groups = [];
  }

  return {
    business_date: today,
    business_timezone: 'Asia/Shanghai',
    generated_at: now,
    summary: {
      total_groups: groups.length,
      never_confirmed: groups.filter((group) => group.confirmation_status === 'never_confirmed').length,
      stale: groups.filter((group) => group.confirmation_status === 'stale').length,
      expired_physical_batches: groups.reduce((count, group) => {
        if (group.kind !== 'exact_ingredient') return count;
        return (
          count +
          group.batches.filter(
            (batch) => batch.remaining_quantity > 0 && batch.expiry_date && batch.expiry_date < today
          ).length
        );
      }, 0),
    },
    groups,
  };
}

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

const emptyDiscoverySection = {
  recipe_ids: [],
  recipes: [],
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

const activityLogs = activityHighlightsFixture.items.map((item, index) => ({
  id: `activity-log-${index + 1}`,
  family_id: family.id,
  actor_id: item.actor_id,
  actor_name: item.actor_name,
  action: item.kind,
  entity_type: item.kind,
  entity_id: item.id,
  summary: item.summary,
  created_at: item.created_at,
}));

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

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createRouteController() {
  return {
    highlightDelay: deferred(),
    activityLogDelay: deferred(),
    routeMode: {
      highlights: 'success',
      activityLogs: 'success',
    },
  };
}

async function fulfillActivityRoute(route, url, routeController) {
  if (url.pathname === '/api/activity-highlights') {
    if (routeController.routeMode.highlights === 'delay') await routeController.highlightDelay.promise;
    if (routeController.routeMode.highlights === 'error') {
      await fulfillJson(route, { detail: 'fixture highlight failure' }, 500);
      return true;
    }
    await fulfillJson(route, activityHighlightsFixture);
    return true;
  }
  if (url.pathname === '/api/activity-logs') {
    if (routeController.routeMode.activityLogs === 'delay') await routeController.activityLogDelay.promise;
    if (routeController.routeMode.activityLogs === 'error') {
      await fulfillJson(route, { detail: 'fixture activity-log failure' }, 500);
      return true;
    }
    await fulfillJson(route, activityLogs);
    return true;
  }
  return false;
}

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

const fixtures = {
  '/api/auth/me': authResponse,
  '/api/family': family,
  '/api/members': [member],
  '/api/ingredients': [ingredient, tomatoIngredient, milkIngredient, saltIngredient],
  '/api/inventory': inventoryItems,
  '/api/inventory/states': inventoryStates,
  '/api/inventory/overview': inventoryOverview,
  '/api/inventory/operations': inventoryOperations,
  '/api/shopping-list': shoppingItems,
  '/api/recipes': [recipe],
  '/api/recipes/discovery': {
    recommended: { recipe_ids: [recipe.id], recipes: [recipe] },
    ready: { recipe_ids: [recipe.id], recipes: [recipe] },
    quick: emptyDiscoverySection,
    missing: emptyDiscoverySection,
  },
  '/api/recipes/stats': {
    total_cooks: 0,
    recently_cooked: [],
    frequent: [],
  },
  '/api/recipe-favorites': [],
  '/api/food-plan': homePlanItems,
  [`/api/food-plan/${planItemOutsideWeek.id}`]: planItemOutsideWeek,
  '/api/food-scenes': [],
  '/api/foods': [...recommendationFoods, riceFood, soupFood],
  '/api/foods/recommendations': {
    target_meal_type: 'dinner',
    target_date: today,
    items: recommendationItems,
  },
  '/api/meal-logs': [recordedDinner],
  // Phase-one meal recording surfaces (Task 16): boot + dialog support.
  '/api/meal-logs/record-operations': [],
  '/api/meal-logs/candidates': [],
  // Phase-two family memories (Task 18): history view only.
  '/api/meal-logs/insights': [],
  '/api/ai/conversations': [],
  '/api/ai/status': {
    enabled: true,
    provider: 'openai-compatible',
    model: 'fake-model',
    supports_vision: true,
    status: 'ready',
    detail: 'AI 已就绪。',
  },
  '/api/media/ai-render/active': [],
  '/api/search/index-jobs/active': [],
  '/api/search': {
    query: '',
    total: 1,
    items: [
      {
        entity_type: 'recipe',
        entity_id: recipe.id,
        score: 1,
        keyword_score: 1,
        semantic_score: 0,
        business_score: 0,
        match_reason: ['title'],
        entity: recipe,
      },
    ],
  },
};

function assertDistExists() {
  if (!existsSync(distDir)) {
    throw new Error('frontend/dist 不存在。请先运行 npm --prefix frontend run build。');
  }
}

async function findOpenPort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (!address || typeof address === 'string') {
          reject(new Error('无法获取可用端口。'));
          return;
        }
        resolvePort(address.port);
      });
    });
  });
}

async function waitForPreview(url, child) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < 20_000) {
    if (child.exitCode !== null) {
      throw new Error(`Vite preview 提前退出，exit code: ${child.exitCode}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`等待 Vite preview 超时：${lastError instanceof Error ? lastError.message : 'unknown error'}`);
}

async function startPreview() {
  const port = await findOpenPort();
  const child = spawn(
    'npx',
    ['vite', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    {
      cwd: frontendRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, BROWSER: 'none' },
      detached: process.platform !== 'win32',
    }
  );

  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });

  const url = `http://127.0.0.1:${port}`;
  try {
    await waitForPreview(url, child);
  } catch (error) {
    await stopPreviewProcess(child);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${output}`);
  }

  return {
    url,
    stop: async () => {
      await stopPreviewProcess(child);
    },
  };
}

function signalPreviewProcess(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== 'win32' && child.pid) {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {
    // Fall through to direct child signaling. Some environments disallow process-group signals.
  }
  child.kill(signal);
}

function waitForPreviewExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveWait) => {
    const timeout = setTimeout(() => {
      child.off('exit', onExit);
      resolveWait(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timeout);
      resolveWait(true);
    };
    child.once('exit', onExit);
  });
}

async function stopPreviewProcess(child) {
  signalPreviewProcess(child, 'SIGTERM');
  const stopped = await waitForPreviewExit(child, 2_500);
  if (stopped) return;
  signalPreviewProcess(child, 'SIGKILL');
  await waitForPreviewExit(child, 2_500);
}

async function installApiMocks(context, unexpectedRequests, options = {}) {
  const requestedApiPaths = options.requestedApiPaths ?? null;
  const requestedAiHeaders = options.requestedAiHeaders ?? null;
  const routeController = options.routeController ?? createRouteController();
  const mealCandidates = options.mealCandidates ?? [];

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

    if (url.pathname.startsWith('/api/ai/') && requestedAiHeaders) {
      requestedAiHeaders.push({
        path: url.pathname,
        contracts: request.headers()['x-culina-ai-draft-contracts'] || '',
      });
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

    if (request.method() === 'GET' && url.pathname === '/api/inventory/reconciliation') {
      const scope = url.searchParams.get('scope') || 'suggested';
      await fulfillJson(route, buildReconciliationResponse(scope));
      return;
    }

    if (request.method() === 'POST' && url.pathname === '/api/inventory/reconciliations') {
      await fulfillJson(route, reconciliationResult);
      return;
    }

    if (request.method() === 'GET' && url.pathname === '/api/inventory/states') {
      await fulfillJson(route, inventoryStates);
      return;
    }

    if (await fulfillActivityRoute(route, url, routeController)) {
      return;
    }

    if (request.method() === 'GET' && url.pathname.startsWith('/api/food-plan/')) {
      const itemId = url.pathname.slice('/api/food-plan/'.length);
      const detail = fixtures[`/api/food-plan/${itemId}`];
      if (detail !== undefined) {
        await fulfillJson(route, detail);
        return;
      }
    }

    if (request.method() === 'GET' && url.pathname === '/api/search') {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) {
        await fulfillJson(route, { query: q, total: 0, items: [] });
        return;
      }
      await fulfillJson(route, {
        query: q,
        total: 2,
        items: [
          {
            entity_type: 'recipe',
            entity_id: recipe.id,
            score: 1,
            keyword_score: 1,
            semantic_score: 0,
            business_score: 0,
            match_reason: ['title'],
            entity: recipe,
          },
          {
            entity_type: 'meal_plan',
            entity_id: planItemOutsideWeek.id,
            score: 0.8,
            keyword_score: 0.8,
            semantic_score: 0,
            business_score: 0,
            match_reason: ['plan'],
            entity: planItemOutsideWeek,
          },
        ],
      });
      return;
    }

    // Phase-one meal recording owners (Task 16). Never serve /api/meal-logs/quick-add.
    if (url.pathname === '/api/meal-logs/quick-add') {
      await fulfillJson(route, { detail: 'Not Found' }, 404);
      return;
    }

    if (request.method() === 'GET' && url.pathname === '/api/meal-logs/candidates') {
      await fulfillJson(route, mealCandidates);
      return;
    }

    if (request.method() === 'GET' && url.pathname === '/api/meal-logs/record-operations') {
      await fulfillJson(route, []);
      return;
    }

    if (request.method() === 'GET' && url.pathname === '/api/meal-logs/insights') {
      await fulfillJson(route, []);
      return;
    }

    if (request.method() === 'POST' && url.pathname === '/api/meal-logs/record') {
      let body = {};
      try {
        body = request.postDataJSON() ?? {};
      } catch {
        body = {};
      }
      const existingEntries = body?.target?.kind === 'existing' ? recordedDinner.food_entries : [];
      const createdEntries = (body.entries || []).map((entry, index) => ({
        id: `entry-smoke-${index + 1}`,
        food_id: entry.food_id || entry.client_food_id || 'food-smoke',
        food_name:
          entry.food_id === riceFood.id
            ? riceFood.name
            : entry.food_id === food.id
              ? food.name
              : entry.name || 'Smoke food',
        servings: entry.servings ?? 1,
        note: '',
        rating: null,
      }));
      const mealLog = {
        id: body?.target?.kind === 'existing' ? body.target.meal_log_id : 'meal-smoke-record-1',
        family_id: family.id,
        date: body.date || today,
        meal_type: body.meal_type || 'dinner',
        food_entries: [...existingEntries, ...createdEntries],
        participant_user_ids: [member.id],
        notes: '',
        mood: '',
        photos: [],
        deduction_suggestions: [],
        row_version: body?.target?.kind === 'existing' ? (body.target.expected_row_version || 1) + 1 : 1,
        created_at: `${today}T12:00:00.000Z`,
        updated_at: `${today}T12:00:00.000Z`,
      };
      await fulfillJson(route, {
        meal_log: mealLog,
        created_foods: [],
        outcome: body?.target?.kind === 'existing' ? 'appended' : 'created',
        operation: {
          id: 'op-smoke-1',
          status: 'applied',
          revertible_until: `${today}T12:30:00.000Z`,
          can_revert: true,
          created_entry_ids: createdEntries.map((entry) => entry.id),
        },
        completed_plan_item_ids: (body.plan_item_completions || []).map((item) => item.food_plan_item_id),
      });
      return;
    }

    if (request.method() === 'POST' && url.pathname.endsWith('/complete') && url.pathname.startsWith('/api/food-plan/')) {
      const itemId = url.pathname.slice('/api/food-plan/'.length, -'/complete'.length);
      await fulfillJson(route, {
        id: 'meal-smoke-plan-1',
        family_id: family.id,
        date: today,
        meal_type: 'dinner',
        food_entries: [
          {
            id: 'entry-plan-1',
            food_id: 'food-smoke',
            food_name: 'Smoke plan food',
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
        created_at: `${today}T12:00:00.000Z`,
        updated_at: `${today}T12:00:00.000Z`,
        created_by: member.id,
        updated_by: member.id,
      });
      return;
    }

    if (request.method() === 'POST' && /\/api\/recipes\/[^/]+\/cook$/.test(url.pathname)) {
      let body = {};
      try {
        body = request.postDataJSON() ?? {};
      } catch {
        body = {};
      }
      await fulfillJson(route, {
        recipe_id: recipe.id,
        consumed_items: [],
        shortages: [],
        meal_log_id: body.target_meal_log_id || 'meal-smoke-cook-1',
        cook_log_id: 'cook-smoke-1',
        completion_request_id: body.completion_request_id || 'cook-smoke-req',
        replayed: false,
      });
      return;
    }

    if (request.method() === 'POST' && /\/api\/recipes\/[^/]+\/cook-preview$/.test(url.pathname)) {
      await fulfillJson(route, {
        recipe_id: recipe.id,
        preview_items: [],
        shortages: [],
      });
      return;
    }

    if (request.method() === 'POST' && /\/api\/meal-logs\/record-operations\/[^/]+\/revert$/.test(url.pathname)) {
      await fulfillJson(route, {
        operation_id: 'op-smoke-1',
        status: 'reverted',
        meal_log_id: 'meal-smoke-record-1',
        meal_log: recordedDinner,
        removed_food_ids: [],
        replayed: false,
      });
      return;
    }

    if (request.method() === 'PATCH' && /\/api\/meal-logs\/[^/]+\/composition$/.test(url.pathname)) {
      await fulfillJson(route, {
        id: 'meal-smoke-record-1',
        family_id: family.id,
        date: today,
        meal_type: 'dinner',
        food_entries: [],
        participant_user_ids: [member.id],
        notes: '',
        mood: '',
        photos: [],
        deduction_suggestions: [],
        row_version: 2,
        created_at: `${today}T12:00:00.000Z`,
        updated_at: `${today}T12:05:00.000Z`,
      });
      return;
    }

    const fixture = fixtures[url.pathname];
    if (fixture !== undefined) {
      await fulfillJson(route, fixture);
      return;
    }

    unexpectedRequests.push(`${request.method()} ${url.pathname}${url.search}`);
    await fulfillJson(route, { detail: `Unhandled smoke API: ${url.pathname}` }, 404);
  });

  return { routeController, requestedApiPaths, requestedAiHeaders };
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization,content-type,x-culina-ai-draft-contracts',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
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

async function createPage(browser, viewport, authenticated = true, contextOptions = {}, mockOptions = {}) {
  const context = await browser.newContext({ viewport, ...contextOptions });
  const unexpectedRequests = [];
  const pageErrors = [];
  const consoleErrors = [];
  const requestedApiPaths = mockOptions.requestedApiPaths ?? [];
  const requestedAiHeaders = mockOptions.requestedAiHeaders ?? [];
  const routeController = mockOptions.routeController ?? createRouteController();

  await installApiMocks(context, unexpectedRequests, {
    requestedApiPaths,
    requestedAiHeaders,
    routeController,
    mealCandidates: mockOptions.mealCandidates,
  });
  if (authenticated) {
    await context.addInitScript(() => {
      localStorage.setItem('culina-access-token', 'smoke-token');
      localStorage.setItem(
        'culina-navigation-v2',
        JSON.stringify({ version: 2, primaryTab: 'home', eatBaseView: 'discover', discoverSection: 'all' }),
      );
    });
  }

  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });

  return {
    context,
    page,
    routeController,
    requestedApiPaths,
    requestedAiHeaders,
    assertClean: () => {
      if (unexpectedRequests.length > 0) {
        throw new Error(`未 mock 的 API 请求：\n${unexpectedRequests.join('\n')}`);
      }
      if (pageErrors.length > 0) {
        throw new Error(`页面运行错误：\n${pageErrors.join('\n')}`);
      }
      const relevantConsoleErrors = consoleErrors.filter((message) => !message.includes('Failed to load resource'));
      if (relevantConsoleErrors.length > 0) {
        throw new Error(`浏览器 console error：\n${relevantConsoleErrors.join('\n')}`);
      }
    },
  };
}

function isPhoneViewportSize(viewport) {
  return viewport.width <= 767;
}

function homeSurfaceLocator(page, viewport) {
  return isPhoneViewportSize(viewport)
    ? page.locator('.mobile-dashboard-page')
    : page.locator('.dashboard-page');
}

async function assertHomeThreeQuestions(page, viewport, label) {
  const isPhoneViewport = isPhoneViewportSize(viewport);
  const surface = homeSurfaceLocator(page, viewport);
  await expectVisible(surface.getByRole('heading', { name: '今天吃什么' }), `${label} 首页问题 1`);
  await expectVisible(surface.getByRole('heading', { name: '今天必须处理什么' }), `${label} 首页问题 2`);
  await expectVisible(surface.getByRole('heading', { name: '家里发生了什么' }), `${label} 首页问题 3`);

  const recommendationCount = await surface.getByTestId('home-recommendation-card').count();
  const expectedRecommendationCount = isPhoneViewport ? 1 : 3;
  if (recommendationCount !== expectedRecommendationCount) {
    throw new Error(
      `${label} 首页推荐数量错误：expected=${expectedRecommendationCount} actual=${recommendationCount}`
    );
  }

  const highlightCount = await surface.getByTestId('home-highlight-row').count();
  const expectedHighlightCount = isPhoneViewport ? 3 : 5;
  if (highlightCount !== expectedHighlightCount) {
    throw new Error(
      `${label} 首页高亮数量错误：expected=${expectedHighlightCount} actual=${highlightCount}`
    );
  }

  const calendarDayCount = await surface.getByRole('button', { name: /选择 / }).count();
  if (calendarDayCount !== 7) {
    throw new Error(`${label} 紧凑日历不是 7 天：actual=${calendarDayCount}`);
  }

  if (isPhoneViewport) {
    await expectVisible(page.getByRole('navigation', { name: '手机主导航' }), `${label} 手机底部导航`);
  }
}

async function assertHomeLayoutMeasurements(page, viewport, label) {
  const isPhoneViewport = isPhoneViewportSize(viewport);
  const layout = await page.evaluate((phone) => {
    const root = document.documentElement;
    const surface = document.querySelector(phone ? '.mobile-dashboard-page' : '.dashboard-page');
    const calendar = surface?.querySelector('[data-testid="mobile-home-calendar-days"]') ?? null;
    const calendarButtons = Array.from(calendar?.querySelectorAll('button[aria-label^="选择 "]') ?? []);
    const meta = surface?.querySelector('.mobile-dashboard-meta-row') ?? null;
    const lower = surface?.querySelector('[data-testid="home-lower-grid"]') ?? null;
    const question2 = surface?.querySelector('[data-testid="mobile-home-question"][data-question="2"]') ?? null;
    const question3 = surface?.querySelector('[data-testid="mobile-home-question"][data-question="3"]') ?? null;
    const actionRows = Array.from(surface?.querySelectorAll('.home-action-row') ?? []);
    const highlightRows = Array.from(surface?.querySelectorAll('[data-testid="home-highlight-row"]') ?? []);
    const uniqueXs = (nodes) =>
      [...new Set(nodes.map((node) => Math.round(node.getBoundingClientRect().left)))];
    return {
      rootFits: root.scrollWidth <= root.clientWidth + 1,
      calendarFits: calendar
        ? calendar.scrollWidth <= calendar.clientWidth + 1 &&
          calendarButtons.length === 7 &&
          calendarButtons.every((button) => {
            const calendarRect = calendar.getBoundingClientRect();
            const buttonRect = button.getBoundingClientRect();
            return buttonRect.left >= calendarRect.left - 1 && buttonRect.right <= calendarRect.right + 1;
          })
        : null,
      metaScrollable: meta ? getComputedStyle(meta).overflowX === 'auto' : null,
      lowerColumns: lower ? getComputedStyle(lower).gridTemplateColumns : '',
      questionStack:
        question2 && question3
          ? {
              q2Bottom: Math.round(question2.getBoundingClientRect().bottom),
              q3Top: Math.round(question3.getBoundingClientRect().top),
              overlap:
                question2.getBoundingClientRect().bottom > question3.getBoundingClientRect().top + 1 &&
                question3.getBoundingClientRect().bottom > question2.getBoundingClientRect().top + 1,
            }
          : null,
      actionXs: uniqueXs(actionRows),
      highlightXs: uniqueXs(highlightRows),
    };
  }, isPhoneViewport);

  if (!layout.rootFits) {
    throw new Error(`${label} 首页根页面产生横向溢出`);
  }

  if (isPhoneViewport) {
    if (layout.calendarFits !== true) {
      throw new Error(`${label} 手机七天日历没有完整收进网格`);
    }
    if (layout.metaScrollable !== true) {
      throw new Error(`${label} 手机 Hero meta chips 没有保持受控横滑`);
    }
    if (!layout.questionStack) {
      throw new Error(`${label} 手机问题 2/3 节点缺失`);
    }
    if (layout.questionStack.overlap || layout.questionStack.q3Top < layout.questionStack.q2Bottom) {
      throw new Error(
        `${label} 手机问题 2/3 重叠或顺序错误：q2Bottom=${layout.questionStack.q2Bottom} q3Top=${layout.questionStack.q3Top}`
      );
    }
  } else {
    if (layout.lowerColumns.trim().split(/\s+/).length !== 2) {
      throw new Error(`${label} 桌面问题 2/3 不是两列：${layout.lowerColumns}`);
    }
    if (layout.actionXs.length > 1) {
      throw new Error(`${label} 桌面动作行不是单列：x=${layout.actionXs.join(',')}`);
    }
    if (layout.highlightXs.length > 1) {
      throw new Error(`${label} 桌面高亮行不是单列：x=${layout.highlightXs.join(',')}`);
    }
  }
}

async function expectVisible(locator, label) {
  await locator.waitFor({ state: 'visible', timeout: 10_000 }).catch((error) => {
    throw new Error(`${label} 未渲染：${error instanceof Error ? error.message : String(error)}`);
  });
}

async function expectVisibleText(page, text, label) {
  await page
    .waitForFunction(
      (expectedText) =>
        Array.from(document.querySelectorAll('body *')).some((element) => {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            (element.textContent ?? '').includes(expectedText)
          );
        }),
      text,
      { timeout: 10_000 }
    )
    .catch((error) => {
      throw new Error(`${label} 未渲染：${error instanceof Error ? error.message : String(error)}`);
    });
}

async function expectNoHorizontalOverflow(page, label) {
  const result = await page.evaluate(() => {
    const documentElement = document.documentElement;
    const body = document.body;
    const overflow = Math.max(documentElement.scrollWidth, body.scrollWidth) - documentElement.clientWidth;
    const overflowingElements =
      overflow > 2
        ? Array.from(document.querySelectorAll('body *'))
            .filter((element) => element.getBoundingClientRect().right > documentElement.clientWidth + 2)
            .slice(0, 5)
            .map((element) => ({
              className: element.className,
              right: Math.round(element.getBoundingClientRect().right),
              width: Math.round(element.getBoundingClientRect().width),
            }))
        : [];
    return {
      overflow,
      overflowingElements,
      viewportWidth: window.innerWidth,
      tabletMediaMatches: window.matchMedia('(min-width: 901px) and (max-width: 1280px)').matches,
    };
  });
  if (result.overflow > 2) {
    throw new Error(
      `${label} 出现横向溢出：${result.overflow}px，视口 ${result.viewportWidth}px，平板规则 ${
        result.tabletMediaMatches ? '已启用' : '未启用'
      }\n${JSON.stringify(result.overflowingElements, null, 2)}`
    );
  }
}

async function expectHeaderActionBesideCopy(page, headerSelector, label) {
  const result = await page.evaluate((selector) => {
    const header = document.querySelector(selector);
    const copy = header?.querySelector('.page-header-copy');
    const side = header?.querySelector('.page-header-side');
    const action = side?.querySelector('button');
    if (!header || !copy || !side || !action) {
      return { ok: false, reason: 'missing-element' };
    }
    const copyRect = copy.getBoundingClientRect();
    const actionRect = action.getBoundingClientRect();
    return {
      ok: actionRect.top <= copyRect.top + 18,
      copyTop: Math.round(copyRect.top),
      copyBottom: Math.round(copyRect.bottom),
      actionTop: Math.round(actionRect.top),
      actionText: action.textContent?.trim() ?? '',
    };
  }, headerSelector);

  if (!result.ok) {
    throw new Error(
      `${label} 操作按钮掉到第二行：${result.reason ?? `${result.actionText} top ${result.actionTop}, copy top ${result.copyTop}, copy bottom ${result.copyBottom}`}`
    );
  }
}

async function expectButtonsOnOneLine(page, selector, label) {
  const result = await page.evaluate((targetSelector) => {
    const buttons = Array.from(document.querySelectorAll(targetSelector));
    if (buttons.length === 0) {
      return { ok: false, reason: 'missing-buttons' };
    }
    const tops = buttons.map((button) => Math.round(button.getBoundingClientRect().top));
    const minTop = Math.min(...tops);
    const maxTop = Math.max(...tops);
    return {
      ok: maxTop - minTop <= 2,
      count: buttons.length,
      tops,
      labels: buttons.map((button) => button.textContent?.trim() || button.getAttribute('aria-label') || ''),
    };
  }, selector);

  if (!result.ok) {
    throw new Error(
      `${label} 操作按钮换行：${result.reason ?? `${result.count} 个按钮 top=${result.tops.join(',')} labels=${result.labels.join('/')}`}`
    );
  }
}


async function expectMobileActionBarSafeArea(page, label) {
  const result = await page.evaluate(() => {
    const bar = document.querySelector(
      '.inventory-maintenance-mobile-actions, .ui-mobile-action-bar.inventory-maintenance-mobile-actions, .ui-mobile-action-bar'
    );
    if (!bar) {
      return { ok: false, reason: 'missing-mobile-action-bar' };
    }
    const style = getComputedStyle(bar);
    const display = style.display;
    const paddingBottom = style.paddingBottom;
    return {
      ok: display !== 'none',
      display,
      paddingBottom,
      className: bar.className,
    };
  });

  if (!result.ok) {
    throw new Error(
      `${label} 底部操作栏未显示：display=${result.display ?? 'missing'} reason=${result.reason ?? 'unknown'} paddingBottom=${result.paddingBottom ?? ''}`
    );
  }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function openReconciliationDialog(page, label, { mobile }) {
  await expectVisibleText(page, '家庭厨房工作台', `${label} 工作台标识`);
  await page.getByRole('button', { name: '食材' }).first().click({ noWaitAfter: true });
  await sleep(800);
  if (!mobile) {
    const inventoryTab = page.getByRole('button', { name: '库存' }).first();
    if (await inventoryTab.count()) {
      await inventoryTab.click({ noWaitAfter: true });
      await sleep(400);
    }
  }
  const reconEntry = page.getByRole('button', { name: '快速盘点' }).first();
  await reconEntry.waitFor({ state: 'visible', timeout: 10_000 });
  try {
    await reconEntry.click({ noWaitAfter: true, timeout: 5_000 });
  } catch {
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((el) =>
        (el.textContent || '').includes('快速盘点')
      );
      if (!btn) throw new Error('missing recon button');
      btn.click();
    });
  }
  for (let i = 0; i < 50; i += 1) {
    const ready = await page.evaluate(() => {
      const modal = document.querySelector('.inventory-reconciliation-modal');
      if (!modal) return false;
      if ((modal.textContent || '').includes('正在准备盘点清单')) return false;
      return (
        Boolean(modal.querySelector('[data-group-key="exact_ingredient:ingredient-egg"]')) &&
        Boolean(modal.querySelector('[data-group-key="presence_ingredient:ingredient-salt"]')) &&
        Boolean(modal.querySelector('[data-group-key="food:food-egg"]'))
      );
    });
    if (ready) return;
    if (i === 10) {
      await page.evaluate(() => {
        Array.from(document.querySelectorAll('button'))
          .find((el) => (el.textContent || '').includes('快速盘点'))
          ?.click();
      });
    }
    await sleep(200);
  }
  throw new Error(`${label} 快速盘点 adapters 未就绪`);
}

/**
 * Phase 2 recon smoke gate.
 * Asserts three adapters (exact/presence/food), expired physical batch badge,
 * scope chips, modal overflow, and mobile action bar.
 * Uses noWaitAfter open clicks to avoid Playwright SPA navigation-wait hangs.
 */
async function runInventoryReconciliationSmoke(browser, baseUrl, viewport, label, options = {}) {
  const mobile = Boolean(options.mobile);
  const contextOptions = mobile ? { isMobile: true, hasTouch: true } : {};
  const { context, page, assertClean } = await createPage(browser, viewport, true, contextOptions);
  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await openReconciliationDialog(page, label, { mobile });

    const snapshot = await page.evaluate(() => {
      const modal = document.querySelector('.inventory-reconciliation-modal');
      if (!modal) return { ok: false, reason: 'missing-modal' };
      const keys = Array.from(modal.querySelectorAll('[data-group-key]')).map((el) =>
        el.getAttribute('data-group-key')
      );
      const scopeLabels = Array.from(
        modal.querySelectorAll('[aria-label="盘点范围"] [role="radio"]')
      ).map((el) => (el.textContent || '').trim());
      const bar =
        document.querySelector('.inventory-maintenance-mobile-actions') ||
        document.querySelector('.ui-mobile-action-bar');
      const egg = modal.querySelector('[data-group-key="exact_ingredient:ingredient-egg"]');
      return {
        ok: true,
        overflow: Math.max(0, modal.scrollWidth - modal.clientWidth),
        keys,
        hasExpiredNotice: Boolean(egg && (egg.textContent || '').includes('过期批次待处理')),
        hasExactActions: Boolean(
          modal.querySelector('[data-field-key="exact_ingredient:ingredient-egg:confirm_all"]') &&
            modal.querySelector('[data-field-key="exact_ingredient:ingredient-egg:correct_total"]')
        ),
        hasPresenceLow: Array.from(
          modal.querySelectorAll('[aria-label="盐 有无状态"] [role="radio"]')
        ).some((el) => (el.textContent || '').includes('少量')),
        hasFoodConfirm: Boolean(modal.querySelector('[data-field-key="food:food-egg:confirm"]')),
        scopeLabels,
        mobileBarVisible: Boolean(bar && getComputedStyle(bar).display !== 'none'),
      };
    });

    if (!snapshot.ok) throw new Error(`${label} 快速盘点快照失败：${snapshot.reason}`);
    if (snapshot.overflow > 8) {
      throw new Error(`${label} 快速盘点弹窗横向溢出：${snapshot.overflow}px`);
    }
    for (const key of [
      'exact_ingredient:ingredient-egg',
      'presence_ingredient:ingredient-salt',
      'food:food-egg',
    ]) {
      if (!snapshot.keys.includes(key)) {
        throw new Error(`${label} 缺少 adapter ${key}; got ${snapshot.keys.join(',')}`);
      }
    }
    if (!snapshot.hasExpiredNotice) throw new Error(`${label} 过期批次处理提示未出现`);
    if (!snapshot.hasExactActions || !snapshot.hasPresenceLow || !snapshot.hasFoodConfirm) {
      throw new Error(
        `${label} 盘点动作控件不完整：exact=${snapshot.hasExactActions} presence=${snapshot.hasPresenceLow} food=${snapshot.hasFoodConfirm}`
      );
    }
    for (const scope of ['建议确认', '冷藏', '冷冻', '常温', '全部']) {
      if (!snapshot.scopeLabels.some((entry) => entry.includes(scope))) {
        throw new Error(`${label} 缺少盘点范围芯片：${scope}`);
      }
    }
    if (mobile && !snapshot.mobileBarVisible) {
      throw new Error(`${label} 底部操作栏未显示`);
    }

    await page.evaluate(() => {
      document.querySelector('[aria-label="关闭快速盘点"]')?.click();
    });
    await sleep(400);
    assertClean();
  } finally {
    try {
      await Promise.race([
        context.close(),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    } catch {
      // ignore close races
    }
  }
}

async function runLoginSmoke(browser, baseUrl) {
  const { context, page, assertClean } = await createPage(browser, { width: 1280, height: 900 }, false);
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await expectVisible(page.getByRole('heading', { name: '登录家庭厨房' }), '登录页标题');
  await expectVisible(page.getByRole('button', { name: '进入家庭厨房' }), '登录按钮');
  await expectNoHorizontalOverflow(page, '登录页');
  assertClean();
  await context.close();
}

async function runDesktopSmoke(browser, baseUrl) {
  const requestedApiPaths = [];
  const { context, page, assertClean } = await createPage(
    browser,
    { width: 1440, height: 960 },
    true,
    {},
    { requestedApiPaths }
  );
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await expectVisibleText(page, '家庭厨房工作台', '桌面首页工作台标识');
  await expectVisible(page.getByRole('heading', { name: '首页' }), '桌面首页标题');
  await assertHomeThreeQuestions(page, { width: 1440, height: 960 }, '1440x960');
  await assertHomeLayoutMeasurements(page, { width: 1440, height: 960 }, '1440x960');
  await expectNoHorizontalOverflow(page, '桌面首页');

  if (requestedApiPaths.includes('/api/activity-logs')) {
    throw new Error('首页错误请求了完整 /api/activity-logs');
  }
  if (!requestedApiPaths.includes('/api/activity-highlights')) {
    throw new Error('首页未请求 /api/activity-highlights');
  }

  // desktop: 首页 → 推荐 Food → 吃什么/Food detail
  await page.locator('.dashboard-food-card').first().click();
  await expectVisible(page.locator('.food-detail-drawer'), '桌面首页推荐 Food 详情');
  await page.getByLabel('关闭弹窗').last().click();
  await page.locator('.food-detail-drawer').waitFor({ state: 'detached', timeout: 10_000 });

  await page.getByRole('button', { name: '吃什么' }).first().click();
  await expectVisible(page.locator('.food-workspace .page-header h2'), '吃什么页头');
  await expectVisibleText(page, '食物库', '发现工作台食物库');

  await page.getByRole('button', { name: '食材' }).first().click();
  await expectVisibleText(page, '管理家庭食材档案、库存状态以及采购清单。', '食材工作台');

  await page.getByRole('button', { name: '吃什么' }).first().click();
  await page.locator('.food-workspace .hero-actions').getByRole('button', { name: '吃过的' }).click();
  await expectVisibleText(page, '吃过的', '吃什么/吃过的');
  await expectVisibleText(page, '家庭时间线', '吃什么/吃过的时间线');
  await page.locator('.meal-log-header-actions').getByRole('button', { name: '记一餐' }).click();
  const mealComposer = page.locator('.meal-composer-modal');
  await expectVisible(mealComposer, '桌面记一餐弹窗');
  await expectVisible(mealComposer.getByRole('heading', { name: '确认时间' }), '桌面记一餐第一步');
  await expectVisible(mealComposer.getByRole('heading', { name: '添加食物' }), '桌面记一餐第二步');
  await page.waitForTimeout(320);
  const mealComposerGeometry = await mealComposer.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const footer = element.querySelector('.workspace-overlay-footer')?.getBoundingClientRect();
    return {
      width: Math.round(rect.width),
      bottom: Math.round(rect.bottom),
      footerBottom: footer ? Math.round(footer.bottom) : null,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  });
  if (
    mealComposerGeometry.width > 681
    || mealComposerGeometry.bottom > mealComposerGeometry.viewportHeight + 1
    || mealComposerGeometry.footerBottom == null
    || mealComposerGeometry.footerBottom > mealComposerGeometry.viewportHeight + 1
  ) {
    throw new Error(`桌面记一餐弹窗几何异常：${JSON.stringify(mealComposerGeometry)}`);
  }
  const desktopFoodSearch = mealComposer.getByRole('searchbox', { name: '搜索食物' });
  await desktopFoodSearch.fill('番茄');
  const desktopFoodMenu = mealComposer.getByRole('listbox', { name: '食物搜索结果' });
  await expectVisible(desktopFoodMenu, '桌面食物搜索下拉框');
  const desktopFoodMenuStyle = await desktopFoodMenu.evaluate((element) => {
    const option = element.querySelector('[role="option"]');
    const optionStyle = option ? getComputedStyle(option) : null;
    return {
      usesDefaultMenu: element.classList.contains('ui-combobox-menu'),
      optionBorderTopWidth: optionStyle?.borderTopWidth ?? null,
    };
  });
  if (!desktopFoodMenuStyle.usesDefaultMenu || desktopFoodMenuStyle.optionBorderTopWidth !== '0px') {
    throw new Error(`桌面食物搜索未使用默认下拉样式：${JSON.stringify(desktopFoodMenuStyle)}`);
  }
  const screenshotDir = process.env.CULINA_SMOKE_SCREENSHOT_DIR;
  if (screenshotDir) {
    mkdirSync(screenshotDir, { recursive: true });
    await page.screenshot({ path: resolve(screenshotDir, 'meal-composer-food-menu-1440x960.png') });
    await desktopFoodSearch.clear();
    await page.screenshot({ path: resolve(screenshotDir, 'meal-composer-1440x960.png') });
  }
  await mealComposer.getByLabel('关闭弹窗').click();
  await mealComposer.waitFor({ state: 'detached', timeout: 10_000 });
  await expectNoHorizontalOverflow(page, '桌面工作台切换');
  assertClean();
  await context.close();
}

async function runResponsiveSmoke(browser, baseUrl, viewport, label, contextOptions = {}) {
  const requestedApiPaths = [];
  const { context, page, assertClean } = await createPage(
    browser,
    viewport,
    true,
    contextOptions,
    { requestedApiPaths }
  );
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await expectVisibleText(page, '家庭厨房工作台', `${label} 工作台标识`);
  await assertHomeThreeQuestions(page, viewport, label);
  await assertHomeLayoutMeasurements(page, viewport, label);
  await expectNoHorizontalOverflow(page, label);
  if (requestedApiPaths.includes('/api/activity-logs')) {
    throw new Error(`${label} 首页错误请求了完整 /api/activity-logs`);
  }
  await page.getByRole('button', { name: '食材' }).first().click();
  await expectVisibleText(page, '食材', `${label} 食材入口`);
  await expectNoHorizontalOverflow(page, `${label} 食材页`);
  assertClean();
  await context.close();
}

async function runOrientationLockSmoke(browser, baseUrl, viewport, label, expectedText, contextOptions = {}) {
  const { context, page, assertClean } = await createPage(browser, viewport, true, contextOptions);
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await expectVisibleText(page, expectedText, `${label} 方向提示`);
  await expectNoHorizontalOverflow(page, `${label} 方向提示`);

  const appFrameDisplay = await page.evaluate(() => {
    const appFrame = document.querySelector('.app-frame');
    return appFrame ? getComputedStyle(appFrame).display : 'missing';
  });
  if (appFrameDisplay !== 'none') {
    throw new Error(`${label} 方向不符时仍显示主工作区：${appFrameDisplay}`);
  }

  assertClean();
  await context.close();
}

async function runTouchTabletLandscapeSmoke(browser, baseUrl) {
  const label = '1024x744 touch iPad 横屏';
  const { context, page, assertClean } = await createPage(
    browser,
    { width: 1024, height: 744 },
    true,
    { isMobile: true, hasTouch: true }
  );
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await expectVisible(page.getByRole('heading', { name: '首页' }), `${label} 首页标题`);
  await expectNoHorizontalOverflow(page, label);

  const lockState = await page.evaluate(() => {
    const landscapeLock = document.querySelector('.app-orientation-lock-landscape');
    const portraitLock = document.querySelector('.app-orientation-lock-portrait');
    const appFrame = document.querySelector('.app-frame');
    return {
      landscapeDisplay: landscapeLock ? getComputedStyle(landscapeLock).display : 'missing',
      portraitDisplay: portraitLock ? getComputedStyle(portraitLock).display : 'missing',
      appFrameDisplay: appFrame ? getComputedStyle(appFrame).display : 'missing',
    };
  });
  if (
    lockState.landscapeDisplay !== 'none' ||
    lockState.portraitDisplay !== 'none' ||
    lockState.appFrameDisplay === 'none'
  ) {
    throw new Error(
      `${label} 不应显示方向提示：landscape=${lockState.landscapeDisplay} portrait=${lockState.portraitDisplay} appFrame=${lockState.appFrameDisplay}`
    );
  }

  await page.getByRole('button', { name: '吃什么' }).first().click();
  await expectVisible(page.locator('.food-tablet-support-surface'), `${label} Pad 辅助区`);
  await expectNoHorizontalOverflow(page, `${label} 食物页`);
  const foodTabletLayout = await page.evaluate(() => {
    const sidebar = document.querySelector('.food-task-sidebar');
    const surface = document.querySelector('.food-tablet-support-surface');
    const sceneScroller = document.querySelector('.food-tablet-scene-scroller');
    return {
      sidebarDisplay: sidebar ? getComputedStyle(sidebar).display : 'missing',
      surfaceDisplay: surface ? getComputedStyle(surface).display : 'missing',
      metricCount: document.querySelectorAll('.food-tablet-management-metric').length,
      dateCount: document.querySelectorAll('.food-tablet-plan-date-rail > button').length,
      sceneCount: document.querySelectorAll('.food-tablet-scene-scroller > button').length,
      sceneScrollable: sceneScroller ? sceneScroller.scrollWidth > sceneScroller.clientWidth : false,
    };
  });
  if (
    foodTabletLayout.sidebarDisplay !== 'none' ||
    foodTabletLayout.surfaceDisplay !== 'grid' ||
    foodTabletLayout.metricCount !== 4 ||
    foodTabletLayout.dateCount !== 7 ||
    (foodTabletLayout.sceneCount > 3 && !foodTabletLayout.sceneScrollable)
  ) {
    throw new Error(`${label} 食物 Pad 辅助区异常：${JSON.stringify(foodTabletLayout)}`);
  }

  assertClean();
  await context.close();
}

async function runTabletLandscapeSmoke(browser, baseUrl) {
  const { context, page, assertClean } = await createPage(browser, { width: 1112, height: 834 });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await expectVisible(page.getByRole('heading', { name: '首页' }), '1112x834 首页标题');
  await assertHomeThreeQuestions(page, { width: 1112, height: 834 }, '1112x834');
  await assertHomeLayoutMeasurements(page, { width: 1112, height: 834 }, '1112x834');
  await expectNoHorizontalOverflow(page, '1112x834 首页');
  await expectHeaderActionBesideCopy(page, '.dashboard-page .page-header', '1112x834 首页头部');
  const legacyDetailButtonCount = await page.locator('.dashboard-food-card .dashboard-icon-button[aria-label="查看详情"]').count();
  if (legacyDetailButtonCount !== 0) {
    throw new Error(`1112x834 首页推荐卡仍显示详情按钮：${legacyDetailButtonCount} 个`);
  }
  await page.locator('.dashboard-food-card').first().click();
  await expectVisible(page.locator('.food-detail-drawer'), '1112x834 首页推荐卡详情抽屉');
  await page.getByLabel('关闭弹窗').last().click();
  await page.locator('.food-detail-drawer').waitFor({ state: 'detached', timeout: 10_000 });

  const layout = await page.evaluate(() => {
    const statGrid = document.querySelector('.dashboard-stat-grid');
    const foodRow = document.querySelector('.dashboard-food-row');
    return {
      statColumns: statGrid ? getComputedStyle(statGrid).gridTemplateColumns.split(' ').length : 0,
      foodColumns: foodRow ? getComputedStyle(foodRow).gridTemplateColumns.split(' ').length : 0,
    };
  });

  if (layout.statColumns !== 4 || layout.foodColumns !== 3) {
    throw new Error(
      `1112x834 首页布局提前降级：统计区 ${layout.statColumns} 列，推荐区 ${layout.foodColumns} 列`
    );
  }

  await page.getByRole('button', { name: '吃什么' }).first().click();
  await expectVisible(page.locator('.food-tablet-support-surface'), '1112x834 食物 Pad 辅助区');
  await expectNoHorizontalOverflow(page, '1112x834 食物页');
  const foodTabletLayout = await page.evaluate(() => ({
    sidebarDisplay: (() => {
      const sidebar = document.querySelector('.food-task-sidebar');
      return sidebar ? getComputedStyle(sidebar).display : 'missing';
    })(),
    surfaceDisplay: (() => {
      const surface = document.querySelector('.food-tablet-support-surface');
      return surface ? getComputedStyle(surface).display : 'missing';
    })(),
    metricCount: document.querySelectorAll('.food-tablet-management-metric').length,
    dateCount: document.querySelectorAll('.food-tablet-plan-date-rail > button').length,
  }));
  if (
    foodTabletLayout.sidebarDisplay !== 'none' ||
    foodTabletLayout.surfaceDisplay !== 'grid' ||
    foodTabletLayout.metricCount !== 4 ||
    foodTabletLayout.dateCount !== 7
  ) {
    throw new Error(`1112x834 食物 Pad 辅助区异常：${JSON.stringify(foodTabletLayout)}`);
  }

  await page.getByRole('button', { name: '家庭' }).first().click();
  await expectVisible(page.getByRole('heading', { name: '我的家庭' }), '1112x834 家庭页标题');
  await expectNoHorizontalOverflow(page, '1112x834 家庭页');
  await expectButtonsOnOneLine(page, '.family-hero-actions > button', '1112x834 家庭页头部');

  assertClean();
  await context.close();
}

async function runTabletAirWorkspaceSmoke(browser, baseUrl) {
  const { context, page, assertClean } = await createPage(browser, { width: 1180, height: 820 });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await expectVisible(page.getByRole('heading', { name: '首页' }), '1180x820 首页标题');
  await expectVisible(page.getByTestId('home-lower-grid'), '1180x820 首页摘要区');
  await assertHomeThreeQuestions(page, { width: 1180, height: 820 }, '1180x820');
  await assertHomeLayoutMeasurements(page, { width: 1180, height: 820 }, '1180x820');
  await expectNoHorizontalOverflow(page, '1180x820 首页');
  await expectVisibleText(page, '今天必须处理什么', '1180x820 今天必须处理什么');
  const homeCompactLayout = await page.evaluate(() => {
    const surface = document.querySelector('.dashboard-page');
    const styles = (selector) => {
      const element = surface?.querySelector(selector) ?? document.querySelector(selector);
      return element ? getComputedStyle(element) : null;
    };
    const columnCount = (selector) => styles(selector)?.gridTemplateColumns.split(/\s+/).filter(Boolean).length ?? 0;
    const columnWidths = (selector) =>
      styles(selector)?.gridTemplateColumns.split(/\s+/).map((value) => Number.parseFloat(value)).filter(Number.isFinite) ?? [];
    const actionItems = Array.from(surface?.querySelectorAll('.home-action-row') ?? []);
    const highlightItems = Array.from(surface?.querySelectorAll('[data-testid="home-highlight-row"]') ?? []);
    return {
      lowerColumns: columnCount('[data-testid="home-lower-grid"]'),
      lowerColumnWidths: columnWidths('[data-testid="home-lower-grid"]'),
      actionColumns: columnCount('.home-action-list'),
      activityColumns: columnCount('.home-highlight-list'),
      actionItemOverflow: actionItems.map((item) => item.scrollWidth - item.clientWidth),
      actionGroupCount: actionItems.length,
      tomatoGroupCount: actionItems.filter((item) => (item.textContent ?? '').includes('番茄')).length,
      highlightCount: highlightItems.length,
    };
  });
  if (
    homeCompactLayout.lowerColumns !== 2 ||
    homeCompactLayout.actionColumns !== 1 ||
    homeCompactLayout.activityColumns !== 1 ||
    homeCompactLayout.lowerColumnWidths.length !== 2 ||
    homeCompactLayout.actionItemOverflow.some((overflow) => overflow > 1) ||
    homeCompactLayout.actionGroupCount < 1 ||
    homeCompactLayout.tomatoGroupCount !== 1 ||
    homeCompactLayout.highlightCount !== 5
  ) {
    throw new Error(
      `1180x820 首页摘要布局异常：主区 ${homeCompactLayout.lowerColumns} 列/${homeCompactLayout.lowerColumnWidths.join(',')}，动作 ${homeCompactLayout.actionColumns} 列，动作溢出 ${homeCompactLayout.actionItemOverflow.join(',')}，番茄组 ${homeCompactLayout.tomatoGroupCount}，高亮 ${homeCompactLayout.highlightCount}`
    );
  }

  await page.getByRole('button', { name: '吃什么' }).first().click();
  await expectVisible(page.locator('.food-workspace .page-header h2'), '1180x820 吃什么页头');
  await expectVisibleText(page, '食物库', '1180x820 食物页');
  await expectNoHorizontalOverflow(page, '1180x820 食物页');
  const foodLayout = await page.evaluate(() => {
    const longTitle = document.querySelector('.food-work-card .food-card-title-row h3');
    if (longTitle) longTitle.textContent = '秋葵凉拌菜自动测0710smoke超长标题';
    const columnCount = (selector) => {
      const element = document.querySelector(selector);
      return element ? getComputedStyle(element).gridTemplateColumns.split(' ').length : 0;
    };
    const cardMeasurements = Array.from(document.querySelectorAll('.food-work-card')).map((card) => {
      const cardBounds = card.getBoundingClientRect();
      const titleSlotBounds = card.querySelector('.food-card-title-row > div')?.getBoundingClientRect();
      const actionBounds = Array.from(card.querySelectorAll('.food-card-actions > *')).map((action) =>
        action.getBoundingClientRect()
      );
      const badgeRows = Array.from(
        card.querySelectorAll('.food-card-status-row, .food-card-issue-row')
      ).map((row) => {
        const bounds = row.getBoundingClientRect();
        const styles = getComputedStyle(row);
        return {
          rightOverflow: bounds.right - cardBounds.right,
          flexWrap: styles.flexWrap,
          overflowX: styles.overflowX,
        };
      });
      return {
        contentOverflow: card.scrollWidth - card.clientWidth,
        titleRightOverflow: titleSlotBounds ? titleSlotBounds.right - cardBounds.right : 0,
        actionRightOverflow: actionBounds.length > 0
          ? Math.max(...actionBounds.map((bounds) => bounds.right - cardBounds.right))
          : 0,
        badgeRows,
      };
    });
    return {
      contentColumns: columnCount('.food-content-layout'),
      recommendationColumns: columnCount('.food-recommendation-grid'),
      cardColumns: columnCount('.food-card-page'),
      cardPageSizes: Array.from(document.querySelectorAll('.food-card-page')).map(
        (page) => page.querySelectorAll('.food-work-card').length
      ),
      cardPageRowCounts: Array.from(document.querySelectorAll('.food-card-page')).map(
        (page) => new Set(
          Array.from(page.querySelectorAll('.food-work-card')).map(
            (card) => Math.round(card.getBoundingClientRect().top)
          )
        ).size
      ),
      cardScrollerOverflowX: (() => {
        const scroller = document.querySelector('.food-card-grid');
        return scroller ? getComputedStyle(scroller).overflowX : 'missing';
      })(),
      cardScrollerSnapType: (() => {
        const scroller = document.querySelector('.food-card-grid');
        return scroller ? getComputedStyle(scroller).scrollSnapType : 'missing';
      })(),
      loadMoreDisplay: (() => {
        const button = document.querySelector('.food-card-library > .paged-list-status .paged-list-load-more');
        return button ? getComputedStyle(button).display : 'missing';
      })(),
      desktopSidebarDisplay: (() => {
        const sidebar = document.querySelector('.food-task-sidebar');
        return sidebar ? getComputedStyle(sidebar).display : 'missing';
      })(),
      tabletSurfaceDisplay: (() => {
        const surface = document.querySelector('.food-tablet-support-surface');
        return surface ? getComputedStyle(surface).display : 'missing';
      })(),
      managementMetricCount: document.querySelectorAll('.food-tablet-management-metric').length,
      tabletDateCount: document.querySelectorAll('.food-tablet-plan-date-rail > button').length,
      tabletMealColumns: columnCount('.food-tablet-plan-day-summary'),
      sceneCount: document.querySelectorAll('.food-tablet-scene-scroller > button').length,
      sceneScroller: (() => {
        const scroller = document.querySelector('.food-tablet-scene-scroller');
        if (!scroller) return null;
        const fourthCard = scroller.children[3];
        const scrollerBounds = scroller.getBoundingClientRect();
        const fourthCardBounds = fourthCard?.getBoundingClientRect();
        return {
          overflowX: getComputedStyle(scroller).overflowX,
          snapType: getComputedStyle(scroller).scrollSnapType,
          scrollable: scroller.scrollWidth > scroller.clientWidth,
          fourthCardPeek: fourthCardBounds ? scrollerBounds.right - fourthCardBounds.left : 0,
        };
      })(),
      cardMeasurements,
    };
  });
  if (
    foodLayout.contentColumns !== 1 ||
    ![0, 3].includes(foodLayout.recommendationColumns) ||
    foodLayout.cardColumns !== 1 ||
    foodLayout.desktopSidebarDisplay !== 'none' ||
    foodLayout.tabletSurfaceDisplay !== 'grid' ||
    foodLayout.managementMetricCount !== 4 ||
    foodLayout.tabletDateCount !== 7 ||
    ![3, 4].includes(foodLayout.tabletMealColumns) ||
    foodLayout.sceneCount < 1 ||
    foodLayout.sceneScroller?.overflowX !== 'auto' ||
    foodLayout.sceneScroller?.snapType !== 'x mandatory' ||
    (foodLayout.sceneCount > 3 && (
      foodLayout.sceneScroller?.scrollable !== true ||
      foodLayout.sceneScroller.fourthCardPeek <= 0 ||
      foodLayout.sceneScroller.fourthCardPeek > 40
    )) ||
    foodLayout.cardPageSizes.length === 0 ||
    foodLayout.cardPageSizes.some((size) => size < 1 || size > 2) ||
    foodLayout.cardPageRowCounts.some((count) => count < 1 || count > 2) ||
    foodLayout.cardScrollerOverflowX !== 'auto' ||
    foodLayout.cardScrollerSnapType !== 'x mandatory' ||
    !['none', 'missing'].includes(foodLayout.loadMoreDisplay) ||
    foodLayout.cardMeasurements.some(
      ({ contentOverflow, titleRightOverflow, actionRightOverflow, badgeRows }) =>
        contentOverflow > 1 ||
        titleRightOverflow > 1 ||
        actionRightOverflow > 1 ||
        badgeRows.some(({ rightOverflow, flexWrap, overflowX }) =>
          rightOverflow > 1 || flexWrap !== 'nowrap' || overflowX !== 'auto'
        )
    )
  ) {
    throw new Error(
      `1180x820 食物页布局异常：主区 ${foodLayout.contentColumns} 列，推荐区 ${foodLayout.recommendationColumns} 列，滑动列 ${foodLayout.cardColumns} 列/${foodLayout.cardPageSizes.join(',')} 张/${foodLayout.cardPageRowCounts.join(',')} 行，横滑 ${foodLayout.cardScrollerOverflowX}/${foodLayout.cardScrollerSnapType}，加载按钮 ${foodLayout.loadMoreDisplay}，旧侧栏 ${foodLayout.desktopSidebarDisplay}，Pad 辅助区 ${foodLayout.tabletSurfaceDisplay}，摘要 ${foodLayout.managementMetricCount} 项，日期 ${foodLayout.tabletDateCount} 天，餐别 ${foodLayout.tabletMealColumns} 列，场景 ${foodLayout.sceneCount} 项/${JSON.stringify(foodLayout.sceneScroller)}，卡片溢出 ${JSON.stringify(foodLayout.cardMeasurements)}`
    );
  }

  await expectNoHorizontalOverflow(page, '1180x820 食物页');

  await page.getByRole('button', { name: '食材' }).first().click();
  await expectVisibleText(page, '管理家庭食材档案、库存状态以及采购清单。', '1180x820 食材页');
  await expectNoHorizontalOverflow(page, '1180x820 食材页');
  const ingredientFilterDisplay = await page.evaluate(() => {
    const element = document.querySelector('.ingredients-catalog-filter-bar');
    return element ? getComputedStyle(element).display : 'missing';
  });
  if (ingredientFilterDisplay !== 'grid') {
    throw new Error(`1180x820 食材筛选区未进入平板布局：${ingredientFilterDisplay}`);
  }
  const ingredientCatalogLayout = await page.evaluate(() => {
    const filterBar = document.querySelector('.ingredients-catalog-filter-bar');
    const sections = filterBar ? Array.from(filterBar.children) : [];
    return {
      columns: filterBar ? getComputedStyle(filterBar).gridTemplateColumns.split(' ').length : 0,
      tops: sections.map((element) => Math.round(element.getBoundingClientRect().top)),
    };
  });
  if (ingredientCatalogLayout.columns !== 1) {
    throw new Error(
      `1180x820 食材档案筛选布局异常：${ingredientCatalogLayout.columns} 列/${ingredientCatalogLayout.tops.join(',')}`
    );
  }

  await page.getByRole('button', { name: '库存' }).first().click();
  await expectVisibleText(page, '位置总览', '1180x820 食材库存页');
  await expectNoHorizontalOverflow(page, '1180x820 食材库存页');
  const inventoryColumns = await page.evaluate(() => {
    const grid = document.querySelector('.ingredients-inventory-grid');
    return grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0;
  });
  if (inventoryColumns !== 3) {
    throw new Error(`1180x820 食材库存卡片未保持三列：${inventoryColumns} 列`);
  }

  await page.getByRole('button', { name: '吃什么' }).first().click();
  const mealInsightsLoaded = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/api/meal-logs/insights'
      && response.ok(),
    { timeout: 10_000 },
  );
  await page.locator('.food-workspace .hero-actions').getByRole('button', { name: '吃过的' }).click();
  await expectVisibleText(page, '吃过的', '1180x820 吃过的');
  await expectVisibleText(page, '家庭时间线', '1180x820 吃过的时间线');
  await expectNoHorizontalOverflow(page, '1180x820 吃过的页');
  await mealInsightsLoaded;
  await page.waitForFunction(
    () => document.querySelectorAll('[data-memory-status="loading"]').length === 0,
    undefined,
    { timeout: 10_000 },
  );
  // Empty insights keep the memory section out of the page; timeline remains first content.
  const mealHistoryLayout = await page.evaluate(() => {
    const memoryCards = document.querySelectorAll('.meal-memory-card');
    const memoryError = document.querySelector('.meal-memory-error');
    const timelineHead = document.querySelector('.meal-log-timeline-head h2');
    return {
      memoryCardCount: memoryCards.length,
      hasMemoryError: Boolean(memoryError),
      timelineVisible: Boolean(timelineHead && getComputedStyle(timelineHead).display !== 'none'),
      timelineText: timelineHead?.textContent?.trim() ?? '',
    };
  });
  if (mealHistoryLayout.memoryCardCount !== 0 || mealHistoryLayout.hasMemoryError) {
    throw new Error(
      `1180x820 空家庭记忆仍渲染了区域：cards=${mealHistoryLayout.memoryCardCount} error=${mealHistoryLayout.hasMemoryError}`,
    );
  }
  if (!mealHistoryLayout.timelineVisible || mealHistoryLayout.timelineText !== '家庭时间线') {
    throw new Error(`1180x820 吃过的时间线不可见：${mealHistoryLayout.timelineText}`);
  }

  await page.evaluate(() => {
    localStorage.setItem('ai_sidebar_collapsed', 'false');
  });
  await page.getByRole('button', { name: 'AI' }).first().click();
  await expectVisibleText(page, 'AI 厨房助手', '1180x820 AI 工作区');
  await expectNoHorizontalOverflow(page, '1180x820 AI 工作区');
  const aiLayout = await page.evaluate(() => {
    const shell = document.querySelector('.ai-workspace-shell');
    const sidePanel = document.querySelector('.ai-side-panel');
    const trigger = document.querySelector('.ai-sidebar-trigger-btn');
    return {
      collapsed: shell?.classList.contains('is-collapsed') ?? false,
      sideWidth: sidePanel ? Math.round(sidePanel.getBoundingClientRect().width) : Number.POSITIVE_INFINITY,
      hasTrigger: Boolean(trigger),
    };
  });
  if (!aiLayout.collapsed || aiLayout.sideWidth > 1 || !aiLayout.hasTrigger) {
    throw new Error(
      `1180x820 AI 历史栏未默认折叠：collapsed=${aiLayout.collapsed} sideWidth=${aiLayout.sideWidth} trigger=${aiLayout.hasTrigger}`
    );
  }

  assertClean();
  await context.close();
}

async function runHomeActionCenterSmoke(browser, baseUrl) {
  const { context, page, assertClean } = await createPage(browser, { width: 1440, height: 960 });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await expectVisibleText(page, '今天必须处理什么', '桌面今天必须处理什么');
  const actionSummary = await page.evaluate(() => {
    const surface = document.querySelector('.dashboard-page');
    const items = Array.from(surface?.querySelectorAll('.home-action-row') ?? []);
    return {
      count: items.length,
      tomatoCount: items.filter((item) => (item.textContent ?? '').includes('番茄')).length,
      hasLegacyExpiry: Boolean(document.querySelector('.dashboard-expiry-panel')),
      hasLegacyTodo: Boolean(document.querySelector('.dashboard-todo-panel')),
    };
  });
  if (actionSummary.hasLegacyExpiry || actionSummary.hasLegacyTodo) {
    throw new Error('桌面首页仍渲染旧的临期/待办面板');
  }
  if (actionSummary.count < 2 || actionSummary.tomatoCount !== 1) {
    throw new Error(
      `桌面今天必须处理分组异常：count=${actionSummary.count} tomato=${actionSummary.tomatoCount}`
    );
  }

  const primary = page
    .locator('.dashboard-page .home-action-row')
    .filter({ hasText: '番茄' })
    .locator('[data-testid="home-action-primary"]');
  await primary.click();
  const inventoryActionDialog = page.locator(
    '.home-dashboard-overlay-root [aria-labelledby="inventory-action-dialog-title"]'
  );
  await expectVisible(inventoryActionDialog, '库存处理弹窗');
  await expectVisibleText(page, '已过期批次', '库存处理弹窗批次分区');
  await page.getByLabel('关闭').last().click();
  await inventoryActionDialog.waitFor({ state: 'detached', timeout: 10_000 });
  assertClean();
  await context.close();
}

async function runInventoryActionViewportSmoke(browser, baseUrl, viewport, label, contextOptions = {}) {
  const { context, page, assertClean } = await createPage(browser, viewport, true, contextOptions);
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

  const surfaceSelector = isPhoneViewportSize(viewport) ? '.mobile-dashboard-page' : '.dashboard-page';
  const primary = page
    .locator(`${surfaceSelector} .home-action-row`)
    .filter({ hasText: '番茄' })
    .locator('[data-testid="home-action-primary"]');
  await primary.click();
  const inventoryActionDialog = page.locator(
    '.home-dashboard-overlay-root [aria-labelledby="inventory-action-dialog-title"]'
  );
  await expectVisible(inventoryActionDialog, `${label} 库存处理弹窗`);
  await page.waitForTimeout(320);

  const geometry = await page.evaluate(() => {
    const modal = document.querySelector(
      '.home-dashboard-overlay-root [aria-labelledby="inventory-action-dialog-title"]'
    );
    const body = modal?.querySelector('.workspace-overlay-body');
    const footer = modal?.querySelector('.workspace-overlay-footer');
    const primaryButton = footer?.querySelector('button:not([disabled])');
    if (!modal || !body || !footer || !primaryButton) {
      return { ok: false, reason: 'missing-element' };
    }
    const modalRect = modal.getBoundingClientRect();
    const bodyStyle = getComputedStyle(body);
    const footerRect = footer.getBoundingClientRect();
    const primaryRect = primaryButton.getBoundingClientRect();
    return {
      ok:
        modalRect.bottom <= window.innerHeight + 1 &&
        footerRect.bottom <= window.innerHeight + 1 &&
        primaryRect.bottom <= window.innerHeight + 1 &&
        primaryRect.top >= footerRect.top - 1 &&
        ['auto', 'scroll'].includes(bodyStyle.overflowY),
      modalBottom: Math.round(modalRect.bottom),
      footerBottom: Math.round(footerRect.bottom),
      primaryTop: Math.round(primaryRect.top),
      primaryBottom: Math.round(primaryRect.bottom),
      viewportHeight: window.innerHeight,
      bodyOverflowY: bodyStyle.overflowY,
    };
  });
  if (!geometry.ok) {
    throw new Error(`${label} 库存处理弹窗底部操作区不可用：${JSON.stringify(geometry)}`);
  }

  const screenshotDir = process.env.CULINA_SMOKE_SCREENSHOT_DIR;
  if (screenshotDir) {
    mkdirSync(screenshotDir, { recursive: true });
    await page.screenshot({ path: resolve(screenshotDir, `inventory-action-${viewport.width}x${viewport.height}.png`) });
  }

  await page.getByLabel('关闭').last().click();
  await inventoryActionDialog.waitFor({ state: 'detached', timeout: 10_000 });
  assertClean();
  await context.close();
}

async function runHomeHighlightLoadingSmoke(browser, baseUrl) {
  const routeController = createRouteController();
  routeController.routeMode.highlights = 'delay';
  const { context, page, assertClean } = await createPage(
    browser,
    { width: 1440, height: 960 },
    true,
    {},
    { routeController }
  );
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  const desktop = page.locator('.dashboard-page');
  await expectVisible(desktop.getByLabel('家庭动态加载中'), '高亮骨架');
  await expectVisible(desktop.getByRole('heading', { name: '今天吃什么' }), '延迟高亮时问题 1 仍可见');
  await expectVisible(desktop.getByRole('heading', { name: '今天必须处理什么' }), '延迟高亮时问题 2 仍可见');
  await expectVisible(desktop.getByRole('button', { name: /选择 / }).first(), '延迟高亮时日历仍可见');
  routeController.highlightDelay.resolve();
  await expectVisible(desktop.getByTestId('home-highlight-row').first(), '延迟后高亮行');
  assertClean();
  await context.close();
}

async function runHomeHighlightErrorSmoke(browser, baseUrl) {
  const routeController = createRouteController();
  routeController.routeMode.highlights = 'error';
  const { context, page, assertClean } = await createPage(
    browser,
    { width: 1440, height: 960 },
    true,
    {},
    { routeController }
  );
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  const desktop = page.locator('.dashboard-page');
  await expectVisibleText(page, '家庭动态暂时加载失败', '高亮初始失败文案');
  await expectVisible(desktop.getByRole('button', { name: '重试家庭动态' }), '高亮重试按钮');
  await expectVisible(desktop.getByRole('heading', { name: '今天吃什么' }), '失败时问题 1 仍可见');
  assertClean();
  await context.close();
}

async function runHomeHighlightStaleCacheSmoke(browser, baseUrl) {
  const routeController = createRouteController();
  const { context, page, assertClean } = await createPage(
    browser,
    { width: 1440, height: 960 },
    true,
    {},
    { routeController }
  );
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  const desktop = page.locator('.dashboard-page');
  await expectVisible(desktop.getByTestId('home-highlight-row').first(), '缓存前高亮行');
  const initialCount = await desktop.getByTestId('home-highlight-row').count();
  if (initialCount !== 5) {
    throw new Error(`缓存场景高亮数量错误：actual=${initialCount}`);
  }

  routeController.routeMode.highlights = 'error';
  const failedRefetch = page.waitForResponse(
    (response) =>
      response.url().includes('/api/activity-highlights') && response.status() === 500,
    { timeout: 10_000 }
  );
  // Leave Home (disables the query) then return so React Query refetches stale cache.
  await page.getByRole('button', { name: '吃什么' }).first().click();
  await expectVisible(page.locator('.food-workspace .page-header h2'), 'stale 场景离开首页');
  await page.getByRole('button', { name: '首页' }).first().click();
  await failedRefetch;
  await expectVisible(desktop.getByTestId('home-highlight-row').first(), 'stale 场景返回首页');
  await expectVisible(desktop.getByRole('button', { name: '刷新失败，重试' }), '高亮 stale 刷新失败');
  const retainedCount = await desktop.getByTestId('home-highlight-row').count();
  if (retainedCount !== 5) {
    throw new Error(`stale 缓存未保留高亮行：actual=${retainedCount}`);
  }
  assertClean();
  await context.close();
}

async function runHomeFamilyActivityNavigationSmoke(browser, baseUrl, viewport, label, contextOptions = {}) {
  const isPhoneViewport = isPhoneViewportSize(viewport);
  const routeController = createRouteController();
  routeController.routeMode.activityLogs = 'delay';
  const { context, page, assertClean } = await createPage(
    browser,
    viewport,
    true,
    contextOptions,
    { routeController }
  );
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await assertHomeThreeQuestions(page, viewport, label);
  await homeSurfaceLocator(page, viewport).getByRole('button', { name: '查看完整记录' }).click();

  if (isPhoneViewport) {
    await expectVisible(page.getByLabel('手机家庭活动页'), `${label} 手机家庭活动页`);
    await expectVisible(
      page.locator('.family-activity-viewer-skeleton, .family-activity-mobile-page [aria-label="家庭活动加载中"]').first(),
      `${label} 活动加载中`
    );
  } else {
    await expectVisible(page.locator('.family-activity-viewer-modal'), `${label} 家庭活动弹窗`);
    await expectVisible(
      page.locator('.family-activity-viewer-modal .family-activity-viewer-skeleton'),
      `${label} 活动加载中`
    );
  }

  const emptyCount = await page
    .locator('.family-activity-viewer-modal, .family-activity-mobile-page')
    .getByText('暂无家庭活动')
    .count();
  if (emptyCount !== 0) {
    throw new Error(`${label} 活动延迟时出现了瞬时空状态`);
  }

  routeController.activityLogDelay.resolve();
  if (isPhoneViewport) {
    await expectVisibleText(page, '完成 5 项采购入库', `${label} 活动记录内容`);
  } else {
    await expectVisible(
      page.locator('.family-activity-viewer-modal').getByText('完成 5 项采购入库'),
      `${label} 活动记录内容`
    );
  }
  assertClean();
  await context.close();
}

async function runHomeFullWeekNavigationSmoke(browser, baseUrl, viewport, label, contextOptions = {}) {
  const isPhoneViewport = isPhoneViewportSize(viewport);
  const { context, page, assertClean } = await createPage(browser, viewport, true, contextOptions);
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  const homeSurface = homeSurfaceLocator(page, viewport);
  if (isPhoneViewport) {
    await homeSurface.getByRole('button', { name: '展开当天安排', exact: true }).click();
  }
  await homeSurface.getByRole('button', { name: '完整周菜单', exact: true }).click();

  if (isPhoneViewport) {
    await expectVisible(page.getByLabel('手机周菜单', { exact: true }), `${label} 周菜单`);
  } else {
    // Desktop focuses the compact menu plan inside the discovery workspace.
    await expectVisible(page.getByTestId('food-plan-week-section'), `${label} 周菜单`);
    const focused = await page.evaluate(() => {
      const week = document.querySelector('[data-testid="food-plan-week-section"]');
      if (!week) return false;
      const rect = week.getBoundingClientRect();
      return rect.top < window.innerHeight && rect.bottom > 0;
    });
    if (!focused) {
      throw new Error(`${label} 桌面周菜单未进入视口`);
    }
  }

  const detailOpen = await page.locator('.food-plan-detail-modal, .recipe-plan-detail-modal').count();
  if (detailOpen !== 0) {
    throw new Error(`${label} 打开完整周菜单时不应打开计划详情`);
  }
  assertClean();
  await context.close();
}

async function runHomeMealEvaluationSmoke(browser, baseUrl, viewport, label, contextOptions = {}) {
  const isPhoneViewport = isPhoneViewportSize(viewport);
  const isTabletViewport = viewport.width >= 768 && viewport.width <= 1180;
  const screenshotDir = process.env.CULINA_SMOKE_SCREENSHOT_DIR;
  const { context, page, assertClean } = await createPage(
    browser,
    viewport,
    true,
    contextOptions,
  );
  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    const homeSurface = homeSurfaceLocator(page, viewport);
    if (isPhoneViewport) {
      await homeSurface.getByRole('button', { name: '展开当天安排', exact: true }).click();
      await page.waitForTimeout(220);
      const mealRowGeometry = await homeSurface.locator('.home-compact-meal-slot.has-items').first().evaluate((element) => {
        const row = element.getBoundingClientRect();
        const items = element.querySelector('.home-compact-meal-items')?.getBoundingClientRect();
        const foods = Array.from(element.querySelectorAll('.home-compact-meal-foods > .home-compact-meal-item'))
          .map((child) => child.getBoundingClientRect());
        const actions = element.querySelector('.home-compact-meal-actions')?.getBoundingClientRect();
        const emptyRow = element.parentElement?.querySelector('.home-compact-meal-slot:not(.has-items)');
        const emptyRowRect = emptyRow?.getBoundingClientRect();
        const emptyAdd = emptyRow?.querySelector('.home-compact-meal-add')?.getBoundingClientRect();
        return {
          rowWidth: Math.round(row.width),
          rowHeight: Math.round(row.height),
          itemsWidth: items ? Math.round(items.width) : 0,
          foodCount: foods.length,
          foodWidths: foods.map((food) => Math.round(food.width)),
          foodsVisible: foods.every((food) => food.width > 0 && food.left >= row.left - 1 && food.right <= row.right + 1),
          actionsInside: Boolean(actions) && actions.left >= row.left - 1 && actions.right <= row.right + 1,
          emptyRowHeight: emptyRowRect ? Math.round(emptyRowRect.height) : null,
          emptyAddHeight: emptyAdd ? Math.round(emptyAdd.height) : null,
        };
      });
      if (
        mealRowGeometry.itemsWidth < mealRowGeometry.rowWidth - 20
        || mealRowGeometry.foodCount !== 2
        || mealRowGeometry.foodWidths.some((width) => width < 48)
        || !mealRowGeometry.foodsVisible
        || !mealRowGeometry.actionsInside
        || mealRowGeometry.emptyRowHeight == null
        || mealRowGeometry.emptyRowHeight > mealRowGeometry.rowHeight - 12
        || mealRowGeometry.emptyAddHeight == null
        || mealRowGeometry.emptyAddHeight < 44
      ) {
        throw new Error(`${label} 手机餐次行布局异常：${JSON.stringify(mealRowGeometry)}`);
      }
      await expectNoHorizontalOverflow(page, `${label} 手机餐次安排`);
      if (screenshotDir) {
        mkdirSync(screenshotDir, { recursive: true });
        await page.screenshot({
          path: resolve(screenshotDir, `mobile-home-plan-${viewport.width}x${viewport.height}.png`),
        });
      }
    }

    if (isTabletViewport) {
      const calendar = homeSurface.locator('.home-compact-calendar');
      const mealLayout = await calendar.locator('.home-compact-meal-slot.has-items').first().evaluate((element) => {
        const mealGrid = element.parentElement;
        const foodArea = element.querySelector('.home-compact-meal-foods')?.getBoundingClientRect();
        const actions = element.querySelector('.home-compact-meal-actions')?.getBoundingClientRect();
        const foods = Array.from(element.querySelectorAll('.home-compact-meal-item'));
        const image = element.querySelector('.home-compact-meal-item-image')?.getBoundingClientRect();
        const firstFood = foods[0];
        const firstFoodBefore = firstFood ? getComputedStyle(firstFood, '::before').content : null;
        const slotHeights = mealGrid
          ? Array.from(mealGrid.querySelectorAll('.home-compact-meal-slot')).map((slot) => Math.round(slot.getBoundingClientRect().height))
          : [];
        const emptySlot = mealGrid?.querySelector('.home-compact-meal-slot:not(.has-items)');
        const emptySlotRect = emptySlot?.getBoundingClientRect();
        const emptyHeadRect = emptySlot?.querySelector('.home-compact-meal-slot-head')?.getBoundingClientRect();
        const emptyAddRect = emptySlot?.querySelector('.home-compact-meal-add')?.getBoundingClientRect();
        return {
          mealGridColumns: mealGrid ? getComputedStyle(mealGrid).gridTemplateColumns.split(' ').filter(Boolean).length : 0,
          hasOverflowClass: element.classList.contains('has-overflow'),
          foodCount: foods.length,
          foodRowsVertical: foods.length === 2 && foods[1].getBoundingClientRect().top > foods[0].getBoundingClientRect().bottom - 1,
          imageVisible: Boolean(image && image.width > 0 && image.height > 0),
          actionsOnNewRow: Boolean(foodArea && actions && actions.top >= foodArea.bottom - 1),
          actionButtonCount: element.querySelectorAll('.home-compact-meal-actions button').length,
          firstFoodBefore,
          slotHeights,
          emptyActionGap: emptyHeadRect && emptyAddRect ? Math.round(emptyAddRect.top - emptyHeadRect.bottom) : null,
          emptyActionFullWidth: Boolean(
            emptySlotRect
            && emptyAddRect
            && emptyAddRect.width >= emptySlotRect.width - 18
          ),
        };
      });
      if (
        mealLayout.mealGridColumns !== 4
        || !mealLayout.hasOverflowClass
        || mealLayout.foodCount !== 2
        || !mealLayout.foodRowsVertical
        || !mealLayout.imageVisible
        || !mealLayout.actionsOnNewRow
        || mealLayout.actionButtonCount !== 2
        || (mealLayout.firstFoodBefore !== 'none' && mealLayout.firstFoodBefore !== 'normal')
        || mealLayout.slotHeights.length !== 4
        || new Set(mealLayout.slotHeights).size !== 1
        || mealLayout.emptyActionGap == null
        || mealLayout.emptyActionGap > 8
        || !mealLayout.emptyActionFullWidth
      ) {
        throw new Error(`${label} Pad 餐次纵向布局异常：${JSON.stringify(mealLayout)}`);
      }
      await expectNoHorizontalOverflow(page, `${label} Pad 餐次安排`);
      if (screenshotDir) {
        mkdirSync(screenshotDir, { recursive: true });
        await calendar.screenshot({
          path: resolve(screenshotDir, `tablet-home-plan-${viewport.width}x${viewport.height}.png`),
        });
      }
    }

    await homeSurface.getByRole('button', { name: `${food.name}，已记录`, exact: true }).click();
    const planDetail = page.locator('.food-plan-detail-modal');
    await expectVisible(planDetail, `${label} 已记录计划详情`);
    await expectVisible(planDetail.getByText('已关联餐食记录'), `${label} 餐食关联状态`);
    const planActionsGeometry = await planDetail.locator('.recipe-plan-detail-actions.is-recorded .ui-form-actions-row').evaluate((element) => {
      const buttons = Array.from(element.querySelectorAll('button')).map((button) => {
        const rect = button.getBoundingClientRect();
        return { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) };
      });
      const row = element.getBoundingClientRect();
      return { buttons, rowWidth: Math.round(row.width) };
    });
    if (
      planActionsGeometry.buttons.length !== 2
      || Math.abs(planActionsGeometry.buttons[0].top - planActionsGeometry.buttons[1].top) > 1
      || planActionsGeometry.buttons[0].width <= planActionsGeometry.buttons[1].width
      || planActionsGeometry.buttons.some((button) => button.height < 44)
    ) {
      throw new Error(`${label} 计划详情按钮布局异常：${JSON.stringify(planActionsGeometry)}`);
    }
    if (screenshotDir) {
      mkdirSync(screenshotDir, { recursive: true });
      await page.screenshot({
        path: resolve(screenshotDir, `food-plan-detail-${viewport.width}x${viewport.height}.png`),
      });
      if (isPhoneViewport) {
        await planDetail.locator('.workspace-overlay-footer').scrollIntoViewIfNeeded();
        await page.screenshot({
          path: resolve(screenshotDir, `food-plan-detail-actions-${viewport.width}x${viewport.height}.png`),
        });
      }
    }
    await planDetail.getByRole('button', { name: '餐食记录', exact: true }).click();

    const evaluation = page.locator('.meal-log-enrich-modal');
    await expectVisible(evaluation, `${label} 整餐评价弹窗`);
    await expectVisible(evaluation.getByText('评价这顿晚餐'), `${label} 整餐评价标题`);
    await expectVisible(evaluation.getByText('本餐计划 · 尚未记录').first(), `${label} 待记录计划项`);

    const layout = await evaluation.locator('.meal-enrichment-layout').evaluate((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const recordedRow = element.querySelector('.meal-dish-rating-row:not(.is-pending-plan)');
      const rowStyle = recordedRow ? getComputedStyle(recordedRow) : null;
      return {
        columns: style.gridTemplateColumns.split(' ').filter(Boolean).length,
        recordedRowColumns: rowStyle?.gridTemplateColumns.split(' ').filter(Boolean).length ?? 0,
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        viewportWidth: window.innerWidth,
      };
    });
    const expectedColumns = viewport.width > 1120 ? 2 : 1;
    const expectedRecordedRowColumns = viewport.width > 640 ? 2 : 1;
    if (
      layout.columns !== expectedColumns
      || layout.recordedRowColumns !== expectedRecordedRowColumns
      || layout.left < -1
      || layout.right > layout.viewportWidth + 1
    ) {
      throw new Error(`${label} 整餐评价布局异常：${JSON.stringify(layout)}`);
    }

    await evaluation.getByRole('button', { name: `记录${riceFood.name}已吃`, exact: true }).click();
    await expectVisible(evaluation.getByText(riceFood.name, { exact: true }).last(), `${label} 新增米饭评分行`);
    await expectVisible(evaluation.getByRole('button', { name: '撤回刚才添加', exact: true }), `${label} 行级撤回`);
    await evaluation.getByRole('button', { name: '撤回刚才添加', exact: true }).click();
    await expectVisible(evaluation.getByRole('button', { name: `记录${riceFood.name}已吃`, exact: true }), `${label} 撤回后恢复加号`);

    await evaluation.getByRole('button', { name: '＋ 添加其他实际吃的食物', exact: true }).click();
    await expectVisible(evaluation.getByRole('searchbox', { name: '搜索食物' }), `${label} 添加其他食物搜索`);
    const firstRating = evaluation.locator('.meal-dish-rating-row:not(.is-pending-plan) .ui-star-rating-stars').first();
    await firstRating.click({ position: { x: 24, y: 18 } });
    await expectVisible(evaluation.getByRole('button', { name: '清除评分', exact: true }).first(), `${label} 清除评分`);
    await expectNoHorizontalOverflow(page, `${label} 整餐评价`);

    if (screenshotDir) {
      mkdirSync(screenshotDir, { recursive: true });
      await page.screenshot({
        path: resolve(
          screenshotDir,
          viewport.width === 375
            ? 'meal-evaluation-375x812.png'
            : viewport.width === 1024
              ? 'meal-evaluation-1024x744.png'
              : 'meal-evaluation-1440x960.png',
        ),
      });
    }
    await evaluation.getByRole('button', { name: '清除评分', exact: true }).first().click();
    await expectVisible(evaluation.getByText('未评分', { exact: true }).first(), `${label} 清除后恢复未评分`);
    assertClean();
  } finally {
    await context.close();
  }
}

async function runMealCandidateSelectorSmoke(browser, baseUrl, viewport, label, contextOptions = {}, multi = false) {
  const isPhoneViewport = isPhoneViewportSize(viewport);
  const screenshotDir = process.env.CULINA_SMOKE_SCREENSHOT_DIR;
  const soupCover = {
    ...recipe.images[0],
    id: 'media-food-soup',
    name: '冬瓜汤.svg',
    alt: '冬瓜汤',
    url: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160"%3E%3Crect width="160" height="160" fill="%23e7efe6"/%3E%3Cellipse cx="80" cy="88" rx="58" ry="42" fill="%23fffaf2"/%3E%3Cpath d="M43 87c13-29 61-39 78-8-7 35-62 45-78 8Z" fill="%2395b99a"/%3E%3Ccircle cx="65" cy="83" r="13" fill="%23dbe8cf"/%3E%3Ccircle cx="96" cy="91" r="15" fill="%23c8ddba"/%3E%3C/svg%3E',
  };
  const mealCandidates = [
    {
      meal_log_id: recordedDinner.id,
      row_version: recordedDinner.row_version,
      date: recordedDinner.date,
      meal_type: 'snack',
      created_at: recordedDinner.created_at,
      foods: [
        {
          food_id: food.id,
          name: food.name,
          food_type: food.type,
          cover: recipe.images[0] ?? null,
        },
        {
          food_id: riceFood.id,
          name: riceFood.name,
          food_type: riceFood.type,
          cover: null,
        },
        {
          food_id: soupFood.id,
          name: soupFood.name,
          food_type: soupFood.type,
          cover: soupCover,
        },
      ],
      preview_media: null,
      photo_count: 0,
    },
    ...(multi
      ? [
          {
            meal_log_id: 'meal-home-snack-2',
            row_version: 1,
            date: homeToday,
            meal_type: 'snack',
            created_at: `${homeToday}T13:08:00.000Z`,
            foods: [
              {
                food_id: riceFood.id,
                name: riceFood.name,
                food_type: riceFood.type,
                cover: null,
              },
            ],
            preview_media: null,
            photo_count: 0,
          },
        ]
      : []),
  ];
  const { context, page, assertClean } = await createPage(
    browser,
    viewport,
    true,
    contextOptions,
    { mealCandidates },
  );
  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    const homeSurface = homeSurfaceLocator(page, viewport);
    if (isPhoneViewport) {
      await homeSurface.getByRole('button', { name: '展开当天安排', exact: true }).click();
    }
    await homeSurface.getByRole('button', { name: `${food.name}，待记录`, exact: true }).click();
    const detail = page.locator('.food-plan-detail-modal');
    await expectVisible(detail, `${label} 待记录计划详情`);
    const primaryMealCover = detail.locator('.meal-cover').first();
    await expectVisible(primaryMealCover, `${label} 餐食组合封面`);
    const coverState = await primaryMealCover.evaluate((element) => ({
      mode: element.getAttribute('data-meal-cover-mode'),
      count: element.getAttribute('data-meal-cover-count'),
      tileCount: element.querySelectorAll('[data-testid="meal-cover-tile"]').length,
      placeholderCount: element.querySelectorAll('[data-testid="meal-cover-empty-state"]').length,
      width: Math.round(element.getBoundingClientRect().width),
      height: Math.round(element.getBoundingClientRect().height),
    }));
    if (
      coverState.mode !== 'mosaic'
      || coverState.count !== '3'
      || coverState.tileCount !== 3
      || coverState.placeholderCount !== 1
      || coverState.width < 44
      || coverState.height < 44
    ) {
      throw new Error(`${label} 餐食组合封面异常：${JSON.stringify(coverState)}`);
    }
    if (multi) {
      const list = detail.getByRole('listbox', { name: '候选餐列表' });
      await expectVisible(list, `${label} 多候选餐列表`);
      const geometry = await list.evaluate((element) => {
        const root = element.getBoundingClientRect();
        const options = Array.from(element.querySelectorAll('[role="option"]')).map((option) => {
          const rect = option.getBoundingClientRect();
          return {
            height: Math.round(rect.height),
            inside: rect.left >= root.left - 1 && rect.right <= root.right + 1,
            selected: option.getAttribute('aria-selected'),
            indicatorVisible: Boolean(option.querySelector('.meal-composer-candidate-option-indicator')),
          };
        });
        return {
          left: Math.round(root.left),
          right: Math.round(root.right),
          viewportWidth: window.innerWidth,
          options,
        };
      });
      if (
        geometry.options.length !== 3
        || geometry.options.some((option) => option.height < 44 || !option.inside || !option.indicatorVisible)
        || geometry.options.filter((option) => option.selected === 'true').length !== 1
        || geometry.left < -1
        || geometry.right > geometry.viewportWidth + 1
      ) {
        throw new Error(`${label} 多候选餐布局异常：${JSON.stringify(geometry)}`);
      }
      const emptyCoverGeometry = await list.locator('[data-meal-cover-mode="empty"]').evaluate((element) => {
        const cover = element.getBoundingClientRect();
        const icon = element.querySelector('.media-placeholder svg')?.getBoundingClientRect();
        return {
          coverCenterX: cover.left + cover.width / 2,
          coverCenterY: cover.top + cover.height / 2,
          iconCenterX: icon ? icon.left + icon.width / 2 : null,
          iconCenterY: icon ? icon.top + icon.height / 2 : null,
        };
      });
      if (
        emptyCoverGeometry.iconCenterX == null
        || emptyCoverGeometry.iconCenterY == null
        || Math.abs(emptyCoverGeometry.coverCenterX - emptyCoverGeometry.iconCenterX) > 1
        || Math.abs(emptyCoverGeometry.coverCenterY - emptyCoverGeometry.iconCenterY) > 1
      ) {
        throw new Error(`${label} 无图餐食占位未居中：${JSON.stringify(emptyCoverGeometry)}`);
      }
      const firstCandidate = list.getByRole('option').first();
      await firstCandidate.click();
      if (await firstCandidate.getAttribute('aria-selected') !== 'true') {
        throw new Error(`${label} 多候选餐未正确切换`);
      }
      await expectNoHorizontalOverflow(page, `${label} 多候选餐`);
      if (screenshotDir) {
        mkdirSync(screenshotDir, { recursive: true });
        await detail.screenshot({
          path: resolve(screenshotDir, `meal-candidate-list-${viewport.width}x${viewport.height}.png`),
        });
      }
      assertClean();
      return;
    }
    const selector = detail.getByRole('group', { name: '餐食记录方式' });
    await expectVisible(selector, `${label} 餐食记录方式`);
    const geometry = await selector.evaluate((element) => {
      const root = element.getBoundingClientRect();
      const buttons = Array.from(element.querySelectorAll('button')).map((button) => {
        const rect = button.getBoundingClientRect();
        const style = getComputedStyle(button);
        return {
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          background: style.backgroundColor,
          pressed: button.getAttribute('aria-pressed'),
          indicatorVisible: Boolean(button.querySelector('.meal-composer-candidate-action-indicator')),
        };
      });
      return {
        left: Math.round(root.left),
        right: Math.round(root.right),
        viewportWidth: window.innerWidth,
        buttons,
      };
    });
    if (
      geometry.buttons.length !== 2
      || geometry.buttons.some((button) => button.height < 44 || !button.indicatorVisible)
      || Math.abs(geometry.buttons[0].width - geometry.buttons[1].width) > 1
      || geometry.buttons.filter((button) => button.pressed === 'true').length !== 1
      || geometry.left < -1
      || geometry.right > geometry.viewportWidth + 1
    ) {
      throw new Error(`${label} 餐食记录方式布局异常：${JSON.stringify(geometry)}`);
    }

    const joinButton = selector.getByRole('button', { name: '记在一起', exact: true });
    const separateButton = selector.getByRole('button', { name: '另记一顿', exact: true });
    await separateButton.click();
    if (await joinButton.getAttribute('aria-pressed') !== 'false' || await separateButton.getAttribute('aria-pressed') !== 'true') {
      throw new Error(`${label} 餐食记录方式未正确切换`);
    }
    await expectNoHorizontalOverflow(page, `${label} 餐食记录方式`);
    if (screenshotDir) {
      mkdirSync(screenshotDir, { recursive: true });
      await detail.screenshot({
        path: resolve(screenshotDir, `meal-candidate-selector-${viewport.width}x${viewport.height}.png`),
      });
    }
    assertClean();
  } finally {
    await context.close();
  }
}

async function runUnifiedEatNavigationSmoke(browser, baseUrl) {
  const label = 'PR A 统一吃什么导航';
  const requestedApiPaths = [];
  const { context, page, assertClean } = await createPage(
    browser,
    { width: 1440, height: 960 },
    true,
    {},
    { requestedApiPaths },
  );
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

  // desktop: 首页 → 推荐 Food → 吃什么/发现/Food detail (also covered in desktop smoke)
  await page.locator('.dashboard-food-card').first().click();
  await expectVisible(page.locator('.food-detail-drawer'), `${label} 首页推荐 Food detail`);
  await page.getByLabel('关闭弹窗').last().click();
  await page.locator('.food-detail-drawer').waitFor({ state: 'detached', timeout: 10_000 });

  // desktop: 搜索 Recipe → recipe-target with real recipe detail content
  await page.locator('.dashboard-page').getByRole('button', { name: '全局搜索' }).click();
  await expectVisible(page.getByRole('dialog', { name: '全局搜索' }), `${label} 搜索弹层`);
  await page.getByLabel('搜索食材、食物、菜谱、餐食计划').fill('番茄');
  await page.waitForTimeout(350);
  const recipeResult = page.locator('.global-search-result-list button, .global-search-result-list [role="button"]').filter({ hasText: '番茄炒蛋' }).first();
  await expectVisible(recipeResult, `${label} 搜索 Recipe 结果`);
  await recipeResult.click();
  await expectVisible(
    page.getByTestId('eat-recipe-task-body').or(
      page.locator('.recipe-task-surface, .recipe-detail-subpage, .eat-recipe-task-title').filter({ hasText: /番茄炒蛋|做法|菜谱/ }),
    ).first(),
    `${label} recipe-target 任务真实内容`,
  );
  await expectVisible(page.getByText('番茄炒蛋').first(), `${label} recipe title`);
  // Prefer real detail chrome over empty shell placeholder
  const recipePlaceholder = await page.getByText('做法任务内容将由上层装配').count();
  if (recipePlaceholder > 0) {
    throw new Error(`${label} recipe-target 仍是占位内容`);
  }

  // plan search: non-current-week result → detail fetch
  // reopen search from home after closing the eat task
  await page.getByRole('button', { name: '首页' }).first().click();
  await page.locator('.dashboard-page').getByRole('button', { name: '全局搜索' }).click();
  await expectVisible(page.getByRole('dialog', { name: '全局搜索' }), `${label} 再次打开搜索`);
  await page.getByLabel('搜索食材、食物、菜谱、餐食计划').fill('菜单');
  await page.waitForTimeout(500);
  const planResult = page.locator('.global-search-result.global-search-result-meal_plan').first();
  await expectVisible(planResult, `${label} 非当周 plan 搜索结果`);
  await planResult.click();
  await page.waitForTimeout(500);
  if (!requestedApiPaths.some((path) => path.startsWith('/api/food-plan/'))) {
    throw new Error(`${label} 非当周 plan 搜索未触发 GET /api/food-plan/{id}: ${requestedApiPaths.join(',')}`);
  }

  // Plan search selection opens the detail task over the discovery workspace.
  await expectVisible(
    page.locator('.food-plan-detail-modal, .recipe-plan-detail-modal').or(
      page.locator('.eat-task-heading').filter({ hasText: /番茄|菜单项|smoke non-current-week/ }),
    ).first(),
    `${label} plan 详情任务`,
  );
  const planPlaceholder = await page.getByText('菜单项任务内容将由上层装配').count();
  if (planPlaceholder > 0) {
    throw new Error(`${label} plan 详情仍是占位内容`);
  }
  // week range for 2026-06-15 is Mon 06/15 – Sun 06/21; surface shows MM/DD - MM/DD
  await page.waitForFunction(() => {
    const head = document.querySelector('.food-sidebar-section-head span');
    const text = `${head?.textContent || ''} ${document.body.innerText || ''}`;
    return (
      text.includes('06/15')
      || text.includes('06/16')
      || text.includes('06/17')
      || text.includes('06/18')
      || text.includes('06/19')
      || text.includes('06/20')
      || text.includes('06/21')
      || text.includes('6月15')
      || text.includes('2026-06-15')
    );
  }, undefined, { timeout: 10_000 }).catch(() => {
    throw new Error(`${label} plan 搜索后未聚焦 fixture 周(2026-06-15)`);
  });
  await expectVisible(
    page.getByTestId('food-plan-week-section').or(page.getByLabel('菜单')).first(),
    `${label} 菜单周表面`,
  );

  assertClean();
  await context.close();
}

async function runMobileEatTabsSmoke(browser, baseUrl) {
  const label = 'mobile 吃什么';
  const { context, page, assertClean } = await createPage(
    browser,
    { width: 375, height: 812 },
    true,
    { isMobile: true, hasTouch: true },
  );
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '吃什么' }).first().click();
  await expectVisible(page.locator('.food-mobile-view'), `${label} 发现`);
  const mealInsightsLoaded = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/api/meal-logs/insights'
      && response.ok(),
    { timeout: 10_000 },
  );
  await page.locator('.food-mobile-view').getByRole('button', { name: '吃过的' }).click();
  // Mobile history uses MealLogMobileView ("吃过的" + day groups / empty), not desktop "家庭时间线".
  await expectVisible(page.locator('.mobile-log-page'), `${label} 吃过的页面`);
  await expectVisibleText(page, '吃过的', `${label} 吃过的`);
  await expectVisible(page.locator('#mobile-log-timeline.mobile-log-timeline-list'), `${label} 时间线列表`);
  await expectVisible(
    page.locator('.mobile-log-empty, .mobile-log-day-group').first(),
    `${label} 时间线内容`,
  );
  await mealInsightsLoaded;
  await page.waitForFunction(
    () => document.querySelectorAll('[data-memory-status="loading"]').length === 0,
    undefined,
    { timeout: 10_000 },
  );
  // Empty insights keep the memory strip out of the page (no cards / error chrome).
  const mealHistoryLayout = await page.evaluate(() => {
    const memoryCards = document.querySelectorAll('.meal-memory-card');
    const memoryError = document.querySelector('.meal-memory-error');
    const pageEl = document.querySelector('.mobile-log-page');
    const timeline = document.querySelector('#mobile-log-timeline');
    const empty = document.querySelector('.mobile-log-empty');
    const dayGroup = document.querySelector('.mobile-log-day-group');
    return {
      memoryCardCount: memoryCards.length,
      hasMemoryError: Boolean(memoryError),
      pageVisible: Boolean(pageEl && getComputedStyle(pageEl).display !== 'none'),
      timelineVisible: Boolean(timeline && getComputedStyle(timeline).display !== 'none'),
      hasEmptyOrDay: Boolean(empty || dayGroup),
    };
  });
  if (mealHistoryLayout.memoryCardCount !== 0 || mealHistoryLayout.hasMemoryError) {
    throw new Error(
      `${label} 空家庭记忆仍渲染了区域：cards=${mealHistoryLayout.memoryCardCount} error=${mealHistoryLayout.hasMemoryError}`,
    );
  }
  if (!mealHistoryLayout.pageVisible || !mealHistoryLayout.timelineVisible || !mealHistoryLayout.hasEmptyOrDay) {
    throw new Error(`${label} 吃过的移动时间线表面不可见`);
  }
  await page.locator('.mobile-log-primary-cta').click();
  const mobileMealComposer = page.locator('.meal-composer-modal');
  await expectVisible(mobileMealComposer, `${label} 记一餐弹窗`);
  await expectVisible(mobileMealComposer.getByRole('heading', { name: '确认时间' }), `${label} 记一餐第一步`);
  await expectVisible(mobileMealComposer.getByRole('heading', { name: '添加食物' }), `${label} 记一餐第二步`);
  await page.waitForTimeout(320);
  const mobileComposerGeometry = await mobileMealComposer.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const removeTargets = Array.from(element.querySelectorAll('.meal-composer-food-remove'));
    const dateStrip = element.querySelector('.meal-composer-date-strip');
    const selectedDate = dateStrip?.querySelector('.meal-composer-date-option.is-active');
    const dateStripRect = dateStrip?.getBoundingClientRect();
    const selectedDateRect = selectedDate?.getBoundingClientRect();
    return {
      left: Math.round(rect.left),
      right: Math.round(rect.right),
      bottom: Math.round(rect.bottom),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      removeTargetsValid: removeTargets.every((target) => {
        const targetRect = target.getBoundingClientRect();
        return targetRect.width >= 44 && targetRect.height >= 44;
      }),
      selectedDateVisible: Boolean(
        dateStripRect
        && selectedDateRect
        && selectedDateRect.left >= dateStripRect.left - 1
        && selectedDateRect.right <= dateStripRect.right + 1
      ),
      dateStripScrollLeft: dateStrip?.scrollLeft ?? null,
      dateStripScrollWidth: dateStrip?.scrollWidth ?? null,
      dateStripClientWidth: dateStrip?.clientWidth ?? null,
      selectedDateLeft: selectedDateRect ? Math.round(selectedDateRect.left) : null,
      selectedDateRight: selectedDateRect ? Math.round(selectedDateRect.right) : null,
      dateStripLeft: dateStripRect ? Math.round(dateStripRect.left) : null,
      dateStripRight: dateStripRect ? Math.round(dateStripRect.right) : null,
    };
  });
  if (
    mobileComposerGeometry.left < -1
    || mobileComposerGeometry.right > mobileComposerGeometry.viewportWidth + 1
    || mobileComposerGeometry.bottom > mobileComposerGeometry.viewportHeight + 1
    || !mobileComposerGeometry.removeTargetsValid
    || !mobileComposerGeometry.selectedDateVisible
  ) {
    throw new Error(`${label} 记一餐弹窗几何异常：${JSON.stringify(mobileComposerGeometry)}`);
  }
  const mobileFoodSearch = mobileMealComposer.getByRole('searchbox', { name: '搜索食物' });
  await mobileFoodSearch.fill('番茄');
  const mobileFoodMenu = mobileMealComposer.getByRole('listbox', { name: '食物搜索结果' });
  await expectVisible(mobileFoodMenu, `${label} 食物搜索下拉框`);
  const mobileFoodMenuStyle = await mobileFoodMenu.evaluate((element) => {
    const option = element.querySelector('[role="option"]');
    const optionStyle = option ? getComputedStyle(option) : null;
    return {
      usesDefaultMenu: element.classList.contains('ui-combobox-menu'),
      optionBorderTopWidth: optionStyle?.borderTopWidth ?? null,
    };
  });
  if (!mobileFoodMenuStyle.usesDefaultMenu || mobileFoodMenuStyle.optionBorderTopWidth !== '0px') {
    throw new Error(`${label} 食物搜索未使用默认下拉样式：${JSON.stringify(mobileFoodMenuStyle)}`);
  }
  const mobileScreenshotDir = process.env.CULINA_SMOKE_SCREENSHOT_DIR;
  if (mobileScreenshotDir) {
    mkdirSync(mobileScreenshotDir, { recursive: true });
    await page.screenshot({ path: resolve(mobileScreenshotDir, 'meal-composer-food-menu-375x812.png') });
    await mobileFoodSearch.clear();
    await page.screenshot({ path: resolve(mobileScreenshotDir, 'meal-composer-375x812.png') });
  }
  await mobileMealComposer.getByLabel('关闭弹窗').click();
  await mobileMealComposer.waitFor({ state: 'detached', timeout: 10_000 });
  await expectNoHorizontalOverflow(page, label);
  assertClean();
  await context.close();
}

async function runLegacyStorageRecoverySmoke(browser, baseUrl) {
  const cases = [
    {
      label: 'valid navigation v2',
      storage: {
        version: 2,
        primaryTab: 'eat',
        eatBaseView: 'discover',
        discoverSection: 'selfMade',
      },
    },
    {
      label: 'unknown primary tab',
      storage: {
        version: 2,
        primaryTab: 'mystery',
        eatBaseView: 'discover',
        discoverSection: 'selfMade',
      },
    },
    {
      label: 'corrupt navigation v2',
      corrupt: true,
    },
  ];
  for (const entry of cases) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    const unexpectedRequests = [];
    const pageErrors = [];
    const consoleErrors = [];
    await installApiMocks(context, unexpectedRequests, {});
    await context.addInitScript(({ storage, corrupt }) => {
      localStorage.setItem('culina-access-token', 'smoke-token');
      if (corrupt) {
        localStorage.setItem('culina-navigation-v2', '{not-json');
      } else {
        localStorage.setItem('culina-navigation-v2', JSON.stringify(storage));
      }
    }, entry);
    const page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await expectVisible(page.locator('.app-frame'), `storage ${entry.label} app frame`);
    const primaryVisible = await page.evaluate(() => {
      const frame = document.querySelector('.app-frame');
      return frame ? getComputedStyle(frame).display !== 'none' : false;
    });
    if (!primaryVisible) {
      throw new Error(`storage ${entry.label} 未恢复到可见工作区`);
    }
    if (unexpectedRequests.length > 0) {
      throw new Error(`storage ${entry.label} 未 mock 的 API 请求：\n${unexpectedRequests.join('\n')}`);
    }
    if (pageErrors.length > 0) {
      throw new Error(`storage ${entry.label} 页面运行错误：\n${pageErrors.join('\n')}`);
    }
    const relevantConsoleErrors = consoleErrors.filter((message) => !message.includes('Failed to load resource'));
    if (relevantConsoleErrors.length > 0) {
      throw new Error(`storage ${entry.label} console error：\n${relevantConsoleErrors.join('\n')}`);
    }
    await context.close();
  }
}


async function runCompatibleAiClientSmoke(browser, baseUrl) {
  const requestedAiHeaders = [];
  const { page, context, assertClean } = await createPage(
    browser,
    { width: 1180, height: 820 },
    true,
    {},
    { requestedAiHeaders },
  );
  try {
    await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'AI' }).click();
    await expectVisibleText(page, 'AI 厨房助手', 'compatible AI workspace');
    await page.waitForTimeout(200);

    const capabilityHits = requestedAiHeaders.filter((item) => item.contracts === 'recipe_cook_operation.v1,recipe_cook_operation.v2');
    if (capabilityHits.length === 0) {
      throw new Error(`AI capability header missing on /api/ai/* requests: ${JSON.stringify(requestedAiHeaders)}`);
    }

    // Fixture-level checks for v1/v2 approval semantics are covered by unit tests;
    // smoke proves the production client always advertises both contracts.
    console.log(`compatible AI client smoke: ${capabilityHits.length} capability-bearing AI request(s)`);
    assertClean();
  } finally {
    await context.close();
  }
}

async function main() {
  assertDistExists();
  const preview = await startPreview();
  const browser = await chromium.launch();
  try {
    if (process.env.SMOKE_TABLET_AIR_ONLY === '1') {
      await runTabletAirWorkspaceSmoke(browser, preview.url);
      console.log('Smoke tablet-air-only passed');
      return;
    }
    if (process.env.SMOKE_RECON_ONLY === '1') {
      await runInventoryReconciliationSmoke(
        browser,
        preview.url,
        { width: 375, height: 812 },
        '375x812 快速盘点',
        { mobile: true }
      );
      await runInventoryReconciliationSmoke(
        browser,
        preview.url,
        { width: 1440, height: 960 },
        '桌面快速盘点',
        { mobile: false }
      );
      console.log('Smoke recon-only passed');
      return;
    }
    if (process.env.SMOKE_MEAL_EVAL_ONLY === '1') {
      await runMealCandidateSelectorSmoke(
        browser,
        preview.url,
        { width: 1440, height: 960 },
        '1440x960 桌面餐食记录方式',
      );
      await runMealCandidateSelectorSmoke(
        browser,
        preview.url,
        { width: 375, height: 812 },
        '375x812 手机餐食记录方式',
        { isMobile: true, hasTouch: true },
      );
      await runMealCandidateSelectorSmoke(
        browser,
        preview.url,
        { width: 1024, height: 768 },
        '1024x768 Pad 餐食记录方式',
        { hasTouch: true },
      );
      await runMealCandidateSelectorSmoke(
        browser,
        preview.url,
        { width: 1440, height: 960 },
        '1440x960 桌面多候选餐',
        {},
        true,
      );
      await runMealCandidateSelectorSmoke(
        browser,
        preview.url,
        { width: 375, height: 812 },
        '375x812 手机多候选餐',
        { isMobile: true, hasTouch: true },
        true,
      );
      await runMealCandidateSelectorSmoke(
        browser,
        preview.url,
        { width: 1024, height: 768 },
        '1024x768 Pad 多候选餐',
        { hasTouch: true },
        true,
      );
      await runHomeMealEvaluationSmoke(
        browser,
        preview.url,
        { width: 1440, height: 960 },
        '1440x960 桌面整餐评价',
      );
      await runHomeMealEvaluationSmoke(
        browser,
        preview.url,
        { width: 350, height: 780 },
        '350x780 手机整餐评价',
        { isMobile: true, hasTouch: true },
      );
      await runHomeMealEvaluationSmoke(
        browser,
        preview.url,
        { width: 375, height: 812 },
        '375x812 手机整餐评价',
        { isMobile: true, hasTouch: true },
      );
      await runHomeMealEvaluationSmoke(
        browser,
        preview.url,
        { width: 390, height: 844 },
        '390x844 手机整餐评价',
        { isMobile: true, hasTouch: true },
      );
      await runHomeMealEvaluationSmoke(
        browser,
        preview.url,
        { width: 430, height: 932 },
        '430x932 手机整餐评价',
        { isMobile: true, hasTouch: true },
      );
      await runHomeMealEvaluationSmoke(
        browser,
        preview.url,
        { width: 1024, height: 744 },
        '1024x744 Pad 整餐评价',
        { hasTouch: true },
      );
      console.log('Smoke meal-evaluation-only passed');
      return;
    }
    await runLoginSmoke(browser, preview.url);
    await runDesktopSmoke(browser, preview.url);
    await runUnifiedEatNavigationSmoke(browser, preview.url);
    await runMobileEatTabsSmoke(browser, preview.url);
    await runLegacyStorageRecoverySmoke(browser, preview.url);
    await runHomeActionCenterSmoke(browser, preview.url);
    await runHomeHighlightLoadingSmoke(browser, preview.url);
    await runHomeHighlightErrorSmoke(browser, preview.url);
    await runHomeHighlightStaleCacheSmoke(browser, preview.url);
    await runHomeFamilyActivityNavigationSmoke(
      browser,
      preview.url,
      { width: 1440, height: 960 },
      '桌面家庭活动导航'
    );
    await runHomeFamilyActivityNavigationSmoke(
      browser,
      preview.url,
      { width: 375, height: 812 },
      '手机家庭活动导航',
      { isMobile: true, hasTouch: true }
    );
    await runHomeFullWeekNavigationSmoke(
      browser,
      preview.url,
      { width: 1440, height: 960 },
      '桌面完整周菜单'
    );
    await runHomeFullWeekNavigationSmoke(
      browser,
      preview.url,
      { width: 375, height: 812 },
      '手机完整周菜单',
      { isMobile: true, hasTouch: true }
    );
    await runHomeMealEvaluationSmoke(
      browser,
      preview.url,
      { width: 1440, height: 960 },
      '1440x960 桌面整餐评价'
    );
    await runHomeMealEvaluationSmoke(
      browser,
      preview.url,
      { width: 375, height: 812 },
      '375x812 手机整餐评价',
      { isMobile: true, hasTouch: true }
    );
    await runHomeMealEvaluationSmoke(
      browser,
      preview.url,
      { width: 1024, height: 744 },
      '1024x744 Pad 整餐评价',
      { hasTouch: true }
    );
    await runInventoryActionViewportSmoke(browser, preview.url, { width: 1440, height: 960 }, '1440x960 桌面端');
    await runInventoryActionViewportSmoke(browser, preview.url, { width: 1024, height: 744 }, '1024x744 iPad 横屏');
    await runInventoryActionViewportSmoke(browser, preview.url, { width: 375, height: 812 }, '375x812 手机端', {
      isMobile: true,
      hasTouch: true,
    });
    await runInventoryReconciliationSmoke(
      browser,
      preview.url,
      { width: 375, height: 812 },
      '375x812 快速盘点',
      { mobile: true }
    );
    await runInventoryReconciliationSmoke(
      browser,
      preview.url,
      { width: 390, height: 844 },
      '390x844 快速盘点',
      { mobile: true }
    );
    await runInventoryReconciliationSmoke(
      browser,
      preview.url,
      { width: 430, height: 932 },
      '430x932 快速盘点',
      { mobile: true }
    );
    await runInventoryReconciliationSmoke(
      browser,
      preview.url,
      { width: 1440, height: 960 },
      '桌面快速盘点',
      { mobile: false }
    );
    await runResponsiveSmoke(browser, preview.url, { width: 1440, height: 960 }, '1440x960');
    await runResponsiveSmoke(browser, preview.url, { width: 1280, height: 820 }, '1280x820');
    await runResponsiveSmoke(browser, preview.url, { width: 1180, height: 820 }, '1180x820');
    await runResponsiveSmoke(browser, preview.url, { width: 1112, height: 834 }, '1112x834');
    await runResponsiveSmoke(
      browser,
      preview.url,
      { width: 1024, height: 744 },
      '1024 landscape touch',
      { isMobile: true, hasTouch: true }
    );
    await runResponsiveSmoke(
      browser,
      preview.url,
      { width: 430, height: 932 },
      '430x932',
      { isMobile: true, hasTouch: true }
    );
    await runResponsiveSmoke(
      browser,
      preview.url,
      { width: 390, height: 844 },
      '390x844',
      { isMobile: true, hasTouch: true }
    );
    await runResponsiveSmoke(
      browser,
      preview.url,
      { width: 375, height: 812 },
      '375x812',
      { isMobile: true, hasTouch: true }
    );
    await runResponsiveSmoke(
      browser,
      preview.url,
      { width: 350, height: 780 },
      '350x780',
      { isMobile: true, hasTouch: true }
    );
    await runOrientationLockSmoke(
      browser,
      preview.url,
      { width: 768, height: 1024 },
      '768x1024',
      '电脑和 iPad 端需要横屏查看'
    );
    await runOrientationLockSmoke(
      browser,
      preview.url,
      { width: 844, height: 390 },
      '844x390',
      '手机端需要竖屏查看',
      { isMobile: true, hasTouch: true }
    );
    await runTouchTabletLandscapeSmoke(browser, preview.url);
    await runTabletLandscapeSmoke(browser, preview.url);
    await runTabletAirWorkspaceSmoke(browser, preview.url);
    await runCompatibleAiClientSmoke(browser, preview.url);
    console.log(
      'Smoke passed: login, compatible AI client capability header, desktop workspace tabs, unified eat navigation (home food detail/search recipe/plan detail/mobile tabs/storage recovery), home household highlights (loading/error/stale/navigation/week), home action center dialog, inventory reconciliation (exact/presence/food adapters + 375/390/430/desktop responsive task), viewport matrix 1440/1280/1180/1112/1024/430/390/375/350, 768x1024 orientation lock, 844x390 mobile orientation lock, 1024x744 touch iPad landscape, 1112x834 and 1180x820 responsive checks.'
    );
  } finally {
    try {
      await browser.close();
    } finally {
      await preview.stop();
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
