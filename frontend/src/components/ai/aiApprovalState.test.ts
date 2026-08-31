import { describe, expect, it } from 'vitest';
import { aiApprovalReducer, initialAiApprovalState } from './state/aiApprovalState';

describe('AI approval state', () => {
  it('deduplicates settled approvals and removes them from pending', () => {
    let state = aiApprovalReducer(initialAiApprovalState, { type: 'pending-loaded', approvalIds: ['a-1', 'a-2'] });
    state = aiApprovalReducer(state, { type: 'settled', approvalId: 'a-1' });
    state = aiApprovalReducer(state, { type: 'pending-loaded', approvalIds: ['a-1', 'a-2', 'a-3'] });
    expect(state.pending).toEqual(['a-2', 'a-3']);
    expect(state.settled).toEqual(new Set(['a-1']));
  });

  it('prevents duplicate submit while busy and clears busy on settle', () => {
    let state = aiApprovalReducer(initialAiApprovalState, { type: 'submit-started', approvalId: 'a-1' });
    expect(aiApprovalReducer(state, { type: 'submit-started', approvalId: 'a-1' })).toEqual(state);
    state = aiApprovalReducer(state, { type: 'settled', approvalId: 'a-1' });
    expect(state.busy).toBe(false);
    expect(state.pending).toEqual([]);
  });
});
