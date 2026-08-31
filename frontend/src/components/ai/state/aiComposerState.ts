export type AiComposerDisabledReason = 'empty' | 'busy' | 'unavailable' | null;

export type AiComposerState = {
  text: string;
  attachments: string[];
  busy: boolean;
  available: boolean;
  canSubmit: boolean;
  disabledReason: AiComposerDisabledReason;
};

export type AiComposerAction =
  | { type: 'text-changed'; text: string }
  | { type: 'attachments-changed'; attachments: readonly string[] }
  | { type: 'busy-changed'; busy: boolean }
  | { type: 'availability-changed'; available: boolean };

function derive(state: Omit<AiComposerState, 'canSubmit' | 'disabledReason'>): AiComposerState {
  const hasContent = state.text.trim().length > 0 || state.attachments.length > 0;
  const disabledReason: AiComposerDisabledReason = state.busy ? 'busy' : !state.available ? 'unavailable' : !hasContent ? 'empty' : null;
  return { ...state, canSubmit: disabledReason === null, disabledReason };
}

export const initialAiComposerState = derive({ text: '', attachments: [], busy: false, available: true });

export function aiComposerReducer(state: AiComposerState, action: AiComposerAction): AiComposerState {
  if (action.type === 'text-changed') return derive({ ...state, text: action.text });
  if (action.type === 'attachments-changed') return derive({ ...state, attachments: [...action.attachments] });
  if (action.type === 'busy-changed') return derive({ ...state, busy: action.busy });
  return derive({ ...state, available: action.available });
}
