import { buildStarterRecommendations } from './mockAi';
import { buildMeta, createId, makeActivity, nowIso, todayKey } from './helpers';
import type {
  AppState,
  Family,
  Food,
  Ingredient,
  InventoryItem,
  MealLog,
  Membership,
  OnboardingPayload,
  Recipe,
  ShoppingListItem,
  User
} from './types';

function buildUser(name: string, role: 'Owner' | 'Member', familyId: string): { user: User; membership: Membership } {
  const meta = buildMeta('system', 'user');
  const user: User = {
    ...meta,
    name,
    avatarSeed: name,
    email: `${name.toLowerCase().replace(/\s+/g, '')}@culina.demo`
  };
  const membership: Membership = {
    ...buildMeta('system', 'membership'),
    familyId,
    userId: user.id,
    role,
    status: 'active'
  };
  return { user, membership };
}

export function createInitialState(payload?: OnboardingPayload): AppState {
  const familyMeta = buildMeta('system', 'family');
  const family: Family = {
    ...familyMeta,
    name: payload?.familyName ?? '星星家的厨房',
    motto: '今天吃得好，明天更有劲儿',
    location: '上海'
  };

  const ownerName = payload?.ownerName ?? '林然';
  const extraMembers = payload?.members?.filter(Boolean) ?? ['安安', '爷爷'];
  const userBundle = [buildUser(ownerName, 'Owner', family.id), ...extraMembers.map((name) => buildUser(name, 'Member', family.id))];
  const users = userBundle.map((item) => item.user);
  const memberships = userBundle.map((item) => item.membership);
  const ownerId = users[0].id;

  const ingredients: Ingredient[] = [
    {
      ...buildMeta(ownerId, 'ingredient'),
      familyId: family.id,
      name: '番茄',
      category: '蔬菜',
      defaultUnit: '个',
      defaultStorage: '冷藏',
      notes: '适合做番茄炒蛋、汤面'
    },
    {
      ...buildMeta(ownerId, 'ingredient'),
      familyId: family.id,
      name: '鸡蛋',
      category: '蛋奶',
      defaultUnit: '个',
      defaultStorage: '冷藏',
      notes: '早餐和家常菜高频使用'
    },
    {
      ...buildMeta(ownerId, 'ingredient'),
      familyId: family.id,
      name: '青椒',
      category: '蔬菜',
      defaultUnit: '个',
      defaultStorage: '冷藏',
      notes: '适合搭配肉片和鸡蛋'
    },
    {
      ...buildMeta(ownerId, 'ingredient'),
      familyId: family.id,
      name: '三文鱼',
      category: '水产',
      defaultUnit: '块',
      defaultStorage: '冷冻',
      notes: '适合煎烤或蒸制'
    },
    {
      ...buildMeta(ownerId, 'ingredient'),
      familyId: family.id,
      name: '米饭',
      category: '主食',
      defaultUnit: '份',
      defaultStorage: '常温',
      notes: '主食基础库存'
    }
  ];

  const inventoryItems: InventoryItem[] = [
    {
      ...buildMeta(ownerId, 'inventory'),
      familyId: family.id,
      ingredientId: ingredients[0].id,
      quantity: 2,
      unit: '个',
      status: 'fresh',
      purchaseDate: todayKey(),
      expiryDate: new Date(Date.now() + 1000 * 60 * 60 * 24 * 2).toISOString().slice(0, 10),
      storageLocation: '冷藏',
      notes: '适合优先做熟食',
      lowStockThreshold: 3
    },
    {
      ...buildMeta(ownerId, 'inventory'),
      familyId: family.id,
      ingredientId: ingredients[1].id,
      quantity: 8,
      unit: '个',
      status: 'fresh',
      purchaseDate: todayKey(),
      expiryDate: new Date(Date.now() + 1000 * 60 * 60 * 24 * 5).toISOString().slice(0, 10),
      storageLocation: '冷藏',
      notes: '',
      lowStockThreshold: 4
    },
    {
      ...buildMeta(ownerId, 'inventory'),
      familyId: family.id,
      ingredientId: ingredients[2].id,
      quantity: 1,
      unit: '个',
      status: 'expiring',
      purchaseDate: todayKey(),
      expiryDate: new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString().slice(0, 10),
      storageLocation: '冷藏',
      notes: '明天前吃掉口感更好',
      lowStockThreshold: 2
    },
    {
      ...buildMeta(ownerId, 'inventory'),
      familyId: family.id,
      ingredientId: ingredients[3].id,
      quantity: 2,
      unit: '块',
      status: 'frozen',
      purchaseDate: todayKey(),
      expiryDate: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString().slice(0, 10),
      storageLocation: '冷冻',
      notes: '',
      lowStockThreshold: 1
    },
    {
      ...buildMeta(ownerId, 'inventory'),
      familyId: family.id,
      ingredientId: ingredients[4].id,
      quantity: 4,
      unit: '份',
      status: 'fresh',
      purchaseDate: todayKey(),
      storageLocation: '常温',
      notes: '',
      lowStockThreshold: 2
    }
  ];

  const recipeTomatoEgg: Recipe = {
    ...buildMeta(ownerId, 'recipe'),
    familyId: family.id,
    title: '番茄炒蛋',
    servings: 2,
    prepMinutes: 18,
    difficulty: 'easy',
    ingredientItems: [
      {
        id: createId('recipe-ingredient'),
        ingredientId: ingredients[0].id,
        ingredientName: '番茄',
        quantity: 2,
        unit: '个',
        note: '切块'
      },
      {
        id: createId('recipe-ingredient'),
        ingredientId: ingredients[1].id,
        ingredientName: '鸡蛋',
        quantity: 3,
        unit: '个',
        note: '打散'
      },
      {
        id: createId('recipe-ingredient'),
        ingredientId: ingredients[2].id,
        ingredientName: '青椒',
        quantity: 1,
        unit: '个',
        note: '可选增加清爽度'
      }
    ],
    steps: [
      {
        id: createId('step'),
        title: '炒鸡蛋',
        text: '先炒鸡蛋到七分熟盛出备用。',
        icon: 'pan',
        summary: '热锅下油，快速翻炒蛋液。',
        estimatedMinutes: 6,
        tip: '火力中大，避免久炒导致口感变老。',
        keyPoints: ['鸡蛋充分打散，炒出来更蓬松。', '油稍多一些，鸡蛋更嫩滑。', '蛋液刚凝固立刻盛出，避免过老。']
      },
      {
        id: createId('step'),
        title: '炒番茄',
        text: '番茄翻炒出汁后回锅鸡蛋，最后再下青椒。',
        icon: 'tomato',
        summary: '番茄炒出汁后回锅鸡蛋。',
        estimatedMinutes: 7,
        tip: '番茄先炒软，汤汁会更自然。',
        keyPoints: ['番茄切块后先下锅。', '出汁后再放鸡蛋。', '青椒最后下，保持清爽。']
      },
      {
        id: createId('step'),
        title: '调味出锅',
        text: '根据家庭口味补盐或一点糖提鲜。',
        icon: 'bowl',
        summary: '调味均匀即可出锅。',
        estimatedMinutes: 3,
        tip: '少量糖可以平衡番茄酸味。',
        keyPoints: ['先尝味再加盐。', '翻炒均匀即可。', '出锅前保持锅内有少量汁水。']
      }
    ],
    tips: '如果想更清淡，减少油量并延长小火翻炒时间。',
    sceneTags: ['工作日晚餐', '孩子也能吃'],
    images: []
  };

  const recipeSalmon: Recipe = {
    ...buildMeta(ownerId, 'recipe'),
    familyId: family.id,
    title: '清蒸三文鱼',
    servings: 2,
    prepMinutes: 25,
    difficulty: 'medium',
    ingredientItems: [
      {
        id: createId('recipe-ingredient'),
        ingredientId: ingredients[3].id,
        ingredientName: '三文鱼',
        quantity: 1,
        unit: '块',
        note: '提前解冻'
      },
      {
        id: createId('recipe-ingredient'),
        ingredientId: ingredients[2].id,
        ingredientName: '青椒',
        quantity: 0.5,
        unit: '个',
        note: '切丝点缀'
      },
      {
        id: createId('recipe-ingredient'),
        ingredientId: ingredients[4].id,
        ingredientName: '米饭',
        quantity: 2,
        unit: '份',
        note: '搭配主食'
      }
    ],
    steps: [
      {
        id: createId('step'),
        title: '蒸鱼',
        text: '三文鱼调味后冷水上锅蒸 8-10 分钟。',
        icon: 'timer',
        summary: '冷水上锅蒸熟。',
        estimatedMinutes: 10,
        tip: '鱼肉刚熟最嫩，不要久蒸。',
        keyPoints: ['表面薄薄调味。', '水开后计时更稳定。']
      },
      {
        id: createId('step'),
        title: '淋油提香',
        text: '出锅后搭配青椒丝和热油提香。',
        icon: 'plate',
        summary: '热油激香后装盘。',
        estimatedMinutes: 3,
        tip: '热油少量即可。',
        keyPoints: ['青椒丝铺在鱼肉上。', '淋油后马上上桌。']
      }
    ],
    tips: '适合安排在周末或家庭轻食日晚餐。',
    sceneTags: ['周末轻食', '高蛋白'],
    images: []
  };

  const foods: Food[] = [
    {
      ...buildMeta(ownerId, 'food'),
      familyId: family.id,
      name: '番茄炒蛋',
      type: 'selfMade',
      category: '家常菜',
      flavorTags: ['酸甜', '下饭'],
      sourceName: '家庭厨房',
      scene: '晚餐',
      images: [],
      notes: '适合工作日快速安排',
      favorite: true,
      recipeId: recipeTomatoEgg.id
    },
    {
      ...buildMeta(ownerId, 'food'),
      familyId: family.id,
      name: '清蒸三文鱼',
      type: 'selfMade',
      category: '轻食',
      flavorTags: ['清淡', '高蛋白'],
      sourceName: '家庭厨房',
      scene: '周末晚餐',
      images: [],
      notes: '适合库存里有三文鱼时安排',
      favorite: false,
      recipeId: recipeSalmon.id
    },
    {
      ...buildMeta(ownerId, 'food'),
      familyId: family.id,
      name: '小龙虾外卖套餐',
      type: 'takeout',
      category: '夜宵',
      flavorTags: ['香辣'],
      sourceName: '夜宵小馆',
      scene: '周末聚餐',
      images: [],
      notes: '适合多人一起吃',
      favorite: true
    },
    {
      ...buildMeta(ownerId, 'food'),
      familyId: family.id,
      name: '社区食堂午餐',
      type: 'diningOut',
      category: '午餐',
      flavorTags: ['省心'],
      sourceName: '幸福食堂',
      scene: '工作日午餐',
      images: [],
      notes: '记录外出吃饭体验',
      favorite: false
    },
    {
      ...buildMeta(ownerId, 'food'),
      familyId: family.id,
      name: '无糖酸奶',
      type: 'packaged',
      category: '早餐',
      flavorTags: ['清爽'],
      sourceName: '鲜活牧场',
      scene: '早餐 / 加餐',
      images: [],
      notes: '适合配水果',
      favorite: false
    }
  ];

  const shoppingList: ShoppingListItem[] = [
    {
      ...buildMeta(ownerId, 'shopping'),
      familyId: family.id,
      title: '番茄',
      quantity: 4,
      unit: '个',
      reason: '补充本周家常菜库存',
      done: false
    }
  ];

  const mealLogs: MealLog[] = [
    {
      ...buildMeta(ownerId, 'meal'),
      familyId: family.id,
      date: todayKey(),
      mealType: 'dinner',
      foodEntries: [
        { id: createId('meal-food'), foodId: foods[0].id, servings: 2, note: '今天做得更清淡' },
        { id: createId('meal-food'), foodId: foods[4].id, servings: 2, note: '餐后加餐' }
      ],
      participantUserIds: users.slice(0, 2).map((user) => user.id),
      notes: '孩子更喜欢番茄多一点的版本。',
      mood: '满足',
      photos: [],
      deductionSuggestions: [
        {
          id: createId('suggestion'),
          ingredientName: '番茄',
          suggestedAmount: 2,
          unit: '个',
          basedOnFoodName: '番茄炒蛋'
        },
        {
          id: createId('suggestion'),
          ingredientName: '鸡蛋',
          suggestedAmount: 3,
          unit: '个',
          basedOnFoodName: '番茄炒蛋'
        }
      ]
    }
  ];

  const activityLogs = [
    makeActivity(family.id, ownerId, 'create', 'Family', family.id, `创建家庭 ${family.name}`),
    makeActivity(family.id, ownerId, 'invite', 'Membership', memberships[1].id, `邀请 ${users[1]?.name} 加入家庭`),
    makeActivity(family.id, ownerId, 'create', 'Recipe', recipeTomatoEgg.id, '新增菜谱 番茄炒蛋'),
    makeActivity(family.id, ownerId, 'create', 'MealLog', mealLogs[0].id, '记录了一顿晚餐')
  ];

  const state: AppState = {
    family,
    users,
    memberships,
    foods,
    recipes: [recipeTomatoEgg, recipeSalmon],
    ingredients,
    inventoryItems,
    shoppingList,
    mealLogs,
    activityLogs,
    aiConversations: [],
    aiRecommendations: [],
    currentUserId: ownerId
  };

  return {
    ...state,
    aiRecommendations: buildStarterRecommendations(state)
  };
}
