
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

const modelUsageHealthFixture = {
  exact_event_count: 8,
  estimated_event_count: 1,
  unpriced_event_count: 1,
  uncertain_attempt_count: 1,
  pending_attempt_count: 1,
  unresolved_unknown_execution_attempt_count: 1,
  conservative_estimated_cost_cny: '0.450000000000',
  known_unmeasured_attempt_count: 1,
  measurement_gap: true,
  measurement_gap_scope: ['llm'],
  gap_intervals: [
    {
      started_at: '2026-06-03T01:00:00.000Z',
      ended_at: '2026-06-03T01:15:00.000Z',
      scope: ['llm'],
      coverage: 'partial_scope',
    },
  ],
};

const modelUsageCapabilityBreakdown = [
  {
    label: 'llm',
    capability: 'llm',
    provider: 'openai',
    billing_model: 'gpt-smoke-regional-routing-snapshot-2026-08-05-with-a-very-long-model-name',
    meter: null,
    meter_total: null,
    local_day: null,
    known_priced_cost_cny: '8.250000000000',
    pricing_complete: false,
    unpriced_event_count: 1,
    measurement_health: modelUsageHealthFixture,
  },
  {
    label: 'embedding',
    capability: 'embedding',
    provider: 'openai',
    billing_model: 'text-embedding-smoke',
    meter: null,
    meter_total: null,
    local_day: null,
    known_priced_cost_cny: '1.020000000000',
    pricing_complete: true,
    unpriced_event_count: 0,
    measurement_health: modelUsageHealthFixture,
  },
  {
    label: 'rerank',
    capability: 'rerank',
    provider: 'dashscope',
    billing_model: 'rerank-smoke',
    meter: null,
    meter_total: null,
    local_day: null,
    known_priced_cost_cny: '0.300000000000',
    pricing_complete: true,
    unpriced_event_count: 0,
    measurement_health: modelUsageHealthFixture,
  },
  {
    label: 'stt',
    capability: 'stt',
    provider: 'openai',
    billing_model: 'stt-smoke',
    meter: null,
    meter_total: null,
    local_day: null,
    known_priced_cost_cny: '0.500000000000',
    pricing_complete: true,
    unpriced_event_count: 0,
    measurement_health: modelUsageHealthFixture,
  },
  {
    label: 'tts',
    capability: 'tts',
    provider: 'openai',
    billing_model: 'tts-smoke',
    meter: null,
    meter_total: null,
    local_day: null,
    known_priced_cost_cny: '0.275000000000',
    pricing_complete: true,
    unpriced_event_count: 0,
    measurement_health: modelUsageHealthFixture,
  },
  {
    label: 'realtime_audio',
    capability: 'realtime_audio',
    provider: 'dashscope',
    billing_model: 'realtime-smoke',
    meter: null,
    meter_total: null,
    local_day: null,
    known_priced_cost_cny: '0.800000000000',
    pricing_complete: true,
    unpriced_event_count: 0,
    measurement_health: modelUsageHealthFixture,
  },
  {
    label: 'image_generation',
    capability: 'image_generation',
    provider: 'openai',
    billing_model: 'image-smoke',
    meter: null,
    meter_total: null,
    local_day: null,
    known_priced_cost_cny: '1.200000000000',
    pricing_complete: true,
    unpriced_event_count: 0,
    measurement_health: modelUsageHealthFixture,
  },
];

const modelUsageProviderModelBreakdown = modelUsageCapabilityBreakdown.slice(0, 2).map((item) => ({
  ...item,
  label: `${item.provider} / ${item.billing_model}`,
  capability: null,
}));

const modelUsageMeterBreakdown = [{
  ...modelUsageCapabilityBreakdown[0],
  label: 'input_tokens',
  capability: null,
  provider: null,
  billing_model: null,
  meter: 'input_tokens',
  meter_total: '1600.000000',
}];

const modelUsageDailyBreakdown = [
  {
    ...modelUsageCapabilityBreakdown[0],
    label: '2026-07-03 / llm',
    local_day: '2026-07-03',
  },
  {
    ...modelUsageCapabilityBreakdown[1],
    label: '2026-07-18 / embedding',
    local_day: '2026-07-18',
  },
];

const modelUsagePolicyFixture = {
  version_number: 4,
  monthly_budget_cny: '80.000000000000',
  alerts_enabled: true,
  hard_limit_enabled: true,
  budget_alert_revision: 2,
  capability_limits: [
    {
      capability: 'llm',
      limit_kind: 'cost',
      meter: null,
      limit_value: '40.000000000000',
      enabled: true,
    },
  ],
  effective_at: '2026-06-01T00:00:00.000Z',
};

const modelUsageAlertsFixture = [
  {
    id: 'alert-model-usage-p0',
    period: '2026-06',
    threshold: '0.800000000000',
    budget_cny: '80.000000000000',
    settled_value: '64.000000000000',
    adjustment_value: '0.000000000000',
    effective_spend_cny: '64.500000000000',
    severity: 'critical',
    seen_at: null,
    dismissed_at: null,
    created_at: '2026-06-06T01:00:00.000Z',
  },
];

function modelUsageFamilyOverview(period) {
  return {
    family_id: family.id,
    scope: 'family',
    period,
    source: 'raw',
    is_partial_period: true,
    tracking_started_at: '2026-06-01T00:00:00.000Z',
    known_priced_cost_cny: '12.345000000000',
    pricing_complete: false,
    unpriced_event_count: 1,
    monthly_budget_cny: '80.000000000000',
    effective_spend_cny: '12.845000000000',
    reserved_cost_cny: '0.500000000000',
    hard_limit_enabled: true,
    meter_totals: [
      { meter: 'input_tokens', quantity: '3200.000000' },
      { meter: 'embedding_tokens', quantity: '1400.000000' },
      { meter: 'rerank_requests', quantity: '5.000000' },
      { meter: 'audio_input_seconds', quantity: '45.000000' },
      { meter: 'tts_characters', quantity: '128.000000' },
      { meter: 'generated_images', quantity: '2.000000' },
    ],
    measurement_health: modelUsageHealthFixture,
  };
}

function modelUsagePersonalOverview(period) {
  return {
    family_id: family.id,
    scope: 'me',
    period,
    source: 'raw',
    is_partial_period: true,
    tracking_started_at: '2026-06-01T00:00:00.000Z',
    known_priced_cost_cny: '3.210000000000',
    pricing_complete: false,
    unpriced_event_count: 1,
    family_budget_state: 'approaching_limit',
    meter_totals: [
      { meter: 'input_tokens', quantity: '800.000000' },
      { meter: 'embedding_tokens', quantity: '300.000000' },
      { meter: 'audio_input_seconds', quantity: '12.000000' },
    ],
    measurement_health: modelUsageHealthFixture,
  };
}

function modelUsageEmptyPersonalOverview(period) {
  return {
    family_id: family.id,
    scope: 'me',
    period,
    source: 'raw',
    is_partial_period: true,
    tracking_started_at: '2026-08-05T00:00:00.000Z',
    known_priced_cost_cny: '0.000000000000',
    pricing_complete: true,
    unpriced_event_count: 0,
    family_budget_state: 'sufficient',
    meter_totals: [],
    measurement_health: {
      exact_event_count: 0,
      estimated_event_count: 0,
      unpriced_event_count: 0,
      uncertain_attempt_count: 0,
      pending_attempt_count: 0,
      unresolved_unknown_execution_attempt_count: 0,
      conservative_estimated_cost_cny: null,
      known_unmeasured_attempt_count: 0,
      measurement_gap: false,
      measurement_gap_scope: [],
      gap_intervals: [],
    },
  };
}

function modelUsageFamilyBreakdown(period, groupBy) {
  return {
    family_id: family.id,
    scope: 'family',
    period,
    source: 'raw',
    is_partial_period: true,
    group_by: groupBy,
    items: modelUsageBreakdownItems(groupBy),
  };
}

function modelUsagePersonalBreakdown(period, groupBy) {
  return {
    family_id: family.id,
    scope: 'me',
    period,
    source: 'raw',
    is_partial_period: true,
    group_by: groupBy,
    items: modelUsageBreakdownItems(groupBy),
  };
}

function modelUsageBreakdownItems(groupBy) {
  if (groupBy === 'provider_model') return modelUsageProviderModelBreakdown;
  if (groupBy === 'meter') return modelUsageMeterBreakdown;
  if (groupBy === 'daily_capability_cost') return modelUsageDailyBreakdown;
  return modelUsageCapabilityBreakdown;
}

const modelUsageRequestLogsFixture = Array.from({ length: 23 }, (_, index) => {
  const isEmbedding = index % 3 === 1;
  const isRerank = index % 3 === 2;
  const capability = isEmbedding ? 'embedding' : isRerank ? 'rerank' : 'llm';
  const provider = isRerank ? 'dashscope' : 'openai-compatible';
  const billingModel = isEmbedding ? 'text-embedding-v4' : isRerank ? 'qwen3-rerank' : 'gpt-5.6-terra';
  const day = String(6 + (index % 4)).padStart(2, '0');
  return {
    id: `model-usage-request-${index + 1}`,
    occurred_at: `2026-08-${day}T0${index % 9}:40:00.000Z`,
    capability,
    provider,
    requested_model: billingModel,
    billing_model: billingModel,
    provider_request_id: `provider-request-${index + 1}`,
    subject_label: 'Smoke User',
    provider_outcome: 'succeeded',
    execution_certainty: 'confirmed',
    measurement_status: index === 2 ? 'estimated' : 'exact',
    pricing_status: index === 3 ? 'unpriced' : 'priced',
    cost_cny: index === 3 ? null : isEmbedding || isRerank ? '0.004000000000' : '0.080000000000',
    meters: isEmbedding
      ? [{ meter: 'embedding_tokens', quantity: '2048.000000' }]
      : isRerank
        ? [{ meter: 'input_tokens', quantity: '5360.000000' }]
        : [
            { meter: 'cached_input_tokens', quantity: '0.000000' },
            { meter: 'input_tokens', quantity: '6017.000000' },
            { meter: 'output_tokens', quantity: '38.000000' },
          ],
  };
});

function modelUsageRequestLogPage(url, scope) {
  const requestedDateFrom = url.searchParams.get('date_from') ?? '2026-08-01';
  const requestedDateTo = url.searchParams.get('date_to') ?? '2026-08-31';
  const capability = url.searchParams.get('capability');
  const provider = url.searchParams.get('provider')?.toLocaleLowerCase();
  const model = url.searchParams.get('model')?.toLocaleLowerCase();
  const dateFrom = requestedDateFrom;
  const dateTo = requestedDateTo;
  const status = url.searchParams.get('status');
  const limit = Number(url.searchParams.get('limit') ?? 20);
  const offset = Number(url.searchParams.get('offset') ?? 0);
  const items = modelUsageRequestLogsFixture.filter((item) => {
    const localDate = item.occurred_at.slice(0, 10);
    if (capability && item.capability !== capability) return false;
    if (provider && !item.provider.toLocaleLowerCase().includes(provider)) return false;
    if (model && !item.billing_model.toLocaleLowerCase().includes(model)) return false;
    if (dateFrom && localDate < dateFrom) return false;
    if (dateTo && localDate > dateTo) return false;
    if (status === 'priced' && item.pricing_status !== 'priced') return false;
    if (status === 'estimated' && item.measurement_status !== 'estimated') return false;
    if (status === 'unpriced' && item.pricing_status === 'priced') return false;
    if (status === 'needs_review' && item.provider_outcome === 'succeeded' && item.measurement_status !== 'estimated' && item.pricing_status === 'priced') return false;
    return true;
  });
  return {
    family_id: family.id,
    date_from: requestedDateFrom,
    date_to: requestedDateTo,
    scope,
    source: 'raw',
    items: items.slice(offset, offset + limit),
    total: items.length,
    limit,
    offset,
  };
}

function copyFixture(value) {
  return JSON.parse(JSON.stringify(value));
}

const p0Fixtures = {
  '/api/activity-highlights': activityHighlightsFixture,
  '/api/activity-logs': [],
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
  const modelUsageScenario = options.modelUsageScenario ?? 'owner';
  const requestedApiPaths = options.requestedApiPaths ?? null;
  let currentModelUsagePolicy = copyFixture(modelUsagePolicyFixture);
  let currentModelUsageAlerts = copyFixture(modelUsageAlertsFixture);
  let policyConflictIssued = false;
  const memberSession = {
    ...authResponse,
    membership: {
      ...membership,
      role: 'Member',
    },
  };

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
      await fulfillJson(route, modelUsageScenario === 'member' ? memberSession : authResponse);
      return;
    }

    if (request.method() === 'GET' && url.pathname === '/api/auth/me' && modelUsageScenario === 'member') {
      await fulfillJson(route, memberSession);
      return;
    }

    if (request.method() === 'GET' && url.pathname === '/api/members' && modelUsageScenario === 'member') {
      await fulfillJson(route, [{ ...member, role: 'Member' }]);
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

    if (request.method() === 'GET' && url.pathname === '/api/model-usage/family/overview') {
      await fulfillJson(route, modelUsageFamilyOverview(url.searchParams.get('period') ?? '2026-07'));
      return;
    }

    if (request.method() === 'GET' && url.pathname === '/api/model-usage/me/overview') {
      const period = url.searchParams.get('period') ?? '2026-07';
      await fulfillJson(route, modelUsageScenario === 'owner-empty-personal'
        ? modelUsageEmptyPersonalOverview(period)
        : modelUsagePersonalOverview(period));
      return;
    }

    if (request.method() === 'GET' && url.pathname === '/api/model-usage/family/breakdown') {
      await fulfillJson(route, modelUsageFamilyBreakdown(
        url.searchParams.get('period') ?? '2026-07',
        url.searchParams.get('group_by') ?? 'capability',
      ));
      return;
    }

    if (request.method() === 'GET' && url.pathname === '/api/model-usage/me/breakdown') {
      const breakdown = modelUsagePersonalBreakdown(
        url.searchParams.get('period') ?? '2026-07',
        url.searchParams.get('group_by') ?? 'capability',
      );
      await fulfillJson(route, modelUsageScenario === 'owner-empty-personal'
        ? { ...breakdown, items: [] }
        : breakdown);
      return;
    }

    if (request.method() === 'GET' && url.pathname === '/api/model-usage/family/requests') {
      await fulfillJson(route, modelUsageRequestLogPage(url, 'family'));
      return;
    }

    if (request.method() === 'GET' && url.pathname === '/api/model-usage/me/requests') {
      await fulfillJson(route, modelUsageRequestLogPage(url, 'me'));
      return;
    }

    if (request.method() === 'GET' && url.pathname === '/api/model-usage/family/policy') {
      await fulfillJson(route, currentModelUsagePolicy);
      return;
    }

    if (request.method() === 'GET' && url.pathname === '/api/model-usage/alerts') {
      await fulfillJson(route, currentModelUsageAlerts.filter((alert) => alert.dismissed_at === null));
      return;
    }

    if (request.method() === 'POST' && /^\/api\/model-usage\/alerts\/[^/]+\/(seen|dismiss)$/.test(url.pathname)) {
      const [, alertId, action] = /^\/api\/model-usage\/alerts\/([^/]+)\/(seen|dismiss)$/.exec(url.pathname) ?? [];
      const timestamp = '2026-06-06T02:00:00.000Z';
      currentModelUsageAlerts = currentModelUsageAlerts.map((alert) => alert.id === alertId
        ? {
          ...alert,
          seen_at: timestamp,
          dismissed_at: action === 'dismiss' ? timestamp : alert.dismissed_at,
        }
        : alert);
      const updated = currentModelUsageAlerts.find((alert) => alert.id === alertId);
      await fulfillJson(route, {
        alert_id: alertId,
        seen_at: updated?.seen_at ?? null,
        dismissed_at: updated?.dismissed_at ?? null,
      });
      return;
    }

    if (request.method() === 'PUT' && url.pathname === '/api/model-usage/family/policy') {
      let body = {};
      try {
        body = request.postDataJSON() ?? {};
      } catch {
        body = {};
      }
      const {
        base_version_number: _baseVersionNumber,
        confirm_missing_price_impact: _confirmMissingPriceImpact,
        ...changes
      } = body;
      if (modelUsageScenario === 'owner-conflict' && !policyConflictIssued) {
        policyConflictIssued = true;
        const currentPolicy = {
          ...currentModelUsagePolicy,
          version_number: currentModelUsagePolicy.version_number + 1,
          monthly_budget_cny: '96.000000000000',
        };
        currentModelUsagePolicy = currentPolicy;
        await fulfillJson(route, {
          detail: {
            code: 'model_usage_policy_conflict',
            current_policy: currentPolicy,
            current_version_number: currentPolicy.version_number,
            recovery_hint: 'review_current_policy_and_reapply',
          },
        }, 409);
        return;
      }
      currentModelUsagePolicy = {
        ...currentModelUsagePolicy,
        ...changes,
        version_number: currentModelUsagePolicy.version_number + 1,
        effective_at: '2026-06-06T02:00:00.000Z',
      };
      await fulfillJson(route, currentModelUsagePolicy);
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
    'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
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
