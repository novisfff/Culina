/** Search contracts. */
import type { Food, FoodPlanItem } from './food';
import type { Ingredient } from './inventory';
import type { Recipe } from './recipe';
import type { ModelUsageErrorCode } from './modelUsage';

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
  | 'search_embedding_provider_rejected'
  | 'search_embedding_transport_uncertain'
  | 'search_embedding_superseded_before_dispatch'
  | 'search_embedding_unavailable'
  | 'search_index_failed'
  | 'search_index_target_missing'
  | 'search_vector_unavailable';
