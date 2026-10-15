
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

const authSnapshot = {
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

function copyFixture(value) {
  return JSON.parse(JSON.stringify(value));
}

const FAMILY_MODEL_SETTINGS_PREFIX = '/api/family/model-settings';
const FAMILY_MODEL_WRITE_ONLY_FIELDS = new Set(['api_key', 'new_api_key', 'current_password']);

function familyModelProfile({
  id,
  displayName,
  adapterKind = 'openai_compatible_http',
  apiBaseUrl,
  websocketBaseUrl = null,
  credentialVersion = 1,
}) {
  return {
    id,
    display_name: displayName,
    adapter_kind: adapterKind,
    auth_mode: 'api_key',
    api_base_url: apiBaseUrl,
    websocket_base_url: websocketBaseUrl,
    options: { workspace_id: null, region: null, project_id: null },
    status: 'active',
    archived: false,
    version_number: 1,
    profile_version_number: 1,
    credential: {
      configured: true,
      version_number: credentialVersion,
      updated_at: now,
    },
    created_at: now,
    updated_at: now,
  };
}

function familyModelRate(capability, variantKey, meter, unitQuantity, unitPrice, profileId, model) {
  return {
    capability,
    variant_key: variantKey,
    meter,
    unit_quantity: unitQuantity,
    unit_price: unitPrice,
    source_currency: 'CNY',
    fx_to_cny: '1',
    reported_model_aliases: [model],
    provider_profile_id: profileId,
    billing_model: model,
    billing_scheme_key: `${capability}-fixture`,
    unit_price_cny: unitPrice,
  };
}

function configuredFamilyModelState() {
  const httpProfile = familyModelProfile({
    id: 'family-model-profile-http',
    displayName: '家庭主服务',
    apiBaseUrl: 'https://primary.example/v1',
  });
  const realtimeProfile = familyModelProfile({
    id: 'family-model-profile-realtime',
    displayName: '家庭实时服务',
    adapterKind: 'openai_realtime',
    apiBaseUrl: 'wss://realtime.example/v1',
    websocketBaseUrl: 'wss://realtime.example/v1',
  });
  const bindings = [
    {
      capability: 'llm', variant_key: 'primary', enabled: true, provider_profile_id: httpProfile.id,
      requested_model: 'culina-chat-v1', billing_scheme_key: 'llm-split-v1', max_output_tokens: 4096,
      supports_vision: true, prompt_cache_enabled: true,
    },
    {
      capability: 'image_generation', variant_key: 'text', enabled: true, provider_profile_id: httpProfile.id,
      requested_model: 'culina-image-v1', billing_scheme_key: 'image-count-v1', image_size: '1024x1024', response_format: 'b64_json',
    },
    {
      capability: 'stt', variant_key: 'default', enabled: true, provider_profile_id: httpProfile.id,
      requested_model: 'culina-stt-v1', billing_scheme_key: 'stt-seconds-v1', language_hint: 'zh', hotwords: [],
    },
    {
      capability: 'tts', variant_key: 'default', enabled: true, provider_profile_id: httpProfile.id,
      requested_model: 'culina-tts-v1', billing_scheme_key: 'tts-characters-v1', voice: 'warm', output_format: 'mp3',
    },
    {
      capability: 'realtime_audio', variant_key: 'default', enabled: true, provider_profile_id: realtimeProfile.id,
      requested_model: 'culina-realtime-v1', billing_scheme_key: 'realtime-asr-seconds-tts-characters-v1', voice: 'warm', language_hint: 'zh',
    },
    {
      capability: 'embedding', variant_key: 'search', enabled: true, provider_profile_id: httpProfile.id,
      requested_model: 'culina-embedding-v1', billing_scheme_key: 'embedding-token-v1', dimensions: 1536,
    },
    {
      capability: 'rerank', variant_key: 'search', enabled: true, provider_profile_id: httpProfile.id,
      requested_model: 'culina-rerank-v1', billing_scheme_key: 'rerank-token-v1', top_n: 20, instruction: null,
    },
  ];
  const rates = [
    familyModelRate('llm', 'primary', 'uncached_input_tokens', '1000000', '2.000000', httpProfile.id, 'culina-chat-v1'),
    familyModelRate('llm', 'primary', 'cached_input_tokens', '1000000', '1.000000', httpProfile.id, 'culina-chat-v1'),
    familyModelRate('llm', 'primary', 'output_tokens', '1000000', '6.000000', httpProfile.id, 'culina-chat-v1'),
    familyModelRate('image_generation', 'text', 'generated_images', '1', '0.120000', httpProfile.id, 'culina-image-v1'),
    familyModelRate('stt', 'default', 'audio_input_seconds', '60', '0.050000', httpProfile.id, 'culina-stt-v1'),
    familyModelRate('tts', 'default', 'tts_characters', '1000', '0.080000', httpProfile.id, 'culina-tts-v1'),
    familyModelRate('realtime_audio', 'default', 'audio_input_seconds', '60', '0.120000', realtimeProfile.id, 'culina-realtime-v1'),
    familyModelRate('realtime_audio', 'default', 'tts_characters', '1000', '0.120000', realtimeProfile.id, 'culina-realtime-v1'),
    familyModelRate('embedding', 'search', 'embedding_tokens', '1000000', '0.500000', httpProfile.id, 'culina-embedding-v1'),
    familyModelRate('rerank', 'search', 'input_tokens', '1000000', '0.800000', httpProfile.id, 'culina-rerank-v1'),
  ];
  const payload = {
    base_config_revision_id: 'family-model-config-v1',
    search_profile_id: 'family-search-profile-active',
    bindings,
    price_rates: rates.map(({ provider_profile_id, billing_model, billing_scheme_key, unit_price_cny, ...rate }) => rate),
    price_draft: null,
    change_note: 'fixture configured family model settings',
  };
  return {
    settings: {
      version_number: 3,
      active_config_revision_id: 'family-model-config-v1',
      active_price_version_id: 'family-model-price-v1',
      active_search_profile_id: 'family-search-profile-active',
      provider_profiles: [httpProfile, realtimeProfile],
      updated_at: now,
    },
    draft: {
      base_config_revision_id: 'family-model-config-v1',
      draft_version_number: 4,
      payload,
      validation_status: 'valid',
      validation_errors: [],
      updated_at: now,
    },
    prices: {
      active_config_revision_id: 'family-model-config-v1',
      active_price_version_id: 'family-model-price-v1',
      current_rates: rates,
      history: [{
        id: 'family-model-price-v1',
        config_revision_id: 'family-model-config-v1',
        search_profile_id: 'family-search-profile-active',
        base_price_version_id: null,
        purpose: 'active',
        version_number: 1,
        checksum: 'fixture-price-checksum-v1',
        change_note: 'fixture active price',
        published_by: user.id,
        published_at: now,
      }],
      draft: null,
    },
  };
}

function createFamilyModelMockState(scenario) {
  const baseline = configuredFamilyModelState();
  if (scenario === 'qwen-tts') {
    const profile = familyModelProfile({
      id: 'family-model-profile-dashscope', displayName: '百炼语音服务', adapterKind: 'dashscope',
      apiBaseUrl: 'https://dashscope.aliyuncs.com/api/v1', websocketBaseUrl: 'wss://dashscope.aliyuncs.com/api-ws/v1',
    });
    baseline.settings.provider_profiles.push(profile);
    const binding = baseline.draft.payload.bindings.find((item) => item.capability === 'tts');
    Object.assign(binding, { provider_profile_id: profile.id, requested_model: 'qwen3-tts-flash', output_format: 'mp3' });
    for (const rate of baseline.prices.current_rates.filter((item) => item.capability === 'tts')) {
      Object.assign(rate, { provider_profile_id: profile.id, billing_model: binding.requested_model, reported_model_aliases: [binding.requested_model] });
    }
    for (const rate of baseline.draft.payload.price_rates.filter((item) => item.capability === 'tts')) {
      rate.reported_model_aliases = [binding.requested_model];
    }
  }
  return {
    ...baseline,
  };
}

function requestJson(request) {
  try {
    return request.postDataJSON() ?? {};
  } catch {
    return {};
  }
}

function redactFamilyModelRequest(value) {
  if (Array.isArray(value)) return value.map(redactFamilyModelRequest);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    FAMILY_MODEL_WRITE_ONLY_FIELDS.has(key) ? '[write-only]' : redactFamilyModelRequest(item),
  ]));
}

function recordFamilyModelRequest(records, request, url, body) {
  if (!records) return;
  records.push({
    method: request.method(),
    pathname: url.pathname,
    body: redactFamilyModelRequest(body),
  });
}

function bumpFamilyModelSettingsVersion(state) {
  state.settings.version_number += 1;
  state.settings.updated_at = now;
}

function familyModelReplacement(status) {
  return {
    profile_id: 'family-search-replacement-fixture',
    status,
    total_documents: 42,
    indexed_documents: status === 'failed' ? 19 : status === 'active' ? 42 : 24,
    failed_documents: status === 'failed' ? 2 : 0,
    budget_blocked_documents: 0,
    retryable: status === 'failed',
    created_at: now,
    activated_at: status === 'active' ? now : null,
    ...(status === 'failed' ? {
      failure: {
        code: 'search_embedding_provider_rejected',
        detail: '嵌入服务拒绝了请求（HTTP 400）',
        provider_http_status: 400,
        provider_error_code: 'invalid_request',
        provider_error_message: 'dimensions is not supported',
        request_sent: true,
        execution_certainty: 'confirmed_not_executed',
      },
    } : {}),
  };
}

async function fulfillFamilyModelSettingsMock({
  route,
  request,
  url,
  state,
  isMember,
  familyModelRequests,
}) {
  if (url.pathname !== FAMILY_MODEL_SETTINGS_PREFIX && !url.pathname.startsWith(`${FAMILY_MODEL_SETTINGS_PREFIX}/`)) {
    return false;
  }

  const body = request.method() === 'GET' ? {} : requestJson(request);
  recordFamilyModelRequest(familyModelRequests, request, url, body);

  if (isMember) {
    await fulfillJson(route, { detail: { code: 'family_model_owner_required' } }, 403);
    return true;
  }

  if (request.method() === 'GET' && url.pathname === FAMILY_MODEL_SETTINGS_PREFIX) {
    await fulfillJson(route, copyFixture(state.settings));
    return true;
  }
  if (request.method() === 'GET' && url.pathname === `${FAMILY_MODEL_SETTINGS_PREFIX}/draft`) {
    await fulfillJson(route, copyFixture(state.draft));
    return true;
  }
  if (request.method() === 'GET' && url.pathname === `${FAMILY_MODEL_SETTINGS_PREFIX}/prices`) {
    await fulfillJson(route, copyFixture(state.prices));
    return true;
  }

  if (request.method() === 'PUT' && url.pathname === `${FAMILY_MODEL_SETTINGS_PREFIX}/draft`) {
    if (body.base_draft_version_number !== state.draft.draft_version_number) {
      await fulfillJson(route, {
        detail: {
          code: 'family_model_settings_version_conflict',
          current_draft_version_number: state.draft.draft_version_number,
        },
      }, 409);
      return true;
    }
    const { base_draft_version_number: _baseDraftVersion, idempotency_key: _idempotencyKey, ...payload } = body;
    const nextDraftVersion = state.draft.draft_version_number + 1;
    const nextConfigRevisionId = `family-model-config-v${nextDraftVersion}`;
    const nextPriceVersionId = `family-model-price-v${nextDraftVersion}`;
    state.draft = {
      ...state.draft,
      base_config_revision_id: nextConfigRevisionId,
      draft_version_number: nextDraftVersion,
      payload: copyFixture({ ...payload, base_config_revision_id: nextConfigRevisionId }),
      validation_status: 'valid',
      validation_errors: [],
      updated_at: now,
    };
    state.settings.active_config_revision_id = nextConfigRevisionId;
    state.settings.active_price_version_id = nextPriceVersionId;
    bumpFamilyModelSettingsVersion(state);
    await fulfillJson(route, copyFixture(state.draft));
    return true;
  }
  const profileAction = new RegExp(`^${FAMILY_MODEL_SETTINGS_PREFIX}/provider-profiles/([^/]+)/(models)$`).exec(url.pathname);
  if (profileAction && request.method() === 'GET') {
    const [, profileId] = profileAction;
    const profile = state.settings.provider_profiles.find((item) => item.id === profileId);
    if (!profile) {
      await fulfillJson(route, { detail: { code: 'family_model_provider_not_found' } }, 404);
      return true;
    }
    await fulfillJson(route, {
      status: 'reachable',
      detail: null,
      checked_at: now,
      latency_ms: 18,
      profile_version_number: profile.profile_version_number,
      models: profile.adapter_kind === 'openai_compatible_http'
        ? [
          'culina-chat-v1',
          'culina-chat-v2',
          'culina-image-v1',
          'culina-stt-v1',
          'culina-tts-v1',
          'culina-embedding-v1',
          'culina-rerank-v1',
        ]
        : [],
    });
    return true;
  }

  const capabilityTest = new RegExp(`^${FAMILY_MODEL_SETTINGS_PREFIX}/capabilities/([^/]+)/test$`).exec(url.pathname);
  if (request.method() === 'POST' && capabilityTest) {
    const capability = capabilityTest[1];
    await fulfillJson(route, {
      capability,
      variant_key: body.variant_key,
      status: 'succeeded',
      detail: 'fixture call completed',
      checked_at: now,
    });
    return true;
  }

  if (request.method() === 'GET' && url.pathname === `${FAMILY_MODEL_SETTINGS_PREFIX}/search/replacements/current`) {
    await fulfillJson(route, null);
    return true;
  }
  if (request.method() === 'GET' && url.pathname === `${FAMILY_MODEL_SETTINGS_PREFIX}/search/replacements/${state.settings.active_search_profile_id}`) {
    await fulfillJson(route, { ...familyModelReplacement('active'), profile_id: state.settings.active_search_profile_id });
    return true;
  }

  return false;
}

const p0Fixtures = {
  '/api/activity-highlights': activityHighlightsFixture,
  '/api/activity-logs': [],
  '/api/ai/conversations': [],
  '/api/ai/status': {
    configured: true,
    enabled: true,
    supports_vision: false,
    status: 'ready',
    detail: 'AI 已就绪。',
    capabilities: {},
  },
  '/api/auth/me': authSnapshot,
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
  const familyModelScenario = options.familyModelScenario ?? 'configured';
  const requestedApiPaths = options.requestedApiPaths ?? null;
  const familyModelRequests = options.familyModelRequests ?? null;
  const mealLogs = copyFixture(p0Fixtures['/api/meal-logs']);
  const mealRecordRequests = options.mealRecordRequests ?? [];
  let refreshSessionActive = options.authenticated ?? true;
  let refreshGeneration = 1;
  const familyModelState = createFamilyModelMockState(familyModelScenario);
  const isMemberScenario = options.role === 'Member';
  const memberSession = {
    ...authResponse,
    membership: {
      ...membership,
      role: 'Member',
    },
  };
  const memberSnapshot = {
    ...authSnapshot,
    membership: memberSession.membership,
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
      refreshSessionActive = true;
      refreshGeneration += 1;
      await fulfillJson(
        route,
        isMemberScenario ? memberSession : authResponse,
        200,
        refreshCookieHeaders(refreshGeneration),
      );
      return;
    }

    if (request.method() === 'POST' && url.pathname === '/api/auth/refresh') {
      const hasRefreshCookie = (request.headers().cookie ?? '').includes('culina-refresh=');
      if (!refreshSessionActive || !hasRefreshCookie) {
        await fulfillJson(
          route,
          { detail: { code: 'refresh_session_invalid', message: '登录已过期，请重新登录' } },
          401,
          clearRefreshCookieHeaders(),
        );
        return;
      }
      refreshGeneration += 1;
      await fulfillJson(
        route,
        isMemberScenario ? memberSession : authResponse,
        200,
        refreshCookieHeaders(refreshGeneration),
      );
      return;
    }

    if (request.method() === 'GET' && url.pathname === '/api/auth/me' && isMemberScenario) {
      await fulfillJson(route, memberSnapshot);
      return;
    }

    if (request.method() === 'GET' && url.pathname === '/api/members' && isMemberScenario) {
      await fulfillJson(route, [{ ...member, role: 'Member' }]);
      return;
    }

    if (await fulfillFamilyModelSettingsMock({
      route,
      request,
      url,
      state: familyModelState,
      isMember: isMemberScenario,
      familyModelRequests,
    })) {
      return;
    }

    if (request.method() === 'GET' && url.pathname === '/api/meal-logs') {
      await fulfillJson(route, mealLogs);
      return;
    }

    if (request.method() === 'POST' && url.pathname === '/api/meal-logs/record') {
      let body = {};
      try {
        body = request.postDataJSON() ?? {};
      } catch {
        body = {};
      }
      mealRecordRequests.push(body);
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
      const result = {
        meal_log: {
          id: `meal-p0-recorded-${mealRecordRequests.length}`,
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
          id: `operation-p0-recorded-${mealRecordRequests.length}`,
          status: 'applied',
          revertible_until: '2026-07-12T01:15:00.000Z',
          can_revert: true,
          created_entry_ids: createdEntries.map((entry) => entry.id),
        },
        completed_plan_item_ids: [],
      };
      mealLogs.push(result.meal_log);
      await fulfillJson(route, result);
      return;
    }

    if (request.method() === 'GET' && url.pathname === '/api/model-usage/alerts') {
      await fulfillJson(route, modelUsageAlertsFixture);
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

  return { requestedApiPaths, familyModelRequests };
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization,content-type',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
  };
}

function refreshCookieHeaders(generation) {
  return {
    'Set-Cookie': `culina-refresh=smoke-refresh-${generation}; Path=/api/auth; HttpOnly; SameSite=Strict`,
  };
}

function clearRefreshCookieHeaders() {
  return {
    'Set-Cookie': 'culina-refresh=; Max-Age=0; Path=/api/auth; HttpOnly; SameSite=Strict',
  };
}

async function fulfillJson(route, body, status = 200, headers = {}) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    headers: { ...corsHeaders(), ...headers },
    body: JSON.stringify(body),
  });
}
