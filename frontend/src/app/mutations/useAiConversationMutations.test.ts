import { describe, expect, it } from 'vitest';
import { mutationOwnership } from '../appMutationOwnership';
describe('AI conversation mutation owner', () => {
  it('assigns visibility and delete to the AI conversation domain', () => {
    expect(mutationOwnership.updateConversationVisibility).toBe('ai-conversation');
    expect(mutationOwnership.deleteConversation).toBe('ai-conversation');
  });
});
