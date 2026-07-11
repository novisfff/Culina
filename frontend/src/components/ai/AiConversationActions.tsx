import { useEffect, useRef, useState } from 'react';
import type { AiConversation, AiConversationVisibility } from '../../api/types';

function ActionMenuIcon(props: { name: 'share' | 'private' | 'delete' }) {
  if (props.name === 'share') {
    return (
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="5" cy="7" r="2.2" />
        <circle cx="11" cy="4.5" r="2.2" />
        <circle cx="11" cy="11.5" r="2.2" />
        <path d="M6.8 6.1 9.2 5" />
        <path d="M6.8 7.9 9.2 10.5" />
      </svg>
    );
  }
  if (props.name === 'private') {
    return (
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
        <path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.5 4.5h9" />
      <path d="M6 4.5V3.5h4v1" />
      <path d="M5 4.5l.5 8h5l.5-8" />
      <path d="M7 7v3.5M9 7v3.5" />
    </svg>
  );
}

export function AiConversationActions(props: {
  conversation: AiConversation;
  isUpdating: boolean;
  activeConversationKey: string | null;
  onChangeVisibility: (conversation: AiConversation, visibility: AiConversationVisibility) => void;
  onDelete: (conversation: AiConversation) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setOpen(false);
  }, [props.activeConversationKey]);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  if (!props.conversation.is_owner) return null;
  const nextVisibility = props.conversation.visibility === 'family' ? 'private' : 'family';
  return (
    <div className="ai-conversation-actions" ref={rootRef}>
      <button
        type="button"
        className="ai-conversation-manage"
        aria-label={`管理会话：${props.conversation.title || props.conversation.prompt || 'AI 会话'}`}
        aria-expanded={open}
        disabled={props.isUpdating}
        onClick={() => setOpen((value) => !value)}
      >
        <svg className="ai-conversation-manage-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <circle cx="3.5" cy="8" r="1.35" />
          <circle cx="8" cy="8" r="1.35" />
          <circle cx="12.5" cy="8" r="1.35" />
        </svg>
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
            <ActionMenuIcon name={nextVisibility === 'family' ? 'share' : 'private'} />
            <span>{nextVisibility === 'family' ? '公开给家庭' : '取消公开'}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              props.onDelete(props.conversation);
              setOpen(false);
            }}
          >
            <ActionMenuIcon name="delete" />
            <span>删除</span>
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
