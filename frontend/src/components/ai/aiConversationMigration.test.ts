import { describe, expect, it } from 'vitest';
import { migratePendingConversation } from './state/aiConversationLocalStore';

describe('AI pending conversation migration', () => {
  it('moves local scopes atomically and deduplicates server messages', () => {
    const result = migratePendingConversation({
      localKey: 'pending-conversation-run-1',
      serverKey: 'conversation-1',
      localMessages: [{ id: 'm-1' }, { id: 'm-2' }],
      serverMessages: [{ id: 'm-2' }, { id: 'm-3' }],
      composer: { text: '继续', attachments: ['a-1'] },
    });
    expect(result.messages).toEqual([{ id: 'm-2' }, { id: 'm-3' }, { id: 'm-1' }]);
    expect(result.composer).toEqual({ text: '继续', attachments: ['a-1'] });
    expect(result.removedKey).toBe('pending-conversation-run-1');
  });
});
