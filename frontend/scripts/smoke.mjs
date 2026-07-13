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
  images: [],
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
  images: [],
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
  '/api/recipe-plan': [],
  '/api/food-plan': [],
  [`/api/food-plan/${planItemOutsideWeek.id}`]: planItemOutsideWeek,
  '/api/food-scenes': [],
  '/api/foods': recommendationFoods,
  '/api/foods/recommendations': {
    target_meal_type: 'dinner',
    target_date: today,
    items: recommendationItems,
  },
  '/api/meal-logs': [],
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
  const routeController = options.routeController ?? createRouteController();

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

    const fixture = fixtures[url.pathname];
    if (fixture !== undefined) {
      await fulfillJson(route, fixture);
      return;
    }

    unexpectedRequests.push(`${request.method()} ${url.pathname}${url.search}`);
    await fulfillJson(route, { detail: `Unhandled smoke API: ${url.pathname}` }, 404);
  });

  return { routeController, requestedApiPaths };
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization,content-type',
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
  const routeController = mockOptions.routeController ?? createRouteController();

  await installApiMocks(context, unexpectedRequests, { requestedApiPaths, routeController });
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
    const calendar = surface?.querySelector('[data-testid="mobile-home-calendar-scroll"]') ?? null;
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
      calendarScrolls: calendar ? calendar.scrollWidth > calendar.clientWidth : null,
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
    if (layout.calendarScrolls !== true) {
      throw new Error(`${label} 手机紧凑日历没有形成受控横滑`);
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
        hasExpiredBadge: Boolean(egg && (egg.textContent || '').includes('含过期批次')),
        hasExactActions: Boolean(
          modal.querySelector('[data-field-key="exact_ingredient:ingredient-egg:confirm_all"]') &&
            modal.querySelector('[data-field-key="exact_ingredient:ingredient-egg:adjust_batches"]')
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
    if (!snapshot.hasExpiredBadge) throw new Error(`${label} 过期批次标记未出现`);
    if (!snapshot.hasExactActions || !snapshot.hasPresenceLow || !snapshot.hasFoodConfirm) {
      throw new Error(`${label} 盘点动作控件不完整`);
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

  // desktop: 首页 → 推荐 Food → 吃什么/发现/Food detail
  await page.locator('.dashboard-food-card').first().click();
  await expectVisible(page.locator('.food-detail-drawer'), '桌面首页推荐 Food 详情');
  await page.getByLabel('关闭弹窗').last().click();
  await page.locator('.food-detail-drawer').waitFor({ state: 'detached', timeout: 10_000 });

  await page.getByRole('button', { name: '吃什么' }).first().click();
  await expectVisible(page.getByRole('tab', { name: '发现' }), '吃什么/发现');
  await expectVisibleText(page, '食物库', '发现工作台食物库');

  await page.getByRole('button', { name: '食材' }).first().click();
  await expectVisibleText(page, '管理家庭食材档案、库存状态以及采购清单。', '食材工作台');

  await page.getByRole('button', { name: '吃什么' }).first().click();
  await page.getByRole('tab', { name: '菜单' }).click();
  await expectVisible(page.getByRole('tab', { name: '菜单' }), '吃什么/菜单');
  await page.getByRole('tab', { name: '吃过的' }).click();
  await expectVisible(page.getByRole('tab', { name: '吃过的' }), '吃什么/吃过的');
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
  await expectVisible(page.getByRole('tab', { name: '发现' }), '1180x820 发现');
  await expectVisibleText(page, '食物库', '1180x820 食物页');
  await expectNoHorizontalOverflow(page, '1180x820 食物页');
  const foodLayout = await page.evaluate(() => {
    const columnCount = (selector) => {
      const element = document.querySelector(selector);
      return element ? getComputedStyle(element).gridTemplateColumns.split(' ').length : 0;
    };
    return {
      contentColumns: columnCount('.food-content-layout'),
      recommendationColumns: columnCount('.food-recommendation-grid'),
      cardColumns: columnCount('.food-card-grid'),
      sidebarColumns: columnCount('.food-task-sidebar'),
      quickColumns: columnCount('.food-sidebar-quick-section .food-library-insight'),
      planColumns: columnCount('.food-plan-week'),
      sceneColumns: columnCount('.food-sidebar-scene-list'),
    };
  });
  if (
    foodLayout.contentColumns !== 1 ||
    foodLayout.recommendationColumns !== 3 ||
    foodLayout.cardColumns !== 3 ||
    foodLayout.sidebarColumns !== 2 ||
    foodLayout.quickColumns !== 3 ||
    foodLayout.planColumns !== 3 ||
    foodLayout.sceneColumns !== 3
  ) {
    throw new Error(
      `1180x820 食物页布局异常：主区 ${foodLayout.contentColumns} 列，推荐区 ${foodLayout.recommendationColumns} 列，卡片区 ${foodLayout.cardColumns} 列，辅助区 ${foodLayout.sidebarColumns} 列，视角 ${foodLayout.quickColumns} 列，菜单 ${foodLayout.planColumns} 列，场景 ${foodLayout.sceneColumns} 列`
    );
  }

  await page.getByRole('tab', { name: '菜单' }).click();
  await expectVisible(page.getByRole('tab', { name: '菜单' }), '1180x820 菜单');
  await expectNoHorizontalOverflow(page, '1180x820 菜单页');

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
  await page.getByRole('tab', { name: '吃过的' }).click();
  await expectVisible(page.getByRole('tab', { name: '吃过的' }), '1180x820 吃过的');
  await expectNoHorizontalOverflow(page, '1180x820 餐食记录页');
  const mealLogMetricLayout = await page.evaluate(() => {
    const grid = document.querySelector('.meal-log-command-grid');
    const cards = grid ? Array.from(grid.querySelectorAll('.meal-log-metric-card')) : [];
    const tops = cards.map((card) => Math.round(card.getBoundingClientRect().top));
    return {
      columns: grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0,
      count: cards.length,
      tops,
      overflow: grid ? grid.scrollWidth - grid.clientWidth : Number.POSITIVE_INFINITY,
    };
  });
  const mealLogMetricTopSpread =
    mealLogMetricLayout.tops.length > 0
      ? Math.max(...mealLogMetricLayout.tops) - Math.min(...mealLogMetricLayout.tops)
      : Number.POSITIVE_INFINITY;
  if (
    mealLogMetricLayout.columns !== 4 ||
    mealLogMetricLayout.count !== 4 ||
    mealLogMetricTopSpread > 2 ||
    mealLogMetricLayout.overflow > 1
  ) {
    throw new Error(
      `1180x820 餐食记录统计卡布局异常：${mealLogMetricLayout.columns} 列/${mealLogMetricLayout.count} 张，top=${mealLogMetricLayout.tops.join(',')}，溢出 ${mealLogMetricLayout.overflow}`
    );
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
  await expectVisible(page.locator('.inventory-action-modal'), '库存处理弹窗');
  await expectVisibleText(page, '已过期批次', '库存处理弹窗批次分区');
  await page.getByLabel('关闭').last().click();
  await page.locator('.inventory-action-modal').waitFor({ state: 'detached', timeout: 10_000 });
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
  await expectVisible(page.locator('.inventory-action-modal'), `${label} 库存处理弹窗`);
  await page.waitForTimeout(320);

  const geometry = await page.evaluate(() => {
    const modal = document.querySelector('.inventory-action-modal');
    const body = modal?.querySelector('.workspace-overlay-body');
    const scroll = modal?.querySelector('.inventory-action-scroll');
    const footer = modal?.querySelector('.workspace-overlay-footer');
    const primaryButton = footer?.querySelector('button:not([disabled])');
    if (!modal || !body || !scroll || !footer || !primaryButton) {
      return { ok: false, reason: 'missing-element' };
    }
    const modalRect = modal.getBoundingClientRect();
    const bodyStyle = getComputedStyle(body);
    const scrollStyle = getComputedStyle(scroll);
    const footerRect = footer.getBoundingClientRect();
    const primaryRect = primaryButton.getBoundingClientRect();
    return {
      ok:
        modalRect.bottom <= window.innerHeight + 1 &&
        footerRect.bottom <= window.innerHeight + 1 &&
        primaryRect.bottom <= window.innerHeight + 1 &&
        primaryRect.top >= footerRect.top - 1 &&
        bodyStyle.overflowY === 'hidden' &&
        ['auto', 'scroll'].includes(scrollStyle.overflowY),
      modalBottom: Math.round(modalRect.bottom),
      footerBottom: Math.round(footerRect.bottom),
      primaryTop: Math.round(primaryRect.top),
      primaryBottom: Math.round(primaryRect.bottom),
      viewportHeight: window.innerHeight,
      bodyOverflowY: bodyStyle.overflowY,
      scrollOverflowY: scrollStyle.overflowY,
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
  await page.locator('.inventory-action-modal').waitFor({ state: 'detached', timeout: 10_000 });
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
  await expectVisible(page.getByRole('tab', { name: '发现' }), 'stale 场景离开首页');
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
  await homeSurfaceLocator(page, viewport).getByRole('button', { name: '查看完整周菜单' }).click();

  // Unified Eat plan surface (Task 9/10) replaces the legacy foods-tab week page.
  await expectVisible(page.getByRole('tab', { name: '菜单' }), `${label} 菜单 tab`);
  await expectVisible(
    page.getByTestId('food-plan-week-section').or(page.getByLabel('菜单')).first(),
    `${label} 周菜单`,
  );
  if (!isPhoneViewport) {
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

  // plan search selection focuses the plan surface / week containing fixture plan_date 2026-06-15
  await expectVisible(page.getByRole('tab', { name: '菜单' }), `${label} plan 搜索后菜单 tab`);
  const planTabSelected = await page.getByRole('tab', { name: '菜单' }).getAttribute('aria-selected');
  if (planTabSelected !== 'true') {
    throw new Error(`${label} plan 搜索后菜单 tab 未选中 (aria-selected=${planTabSelected})`);
  }
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
  const label = 'mobile 吃什么 tabs';
  const { context, page, assertClean } = await createPage(
    browser,
    { width: 375, height: 812 },
    true,
    { isMobile: true, hasTouch: true },
  );
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '吃什么' }).first().click();
  await expectVisible(page.getByRole('tab', { name: '发现' }), `${label} 发现`);
  await page.getByRole('tab', { name: '菜单' }).click();
  await expectVisible(page.getByRole('tab', { name: '菜单' }), `${label} 菜单`);
  await page.getByRole('tab', { name: '吃过的' }).click();
  await expectVisible(page.getByRole('tab', { name: '吃过的' }), `${label} 吃过的`);
  await expectNoHorizontalOverflow(page, label);
  assertClean();
  await context.close();
}

async function runLegacyStorageRecoverySmoke(browser, baseUrl) {
  const cases = [
    { key: 'foods', label: 'legacy foods' },
    { key: 'recipes', label: 'legacy recipes' },
    { key: 'logs', label: 'legacy logs' },
    { key: 'unknown-tab', label: 'unknown tab' },
    { key: '__corrupt__', label: 'corrupt storage', corrupt: true },
  ];
  for (const entry of cases) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    const unexpectedRequests = [];
    const pageErrors = [];
    const consoleErrors = [];
    await installApiMocks(context, unexpectedRequests, {});
    await context.addInitScript(({ key, corrupt }) => {
      localStorage.setItem('culina-access-token', 'smoke-token');
      if (corrupt) {
        localStorage.setItem('culina-navigation-v2', '{not-json');
        localStorage.setItem('culina-active-tab', 'foods');
      } else if (key === 'unknown-tab') {
        localStorage.setItem('culina-active-tab', 'unknown-tab');
      } else {
        localStorage.setItem('culina-active-tab', key);
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
    // Legacy foods/recipes/logs should land in eat workspace safely.
    if (['foods', 'recipes', 'logs'].includes(entry.key)) {
      await expectVisible(page.getByRole('button', { name: '吃什么' }).first(), `storage ${entry.label} eat nav`);
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

async function main() {
  assertDistExists();
  const preview = await startPreview();
  const browser = await chromium.launch();
  try {
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
    console.log(
      'Smoke passed: login, desktop workspace tabs, unified eat navigation (home food detail/search recipe/plan detail/mobile tabs/storage recovery), home household highlights (loading/error/stale/navigation/week), home action center dialog, inventory reconciliation (exact/presence/food adapters + 375/390/430/desktop responsive task), viewport matrix 1440/1280/1180/1112/1024/430/390/375/350, 768x1024 orientation lock, 844x390 mobile orientation lock, 1024x744 touch iPad landscape, 1112x834 and 1180x820 responsive checks.'
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
