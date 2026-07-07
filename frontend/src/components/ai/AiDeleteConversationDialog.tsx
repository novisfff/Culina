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
      title="删除这条历史？"
      description={`将删除「${props.conversation.title || props.conversation.prompt || 'AI 会话'}」，相关消息不会再显示。`}
      confirmLabel="确认删除"
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
