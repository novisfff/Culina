import type { AiConversation } from '../../api/types';
import { WorkspaceModal } from '../ui-kit';
import { TrashIcon } from './aiWorkspaceHelpers';

export function AiDeleteConversationDialog(props: {
  conversation: AiConversation;
  isDeleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="workspace-overlay-root ai-delete-confirm-root">
      <div className="workspace-overlay-backdrop" onClick={() => {
        if (!props.isDeleting) props.onCancel();
      }} />
      <WorkspaceModal
        title="删除这条历史？"
        eyebrow="确认操作"
        description="删除后，这条会话和相关消息将从历史记录中移除。"
        closeLabel="取消"
        closeAriaLabel="取消删除"
        className="ai-delete-confirm-modal"
        onClose={() => {
          if (!props.isDeleting) props.onCancel();
        }}
      >
        <div className="ai-delete-confirm-body">
          <div className="ai-delete-confirm-icon" aria-hidden="true">
            <TrashIcon />
          </div>
          <div>
            <span>将删除</span>
            <strong>{props.conversation.title || props.conversation.prompt || 'AI 会话'}</strong>
          </div>
        </div>
        <div className="ai-delete-confirm-actions">
          <button className="ghost-button" type="button" disabled={props.isDeleting} onClick={props.onCancel}>
            取消
          </button>
          <button className="solid-button danger" type="button" disabled={props.isDeleting} onClick={props.onConfirm}>
            {props.isDeleting ? '删除中...' : '确认删除'}
          </button>
        </div>
      </WorkspaceModal>
    </div>
  );
}
