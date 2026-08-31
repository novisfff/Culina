/**
 * Runtime AI conversation mutations currently remain in AiWorkspace to keep
 * the lazy entry within the B0 bundle ratchet. This type boundary documents
 * the eventual owner without adding a second runtime mutation registry.
 */
export type AiConversationMutationOwner = 'ai-conversation';
