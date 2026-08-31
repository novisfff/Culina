import { describe, expect, it } from 'vitest';
import { clearInaccessibleConversation, selectConversation } from './state/aiConversationSelection';

describe('AI conversation selection', () => {
  it('returns a stable key/id pair without mutating selection state', () => {
    const previous = { key: 'conversation-1', id: 'conversation-1' };
    expect(selectConversation(previous, { key: 'conversation-2', id: 'conversation-2' })).toEqual({ key: 'conversation-2', id: 'conversation-2' });
    expect(previous).toEqual({ key: 'conversation-1', id: 'conversation-1' });
  });

  it('clears only the inaccessible conversation scope', () => {
    expect(clearInaccessibleConversation({ key: 'conversation-1', messageKeys: ['conversation-1', 'conversation-2'], approvalIds: ['a-1', 'a-2'] })).toEqual({
      activeKey: null,
      messageKeys: ['conversation-2'],
      approvalIds: ['a-2'],
    });
  });
});
