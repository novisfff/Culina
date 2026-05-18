import { runAiConversation } from './mockAi';
import { createInitialState } from './seed';
import { buildMeta, makeActivity, sortLogs, sortByUpdatedAtDesc, splitTags, STORAGE_KEY, todayKey } from './helpers';
import type {
  AIConversation,
  AIRecommendation,
  AppState,
  Food,
  FoodType,
  ImageInputValue,
  Ingredient,
  InventoryItem,
  MealLog,
  Membership,
  OnboardingPayload,
  PhotoAsset,
  Recipe,
  RecipeIngredient,
  ShoppingListItem,
  User
} from './types';

function updateEntityMeta<T extends { updatedAt: string; updatedBy: string }>(entity: T, userId: string): T {
  return {
    ...entity,
    updatedAt: new Date().toISOString(),
    updatedBy: userId
  };
}

function getCurrentUser(state: AppState): User {
  const currentUser = state.users.find((user) => user.id === state.currentUserId);
  if (!currentUser) {
    throw new Error('Current user not found');
  }
  return currentUser;
}

function addActivity(state: AppState, summary: {
  action: 'create' | 'update' | 'invite' | 'switch';
  entityType: string;
  entityId: string;
  summary: string;
  actorId?: string;
}): AppState {
  return {
    ...state,
    activityLogs: [
      makeActivity(
        state.family.id,
        summary.actorId ?? state.currentUserId,
        summary.action,
        summary.entityType,
        summary.entityId,
        summary.summary
      ),
      ...state.activityLogs
    ]
  };
}

function normalizeImages(images: ImageInputValue): PhotoAsset[] {
  return images.generatedAsset ? [images.generatedAsset] : [];
}

function buildMealSuggestions(state: AppState, foodEntries: MealLog['foodEntries']) {
  return foodEntries.flatMap((entry) => {
    const food = state.foods.find((item) => item.id === entry.foodId);
    if (!food?.recipeId) {
      return [];
    }
    const recipe = state.recipes.find((item) => item.id === food.recipeId);
    if (!recipe) {
      return [];
    }
    return recipe.ingredientItems.map((item) => ({
      id: `${entry.id}-${item.id}`,
      ingredientName: item.ingredientName,
      suggestedAmount: Number((item.quantity * entry.servings).toFixed(1)),
      unit: item.unit,
      basedOnFoodName: food.name
    }));
  });
}

export type AppAction =
  | { type: 'bootstrap'; payload?: OnboardingPayload }
  | { type: 'switchUser'; userId: string }
  | {
      type: 'inviteMember';
      payload: {
        name: string;
        role: 'Owner' | 'Member';
        email?: string;
      };
    }
  | {
      type: 'addIngredient';
      payload: {
        name: string;
        category: string;
        defaultUnit: string;
        defaultStorage: string;
        notes: string;
        images: ImageInputValue;
      };
    }
  | {
      type: 'addInventoryItem';
      payload: {
        ingredientId: string;
        quantity: number;
        unit: string;
        status: InventoryItem['status'];
        purchaseDate: string;
        expiryDate?: string;
        storageLocation: string;
        notes: string;
        lowStockThreshold: number;
      };
    }
  | {
      type: 'addShoppingItem';
      payload: {
        title: string;
        quantity: number;
        unit: string;
        reason: string;
      };
    }
  | { type: 'toggleShoppingItem'; itemId: string }
  | {
      type: 'addRecipe';
      payload: {
        title: string;
        servings: number;
        prepMinutes: number;
        difficulty: Recipe['difficulty'];
        ingredientItems: RecipeIngredient[];
        steps: Array<{ title: string; text: string }>;
        tips: string;
        sceneTags: string[];
        images: ImageInputValue;
        autoCreateFood: boolean;
      };
    }
  | {
      type: 'addFood';
      payload: {
        name: string;
        type: FoodType;
        category: string;
        flavorTags: string[];
        sourceName: string;
        scene: string;
        notes: string;
        favorite: boolean;
        recipeId?: string;
        images: ImageInputValue;
      };
    }
  | { type: 'toggleFoodFavorite'; foodId: string }
  | {
      type: 'addMealLog';
      payload: {
        date: string;
        mealType: MealLog['mealType'];
        foodEntries: MealLog['foodEntries'];
        participantUserIds: string[];
        notes: string;
        mood: string;
        photos: ImageInputValue;
      };
    }
  | {
      type: 'runAi';
      payload: {
        mode: AIConversation['mode'];
        prompt: string;
        foodId?: string;
        ingredientIds?: string[];
      };
    }
  | { type: 'resetDemo' };

export function appReducer(state: AppState, action: AppAction): AppState {
  if (action.type === 'bootstrap') {
    return createInitialState(action.payload);
  }

  if (action.type === 'resetDemo') {
    return createInitialState();
  }

  if (action.type === 'switchUser') {
    const user = state.users.find((entry) => entry.id === action.userId);
    if (!user) {
      return state;
    }
    return addActivity(
      {
        ...state,
        currentUserId: user.id
      },
      {
        action: 'switch',
        entityType: 'User',
        entityId: user.id,
        summary: `${user.name} 正在操作家庭厨房`,
        actorId: user.id
      }
    );
  }

  if (action.type === 'inviteMember') {
    const userMeta = buildMeta(state.currentUserId, 'user');
    const user: User = {
      ...userMeta,
      name: action.payload.name,
      email: action.payload.email,
      avatarSeed: action.payload.name
    };
    const membership: Membership = {
      ...buildMeta(state.currentUserId, 'membership'),
      familyId: state.family.id,
      userId: user.id,
      role: action.payload.role,
      status: 'active'
    };
    return addActivity(
      {
        ...state,
        users: sortByUpdatedAtDesc([...state.users, user]),
        memberships: [...state.memberships, membership]
      },
      {
        action: 'invite',
        entityType: 'Membership',
        entityId: membership.id,
        summary: `邀请 ${user.name} 成为${action.payload.role === 'Owner' ? '管理员' : '成员'}`
      }
    );
  }

  if (action.type === 'addIngredient') {
    const ingredient: Ingredient = {
      ...buildMeta(state.currentUserId, 'ingredient'),
      familyId: state.family.id,
      name: action.payload.name,
      category: action.payload.category,
      defaultUnit: action.payload.defaultUnit,
      defaultStorage: action.payload.defaultStorage,
      notes: action.payload.notes,
      image: normalizeImages(action.payload.images)[0]
    };

    return addActivity(
      {
        ...state,
        ingredients: sortByUpdatedAtDesc([ingredient, ...state.ingredients])
      },
      {
        action: 'create',
        entityType: 'Ingredient',
        entityId: ingredient.id,
        summary: `新增食材 ${ingredient.name}`
      }
    );
  }

  if (action.type === 'addInventoryItem') {
    const inventoryItem: InventoryItem = {
      ...buildMeta(state.currentUserId, 'inventory'),
      familyId: state.family.id,
      ...action.payload
    };
    const ingredient = state.ingredients.find((item) => item.id === action.payload.ingredientId);
    return addActivity(
      {
        ...state,
        inventoryItems: sortByUpdatedAtDesc([inventoryItem, ...state.inventoryItems])
      },
      {
        action: 'create',
        entityType: 'InventoryItem',
        entityId: inventoryItem.id,
        summary: `录入库存 ${ingredient?.name ?? '食材'} ${inventoryItem.quantity}${inventoryItem.unit}`
      }
    );
  }

  if (action.type === 'addShoppingItem') {
    const item: ShoppingListItem = {
      ...buildMeta(state.currentUserId, 'shopping'),
      familyId: state.family.id,
      done: false,
      ...action.payload
    };
    return addActivity(
      {
        ...state,
        shoppingList: [item, ...state.shoppingList]
      },
      {
        action: 'create',
        entityType: 'ShoppingListItem',
        entityId: item.id,
        summary: `加入购物清单 ${item.title}`
      }
    );
  }

  if (action.type === 'toggleShoppingItem') {
    const shoppingList = state.shoppingList.map((item) =>
      item.id === action.itemId
        ? updateEntityMeta(
            {
              ...item,
              done: !item.done
            },
            state.currentUserId
          )
        : item
    );
    const target = shoppingList.find((item) => item.id === action.itemId);
    return addActivity(
      {
        ...state,
        shoppingList
      },
      {
        action: 'update',
        entityType: 'ShoppingListItem',
        entityId: action.itemId,
        summary: `${target?.title ?? '购物项'}已标记为${target?.done ? '完成' : '待办'}`
      }
    );
  }

  if (action.type === 'addRecipe') {
    const images = normalizeImages(action.payload.images);
    const recipe: Recipe = {
      ...buildMeta(state.currentUserId, 'recipe'),
      familyId: state.family.id,
      title: action.payload.title,
      servings: action.payload.servings,
      prepMinutes: action.payload.prepMinutes,
      difficulty: action.payload.difficulty,
      ingredientItems: action.payload.ingredientItems,
      steps: action.payload.steps
        .map((step) => ({ title: step.title.trim(), text: step.text.trim() }))
        .filter((step) => step.text)
        .map((step) => ({ id: buildMeta(state.currentUserId, 'step').id, title: step.title, text: step.text })),
      tips: action.payload.tips,
      sceneTags: action.payload.sceneTags,
      images
    };
    const foods = [...state.foods];
    const activities = [];
    if (action.payload.autoCreateFood) {
      const food: Food = {
        ...buildMeta(state.currentUserId, 'food'),
        familyId: state.family.id,
        name: recipe.title,
        type: 'selfMade',
        category: '家常菜',
        flavorTags: action.payload.sceneTags,
        sourceName: '家庭厨房',
        scene: action.payload.sceneTags[0] ?? '日常',
        images,
        notes: action.payload.tips,
        favorite: false,
        recipeId: recipe.id
      };
      foods.unshift(food);
      activities.push(
        makeActivity(state.family.id, state.currentUserId, 'create', 'Food', food.id, `自动创建自做菜 ${food.name}`)
      );
    }
    return {
      ...addActivity(
        {
          ...state,
          recipes: sortByUpdatedAtDesc([recipe, ...state.recipes]),
          foods,
          activityLogs: [...activities, ...state.activityLogs]
        },
        {
          action: 'create',
          entityType: 'Recipe',
          entityId: recipe.id,
          summary: `新增菜谱 ${recipe.title}`
        }
      )
    };
  }

  if (action.type === 'addFood') {
    const food: Food = {
      ...buildMeta(state.currentUserId, 'food'),
      familyId: state.family.id,
      ...action.payload,
      images: normalizeImages(action.payload.images)
    };
    return addActivity(
      {
        ...state,
        foods: sortByUpdatedAtDesc([food, ...state.foods])
      },
      {
        action: 'create',
        entityType: 'Food',
        entityId: food.id,
        summary: `新增${food.type === 'selfMade' ? '自做菜' : '食物'} ${food.name}`
      }
    );
  }

  if (action.type === 'toggleFoodFavorite') {
    const foods = state.foods.map((item) =>
      item.id === action.foodId
        ? updateEntityMeta(
            {
              ...item,
              favorite: !item.favorite
            },
            state.currentUserId
          )
        : item
    );
    const food = foods.find((item) => item.id === action.foodId);
    return addActivity(
      {
        ...state,
        foods
      },
      {
        action: 'update',
        entityType: 'Food',
        entityId: action.foodId,
        summary: `${food?.name ?? '食物'}已${food?.favorite ? '加入' : '移出'}收藏`
      }
    );
  }

  if (action.type === 'addMealLog') {
    const mealLog: MealLog = {
      ...buildMeta(state.currentUserId, 'meal'),
      familyId: state.family.id,
      ...action.payload,
      photos: normalizeImages(action.payload.photos),
      deductionSuggestions: buildMealSuggestions(state, action.payload.foodEntries)
    };
    return addActivity(
      {
        ...state,
        mealLogs: sortLogs([mealLog, ...state.mealLogs])
      },
      {
        action: 'create',
        entityType: 'MealLog',
        entityId: mealLog.id,
        summary: `记录了${mealLog.date === todayKey() ? '今天' : mealLog.date}的${mealLog.mealType}`
      }
    );
  }

  if (action.type === 'runAi') {
    const result = runAiConversation(state, action.payload.mode, action.payload.prompt, state.currentUserId, {
      foodId: action.payload.foodId,
      ingredientIds: action.payload.ingredientIds
    });
    const recommendations = result.recommendation
      ? [result.recommendation, ...state.aiRecommendations.filter((item) => item.id !== result.recommendation?.id)]
      : state.aiRecommendations;
    return addActivity(
      {
        ...state,
        aiConversations: [result.conversation, ...state.aiConversations],
        aiRecommendations: recommendations
      },
      {
        action: 'create',
        entityType: 'AIConversation',
        entityId: result.conversation.id,
        summary: `发起 AI ${result.conversation.mode} 对话`
      }
    );
  }

  return state;
}

export function loadInitialState(): AppState {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return createInitialState();
  }
  try {
    return JSON.parse(raw) as AppState;
  } catch {
    return createInitialState();
  }
}

export function persistState(state: AppState): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
