export type UserRole = 'Owner' | 'Member';
export type FoodType = 'selfMade' | 'takeout' | 'diningOut' | 'readyMade' | 'instant' | 'packaged';
export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack';
export type Difficulty = 'easy' | 'medium' | 'hard';
export type InventoryStatus = 'fresh' | 'opened' | 'frozen' | 'expiring';
export type IngredientExpiryMode = 'days' | 'manual_date' | 'none';
export type AiMode = 'foodQa' | 'inventoryQa' | 'recommendation' | 'recipeDraft';
export type MediaSource = 'upload' | 'ai';
export type ImageGenerationMode = 'reference' | 'text';
export type MediaEntityType = 'user' | 'family' | 'ingredient' | 'food' | 'recipe' | 'recipe_scene' | 'food_scene' | 'meal_log';

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
  variants?: {
    thumb?: MediaAssetVariant | null;
    card?: MediaAssetVariant | null;
    large?: MediaAssetVariant | null;
  } | null;
  created_at: string;
  created_by?: string | null;
}

export interface MediaAssetVariant {
  url: string;
  width: number;
  height: number;
  content_type: string;
  byte_size: number;
}

export interface UserSummary {
  id: string;
  username: string;
  display_name: string;
  email?: string | null;
  phone?: string | null;
  avatar_seed: string;
  avatar_image?: MediaAsset | null;
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
  image?: MediaAsset | null;
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
  disposed_quantity?: number;
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
}

export type CreateRecipePayload = RecipePayload;

export interface CookRecipeRequest {
  servings: number;
  date?: string;
  meal_type?: MealType;
  participant_user_ids?: string[];
  notes?: string;
  create_meal_log: boolean;
  food_plan_item_id?: string;
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

export type RecipePlanItem = FoodPlanItem;

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
  favorite: boolean;
  recipe_id?: string | null;
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
  favorite: boolean;
  recipe_id?: string | null;
  media_ids: string[];
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

export interface MealFoodEntry {
  id: string;
  food_id: string;
  food_name: string;
  servings: number;
  note: string;
  rating?: number | null;
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

export interface QuickAddMealLogPayload {
  food_id: string;
  date: string;
  meal_type: MealType;
  servings: number;
  note: string;
  food_plan_item_id?: string;
}

export interface UpdateMealLogPayload {
  participant_user_ids?: string[];
  notes?: string;
  mood?: string;
  media_ids?: string[];
  food_entry_ratings?: Array<{ id: string; rating: number | null }>;
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
  title: string;
  summary: string;
  status: string;
  last_message_at?: string | null;
  last_run_status: string;
}

export interface AiGeneratedRecipeDraft extends RecipePayload {
  scene_tags?: string[];
}

export interface GenerateRecipeDraftPayload {
  title?: string;
  prompt?: string;
  ingredient_ids?: string[];
  extra_ingredients?: string[];
  servings?: number | null;
  prep_minutes?: number | null;
  difficulty?: Difficulty | null;
  scene_tags?: string[];
  generate_image?: boolean;
}

export type AiMessageRole = 'user' | 'assistant' | 'system';
export type AiMessagePartType = 'text' | 'result_card' | 'draft' | 'approval_request' | 'error_recovery';
export type AiResultCardType =
  | 'today_recommendation'
  | 'recipe_draft'
  | 'approval_request'
  | 'error_recovery'
  | 'inventory_summary'
  | 'meal_plan_draft'
  | 'shopping_list_draft'
  | 'meal_log_draft'
  | 'food_profile_draft';
export type AiTaskDraftType = 'recipe' | 'shopping_list' | 'meal_plan' | 'meal_log' | 'food_profile' | 'inventory_operation';
export type AiApprovalDecision = 'approved' | 'rejected';

export interface AiEvidenceItem {
  type: string;
  id?: string;
  label: string;
  status?: string;
  detail?: string;
}

export type AiInventoryDisplayStatus = 'available' | 'low_stock' | 'expiring' | 'expired';
export type AiInventoryOperationAction = 'restock' | 'consume' | 'dispose';
export type AiInventoryQueryFocus = 'overview' | 'available' | 'expiring' | 'expired' | 'low_stock';

export interface AiInventoryOperationResult {
  action: AiInventoryOperationAction;
  quantity?: number | null;
  unit?: string | null;
  reason?: string | null;
  handledAt: string;
  handledBy?: string | null;
}

export interface AiInventoryResultItem {
  id: string;
  ingredientId: string;
  name: string;
  image?: MediaAsset | null;
  quantity: string;
  unit: string;
  status: string;
  displayStatus: AiInventoryDisplayStatus;
  expiryDate?: string | null;
  daysUntilExpiry?: number | null;
  lowStockThreshold?: string | null;
  purchaseDate?: string | null;
  storageLocation?: string | null;
  suggestedAction?: AiInventoryOperationAction | null;
  lastOperation?: AiInventoryOperationResult | null;
}

export interface AiInventoryBatchOption {
  id: string;
  label: string;
  remainingQuantity: number;
  unit: string;
  expiryDate?: string | null;
}

export interface AiInventoryOperationDraftItem {
  action: AiInventoryOperationAction;
  ingredientId: string;
  ingredientName: string;
  inventoryItemId?: string | null;
  quantity: number;
  unit: string;
  purchaseDate?: string | null;
  expiryDate?: string | null;
  storageLocation?: string | null;
  status?: InventoryStatus | null;
  notes: string;
  lowStockThreshold?: number | null;
  reason: string;
  image?: MediaAsset | null;
  remainingQuantity?: number | null;
  batchOptions?: AiInventoryBatchOption[];
}

export interface AiInventoryOperationDraft {
  draftType: 'inventory_operation';
  schemaVersion: 'inventory_operation.v1';
  operations: AiInventoryOperationDraftItem[];
  source?: Record<string, unknown>;
}

export interface AiTodayRecommendationItem {
  entityType: 'food' | 'recipe';
  entityId: string;
  foodId?: string | null;
  recipeId?: string | null;
  name: string;
  image?: MediaAsset | null;
  category?: string | null;
  foodType?: string | null;
  prepMinutes?: number | null;
  servings?: number | null;
  difficulty?: string | null;
  reason: string;
  evidence: AiEvidenceItem[];
  planSelection?: {
    foodPlanItemId: string;
    foodId: string;
    name: string;
    planDate: string;
    mealType: MealType;
    selectedAt: string;
    selectedBy?: string | null;
  } | null;
}

export interface AiInventorySummaryCardData {
  queryFocus: AiInventoryQueryFocus;
  availableCount: number;
  expiringCount: number;
  lowStockCount: number;
  items: AiInventoryResultItem[];
}

export interface AiTodayRecommendationCardData {
  recommendations: AiTodayRecommendationItem[];
  targetDate?: string | null;
  mealType?: MealType | null;
  contextSummary: {
    inventoryCount: number;
    expiringCount: number;
    recentMealCount: number;
    recipeCount: number;
  };
}

export interface AiResultCard {
  id: string;
  type: AiResultCardType;
  title: string;
  data: {
    recommendations?: AiTodayRecommendationItem[];
    targetDate?: string | null;
    mealType?: MealType | null;
    contextSummary?: AiTodayRecommendationCardData['contextSummary'];
    items?: AiInventoryResultItem[];
    queryFocus?: AiInventoryQueryFocus;
    availableCount?: number;
    expiringCount?: number;
    lowStockCount?: number;
    message?: string;
    draftId?: string;
    approvalId?: string;
    summary?: string;
    draft?: AiGeneratedRecipeDraft | Record<string, unknown>;
    [key: string]: unknown;
  };
}

export interface AiTaskDraft {
  id: string;
  conversation_id: string;
  message_id?: string | null;
  run_id?: string | null;
  draft_type: AiTaskDraftType;
  payload: AiGeneratedRecipeDraft | Record<string, unknown>;
  preview_summary: string;
  status: string;
  version: number;
  schema_version: string;
  validation_errors: Array<Record<string, unknown>>;
  expires_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface AiApprovalField {
  name: string;
  label: string;
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  widget: 'input' | 'textarea' | 'switch' | 'select' | 'radio' | 'checkbox_group' | 'tag_selector' | 'date' | 'time' | 'recipe_draft_editor';
  options?: Array<string | { value: string; label: string; description?: string }> | null;
  allow_custom?: boolean;
  placeholder?: string | null;
  required?: boolean;
}

export interface AiApprovalRequest {
  id: string;
  conversation_id: string;
  message_id?: string | null;
  run_id?: string | null;
  draft_id: string;
  draft_version: number;
  draft_schema_version: string;
  approval_type: string;
  status: string;
  title: string;
  instruction: string;
  approve_label: string;
  reject_label: string;
  require_reject_comment: boolean;
  field_schema: AiApprovalField[];
  initial_values: { recipe?: AiGeneratedRecipeDraft; draft?: Record<string, unknown>; [key: string]: unknown };
  submitted_values: { recipe?: AiGeneratedRecipeDraft; draft?: Record<string, unknown>; [key: string]: unknown };
  decision?: AiApprovalDecision | null;
  comment?: string | null;
  resolved_at?: string | null;
  expires_at?: string | null;
  created_at: string;
}

export interface AiMessagePart {
  id: string;
  type: AiMessagePartType;
  text?: string | null;
  card?: AiResultCard | null;
  draft?: AiTaskDraft | null;
  approval?: AiApprovalRequest | null;
}

export interface AiMessage {
  id: string;
  conversation_id: string;
  role: AiMessageRole;
  content: string;
  content_type: string;
  parts: AiMessagePart[];
  run_id?: string | null;
  status: string;
  metadata: Record<string, unknown>;
  client_message_id?: string | null;
  created_at: string;
}

export interface AiRun {
  id: string;
  agent_key: string;
  intent: string;
  status: string;
  model: string;
  created_at: string;
}

export interface AiRunEvent {
  id: string;
  run_id: string;
  type: string;
  internal_code: string;
  user_message: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  created_at: string;
}

export interface AiStatus {
  enabled: boolean;
  provider: string;
  model: string;
  status: 'ready' | 'disabled' | 'missing_api_key' | 'unsupported_provider';
  detail: string;
}

export interface AiChatResponse {
  conversation_id: string;
  message: AiMessage;
  run: AiRun;
  events: AiRunEvent[];
  included: {
    result_cards: AiResultCard[];
    drafts: AiTaskDraft[];
    approvals: AiApprovalRequest[];
  };
}

export interface AiApprovalDecisionResponse {
  approval: AiApprovalRequest;
  draft: AiTaskDraft;
  operation?: Record<string, unknown> | null;
  business_entity?: Recipe | Record<string, unknown> | null;
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

export type AiRecipeImageRenderPayload = Omit<CreateAiRenderRequest, 'mode' | 'reference_media_id'>;

export interface GenerateRecipeDraftResponse {
  draft?: AiGeneratedRecipeDraft | null;
  agent_run_id: string;
  status: 'completed' | 'failed';
  error?: string | null;
  image_render_payload?: AiRecipeImageRenderPayload | null;
}

export interface AiRenderResponse {
  job_id?: string | null;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  error?: string | null;
  generated_asset?: MediaAsset | null;
  reference_asset?: MediaAsset | null;
  style_key?: string | null;
  prompt_version?: string | null;
  generation_mode: ImageGenerationMode;
}

export interface ConsumeInventoryResponse {
  ingredient_id: string;
  unit: string;
  consumed_quantity: number;
  affected_item_ids: string[];
}

export interface DisposeInventoryResponse {
  ingredient_id: string;
  inventory_item_id: string;
  unit: string;
  disposed_quantity: number;
  remaining_quantity: number;
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
