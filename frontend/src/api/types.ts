export type UserRole = 'Owner' | 'Member';

export type ModelUsageCapability =
  | 'llm'
  | 'embedding'
  | 'rerank'
  | 'stt'
  | 'tts'
  | 'realtime_audio'
  | 'image_generation';

export type ModelUsageMeter =
  | 'input_tokens'
  | 'uncached_input_tokens'
  | 'cached_input_tokens'
  | 'output_tokens'
  | 'total_tokens'
  | 'embedding_tokens'
  | 'rerank_requests'
  | 'rerank_documents'
  | 'audio_input_seconds'
  | 'audio_output_seconds'
  | 'audio_input_tokens'
  | 'audio_output_tokens'
  | 'tts_characters'
  | 'tts_tokens'
  | 'generated_images'
  | 'request_units';

export type ModelUsageScope = 'me' | 'family';
export type ModelUsagePersonalGroupBy =
  | 'capability'
  | 'meter'
  | 'daily_capability_cost';
export type ModelUsageFamilyGroupBy = ModelUsagePersonalGroupBy
  | 'provider_model'
  | 'subject';
/** The current UI selection may be any Owner choice; personal calls narrow it first. */
export type ModelUsageGroupBy = ModelUsageFamilyGroupBy;

export interface ModelUsageRequestMeter {
  meter: ModelUsageMeter;
  quantity: string;
}

export interface ModelUsagePersonalRequestLog {
  id: string;
  occurred_at: string;
  capability: ModelUsageCapability;
  provider_outcome: string;
  execution_certainty: string;
  measurement_status: string;
  pricing_status: string;
  meters: ModelUsageRequestMeter[];
}

/** Owner-only diagnostic record. It deliberately extends the personal projection. */
export interface ModelUsageFamilyRequestLog extends ModelUsagePersonalRequestLog {
  provider: string;
  requested_model: string;
  billing_model: string;
  provider_request_id?: string | null;
  subject_label?: string | null;
  cost_cny?: string | null;
}

export interface ModelUsagePersonalRequestLogPage {
  family_id: string;
  date_from: string;
  date_to: string;
  scope: 'me';
  source: 'raw';
  items: ModelUsagePersonalRequestLog[];
  total: number;
  limit: number;
  offset: number;
}

export interface ModelUsageFamilyRequestLogPage {
  family_id: string;
  date_from: string;
  date_to: string;
  scope: 'family';
  source: 'raw';
  items: ModelUsageFamilyRequestLog[];
  total: number;
  limit: number;
  offset: number;
}

export type ModelUsageRequestLogPage =
  | ModelUsagePersonalRequestLogPage
  | ModelUsageFamilyRequestLogPage;

export interface ModelUsagePersonalRequestFilters {
  date_from: string;
  date_to: string;
  capability?: ModelUsageCapability;
  status?: 'priced' | 'estimated' | 'unpriced' | 'needs_review';
  limit?: number;
  offset?: number;
}

export interface ModelUsageFamilyRequestFilters extends ModelUsagePersonalRequestFilters {
  provider?: string;
  model?: string;
}

export type FamilyModelCapability = ModelUsageCapability;

export type FamilyModelAdapterKind =
  | 'openai_compatible_http'
  | 'openai_realtime'
  | 'dashscope_http'
  | 'dashscope_realtime';

export type FamilyModelAuthMode = 'api_key' | 'no_auth';
export type FamilyModelProviderStatus = 'active' | 'disabled' | 'archived';

export interface FamilyModelProviderScopeOptions {
  workspace_id?: string | null;
  region?: string | null;
  project_id?: string | null;
}

export interface FamilyModelCredentialMetadata {
  configured: boolean;
  version_number: number | null;
  updated_at: string | null;
}

/** Safe provider metadata. Credentials are intentionally absent. */
export interface FamilyModelProviderProfile {
  id: string;
  display_name: string;
  adapter_kind: FamilyModelAdapterKind;
  auth_mode: FamilyModelAuthMode;
  api_base_url: string;
  websocket_base_url: string | null;
  options: FamilyModelProviderScopeOptions;
  status: FamilyModelProviderStatus;
  archived: boolean;
  version_number: number;
  profile_version_number: number;
  credential: FamilyModelCredentialMetadata;
  created_at: string;
  updated_at: string;
}

/** `api_key` only exists in an immediate write payload. */
export interface FamilyModelProviderProfileCreate {
  display_name: string;
  adapter_kind: FamilyModelAdapterKind;
  auth_mode: FamilyModelAuthMode;
  api_base_url: string;
  websocket_base_url?: string | null;
  options?: FamilyModelProviderScopeOptions;
  api_key?: string;
  idempotency_key: string;
}

/** Endpoint, auth mode and credential scope are immutable after creation. */
export interface FamilyModelProviderProfilePatch {
  display_name?: string;
  status?: FamilyModelProviderStatus;
  base_profile_version_number: number;
  idempotency_key: string;
}

export interface RotateFamilyModelProviderProfileKeyPayload {
  new_api_key: string;
  base_settings_version_number: number;
  idempotency_key: string;
}

export interface RotateFamilyModelProviderProfileKeyResult {
  configured: boolean;
  secret_version_number: number;
  updated_at: string;
}

export interface FamilyModelProviderConnectionCheckPayload {
  idempotency_key: string;
}

export interface FamilyModelProviderConnectionCheckResult {
  status: 'reachable' | 'not_supported';
  detail: string | null;
  checked_at: string;
  latency_ms: number | null;
  profile_version_number: number;
  models: string[];
}

interface FamilyModelBindingDraftBase<C extends FamilyModelCapability, V extends string> {
  capability: C;
  variant_key: V;
  enabled: boolean;
  provider_profile_id: string | null;
  requested_model: string;
  billing_scheme_key: string;
}

export interface FamilyModelLlmBindingDraft
  extends FamilyModelBindingDraftBase<'llm', 'primary' | 'fallback'> {
  billing_scheme_key: 'llm-split-v1';
  max_output_tokens: number;
  supports_vision: boolean;
  prompt_cache_enabled: boolean;
}

export interface FamilyModelImageGenerationBindingDraft
  extends FamilyModelBindingDraftBase<'image_generation', 'text' | 'reference'> {
  billing_scheme_key: 'image-count-v1';
  image_size: '1024x1024' | '1024x1536' | '1536x1024';
  response_format: 'b64_json' | 'url';
}

export interface FamilyModelSttBindingDraft
  extends FamilyModelBindingDraftBase<'stt', 'default'> {
  billing_scheme_key: 'stt-seconds-v1';
  language_hint: string | null;
  hotwords: string[];
}

export interface FamilyModelTtsBindingDraft
  extends FamilyModelBindingDraftBase<'tts', 'default'> {
  billing_scheme_key: 'tts-characters-v1';
  voice: string | null;
  output_format: 'mp3' | 'wav' | 'ogg' | 'flac' | 'mp4';
}

export interface FamilyModelRealtimeAudioBindingDraft
  extends FamilyModelBindingDraftBase<'realtime_audio', 'default'> {
  billing_scheme_key: 'realtime-asr-seconds-tts-characters-v1';
  voice: string | null;
  language_hint: string | null;
}

export interface FamilyModelEmbeddingBindingDraft
  extends FamilyModelBindingDraftBase<'embedding', 'search'> {
  billing_scheme_key: 'embedding-token-v1';
  dimensions: number;
}

export interface FamilyModelRerankBindingDraft
  extends FamilyModelBindingDraftBase<'rerank', 'search'> {
  billing_scheme_key: 'rerank-token-v1';
  top_n: number;
  instruction: string | null;
}

export type FamilyModelBindingDraft =
  | FamilyModelLlmBindingDraft
  | FamilyModelImageGenerationBindingDraft
  | FamilyModelSttBindingDraft
  | FamilyModelTtsBindingDraft
  | FamilyModelRealtimeAudioBindingDraft
  | FamilyModelEmbeddingBindingDraft
  | FamilyModelRerankBindingDraft;

export interface FamilyModelPriceRate {
  capability: FamilyModelCapability;
  variant_key: string;
  meter: ModelUsageMeter;
  unit_quantity: string;
  unit_price: string;
  source_currency: string;
  fx_to_cny: string;
  reported_model_aliases: string[];
}

export interface FamilyModelPriceRateOut extends FamilyModelPriceRate {
  provider_profile_id: string;
  billing_model: string;
  billing_scheme_key: string;
  unit_price_cny: string;
}

export interface FamilyModelPriceDraftPayload {
  base_price_version_id: string | null;
  rates: FamilyModelPriceRate[];
  change_note: string;
}

export interface SaveFamilyModelPricesDraftPayload extends FamilyModelPriceDraftPayload {
  base_draft_version_number: number;
  idempotency_key: string;
}

export interface FamilyModelPricesDraft extends FamilyModelPriceDraftPayload {
  draft_version_number: number;
  updated_at: string | null;
}

export interface FamilyModelConfigDraftPayload {
  base_config_revision_id: string | null;
  search_profile_id: string | null;
  bindings: FamilyModelBindingDraft[];
  price_rates: FamilyModelPriceRate[];
  price_draft: FamilyModelPriceDraftPayload | null;
  change_note: string;
}

export interface SaveFamilyModelConfigDraftPayload extends FamilyModelConfigDraftPayload {
  base_draft_version_number: number;
  idempotency_key: string;
  confirm_initial_search_index?: boolean;
}

export interface FamilyModelConfigDraft {
  base_config_revision_id: string | null;
  draft_version_number: number;
  payload: FamilyModelConfigDraftPayload;
  validation_status: string;
  validation_errors: Array<{ code: string; field?: string | null }>;
  updated_at: string | null;
}

export interface FamilyModelDraftValidationIssue {
  code: string;
  field: string | null;
}

export interface FamilyModelDraftValidation {
  valid: boolean;
  draft_version_number: number;
  errors: FamilyModelDraftValidationIssue[];
  config_checksum: string | null;
  price_checksum: string | null;
}

export interface PublishFamilyModelSettingsPayload {
  base_settings_version_number: number;
  base_draft_version_number: number;
  idempotency_key: string;
  config_checksum: string;
  price_checksum: string;
  current_password?: string;
}

export interface PublishedFamilyModelConfiguration {
  config_revision_id: string;
  price_version_id: string;
  settings_version_number: number;
  config_checksum: string;
  price_checksum: string;
  search_profile_id: string | null;
}

export interface FamilyModelPriceVersionSummary {
  id: string;
  config_revision_id: string | null;
  search_profile_id: string | null;
  base_price_version_id: string | null;
  purpose: string;
  version_number: number;
  checksum: string;
  change_note: string;
  published_by: string | null;
  published_at: string;
}

export interface FamilyModelPrices {
  active_config_revision_id: string | null;
  active_price_version_id: string | null;
  current_rates: FamilyModelPriceRateOut[];
  history: FamilyModelPriceVersionSummary[];
  draft: FamilyModelPricesDraft | null;
}

export interface PublishFamilyModelPricesPayload {
  base_settings_version_number: number;
  base_price_version_id: string;
  idempotency_key: string;
  confirm_checksum: string;
  change_note: string;
  rates: FamilyModelPriceRate[];
}

export interface PublishedFamilyModelPrices {
  config_revision_id: string;
  price_version_id: string;
  settings_version_number: number;
  price_checksum: string;
}

export interface FamilyModelSettings {
  version_number: number;
  active_config_revision_id: string | null;
  active_price_version_id: string | null;
  active_search_profile_id?: string | null;
  provider_profiles: FamilyModelProviderProfile[];
  updated_at: string;
}

export interface FamilyModelCapabilityTestPayload {
  variant_key: string;
  confirm_billable: boolean;
  base_draft_version_number: number;
  idempotency_key: string;
}

export interface FamilyModelCapabilityTestResult {
  capability: FamilyModelCapability;
  variant_key: string;
  status: 'succeeded' | 'failed' | 'blocked';
  detail: string;
  checked_at: string;
}

export interface FamilyModelSearchReplacementBasePayload {
  base_settings_version_number: number;
  base_search_profile_id: string;
  provider_profile_id: string;
  requested_model: string;
  dimensions: number;
  rates: FamilyModelPriceRate[];
}

export interface FamilyModelSearchReplacementPreview extends FamilyModelSearchReplacementBasePayload {}

export interface FamilyModelSearchReplacementPreviewResult {
  document_count: number;
  minimum_estimated_tokens: number;
  conservative_estimated_tokens: number;
  minimum_estimated_cost_cny: string;
  conservative_estimated_cost_cny: string;
  confirmation_checksum: string;
}

export interface CreateFamilyModelSearchReplacementPayload extends FamilyModelSearchReplacementBasePayload {
  confirm_checksum: string;
  current_password: string;
  idempotency_key: string;
}

export interface FamilyModelSearchReplacement {
  profile_id: string;
  status: 'provisioning' | 'failed' | 'active' | 'cancelled' | 'superseded' | 'retired';
  total_documents: number;
  indexed_documents: number;
  failed_documents: number;
  budget_blocked_documents: number;
  retryable: boolean;
  created_at: string;
  activated_at: string | null;
}

export interface FamilyModelSearchReplacementMutationPayload {
  base_settings_version_number: number;
  idempotency_key: string;
}
export type ModelUsageLimitKind = 'cost' | 'meter';
export type ModelUsageMemberBudgetState =
  | 'sufficient'
  | 'approaching_limit'
  | 'alert_threshold_reached'
  | 'capability_degraded'
  | 'measurement_unavailable';
export type ModelUsageIncidentCoverage = 'exact_scope' | 'partial_scope' | 'unknown_scope';

export type ModelUsageErrorCode =
  | 'model_usage_adjustment_window_closed'
  | 'model_usage_alert_not_found'
  | 'model_usage_attempt_already_accounted'
  | 'model_usage_attempt_conflict'
  | 'model_usage_budget_exceeded'
  | 'model_usage_capability_limit_exceeded'
  | 'model_usage_dispatch_recovery_required'
  | 'model_usage_future_period_not_allowed'
  | 'model_usage_guardrail_quantity_unavailable'
  | 'model_usage_historical_rollup_not_found'
  | 'model_usage_invalid_group_by'
  | 'model_usage_invalid_period'
  | 'model_usage_ledger_unavailable'
  | 'model_usage_missing_price_confirmation_required'
  | 'model_usage_policy_conflict'
  | 'model_usage_policy_validation_error'
  | 'model_usage_price_unavailable'
  | 'model_usage_query_unavailable'
  | 'model_usage_settlement_pending';

export interface ModelUsageGapInterval {
  started_at: string;
  ended_at: string;
  scope: string[];
  coverage: ModelUsageIncidentCoverage;
}

export interface ModelUsageMeasurementHealth {
  exact_event_count: number;
  estimated_event_count: number;
  unpriced_event_count: number;
  uncertain_attempt_count: number;
  pending_attempt_count: number;
  unresolved_unknown_execution_attempt_count: number;
  conservative_estimated_cost_cny: string | null;
  known_unmeasured_attempt_count: number;
  measurement_gap: boolean;
  measurement_gap_scope: string[];
  gap_intervals: ModelUsageGapInterval[];
}

export interface ModelUsageCostSummary {
  known_priced_cost_cny: string;
  pricing_complete: boolean;
  unpriced_event_count: number;
  total_cost_cny?: string;
}

export interface ModelUsageMeterTotal {
  meter: ModelUsageMeter;
  quantity: string;
}

export interface ModelUsageOverviewBase extends ModelUsageCostSummary {
  family_id: string;
  period: string;
  source: 'raw' | 'rollup';
  is_partial_period: boolean;
  tracking_started_at?: string | null;
  meter_totals: ModelUsageMeterTotal[];
  measurement_health: ModelUsageMeasurementHealth;
}

export interface ModelUsagePersonalOverview extends ModelUsageOverviewBase {
  scope: 'me';
  family_budget_state: ModelUsageMemberBudgetState;
}

export interface ModelUsageFamilyOverview extends ModelUsageOverviewBase {
  scope: 'family';
  monthly_budget_cny: string | null;
  effective_spend_cny: string;
  reserved_cost_cny: string;
  hard_limit_enabled: boolean;
}

export interface ModelUsagePersonalBreakdownItem extends ModelUsageCostSummary {
  label: string;
  capability?: ModelUsageCapability | null;
  meter?: ModelUsageMeter | null;
  meter_total?: string | null;
  local_day?: string | null;
  measurement_health: ModelUsageMeasurementHealth;
}

/** Owner-only diagnostic aggregate. Provider/model identity is not optional in the personal branch. */
export interface ModelUsageFamilyBreakdownItem extends ModelUsagePersonalBreakdownItem {
  provider?: string | null;
  billing_model?: string | null;
}

export type ModelUsageBreakdownItem =
  | ModelUsagePersonalBreakdownItem
  | ModelUsageFamilyBreakdownItem;

export interface ModelUsageBreakdownBase {
  family_id: string;
  period: string;
  source: 'raw' | 'rollup';
  is_partial_period: boolean;
}

export interface ModelUsagePersonalBreakdown extends ModelUsageBreakdownBase {
  scope: 'me';
  group_by: ModelUsagePersonalGroupBy;
  items: ModelUsagePersonalBreakdownItem[];
}

export interface ModelUsageFamilyBreakdown extends ModelUsageBreakdownBase {
  scope: 'family';
  group_by: ModelUsageFamilyGroupBy;
  items: ModelUsageFamilyBreakdownItem[];
}

export type ModelUsageBreakdown = ModelUsagePersonalBreakdown | ModelUsageFamilyBreakdown;

export interface ModelUsageCapabilityLimit {
  capability: ModelUsageCapability;
  limit_kind: ModelUsageLimitKind;
  meter: ModelUsageMeter | null;
  limit_value: string;
  enabled: boolean;
}

export interface ModelUsagePolicy {
  version_number: number;
  monthly_budget_cny: string | null;
  alerts_enabled: boolean;
  hard_limit_enabled: boolean;
  budget_alert_revision: number;
  capability_limits: ModelUsageCapabilityLimit[];
  effective_at: string;
}

export interface UpdateModelUsagePolicyPayload {
  base_version_number: number;
  monthly_budget_cny: string | null;
  alerts_enabled: boolean;
  hard_limit_enabled: boolean;
  capability_limits: ModelUsageCapabilityLimit[];
  confirm_missing_price_impact: boolean;
}

export interface ModelUsageAlertReceipt {
  alert_id: string;
  seen_at: string | null;
  dismissed_at: string | null;
}

export interface ModelUsageAlert {
  id: string;
  period: string;
  threshold: string;
  budget_cny: string;
  settled_value: string;
  adjustment_value: string;
  effective_spend_cny: string;
  severity: 'warning' | 'critical';
  seen_at: string | null;
  dismissed_at: string | null;
  created_at: string;
}

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
  url_expires_at?: string;
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
  url_expires_at?: string;
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
  food_preferences: string[];
  food_avoidances: string[];
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

export type IngredientQuantityTrackingMode = 'track_quantity' | 'not_track_quantity';

export interface Ingredient {
  id: string;
  family_id: string;
  name: string;
  category: string;
  default_unit: string;
  unit_conversions: IngredientUnitConversion[];
  quantity_tracking_mode?: IngredientQuantityTrackingMode;
  default_storage: string;
  default_expiry_mode: IngredientExpiryMode;
  default_expiry_days?: number | null;
  default_low_stock_threshold?: number | null;
  notes: string;
  image?: MediaAsset | null;
  row_version?: number;
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
  quantity_tracking_mode?: IngredientQuantityTrackingMode;
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
  row_version: number;
  expiry_alert_snoozed_until?: string | null;
  expiry_reviewed_at?: string | null;
  expiry_reviewed_by?: string | null;
  last_confirmed_at?: string | null;
  last_confirmed_by?: string | null;
  last_confirmation_source?: InventoryConfirmationSource | null;
}


export type InventoryAvailabilityLevel = 'present_unknown' | 'low' | 'sufficient' | 'absent';
export type InventoryConfirmationSource = 'manual_entry' | 'reconciliation' | 'shopping_intake';
export type InventoryConfirmationStatus = 'never_confirmed' | 'current' | 'stale';

export interface IngredientInventoryState {
  id: string;
  family_id: string;
  ingredient_id: string;
  availability_level: InventoryAvailabilityLevel;
  inventory_status: InventoryStatus;
  purchase_date: string | null;
  expiry_date: string | null;
  storage_location: string | null;
  notes: string;
  expiry_alert_snoozed_until: string | null;
  expiry_reviewed_at: string | null;
  expiry_reviewed_by: string | null;
  last_confirmed_at: string | null;
  last_confirmed_by: string | null;
  last_confirmation_source: InventoryConfirmationSource | null;
  row_version: number;
  created_at: string;
  updated_at: string;
}

export type UpsertIngredientInventoryStateRequest = {
  expected_ingredient_row_version: number;
  state_id?: string | null;
  expected_state_row_version?: number | null;
  availability_level: InventoryAvailabilityLevel;
  inventory_status: InventoryStatus;
  purchase_date?: string | null;
  expiry_date?: string | null;
  storage_location?: string | null;
  notes?: string;
};

export type SnoozeStateExpiryAlertRequest = {
  action: 'retain_expired' | 'snooze_upcoming';
  state_id: string;
  expected_row_version: number;
  snoozed_until: string;
};

export type CorrectStateExpiryDateRequest = {
  state_id: string;
  expected_row_version: number;
  expiry_date: string;
};

export type SetInventoryStateAbsentRequest = {
  state_id: string;
  expected_row_version: number;
};

export type ShoppingIntakeItemRequest =
  | {
      shopping_item_id: string;
      expected_shopping_item_row_version: number;
      action: 'stock_and_fulfill';
      target_kind: 'exact_ingredient';
      target_id: string;
      expected_ingredient_row_version: number;
      actual_quantity: number;
      unit: string;
      inventory_status: InventoryStatus;
      expiry_date: string | null;
      storage_location: string;
      notes: string;
    }
  | {
      shopping_item_id: string;
      expected_shopping_item_row_version: number;
      action: 'stock_and_fulfill';
      target_kind: 'presence_ingredient';
      target_id: string;
      expected_ingredient_row_version: number;
      state_id: string | null;
      expected_state_row_version: number | null;
      resulting_availability_level: Exclude<InventoryAvailabilityLevel, 'absent'>;
      inventory_status: InventoryStatus;
      expiry_date: string | null;
      storage_location: string;
      notes: string;
    }
  | {
      shopping_item_id: string;
      expected_shopping_item_row_version: number;
      action: 'stock_and_fulfill';
      target_kind: 'food';
      target_id: string;
      expected_food_row_version: number;
      actual_quantity: number;
      unit: string;
      expiry_date: string | null;
      storage_location: string;
    }
  | {
      shopping_item_id: string;
      expected_shopping_item_row_version: number;
      action: 'complete_without_inventory';
      target_kind: 'none';
      target_id: null;
    };

export interface ShoppingIntakeRequest {
  client_request_id: string;
  purchase_date: string;
  items: ShoppingIntakeItemRequest[];
}

export interface ShoppingIntakeItemResult {
  shopping_item_id: string;
  result: 'completed' | 'partial' | 'stocked' | 'completed_without_inventory';
  remaining_planned_quantity: number | null;
  inventory_item_id: string | null;
  state_id: string | null;
  food_id: string | null;
}

export interface InventoryOperationDisplaySummary {
  title: string;
  description: string;
  confirmed_count: number;
  adjusted_count: number;
  completed_count: number;
  partial_count: number;
}

export interface InventoryOperationResult {
  operation_id: string;
  operation_type: 'reconciliation' | 'shopping_intake';
  status: 'applied' | 'reverted';
  applied_at: string;
  revertible_until: string;
  can_revert: boolean;
  summary: InventoryOperationDisplaySummary;
}

export interface InventoryOperationSummary extends InventoryOperationResult {
  actor_display_name: string;
}

export type InventoryOperationEntityType =
  | 'ingredient'
  | 'inventory_item'
  | 'non_tracked_ingredient_state'
  | 'food'
  | 'shopping_list_item';

export type InventoryOperationChangeType = 'create' | 'update' | 'delete';

export interface InventoryOperationLineDisplay {
  sequence: number;
  entity_type: InventoryOperationEntityType;
  change_type: InventoryOperationChangeType;
  title: string;
  description: string;
}

export interface InventoryOperationDetail extends InventoryOperationSummary {
  lines: InventoryOperationLineDisplay[];
}

export interface ShoppingIntakeResult extends InventoryOperationResult {
  items: ShoppingIntakeItemResult[];
}

export interface ReconciliationSummary {
  total_groups: number;
  never_confirmed: number;
  stale: number;
  expired_physical_batches: number;
}

export interface ReconciliationBatch {
  inventory_item_id: string;
  row_version: number;
  remaining_quantity: number;
  unit: string;
  status: InventoryStatus;
  purchase_date: string;
  expiry_date: string | null;
  storage_location: string;
  notes: string;
  confirmation_status: InventoryConfirmationStatus;
  last_confirmed_at: string | null;
}

export interface ExactIngredientReconciliationGroup {
  kind: 'exact_ingredient';
  ingredient_id: string;
  ingredient_name: string;
  ingredient_row_version: number;
  default_unit?: string;
  unit_conversions?: IngredientUnitConversion[];
  confirmation_status: InventoryConfirmationStatus;
  last_confirmed_at: string | null;
  batches: ReconciliationBatch[];
  pending_shopping_item_id: string | null;
}

export interface PresenceIngredientReconciliationGroup {
  kind: 'presence_ingredient';
  ingredient_id: string;
  ingredient_name: string;
  ingredient_row_version: number;
  state: IngredientInventoryState;
  confirmation_status: InventoryConfirmationStatus;
  pending_shopping_item_id: string | null;
}

export interface FoodReconciliationGroup {
  kind: 'food';
  food_id: string;
  food_name: string;
  row_version: number;
  stock_quantity: number;
  stock_unit: string;
  expiry_date: string | null;
  storage_location: string | null;
  confirmation_status: InventoryConfirmationStatus;
  last_confirmed_at: string | null;
}

export type InventoryReconciliationGroup =
  | ExactIngredientReconciliationGroup
  | PresenceIngredientReconciliationGroup
  | FoodReconciliationGroup;

export interface InventoryReconciliationResponse {
  business_date: string;
  business_timezone: 'Asia/Shanghai';
  generated_at: string;
  summary: ReconciliationSummary;
  groups: InventoryReconciliationGroup[];
}

export interface VersionedObservedBatchRequest {
  inventory_item_id: string;
  expected_row_version: number;
}

export interface InventoryBatchUpdateRequest {
  inventory_item_id: string;
  expected_row_version: number;
  actual_remaining_quantity: number;
  inventory_status: InventoryStatus;
  purchase_date: string;
  expiry_date: string | null;
  storage_location: string;
  notes: string;
}

export interface InventoryBatchCreateRequest {
  client_line_id: string;
  actual_remaining_quantity: number;
  unit: string;
  inventory_status: InventoryStatus;
  purchase_date: string;
  expiry_date: string | null;
  storage_location: string;
  notes: string;
}

export type InventoryReconciliationGroupRequest =
  | {
      kind: 'exact_ingredient';
      ingredient_id: string;
      expected_ingredient_row_version: number;
      action: 'confirm_all' | 'set_absent' | 'adjust_batches';
      observed_batches: VersionedObservedBatchRequest[];
      updates: InventoryBatchUpdateRequest[];
      creates: InventoryBatchCreateRequest[];
    }
  | {
      kind: 'presence_ingredient';
      ingredient_id: string;
      state_id: string | null;
      expected_ingredient_row_version: number;
      expected_state_row_version: number | null;
      availability_level: InventoryAvailabilityLevel;
      inventory_status: InventoryStatus;
      purchase_date: string | null;
      expiry_date: string | null;
      storage_location: string | null;
      notes: string;
    }
  | {
      kind: 'food';
      food_id: string;
      expected_row_version: number;
      action: 'confirm' | 'set_stock';
      stock_quantity: number | null;
      stock_unit: string | null;
      expiry_date: string | null;
      storage_location: string | null;
    };

export interface InventoryReconciliationRequest {
  client_request_id: string;
  scope: 'suggested' | 'refrigerated' | 'frozen' | 'room_temperature' | 'all';
  storage_location: string | null;
  groups: InventoryReconciliationGroupRequest[];
}

export type InventoryOverviewScope = 'all' | 'ingredient' | 'food';
export type InventoryOverviewSourceType = 'ingredient' | 'food';
export type InventoryOverviewTone = 'stable' | 'warning' | 'danger' | 'empty';
export type InventoryOverviewPrimaryAction = 'restock' | 'consume' | 'dispose' | 'record_meal' | 'edit_food_stock';

export interface InventoryOverviewItem {
  id: string;
  source_type: InventoryOverviewSourceType;
  source_id: string;
  row_version: number;
  inventory_item_id?: string | null;
  title: string;
  category: string;
  image?: MediaAsset | null;
  quantity?: number | null;
  unit: string;
  quantity_label: string;
  quantity_tracking_mode: IngredientQuantityTrackingMode;
  status?: InventoryStatus | null;
  tone: InventoryOverviewTone;
  expiry_date?: string | null;
  days_until_expiry?: number | null;
  storage_location: string;
  purchase_source?: string | null;
  updated_at: string;
  primary_action: InventoryOverviewPrimaryAction;
  search_text: string;
}

export interface InventoryOverview {
  scope: InventoryOverviewScope;
  query: string;
  summary: {
    total_count: number;
    ingredient_count: number;
    food_count: number;
    alert_count: number;
    expiring_count: number;
    empty_count: number;
  };
  items: InventoryOverviewItem[];
}

export interface FoodStockChangePayload {
  expected_row_version: number;
  quantity: number;
  unit?: string | null;
  expiry_date?: string | null;
  purchase_source?: string | null;
  storage_location?: string | null;
  note?: string;
  reason?: string;
}

export interface ShoppingListItem {
  id: string;
  family_id: string;
  ingredient_id?: string | null;
  food_id?: string | null;
  target_type?: 'ingredient' | 'food' | 'free_text';
  title: string;
  quantity: number;
  unit: string;
  quantity_mode?: IngredientQuantityTrackingMode;
  display_label?: string | null;
  reason: string;
  done: boolean;
  created_at: string;
  updated_at: string;
  created_by?: string | null;
  updated_by?: string | null;
  row_version: number;
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

export type SearchEntityType = 'ingredient' | 'food' | 'recipe' | 'meal_plan';
export type SearchMode = 'keyword' | 'semantic' | 'hybrid' | string;
export type SearchIndexJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'budget_blocked';
export type SearchIndexVectorStatus = 'pending' | 'indexed' | 'skipped' | 'failed';
export type SearchResultEntity = Ingredient | Food | Recipe | FoodPlanItem;

export interface SearchResultItem {
  entity_type: SearchEntityType;
  entity_id: string;
  score: number;
  keyword_score: number;
  semantic_score: number;
  business_score: number;
  match_reason: string[];
  entity: SearchResultEntity;
}

export interface SearchResponse {
  items: SearchResultItem[];
  total: number;
  query: string;
  search_mode: SearchMode;
  degraded: boolean;
  degradation_code?: string | null;
}

export interface SearchIndexJobResponse {
  job_id: string;
  status: SearchIndexJobStatus;
  error?: string | null;
  error_code?: ModelUsageErrorCode | SearchIndexJobErrorCode | null;
  entity_type: SearchEntityType;
  entity_id: string;
  target_name: string;
  vector_status: SearchIndexVectorStatus;
  created_at: string;
  completed_at?: string | null;
}

export type SearchIndexJobErrorCode =
  | 'embedding_output_unavailable_after_provider_success'
  | 'search_embedding_response_invalid'
  | 'search_embedding_superseded_before_dispatch'
  | 'search_embedding_unavailable'
  | 'search_index_failed'
  | 'search_index_target_missing'
  | 'search_vector_unavailable';

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
  row_version: number;
  created_at: string;
  updated_at: string;
  created_by?: string | null;
  updated_by?: string | null;
}

export interface UpdateMealLogPayload {
  expected_row_version: number;
  participant_user_ids?: string[];
  notes?: string;
  mood?: string;
  media_ids?: string[];
  pending_image_job_id?: string | null;
  food_entry_ratings?: Array<{ id: string; rating: number | null }>;
}

export type RecordMealTarget =
  | { kind: 'new' }
  | { kind: 'existing'; meal_log_id: string; expected_row_version: number };

export type RecordMealEntryPayload =
  | { food_id: string; servings: number }
  | { client_food_id: string; servings: number };

export type RecordMealNewFoodPayload = {
  client_food_id: string;
  name: string;
  type: FoodType;
};

export type RecordMealPlanCompletionPayload = {
  food_plan_item_id: string;
  food_plan_item_base_updated_at: string;
};

export type RecordMealPayload = {
  client_request_id: string;
  date: string;
  meal_type: MealType;
  target: RecordMealTarget;
  new_foods?: RecordMealNewFoodPayload[];
  entries: RecordMealEntryPayload[];
  plan_item_completions?: RecordMealPlanCompletionPayload[];
};

export type MealLogRecordStatus = 'applied' | 'reverted';

export type MealLogRecordOperation = {
  id: string;
  status: MealLogRecordStatus;
  revertible_until: string;
  can_revert: boolean;
  /** Entry ids created by this operation — rate / summarize these only. */
  created_entry_ids?: string[];
};

export type RecordMealResponse = {
  meal_log: MealLog;
  created_foods: Food[];
  outcome: 'created' | 'appended' | 'replayed';
  operation: MealLogRecordOperation;
  completed_plan_item_ids?: string[];
};

export type MealLogCandidateFood = {
  food_id: string;
  name: string;
  food_type: string;
  cover?: MediaAsset | null;
};

export type MealLogCandidate = {
  meal_log_id: string;
  row_version: number;
  date: string;
  meal_type: MealType;
  created_at: string;
  foods: MealLogCandidateFood[];
  preview_media?: MediaAsset | null;
  photo_count: number;
};

export type MealLogRecordOperationFoodSummary = {
  food_id: string;
  name: string;
  food_type: string;
  cover?: MediaAsset | null;
};

export type MealLogRecordOperationSummary = {
  id: string;
  meal_log_id: string;
  foods: MealLogRecordOperationFoodSummary[];
  preview_media?: MediaAsset | null;
  revertible_until: string;
  can_revert: boolean;
};

export type RevertMealRecordResponse = {
  status: 'reverted';
  meal_log: MealLog | null;
  removed_food_ids: string[];
  replayed: boolean;
};

export type MealCompositionEntryPayload = {
  id?: string | null;
  food_id: string;
  servings: number;
  note?: string;
};

export type UpdateMealCompositionPayload = {
  expected_row_version: number;
  food_entries: MealCompositionEntryPayload[];
};

export type CompleteFoodPlanItemPayload = {
  food_plan_item_base_updated_at: string;
  target_meal_log_id?: string | null;
  expected_meal_log_row_version?: number | null;
};

export type MealInsightKind =
  | 'frequent_recent'
  | 'missed'
  | 'repurchase'
  | 'repeated_choice';

export type MealInsightFood = {
  id: string;
  name: string;
  food_type: string;
  cover?: MediaAsset | null;
};

export type MealInsightEvidence = {
  meal_count: number;
  last_eaten_on: string;
  rating_count: number;
  average_rating: number | null;
  window_days: number;
};

export type MealInsight = {
  kind: MealInsightKind;
  food: MealInsightFood;
  evidence: MealInsightEvidence;
};

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

export interface ActivityLogQuery {
  start_date?: string;
  end_date?: string;
  actor_id?: string;
  action?: string;
  entity_type?: string;
  limit?: number;
  offset?: number;
}

export type ActivityHighlightKind =
  | 'shopping'
  | 'inventory'
  | 'meal_plan'
  | 'meal'
  | 'family';

export type ActivityHighlight = {
  id: string;
  kind: ActivityHighlightKind;
  summary: string;
  actor_id: string;
  actor_name: string;
  created_at: string;
};

export type ActivityHighlightsResponse = {
  items: ActivityHighlight[];
  week_highlight_count: number;
};

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
  operation?: string | null;
  operationLabel?: string | null;
  updatedAt?: string | null;
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

export type VersionedInventoryItemRef = {
  inventory_item_id: string;
  expected_row_version: number;
};

export type PresenceTransitionResolution = {
  availability_level: InventoryAvailabilityLevel;
  inventory_status: InventoryStatus;
  purchase_date?: string | null;
  expiry_date?: string | null;
  storage_location?: string | null;
  notes?: string;
  mark_inventory_confirmed?: boolean;
};

export type ExactTransitionResolution = {
  confirm_absent: boolean;
  quantity?: number | null;
  unit?: string | null;
  inventory_status?: InventoryStatus | null;
  purchase_date?: string | null;
  expiry_date?: string | null;
  storage_location?: string | null;
  notes?: string;
};

export type IngredientTrackingModeTransitionRequest = {
  expected_ingredient_row_version: number;
  target_mode: IngredientQuantityTrackingMode;
  expected_state_row_version?: number | null;
  observed_batches?: VersionedInventoryItemRef[];
  presence_resolution?: PresenceTransitionResolution | null;
  exact_resolution?: ExactTransitionResolution | null;
};

export type DisposeExpiredInventoryRequest = {
  ingredient_id: string;
  items: VersionedInventoryItemRef[];
};

export type SnoozeExpiryAlertsAction = 'retain_expired' | 'snooze_upcoming';

export type SnoozeExpiryAlertsRequest = {
  action: SnoozeExpiryAlertsAction;
  ingredient_id: string;
  items: VersionedInventoryItemRef[];
  snoozed_until: string;
};

export type SnoozeExpiryAlertsResponse = {
  ingredient_id: string;
  snoozed_item_ids: string[];
  snoozed_count: number;
  reviewed_expired_count: number;
  snoozed_until: string;
};

export type CorrectInventoryExpiryDateRequest = {
  expiry_date: string;
  expected_row_version: number;
};

export interface DisposeExpiredInventoryResponse {
  ingredient_id: string;
  disposed_item_ids: string[];
  disposed_count: number;
}
