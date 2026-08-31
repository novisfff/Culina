export type AiApprovalState = {
  pending: string[];
  settled: Set<string>;
  busy: boolean;
  error: string | null;
};

export type AiApprovalAction =
  | { type: 'pending-loaded'; approvalIds: readonly string[] }
  | { type: 'submit-started'; approvalId: string }
  | { type: 'settled'; approvalId: string }
  | { type: 'failed'; message: string };

export const initialAiApprovalState: AiApprovalState = {
  pending: [],
  settled: new Set(),
  busy: false,
  error: null,
};

export function aiApprovalReducer(state: AiApprovalState, action: AiApprovalAction): AiApprovalState {
  if (action.type === 'pending-loaded') {
    return {
      ...state,
      pending: [...new Set(action.approvalIds)].filter((id) => !state.settled.has(id)),
    };
  }
  if (action.type === 'submit-started') {
    if (state.busy) return state;
    return { ...state, busy: true, error: null };
  }
  if (action.type === 'settled') {
    const settled = new Set(state.settled);
    settled.add(action.approvalId);
    return { ...state, pending: state.pending.filter((id) => id !== action.approvalId), settled, busy: false, error: null };
  }
  return { ...state, busy: false, error: action.message };
}
