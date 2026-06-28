import { request } from './request';
import type {
  ActivityLog,
  CreateFoodPlanItemPayload,
  Food,
  FoodPlanItem,
  FoodPayload,
  FoodRecommendations,
  FoodScene,
  MealLog,
  MealType,
  QuickAddMealLogPayload,
  UpdateMealLogPayload,
  UpdateFoodPlanItemPayload,
} from './types';

export const foodsApi = {
  getFoodPlan: (dateFrom: string, dateTo: string, q = '') => {
    const search = new URLSearchParams({
      date_from: dateFrom,
      date_to: dateTo,
    });
    if (q.trim()) search.set('q', q.trim());
    return request<FoodPlanItem[]>(`/api/food-plan?${search.toString()}`);
  },
  createFoodPlanItem: (payload: CreateFoodPlanItemPayload) =>
    request<FoodPlanItem>('/api/food-plan', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateFoodPlanItem: (itemId: string, payload: UpdateFoodPlanItemPayload) =>
    request<FoodPlanItem>(`/api/food-plan/${itemId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  deleteFoodPlanItem: (itemId: string) =>
    request<void>(`/api/food-plan/${itemId}`, {
      method: 'DELETE',
    }),
  getFoodScenes: () => request<FoodScene[]>('/api/food-scenes'),
  createFoodScene: (payload: {
    name: string;
    description: string;
    image_prompt: string;
    image_asset_id?: string;
    pending_image_job_id?: string | null;
    hidden: boolean;
    custom: boolean;
    sort_order: number;
  }) =>
    request<FoodScene>('/api/food-scenes', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateFoodScene: (
    sceneId: string,
    payload: {
      name?: string;
      description?: string;
      image_prompt?: string;
      image_asset_id?: string;
      pending_image_job_id?: string | null;
      hidden?: boolean;
      custom?: boolean;
      sort_order?: number;
    }
  ) =>
    request<FoodScene>(`/api/food-scenes/${sceneId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  deleteFoodScene: (sceneId: string) =>
    request<void>(`/api/food-scenes/${sceneId}`, {
      method: 'DELETE',
    }),
  getFoods: (params: { q?: string; limit?: number; offset?: number } = {}) => {
    const search = new URLSearchParams();
    if (params.q?.trim()) search.set('q', params.q.trim());
    if (params.limit !== undefined) search.set('limit', String(params.limit));
    if (params.offset !== undefined) search.set('offset', String(params.offset));
    const suffix = search.size > 0 ? `?${search.toString()}` : '';
    return request<Food[]>(`/api/foods${suffix}`);
  },
  getFoodRecommendations: (params: { limit?: number; now?: string; meal_type?: MealType } = {}) => {
    const search = new URLSearchParams({ limit: String(params.limit ?? 12) });
    if (params.now) search.set('now', params.now);
    if (params.meal_type) search.set('meal_type', params.meal_type);
    return request<FoodRecommendations>(`/api/foods/recommendations?${search.toString()}`);
  },
  createFood: (payload: FoodPayload) =>
    request<Food>('/api/foods', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateFood: (foodId: string, payload: FoodPayload) =>
    request<Food>(`/api/foods/${foodId}`, {
      method: 'PATCH',
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
  updateMealLog: (mealLogId: string, payload: UpdateMealLogPayload) =>
    request<MealLog>(`/api/meal-logs/${mealLogId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  quickAddMealLog: (payload: QuickAddMealLogPayload) =>
    request<MealLog>('/api/meal-logs/quick-add', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getActivityLogs: () => request<ActivityLog[]>('/api/activity-logs'),
};
