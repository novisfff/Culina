import type { AiMessagePartType, AiResultCardType } from '../api/types';

export const AI_MESSAGE_PART_TYPES = ['text', 'image', 'run_activity', 'result_card', 'draft', 'approval_request', 'human_input_request', 'error_recovery'] as const satisfies readonly AiMessagePartType[];
export const AI_RESULT_CARD_TYPES = [
  'today_recommendation',
  'recipe_draft',
  'approval_request',
  'error_recovery',
  'inventory_summary',
  'operation_result',
  'meal_plan_draft',
  'shopping_list_draft',
  'meal_log_draft',
  'food_profile_draft',
  'ui_actions',
  'recipe_shortage',
  'inventory_intake_candidates',
  'meal_idea_proposal',
] as const satisfies readonly AiResultCardType[];

export const AI_MESSAGE_PART_RENDERERS = {
  text: true,
  image: true,
  run_activity: true,
  result_card: true,
  draft: true,
  approval_request: true,
  human_input_request: true,
  error_recovery: true,
} as const satisfies Record<AiMessagePartType, true>;

export const AI_RESULT_CARD_RENDERERS = {
  today_recommendation: true,
  recipe_draft: true,
  approval_request: true,
  error_recovery: true,
  inventory_summary: true,
  operation_result: true,
  meal_plan_draft: true,
  shopping_list_draft: true,
  meal_log_draft: true,
  food_profile_draft: true,
  ui_actions: true,
  recipe_shortage: true,
  inventory_intake_candidates: true,
  meal_idea_proposal: true,
} as const satisfies Record<AiResultCardType, true>;
