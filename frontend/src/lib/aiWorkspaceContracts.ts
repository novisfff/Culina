import type { AiMessagePartType, AiResultCardType } from '../api/types';

export const AI_MESSAGE_PART_TYPES = ['text', 'result_card', 'draft', 'approval_request', 'error_recovery'] as const satisfies readonly AiMessagePartType[];
export const AI_RESULT_CARD_TYPES = ['today_recommendation', 'recipe_draft', 'approval_request', 'error_recovery'] as const satisfies readonly AiResultCardType[];

export const AI_MESSAGE_PART_RENDERERS = {
  text: true,
  result_card: true,
  draft: true,
  approval_request: true,
  error_recovery: true,
} as const satisfies Record<AiMessagePartType, true>;

export const AI_RESULT_CARD_RENDERERS = {
  today_recommendation: true,
  recipe_draft: true,
  approval_request: true,
  error_recovery: true,
} as const satisfies Record<AiResultCardType, true>;
