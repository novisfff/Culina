/** Food and food-plan contracts. */
import type { InventoryConfirmationSource } from './inventory';
import type { MediaAsset } from './media';
import type { FoodType, MealType } from './primitives';
import type { CookRecipeShortage, Recipe, RecipeScene } from './recipe';

export interface FoodPlanItem {
  id: string;
  family_id: string;
  user_id: string;
  food_id: string;
  food_name: string;
  food_type: FoodType | string;
  recipe_id?: string | null;
  recipe_title: string;
  plan_date: string;
  meal_type: MealType;
  note: string;
  status: 'planned' | 'cooked' | 'skipped' | string;
  completed_at?: string | null;
  meal_log_id?: string | null;
  created_at: string;
  updated_at: string;
  created_by?: string | null;
  updated_by?: string | null;
}

export interface CreateFoodPlanItemPayload {
  food_id: string;
  plan_date: string;
  meal_type: MealType;
  note: string;
}

export interface UpdateFoodPlanItemPayload {
  food_id?: string;
  plan_date?: string;
  meal_type?: MealType;
  note?: string;
  status?: 'planned' | 'cooked' | 'skipped';
}

export interface Food {
  id: string;
  family_id: string;
  name: string;
  type: FoodType;
  category: string;
  flavor_tags: string[];
  scene_tags?: string[];
  suitable_meal_types: MealType[];
  source_name: string;
  purchase_source: string;
  scene: string;
  images: MediaAsset[];
  notes: string;
  routine_note: string;
  price?: number | null;
  rating?: number | null;
  repurchase?: boolean | null;
  expiry_date?: string | null;
  stock_quantity?: number | null;
  stock_unit: string;
  storage_location: string;
  favorite: boolean;
  recipe_id?: string | null;
  row_version: number;
  inventory_last_confirmed_at?: string | null;
  inventory_last_confirmed_by?: string | null;
  inventory_confirmation_source?: InventoryConfirmationSource | null;
  created_at: string;
  updated_at: string;
  created_by?: string | null;
  updated_by?: string | null;
}

export interface FoodPayload {
  name: string;
  type: FoodType;
  category: string;
  flavor_tags: string[];
  scene_tags: string[];
  suitable_meal_types: MealType[];
  source_name: string;
  purchase_source: string;
  scene: string;
  notes: string;
  routine_note: string;
  price?: number | null;
  rating?: number | null;
  repurchase?: boolean | null;
  expiry_date?: string | null;
  stock_quantity?: number | null;
  stock_unit: string;
  storage_location: string;
  favorite: boolean;
  recipe_id?: string | null;
  media_ids: string[];
  pending_image_job_id?: string | null;
}

export interface UpdateFoodPayload extends FoodPayload {
  expected_row_version: number;
}

export type FoodRecommendationPrimaryAction = 'cook_recipe' | 'quick_add_meal' | 'review_food';

export interface FoodRecommendationRecipeAvailability {
  recipe_id: string;
  availability: 'ready' | 'partial' | 'missing';
  availability_score: number;
  ready_count: number;
  total_count: number;
  shortages: CookRecipeShortage[];
}

export interface FoodRecommendationItem {
  food: Food;
  score: number;
  reasons: string[];
  primary_action: FoodRecommendationPrimaryAction;
  recipe_availability?: FoodRecommendationRecipeAvailability | null;
}

export interface FoodRecommendations {
  target_meal_type: MealType;
  target_date: string;
  items: FoodRecommendationItem[];
}


export type { MediaAsset } from './media';
export type { FoodType, MealType } from './primitives';
export type { FoodScene, Recipe, RecipePayload, RecipeScene } from './recipe';
export type { Ingredient, InventoryItem, ShoppingListItem } from './inventory';
export type { Member } from './shell';
