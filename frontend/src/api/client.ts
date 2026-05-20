import type {
  ActivityLog,
  AiQueryResponse,
  GenerateRecipeDraftPayload,
  GenerateRecipeDraftResponse,
  AiRenderResponse,
  AiConversation,
  CookRecipePreviewResponse,
  CookRecipeRequest,
  CookRecipeResponse,
  CreateRecipePlanItemPayload,
  ConsumeInventoryResponse,
  CreateRecipePayload,
  CreateAiRenderRequest,
  DisposeExpiredInventoryResponse,
  FamilyDetail,
  Food,
  Ingredient,
  InventoryItem,
  LoginResponse,
  MealLog,
  Member,
  Recipe,
  RecipeAvailabilitySummary,
  RecipeDiscovery,
  RecipeFavorite,
  RecipePlanItem,
  RecipeScene,
  RecipePayload,
  RecipeStats,
  ShoppingListItem,
  UpdateRecipePlanItemPayload,
} from './types';

export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://127.0.0.1:8010';

let authToken: string | null = localStorage.getItem('culina-access-token');

export function setAccessToken(token: string | null) {
  authToken = token;
  if (token) {
    localStorage.setItem('culina-access-token', token);
  } else {
    localStorage.removeItem('culina-access-token');
  }
}

export function getAccessToken() {
  return authToken;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type') && !(init.body instanceof FormData) && init.body !== undefined) {
    headers.set('Content-Type', 'application/json');
  }
  if (authToken) {
    headers.set('Authorization', `Bearer ${authToken}`);
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers,
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const isJson = response.headers.get('Content-Type')?.includes('application/json');
  const payload = isJson ? await response.json() : await response.text();
  if (!response.ok) {
    const detail =
      typeof payload === 'object' && payload && 'detail' in payload
        ? String(payload.detail)
        : response.statusText || '请求失败';
    throw new Error(detail);
  }

  return payload as T;
}

export const api = {
  login: (username: string, password: string) =>
    request<LoginResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  me: () => request<LoginResponse>('/api/auth/me'),
  logout: () => request<void>('/api/auth/logout', { method: 'POST' }),
  getFamily: () => request<FamilyDetail>('/api/family'),
  getMembers: () => request<Member[]>('/api/members'),
  createMember: (payload: {
    username: string;
    display_name: string;
    password: string;
    role: 'Owner' | 'Member';
    email?: string;
  }) =>
    request<Member>('/api/members', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getIngredients: () => request<Ingredient[]>('/api/ingredients'),
  createIngredient: (payload: {
    name: string;
    category: string;
    default_unit: string;
    unit_conversions: Array<{ unit: string; ratio_to_default: number }>;
    default_storage: string;
    default_expiry_mode: string;
    default_expiry_days?: number | null;
    default_low_stock_threshold?: number | null;
    notes: string;
    media_ids: string[];
  }) =>
    request<Ingredient>('/api/ingredients', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateIngredient: (
    ingredientId: string,
    payload: {
      name: string;
      category: string;
      default_unit: string;
      unit_conversions: Array<{ unit: string; ratio_to_default: number }>;
      default_storage: string;
      default_expiry_mode: string;
      default_expiry_days?: number | null;
      default_low_stock_threshold?: number | null;
      notes: string;
      media_ids: string[];
    }
  ) =>
    request<Ingredient>(`/api/ingredients/${ingredientId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  getInventory: () => request<InventoryItem[]>('/api/inventory'),
  createInventory: (payload: {
    ingredient_id: string;
    quantity: number;
    unit: string;
    status: string;
    purchase_date: string;
    expiry_date?: string;
    storage_location: string;
    notes: string;
    low_stock_threshold?: number;
  }) =>
    request<InventoryItem>('/api/inventory', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  consumeInventory: (payload: { ingredient_id: string; quantity: number; unit: string }) =>
    request<ConsumeInventoryResponse>('/api/inventory/consume', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  disposeExpiredInventory: (payload: { ingredient_id: string; inventory_item_ids: string[] }) =>
    request<DisposeExpiredInventoryResponse>('/api/inventory/dispose-expired', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getShoppingList: () => request<ShoppingListItem[]>('/api/shopping-list'),
  createShoppingItem: (payload: { title: string; quantity: number; unit: string; reason: string }) =>
    request<ShoppingListItem>('/api/shopping-list', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateShoppingItem: (itemId: string, done: boolean) =>
    request<ShoppingListItem>(`/api/shopping-list/${itemId}`, {
      method: 'PATCH',
      body: JSON.stringify({ done }),
    }),
  getRecipes: () => request<Recipe[]>('/api/recipes'),
  getRecipeDiscovery: (limit = 6) => request<RecipeDiscovery>(`/api/recipes/discovery?limit=${encodeURIComponent(String(limit))}`),
  getRecipeAvailability: (recipeId: string) => request<RecipeAvailabilitySummary>(`/api/recipes/${recipeId}/availability`),
  getRecipeStats: (dateFrom?: string, dateTo?: string, limit = 10) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (dateFrom) params.set('date_from', dateFrom);
    if (dateTo) params.set('date_to', dateTo);
    return request<RecipeStats>(`/api/recipes/stats?${params.toString()}`);
  },
  createRecipe: (payload: CreateRecipePayload) =>
    request<Recipe>('/api/recipes', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateRecipe: (recipeId: string, payload: RecipePayload) =>
    request<Recipe>(`/api/recipes/${recipeId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  deleteRecipe: (recipeId: string) =>
    request<void>(`/api/recipes/${recipeId}`, {
      method: 'DELETE',
    }),
  cookRecipe: (recipeId: string, payload: CookRecipeRequest) =>
    request<CookRecipeResponse>(`/api/recipes/${recipeId}/cook`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  previewCookRecipe: (recipeId: string, payload: CookRecipeRequest) =>
    request<CookRecipePreviewResponse>(`/api/recipes/${recipeId}/cook-preview`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getRecipeFavorites: () => request<RecipeFavorite[]>('/api/recipe-favorites'),
  addRecipeFavorite: (recipeId: string) =>
    request<RecipeFavorite>(`/api/recipe-favorites/${recipeId}`, {
      method: 'PUT',
    }),
  removeRecipeFavorite: (recipeId: string) =>
    request<void>(`/api/recipe-favorites/${recipeId}`, {
      method: 'DELETE',
    }),
  getRecipePlan: (dateFrom: string, dateTo: string) =>
    request<RecipePlanItem[]>(`/api/recipe-plan?date_from=${encodeURIComponent(dateFrom)}&date_to=${encodeURIComponent(dateTo)}`),
  createRecipePlanItem: (payload: CreateRecipePlanItemPayload) =>
    request<RecipePlanItem>('/api/recipe-plan', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateRecipePlanItem: (itemId: string, payload: UpdateRecipePlanItemPayload) =>
    request<RecipePlanItem>(`/api/recipe-plan/${itemId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  deleteRecipePlanItem: (itemId: string) =>
    request<void>(`/api/recipe-plan/${itemId}`, {
      method: 'DELETE',
    }),
  getRecipeScenes: () => request<RecipeScene[]>('/api/recipe-scenes'),
  createRecipeScene: (payload: {
    name: string;
    description: string;
    image_prompt: string;
    image_asset_id?: string;
    hidden: boolean;
    custom: boolean;
    sort_order: number;
  }) =>
    request<RecipeScene>('/api/recipe-scenes', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateRecipeScene: (
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
  ) =>
    request<RecipeScene>(`/api/recipe-scenes/${sceneId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  deleteRecipeScene: (sceneId: string) =>
    request<void>(`/api/recipe-scenes/${sceneId}`, {
      method: 'DELETE',
    }),
  getFoods: () => request<Food[]>('/api/foods'),
  createFood: (payload: Record<string, unknown>) =>
    request<Food>('/api/foods', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateFoodFavorite: (foodId: string, favorite: boolean) =>
    request<Food>(`/api/foods/${foodId}/favorite`, {
      method: 'PATCH',
      body: JSON.stringify({ favorite }),
    }),
  getMealLogs: () => request<MealLog[]>('/api/meal-logs'),
  createMealLog: (payload: Record<string, unknown>) =>
    request<MealLog>('/api/meal-logs', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getActivityLogs: () => request<ActivityLog[]>('/api/activity-logs'),
  getAiConversations: () => request<AiConversation[]>('/api/ai/conversations'),
  queryAi: (payload: { mode: string; prompt: string; food_id?: string; ingredient_ids?: string[] }) =>
    request<AiQueryResponse>('/api/ai/query', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  generateRecipeDraft: (payload: GenerateRecipeDraftPayload) =>
    request<GenerateRecipeDraftResponse>('/api/ai/recipes/draft', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  uploadMedia: async (file: File, source: 'upload' | 'ai', alt: string) => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('source', source);
    formData.append('alt', alt);
    return request<{ id: string; name: string; url: string; source: 'upload' | 'ai'; alt: string; created_at: string; created_by?: string | null }>(
      '/api/media/upload',
      {
        method: 'POST',
        body: formData,
      }
    );
  },
  renderAiImage: (payload: CreateAiRenderRequest) =>
    request<AiRenderResponse>('/api/media/ai-render', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
};
