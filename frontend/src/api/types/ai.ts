/** AI workspace contracts. */
import type { Food, FoodPlanItem } from './food';
import type {
  Ingredient,
  IngredientQuantityTrackingMode,
  InventoryAvailabilityLevel,
  InventoryConfirmationSource,
} from './inventory';
import type { MealLogCandidate, RecordMealTarget } from './meal';
import type { IngredientUnitConversion, MediaAsset } from './media';
import type { FamilyModelCapability, ModelUsageErrorCode } from './modelUsage';
import type {
  AiMode,
  Difficulty,
  FoodType,
  ImageGenerationMode,
  IngredientExpiryMode,
  InventoryStatus,
  MealType,
  MediaEntityType,
  MediaSource,
  UserRole,
} from './primitives';
import type { CookRecipeShortage, FoodScene, Recipe, RecipePayload } from './recipe';
import type { SearchIndexJobErrorCode } from './search';
import type { Member, UserSummary } from './shell';
export type { AiRecommendation } from './shell';

export type AiConversationVisibility = 'private' | 'family';

export interface AiConversation {
  id: string;
  family_id: string;
  owner_user_id: string;
  owner_display_name: string;
  visibility: AiConversationVisibility;
  is_owner: boolean;
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

export interface AiGeneratedRecipeDraft extends Omit<RecipePayload, 'ingredient_items'> {
  ingredient_items: Array<{
    ingredient_id?: string | null;
    ingredient_name: string;
    quantity?: number | null;
    unit?: string | null;
    note: string;
  }>;
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

export interface AiChatAttachment {
  type: 'image';
  media_id: string;
  client_attachment_id?: string;
}

export type AiMessageRole = 'user' | 'assistant' | 'system';
export type AiMessagePartType = 'text' | 'image' | 'result_card' | 'draft' | 'approval_request' | 'human_input_request' | 'error_recovery' | 'run_activity';
export type AiResultCardType =
  | 'today_recommendation'
  | 'recipe_draft'
  | 'approval_request'
  | 'error_recovery'
  | 'inventory_summary'
  | 'operation_result'
  | 'meal_plan_draft'
  | 'shopping_list_draft'
  | 'meal_log_draft'
  | 'food_profile_draft'
  | 'ui_actions'
  | 'recipe_shortage'
  | 'meal_idea_proposal';

export interface AiProductLoopPrompt {
  message: string;
  quick_task: 'inventory_analysis' | 'recipe_draft';
  subject: Record<string, unknown>;
}

export interface AiMealIdeaIngredient {
  ingredientId: string;
  name: string;
  quantityMode: 'track_quantity' | 'not_track_quantity';
  availableQuantity: string | null;
  unit: string | null;
  available: boolean;
}
export type AiTaskDraftType = 'recipe' | 'recipe_cook' | 'ingredient_profile' | 'shopping_list' | 'inventory_intake' | 'meal_plan' | 'meal_log' | 'food_profile' | 'inventory_operation' | 'composite_operation';
export type AiRecipeCookSchemaVersion = 'recipe_cook_operation.v1' | 'recipe_cook_operation.v2';
export type AiApprovalDecision = 'approved' | 'rejected';

export interface AiEvidenceItem {
  type: string;
  id?: string;
  label: string;
  status?: string;
  detail?: string;
}

export type AiInventoryDisplayStatus = 'available' | 'low_stock' | 'expiring' | 'expired';
export type AiInventoryOperationAction = 'consume' | 'dispose';
/** Inventory summary card quick actions. restock creates inventory_intake on the backend. */
export type AiInventoryCardAction = 'restock' | 'consume' | 'dispose';
export type AiInventoryQueryFocus = 'overview' | 'available' | 'expiring' | 'expired' | 'low_stock';

export type AiCookPageAction =
  | { type: 'go_next_step' }
  | { type: 'go_previous_step' }
  | { type: 'jump_to_step'; stepIndex: number }
  | { type: 'switch_tab'; tab: 'step' | 'ingredients' }
  | { type: 'start_timer'; timerId?: string }
  | { type: 'pause_timer'; timerId?: string }
  | { type: 'reset_timer'; timerId?: string }
  | { type: 'add_timer_seconds'; timerId?: string; seconds: number }
  | { type: 'set_timer'; timerId?: string; seconds: number; name?: string }
  | { type: 'reset_cook_session' }
  | { type: 'delete_timer'; timerId: string }
  | { type: 'finish_cooking' }
  | { type: 'open_shopping_dialog' };

export interface AiUiActionsCardData {
  surface: 'recipe_cook_page';
  recipeId: string;
  cookSessionId: string;
  sessionRevision: number;
  actions: AiCookPageAction[];
  requiresConfirmation: boolean;
}

export interface AiInventoryOperationResult {
  action: AiInventoryCardAction;
  quantity?: number | null;
  unit?: string | null;
  reason?: string | null;
  handledAt: string;
  handledBy?: string | null;
}

export interface AiInventoryResultItem {
  id: string;
  sourceType: 'ingredient' | 'food';
  ingredientId: string | null;
  foodId: string | null;
  inventoryItemId: string | null;
  name: string;
  image?: MediaAsset | null;
  quantity: string;
  unit: string;
  quantityTrackingMode: 'track_quantity' | 'not_track_quantity';
  status: string;
  displayStatus: AiInventoryDisplayStatus;
  expiryDate?: string | null;
  daysUntilExpiry?: number | null;
  lowStockThreshold?: string | null;
  purchaseDate?: string | null;
  storageLocation?: string | null;
  suggestedAction?: AiInventoryCardAction | null;
  lastOperation?: AiInventoryOperationResult | null;
}

export interface AiInventoryBatchOption {
  id: string;
  label: string;
  remainingQuantity: number;
  unit: string;
  expiryDate?: string | null;
  rowVersion?: number;
}

export interface AiInventoryOperationDraftItem {
  action: AiInventoryOperationAction;
  ingredientId: string;
  ingredientName: string;
  quantityTrackingMode?: 'track_quantity' | 'not_track_quantity';
  expectedIngredientRowVersion?: number;
  stateId?: string | null;
  expectedStateRowVersion?: number | null;
  inventoryItemId?: string | null;
  expectedInventoryItemRowVersion?: number | null;
  availabilityLevel?: 'present_unknown' | 'low' | 'sufficient' | null;
  quantity: number | null;
  unit: string;
  purchaseDate?: string | null;
  expiryDate?: string | null;
  storageLocation?: string | null;
  status?: InventoryStatus | null;
  notes: string;
  lowStockThreshold?: number | null;
  reason: string;
  sourceQuantity?: number | null;
  sourceUnit?: string | null;
  conversionRatioToDefault?: number | null;
  conversionNote?: string | null;
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
  expiredCount: number;
  lowStockCount: number;
  foodStockCount: number;
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

export interface AiClarificationCandidate {
  id: string;
  label: string;
  summary?: string | null;
  entityType?: string | null;
  updatedAt?: string | null;
}

export interface AiOperationResultEntity {
  id: string;
  label: string;
  entityType?: string | null;
  operation?: string | null;
  operationLabel?: string | null;
  updatedAt?: string | null;
}

export type AiAutoExecutionActionKey =
  | 'food.set_favorite'
  | 'meal_log.rate_food'
  | 'shopping_list.safe_write'
  | 'meal_log.simple_create'
  | 'meal_plan.simple_create';

export type AiCacheScope =
  | 'food'
  | 'meal_log'
  | 'meal_plan'
  | 'shopping_list'
  | 'inventory'
  | 'ai_conversation';

export interface AiAutoExecutionSettingRow {
  action_key: AiAutoExecutionActionKey;
  enabled: boolean;
  effective_enabled: boolean;
  row_version: number;
  consent_notice_version: string | null;
  requires_reconsent: boolean;
}

export interface AiAutoExecutionSettings {
  catalog_version: string;
  consent_notice: {
    version: string;
    acknowledged: boolean;
  };
  member_preferences: AiAutoExecutionSettingRow[];
  family_policies: AiAutoExecutionSettingRow[];
  limits: Record<string, Record<string, number>>;
  server_now: string;
}

export interface AiAutoExecutionUpdate {
  enabled: boolean;
  expected_row_version: number;
  consent_notice_version?: string;
}

export interface AiOperationResultProjection {
  draft_id: string;
  operation_id: string | null;
  result_status: 'completed' | 'no_change' | 'failed' | 'reverted';
  execution_mode: 'manual_approval' | 'policy_auto' | 'policy_no_change';
  operation_status: 'pending' | 'completed' | 'failed' | 'reverted' | null;
  execution_explanation: string;
  revert_availability: 'available' | 'expired' | 'unsupported' | 'blocked' | 'reverted';
  revertible_until: string | null;
  revert_blocked_code: string | null;
  server_now: string;
  entities: AiOperationResultEntity[];
  cache_scopes: AiCacheScope[];
}

export interface AiOperationRevertResponse {
  projection: AiOperationResultProjection;
  result_card: AiResultCard;
  cache_scopes: AiCacheScope[];
  server_now: string;
  replayed: boolean;
}

export interface AiOperationRevertConflict extends AiOperationRevertResponse {
  code:
    | 'revert_target_changed'
    | 'revert_dependency_exists'
    | 'revert_adapter_version_unsupported';
  message: string;
}

export interface AiResultCardData {
  recommendations?: AiTodayRecommendationItem[];
  targetDate?: string | null;
  mealType?: MealType | null;
  contextSummary?: AiTodayRecommendationCardData['contextSummary'];
  items?: AiInventoryResultItem[];
  queryFocus?: AiInventoryQueryFocus;
  availableCount?: number;
  expiringCount?: number;
  expiredCount?: number;
  lowStockCount?: number;
  foodStockCount?: number;
  question?: string;
  questionType?: string;
  missingFields?: string[];
  candidates?: AiClarificationCandidate[];
  allowFreeText?: boolean;
  actionSummary?: string;
  entityCount?: number;
  entityCountLabel?: string;
  workspaceLabel?: string;
  workspaceHint?: string;
  entities?: AiOperationResultEntity[];
  message?: string;
  draftId?: string;
  approvalId?: string;
  summary?: string;
  draft?: AiGeneratedRecipeDraft | Record<string, unknown>;
  draft_id?: string;
  operation_id?: string | null;
  result_status?: AiOperationResultProjection['result_status'];
  execution_mode?: AiOperationResultProjection['execution_mode'];
  operation_status?: AiOperationResultProjection['operation_status'];
  execution_explanation?: string;
  revert_availability?: AiOperationResultProjection['revert_availability'];
  revertible_until?: string | null;
  revert_blocked_code?: string | null;
  server_now?: string;
  cache_scopes?: AiCacheScope[];
  [key: string]: unknown;
}

export interface AiResultCard {
  id: string;
  type: AiResultCardType;
  title: string;
  data: AiResultCardData;
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
  widget: 'input' | 'textarea' | 'switch' | 'select' | 'radio' | 'checkbox_group' | 'tag_selector' | 'date' | 'time' | 'recipe_draft_editor' | 'inventory_intake_editor';
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
  failure_summary?: Record<string, unknown> | null;
  field_schema: AiApprovalField[];
  initial_values: { recipe?: AiGeneratedRecipeDraft; draft?: Record<string, unknown>; [key: string]: unknown };
  submitted_values: { recipe?: AiGeneratedRecipeDraft; draft?: Record<string, unknown>; [key: string]: unknown };
  decision?: AiApprovalDecision | null;
  comment?: string | null;
  resolved_at?: string | null;
  expires_at?: string | null;
  created_at: string;
}

export interface AiHumanInputOption {
  id: string;
  label: string;
  description?: string | null;
}

export interface AiHumanInputRequest {
  id: string;
  question: string;
  inputMode: 'choice' | 'text' | 'choice_or_text';
  options: AiHumanInputOption[];
  allowMultiple: boolean;
  required: boolean;
  reason?: string | null;
  sourceSkills: string[];
  resumeHint: Record<string, unknown>;
}

export interface AiHumanInputResponse {
  selectedOptionIds: string[];
  text: string;
  summary: string;
}

export interface AiMessageImagePartData {
  media_id: string;
  asset: MediaAsset;
  alt: string;
}

export interface AiMessagePart {
  id: string;
  type: AiMessagePartType;
  status?: 'pending' | 'completed' | string | null;
  responded_at?: string | null;
  text?: string | null;
  image?: AiMessageImagePartData | null;
  card?: AiResultCard | null;
  draft?: AiTaskDraft | null;
  approval?: AiApprovalRequest | null;
  request?: AiHumanInputRequest | null;
  response?: AiHumanInputResponse | null;
  activity?: AiRunEvent | null;
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

export interface AiModelUsageFallback {
  used: true;
  reasonCode: ModelUsageErrorCode | null;
}

export type AiRunStatus = 'pending' | 'running' | 'waiting_approval' | 'waiting_input' | 'cancelling' | 'completed' | 'failed' | 'fallback' | 'cancelled';
export type AiRunEventStatus = 'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
export type AiRunCancellationPhase = 'idle' | 'requesting' | 'cancelling' | 'cancelled' | 'failed';
export type AiRunCancellationOutcome = 'cancel_requested' | 'cancelled' | 'already_cancelled';

export interface AiRun {
  id: string;
  agent_key: string;
  intent: string;
  status: AiRunStatus;
  model: string;
  fallback_used?: boolean;
  fallback_reason_code?: ModelUsageErrorCode | null;
  created_at: string;
}

export interface AiRunEvent {
  id: string;
  run_id: string;
  type: string;
  internal_code: string;
  user_message: string;
  status: AiRunEventStatus;
  created_at: string;
}

export interface AiRunCancellationResponse {
  outcome: AiRunCancellationOutcome;
  request: {
    run_id: string;
    status: 'requested' | 'applied';
    requested_at: string;
    resolved_at?: string | null;
  };
  run: AiRun | null;
  events: AiRunEvent[];
}

export interface AiRunTraceSpan {
  id: string;
  runId: string;
  conversationId?: string | null;
  traceId: string;
  spanId: string;
  parentSpanId?: string | null;
  spanType: string;
  name: string;
  status: string;
  roundIndex?: number | null;
  attemptIndex?: number | null;
  startedAt: string;
  endedAt?: string | null;
  durationMs: number;
  inputSummary: Record<string, unknown>;
  outputSummary: Record<string, unknown>;
  errorCode?: string | null;
  errorMessage?: string | null;
  exceptionType?: string | null;
  payload: Record<string, unknown>;
}

export interface AiRunTraceResponse {
  runId: string;
  traceId: string;
  status: string;
  spans: AiRunTraceSpan[];
}

export interface AiRunTraceTreeNode extends AiRunTraceSpan {
  children: AiRunTraceTreeNode[];
}

export interface AiRunTraceTreeResponse {
  runId: string;
  traceId: string;
  status: string;
  tree: AiRunTraceTreeNode[];
}

export interface AiRunLLMExchange {
  id: string;
  runId: string;
  conversationId?: string | null;
  traceId: string;
  spanId?: string | null;
  providerRound: number;
  attemptIndex: number;
  mode: string;
  model: string;
  requestToolCount: number;
  requestToolNames: string[];
  responseToolCallCount: number;
  responseToolCallNames: string[];
  payloadIncluded: boolean;
  requestMessages: unknown[];
  requestTools: unknown[];
  requestOptions: Record<string, unknown>;
  requestOriginalDigest: string;
  requestOriginalBytes: number;
  requestDigest: string;
  requestBytes: number;
  requestTruncated: boolean;
  responseMessage: Record<string, unknown>;
  responseText?: string | null;
  responseToolCalls: unknown[];
  streamChunks: unknown[];
  responseOriginalDigest: string;
  responseOriginalBytes: number;
  responseDigest: string;
  responseBytes: number;
  responseTruncated: boolean;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  cachedTokens?: number | null;
  estimatedCostUsd?: number | null;
  tokenUsage: Record<string, unknown>;
  status: string;
  errorCode?: string | null;
  errorMessage?: string | null;
  startedAt: string;
  endedAt?: string | null;
  durationMs: number;
}

export interface AiRunLLMExchangeResponse {
  runId: string;
  traceId: string;
  exchanges: AiRunLLMExchange[];
}

export interface AiStatus {
  configured: boolean;
  enabled: boolean;
  supports_vision: boolean;
  status: 'ready' | 'not_configured' | 'disabled' | 'degraded';
  detail: string;
  capabilities: Record<FamilyModelCapability, 'available' | 'unavailable' | 'provisioning' | 'failed' | 'budget_blocked'>;
}

export interface AiQualityMetrics {
  family_id: string;
  window: {
    limit: number;
    days?: number | null;
  };
  run_count: number;
  status_counts: Record<string, number>;
  intent_counts: Record<string, number>;
  routing_skill_counts: Record<string, number>;
  clarification_reasons: Record<string, number>;
  clarification_by_skill: Record<string, number>;
  approval_by_draft_type: Record<string, Record<string, number>>;
  skill_diagnostics: Record<string, number>;
  skill_status_counts: Record<string, number>;
  totals: {
    skillExecutionCount: number;
    completedSkillExecutionCount: number;
    toolCallCount: number;
    draftCount: number;
    approvalRequestCount: number;
    clarificationCount: number;
    approvalApprovedCount: number;
    approvalRejectedCount: number;
    routeSelectionCount: number;
    draftValidationCandidateCount: number;
    draftValidationAttemptCount: number;
    draftFirstPassSuccessCount: number;
    invalidIdentityRejectedCount: number;
    toolBudgetExhaustedCount: number;
    continuationStartedCount: number;
    continuationCompletedCount: number;
    continuationRejectedCount: number;
    totalDurationMs: number;
    averageDurationMs: number;
  };
  operational_metrics: {
    draftFirstPassRate: AiRateMetric;
    continuationCompletionRate: AiRateMetric;
    approvalUneditedRate: AiRateMetric;
    invalidIdentityRejectedCount: number;
    toolBudgetExhaustedCount: number;
    continuationRejectedCount: number;
  };
  token_usage: {
    windows: Record<string, AiTokenUsageWindow>;
  };
  trace_metrics: {
    traceSpanCount: number;
    llmExchangeCount: number;
    failedSpanCount: number;
    failedExchangeCount: number;
    averageProviderDurationMs: number;
    averageToolDurationMs: number;
    averageScriptDurationMs: number;
    averageProviderRounds: number;
    errorCodes: Record<string, number>;
    spanTypeCounts: Record<string, number>;
    spanStatusCounts: Record<string, number>;
    exchangeStatusCounts: Record<string, number>;
  };
  recent_runs: Array<{
    id: string;
    agent_key: string;
    intent: string;
    status: string;
    model: string;
    created_at: string;
    duration_ms: number;
    error_code?: string | null;
    routing_skills: string[];
    clarification_count: number;
    approval_request_count: number;
    approval_approved_count: number;
    approval_rejected_count: number;
  }>;
}

export interface AiTokenUsageWindow {
  hours: number;
  exchangeCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens: number;
  estimatedCostUsd: number;
}

export interface AiRateMetric {
  numerator: number;
  denominator: number;
  rate: number | null;
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

export interface ImageInputValue {
  referenceAsset?: MediaAsset;
  generatedAsset?: MediaAsset;
  pendingJob?: AiRenderResponse;
}

export interface CreateAiRenderRequest {
  mode: ImageGenerationMode;
  entity_type: MediaEntityType;
  reference_media_id?: string;
  target_entity_type?: AiImageTargetEntityType;
  target_entity_id?: string;
  replace_anchor_media_id?: string | null;
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
export type AiImageTargetEntityType = 'food' | 'ingredient' | 'recipe' | 'food_scene' | 'meal_log' | 'user' | 'family';
export type AiImageBindStatus = 'pending' | 'bound' | 'skipped' | 'unbound';

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
  error_code?: string | null;
  can_retry: boolean;
  generated_asset?: MediaAsset | null;
  reference_asset?: MediaAsset | null;
  style_key?: string | null;
  prompt_version?: string | null;
  generation_mode: ImageGenerationMode;
  target_entity_type?: AiImageTargetEntityType | null;
  target_entity_id?: string | null;
  target_entity_name?: string | null;
  bind_status?: AiImageBindStatus | null;
  created_at?: string | null;
  completed_at?: string | null;
}
