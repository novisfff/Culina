import { describe, expect, it } from 'vitest';
import type { AiMessage, AiMessagePart } from '../../api/types/ai';
import {
  collectSettledApprovalIds,
  getLocalPendingRunId,
  isApprovalDecisionSettledPart,
  isUnfinishedConversationStatus,
} from './state/aiStreamProjection';

describe('AI stream projection', () => {
  it('keeps pending runs scoped to their local conversation', () => {
    expect(getLocalPendingRunId('pending-conversation-run-2', [])).toBe('run-2');
    expect(isUnfinishedConversationStatus('waiting_input')).toBe(true);
    expect(isUnfinishedConversationStatus('completed')).toBe(false);
  });

  it('recognizes approval settlement from approval and operation result parts', () => {
    const approval = { type: 'approval_request', approval: { id: 'approval-1', status: 'approved' } } as AiMessagePart;
    const result = { type: 'result_card', card: { type: 'operation_result', data: { approvalId: 'approval-2' } } } as AiMessagePart;
    expect(isApprovalDecisionSettledPart(approval, 'approval-1')).toBe(true);
    expect(isApprovalDecisionSettledPart(result, 'approval-2')).toBe(true);
    expect(collectSettledApprovalIds([{ id: 'message-1', role: 'assistant', content: '', parts: [approval, result] } as AiMessage]))
      .toEqual(new Set(['approval-1', 'approval-2']));
  });
});
