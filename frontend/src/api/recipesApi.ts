import { request } from './request';
import type {
  CookRecipePreviewResponse,
  CookRecipeRequest,
  CookRecipeResponse,
  CreateRecipePayload,
  CreateRecipePlanItemPayload,
  Recipe,
  RecipeAvailabilitySummary,
  RecipeDiscovery,
  RecipeFavorite,
  RecipePayload,
  RecipePlanItem,
  RecipeStats,
  UpdateRecipePlanItemPayload,
} from './types';

export const recipesApi = {
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
};
