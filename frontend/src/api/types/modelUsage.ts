/** Model usage and family model settings contracts. */
export type { UserRole } from './primitives';
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
  | 'dashscope';

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
  api_base_url?: string;
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

export interface FamilyModelProviderProfileDeletePayload {
  base_profile_version_number: number;
  confirmation_name: string;
  idempotency_key: string;
}

export interface FamilyModelProviderProfileReference {
  type: string;
  name: string;
  description: string;
  resource_id: string;
  can_unbind: boolean;
}

export interface FamilyModelProviderProfileDeletionCheck {
  can_delete: boolean;
  blocking_references: FamilyModelProviderProfileReference[];
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
  /** Optional unsaved binding values used by the search replacement probe. */
  provider_profile_id?: string;
  requested_model?: string;
  dimensions?: number;
}

export interface FamilyModelCapabilityTestOverride {
  provider_profile_id?: string;
  requested_model?: string;
  dimensions?: number;
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

export interface FamilyModelSearchReplacementFailure {
  code: string;
  detail: string;
  provider_http_status: number | null;
  provider_error_code: string | null;
  provider_error_message: string | null;
  request_sent: boolean | null;
  execution_certainty: 'confirmed_executed' | 'confirmed_not_executed' | 'unknown' | null;
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
  failure?: FamilyModelSearchReplacementFailure | null;
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
