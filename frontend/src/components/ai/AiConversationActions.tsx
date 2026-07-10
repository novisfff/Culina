import { useState } from 'react';
import type { AiConversation, AiConversationVisibility } from '../../api/types';

export function AiConversationActions(props: {
  conversation: AiConversation;
  isUpdating: boolean;
  onChangeVisibility: (conversation: AiConversation, visibility: AiConversationVisibility) => void;
  onDelete: (conversation: AiConversation) => void;
}) {
  const [open, setOpen] = useState(false);
  if (!props.conversation.is_owner) return null;
  const nextVisibility = props.conversation.visibility === 'family' ? 'private' : 'family';
  return (
    <div className="ai-conversation-actions">
      <button
        type="button"
        className="ai-conversation-manage"
        aria-label={`管理会话：${props.conversation.title || props.conversation.prompt || 'AI 会话'}`}
        aria-expanded={open}
        disabled={props.isUpdating}
        onClick={() => setOpen((value) => !value)}
      >
        ···
      </button>
      {open && (
        <div className="ai-conversation-action-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              props.onChangeVisibility(props.conversation, nextVisibility);
              setOpen(false);
            }}
          >
            {nextVisibility === 'family' ? '公开给家庭' : '取消公开'}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              props.onDelete(props.conversation);
              setOpen(false);
            }}
          >
            删除
          </button>
        </div>
      )}
    </div>
  );
}

export function AiConversationSharingMeta(props: { conversation: AiConversation }) {
  if (props.conversation.visibility !== 'family') return null;
  return (
    <span className="ai-history-sharing-meta">
      <span className="ai-history-shared-badge">家庭公开</span>
      <span className="ai-history-owner-name">{props.conversation.owner_display_name}</span>
    </span>
  );
}
