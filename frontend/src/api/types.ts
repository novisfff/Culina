export type UserRole = 'Owner' | 'Member';
export type FoodType = 'selfMade' | 'takeout' | 'diningOut' | 'packaged';
export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack';
export type Difficulty = 'easy' | 'medium' | 'hard';
export type InventoryStatus = 'fresh' | 'opened' | 'frozen' | 'expiring';
export type IngredientExpiryMode = 'days' | 'manual_date' | 'none';
export type AiMode = 'foodQa' | 'inventoryQa' | 'recommendation' | 'recipeDraft';
export type MediaSource = 'upload' | 'ai';
export type ImageGenerationMode = 'reference' | 'text';
export type MediaEntityType = 'ingredient' | 'food' | 'recipe' | 'recipe_scene' | 'meal_log';

export interface IngredientUnitConversion {
  unit: string;
  ratio_to_default: number;
}

export interface MediaAsset {
  id: string;
  name: string;
  url: string;
  source: MediaSource;
  alt: string;
  generation_mode?: ImageGenerationMode | null;
  reference_media_id?: string | null;
  style_key?: string | null;
  prompt_version?: string | null;
  created_at: string;
  created_by?: string | null;
}

export interface UserSummary {
  id: string;
  username: string;
  display_name: string;
  email?: string | null;
  phone?: string | null;
  avatar_seed: string;
}

export interface MembershipSummary {
  id: string;
  family_id: string;
  user_id: string;
  role: UserRole;
  status: string;
}

export interface FamilyDetail {
  id: string;
  name: string;
  motto: string;
  location: string;
  created_at: string;
  updated_at: string;
  ai_recommendations: AiRecommendation[];
}

export interface LoginResponse {
  access_token: string;
  user: UserSummary;
  membership: MembershipSummary;
  family: FamilyDetail;
}

export interface Member extends UserSummary {
  role: UserRole;
  status: string;
}

export interface Ingredient {
  id: string;
  family_id: string;
  name: string;
  category: string;
  default_unit: string;
  unit_conversions: IngredientUnitConversion[];
  default_storage: string;
  default_expiry_mode: IngredientExpiryMode;
  default_expiry_days?: number | null;
  default_low_stock_threshold?: number | null;
  notes: string;
  image?: MediaAsset | null;
  created_at: string;
  updated_at: string;
  created_by?: string | null;
  updated_by?: string | null;
}

export interface InventoryItem {
  id: string;
  family_id: string;
  ingredient_id: string;
  ingredient_name: string;
  quantity: number;
  consumed_quantity?: number;
  remaining_quantity?: number;
  unit: string;
  entered_quantity?: number | null;
  entered_unit?: string | null;
  status: InventoryStatus;
  purchase_date: string;
  expiry_date?: string | null;
  storage_location: string;
  notes: string;
  low_stock_threshold: number;
  created_at: string;
  updated_at: string;
  created_by?: string | null;
  updated_by?: string | null;
}

export interface ShoppingListItem {
  id: string;
  family_id: string;
  title: string;
  quantity: number;
  unit: string;
  reason: string;
  done: boolean;
  created_at: string;
  updated_at: string;
  created_by?: string | null;
  updated_by?: string | null;
}

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
  scene_tags: string[];
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

export interface RecipeScene {
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
  scene_tags: string[];
  media_ids: string[];
}

export interface CreateRecipePayload extends RecipePayload {
  auto_create_food: boolean;
}

export interface CookRecipeRequest {
  servings: number;
  date?: string;
  meal_type?: MealType;
  participant_user_ids?: string[];
  notes?: string;
  create_meal_log: boolean;
  recipe_plan_item_id?: string;
  result_note?: string;
  adjustments?: string;
  rating?: number | null;
}

export interface CookRecipeConsumedItem {
  ingredient_id: string;
  ingredient_name: string;
  requested_quantity: number;
  unit: string;
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
  batches: CookRecipePreviewBatch[];
}

export interface CookRecipeShortage {
  ingredient_id?: string | null;
  ingredient_name: string;
  required_quantity: number;
  available_quantity: number;
  missing_quantity: number;
  unit: string;
}

export interface CookRecipeResponse {
  recipe_id: string;
  consumed_items: CookRecipeConsumedItem[];
  shortages: CookRecipeShortage[];
  meal_log_id?: string | null;
  cook_log_id?: string | null;
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

export interface RecipeFavorite {
  id: string;
  family_id: string;
  user_id: string;
  recipe_id: string;
  created_at: string;
}

export interface RecipePlanItem {
  id: string;
  family_id: string;
  user_id: string;
  recipe_id: string;
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

export interface CreateRecipePlanItemPayload {
  recipe_id: string;
  plan_date: string;
  meal_type: MealType;
  note: string;
}

export interface UpdateRecipePlanItemPayload {
  recipe_id?: string;
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
  source_name: string;
  scene: string;
  images: MediaAsset[];
  notes: string;
  favorite: boolean;
  recipe_id?: string | null;
  created_at: string;
  updated_at: string;
  created_by?: string | null;
  updated_by?: string | null;
}

export interface MealFoodEntry {
  id: string;
  food_id: string;
  food_name: string;
  servings: number;
  note: string;
}

export interface DeductionSuggestion {
  id: string;
  ingredient_name: string;
  suggested_amount: number;
  unit: string;
  based_on_food_name: string;
}

export interface MealLog {
  id: string;
  family_id: string;
  date: string;
  meal_type: MealType;
  food_entries: MealFoodEntry[];
  participant_user_ids: string[];
  notes: string;
  mood: string;
  photos: MediaAsset[];
  deduction_suggestions: DeductionSuggestion[];
  created_at: string;
  updated_at: string;
  created_by?: string | null;
  updated_by?: string | null;
}

export interface ActivityLog {
  id: string;
  family_id: string;
  actor_id: string;
  actor_name?: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  summary: string;
  created_at: string;
}

export interface AiConversation {
  id: string;
  family_id: string;
  mode: AiMode;
  prompt: string;
  response: string;
  created_at: string;
  created_by?: string | null;
  context: Record<string, unknown>;
}

export interface AiRecipeDraft {
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
  steps: string[];
  tips: string;
  scene_tags: string[];
}

export interface AiQueryResponse {
  conversation: AiConversation;
  recommendation?: AiRecommendation | null;
}

export interface AiRecommendation {
  id: string;
  family_id: string;
  title: string;
  detail: string;
  created_at: string;
}

export interface ImageInputValue {
  referenceAsset?: MediaAsset;
  generatedAsset?: MediaAsset;
}

export interface CreateAiRenderRequest {
  mode: ImageGenerationMode;
  entity_type: MediaEntityType;
  reference_media_id?: string;
  title?: string;
  category?: string;
  notes?: string;
  tags?: string[];
  scene?: string;
  meal_type?: MealType;
  food_names?: string[];
  ingredient_names?: string[];
  size?: string;
}

export interface AiRenderResponse {
  generated_asset: MediaAsset;
  reference_asset?: MediaAsset | null;
  style_key: string;
  prompt_version: string;
  generation_mode: ImageGenerationMode;
}

export interface ConsumeInventoryResponse {
  ingredient_id: string;
  unit: string;
  consumed_quantity: number;
  affected_item_ids: string[];
}

export interface DisposeExpiredInventoryRequest {
  ingredient_id: string;
  inventory_item_ids: string[];
}

export interface DisposeExpiredInventoryResponse {
  ingredient_id: string;
  disposed_item_ids: string[];
  disposed_count: number;
}
