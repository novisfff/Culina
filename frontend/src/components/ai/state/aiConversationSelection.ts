export type AiConversationSelection = { key: string | null; id: string | null };

export function selectConversation(
  _previous: AiConversationSelection,
  next: AiConversationSelection,
): AiConversationSelection {
  return { key: next.key, id: next.id };
}

export function clearInaccessibleConversation(args: {
  key: string;
  messageKeys: readonly string[];
  approvalIds: readonly string[];
}) {
  return {
    activeKey: null,
    messageKeys: args.messageKeys.filter((key) => key !== args.key),
    approvalIds: args.approvalIds.filter((id) => id !== args.key.replace(/^conversation-/, 'a-')),
  };
}
