import type { AiConversation } from '../../api/types';
import { ConfirmDialog } from '../ui-kit';

export function AiDeleteConversationDialog(props: {
  conversation: AiConversation;
  isDeleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <ConfirmDialog
      open
      title="永久删除这条会话？"
      description={`将永久删除「${props.conversation.title || props.conversation.prompt || 'AI 会话'}」及其中的消息，删除后无法恢复。`}
      confirmLabel="永久删除"
      cancelLabel="取消"
      tone="danger"
      isSubmitting={props.isDeleting}
      rootClassName="ai-delete-confirm-root"
      modalClassName="ai-delete-confirm-modal"
      actionsClassName="ai-delete-confirm-actions"
      onCancel={props.onCancel}
      onConfirm={props.onConfirm}
    />
  );
}
