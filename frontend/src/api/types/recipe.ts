/** Recipe contracts. */
import type { Ingredient, IngredientQuantityTrackingMode, InventoryItem } from './inventory';
import type { MediaAsset } from './media';
import type { Difficulty, FoodType, MealType } from './primitives';

export interface RecipeIngredient {
  id: string;
  ingredient_id?: string | null;
  ingredient_name: string;
  quantity: number;
  unit: string;
  note: string;
}

export interface RecipeStep {
  id: string;
  title: string;
  text: string;
  icon?: string;
  summary?: string;
  estimated_minutes?: number | null;
  tip?: string;
  key_points?: string[];
}

export interface Recipe {
  id: string;
  family_id: string;
  title: string;
  servings: number;
  prep_minutes: number;
  difficulty: Difficulty;
  ingredient_items: RecipeIngredient[];
  steps: RecipeStep[];
  tips: string;
  scene_tags?: string[];
  images: MediaAsset[];
  cook_logs: RecipeCookLog[];
  created_at: string;
  updated_at: string;
  created_by?: string | null;
  updated_by?: string | null;
}

export interface RecipeCookLog {
  id: string;
  family_id: string;
  recipe_id: string;
  meal_log_id?: string | null;
  cook_date: string;
  meal_type: MealType;
  servings: number;
  result_note: string;
  adjustments: string;
  rating?: number | null;
  created_at: string;
  updated_at: string;
  created_by?: string | null;
  updated_by?: string | null;
}

export interface FoodScene {
  id: string;
  family_id: string;
  name: string;
  description: string;
  image_prompt: string;
  image?: MediaAsset | null;
  hidden: boolean;
  custom: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
  created_by?: string | null;
  updated_by?: string | null;
}

export type RecipeScene = FoodScene;

export interface RecipePayload {
  title: string;
  servings: number;
  prep_minutes: number;
  difficulty: Difficulty;
  ingredient_items: Array<{
    ingredient_id?: string | null;
    ingredient_name: string;
    quantity: number;
    unit: string;
    note: string;
  }>;
  steps: Array<{
    title: string;
    text: string;
    icon?: string;
    summary?: string;
    estimated_minutes?: number | null;
    tip?: string;
    key_points?: string[];
  }>;
  tips: string;
  scene_tags?: string[];
  media_ids: string[];
  pending_image_job_id?: string | null;
}

export type CreateRecipePayload = RecipePayload;

export interface CookRecipeRequest {
  servings: number;
  date?: string;
  meal_type?: MealType;
  participant_user_ids?: string[];
  notes?: string;
  completion_request_id: string;
  food_plan_item_id?: string;
  food_plan_item_base_updated_at?: string;
  target_meal_log_id?: string | null;
  expected_meal_log_row_version?: number | null;
  result_note?: string;
  adjustments?: string;
  rating?: number | null;
  allow_partial_inventory_deduction?: boolean;
}

/** Preview-only: does not claim completion identity or plan OCC. */
export interface CookRecipePreviewRequest {
  servings: number;
  allow_partial_inventory_deduction?: boolean;
}

export interface CookRecipeConsumedItem {
  ingredient_id: string;
  ingredient_name: string;
  requested_quantity: number;
  unit: string;
  quantity_tracking_mode?: IngredientQuantityTrackingMode;
  deduction_note?: string | null;
  affected_item_ids: string[];
}

export interface CookRecipePreviewBatch {
  inventory_item_id: string;
  quantity: number;
  unit: string;
  purchase_date: string;
  expiry_date?: string | null;
  storage_location: string;
}

export interface CookRecipePreviewItem {
  ingredient_id: string;
  ingredient_name: string;
  requested_quantity: number;
  unit: string;
  quantity_tracking_mode?: IngredientQuantityTrackingMode;
  deduction_note?: string | null;
  batches: CookRecipePreviewBatch[];
}

export interface CookRecipeShortage {
  ingredient_id?: string | null;
  ingredient_name: string;
  required_quantity: number;
  available_quantity: number;
  missing_quantity: number;
  unit: string;
  shortage_type?: 'quantity' | 'presence' | string;
}

export interface CookRecipeResponse {
  recipe_id: string;
  consumed_items: CookRecipeConsumedItem[];
  shortages: CookRecipeShortage[];
  meal_log_id: string | null;
  cook_log_id: string | null;
  replayed?: boolean;
}

export interface CookRecipePreviewResponse {
  recipe_id: string;
  preview_items: CookRecipePreviewItem[];
  shortages: CookRecipeShortage[];
}

export interface RecipeAvailabilitySummary {
  recipe_id: string;
  availability: 'ready' | 'partial' | 'missing';
  availability_score: number;
  ready_count: number;
  total_count: number;
  shortages: CookRecipeShortage[];
}

export interface RecipeDiscoverySection {
  recipe_ids: string[];
  recipes: Recipe[];
}

export interface RecipeDiscovery {
  recommended: RecipeDiscoverySection;
  ready: RecipeDiscoverySection;
  quick: RecipeDiscoverySection;
  missing: RecipeDiscoverySection;
}

export interface RecipeStatsItem {
  recipe_id: string;
  recipe_title: string;
  count: number;
  last_used_at?: string | null;
}

export interface RecipeStats {
  total_cooks: number;
  recently_cooked: RecipeStatsItem[];
  frequent: RecipeStatsItem[];
}


export type { Ingredient, IngredientQuantityTrackingMode, InventoryItem, ShoppingListItem } from './inventory';
export type { MediaAsset } from './media';
export type { Difficulty, MealType } from './primitives';
