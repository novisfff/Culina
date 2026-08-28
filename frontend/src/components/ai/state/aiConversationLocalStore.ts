export type LocalConversationMessage = { id: string; [key: string]: unknown };

export type ConversationComposerScope = {
  text: string;
  attachments: readonly string[];
};

export type PendingConversationMigration = {
  localKey: string;
  serverKey: string;
  localMessages: readonly LocalConversationMessage[];
  serverMessages: readonly LocalConversationMessage[];
  composer: ConversationComposerScope;
};

export function migratePendingConversation(args: PendingConversationMigration) {
  const seen = new Set<string>();
  const messages = [...args.serverMessages, ...args.localMessages].filter((message) => {
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  });
  return {
    serverKey: args.serverKey,
    removedKey: args.localKey,
    messages,
    composer: { text: args.composer.text, attachments: [...args.composer.attachments] },
  };
}
