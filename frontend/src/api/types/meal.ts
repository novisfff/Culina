/** Meal logging and insight contracts. */
import type { Food, FoodPlanItem } from './food';
import type { MediaAsset } from './media';
import type { FoodType, MealType } from './primitives';

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


export type { Food, FoodPlanItem } from './food';
export type { MediaAsset } from './media';
export type { FoodType, MealType } from './primitives';
export type { Member } from './shell';
