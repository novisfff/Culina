import { useMemo } from 'react';
import type { AiConversation, AiMessage } from '../../api/types';
import { EmptyState } from '../ui-kit';
import { TrashIcon } from './aiWorkspaceHelpers';

export function createPendingConversationKey(runId: string) {
  return `pending-conversation-${runId}`;
}

export function isPendingConversationKey(conversationKey: string | null | undefined) {
  return Boolean(conversationKey?.startsWith('pending-conversation-'));
}

export function getConversationTitleFromMessages(messages: AiMessage[]) {
  const userMessage = messages.find((message) => message.role === 'user');
  return userMessage?.content?.trim() || userMessage?.parts.find((part) => part.type === 'text')?.text?.trim() || '新会话生成中';
}

function groupConversationsByDate(conversations: AiConversation[]) {
  const today: AiConversation[] = [];
  const yesterday: AiConversation[] = [];
  const previous7Days: AiConversation[] = [];
  const older: AiConversation[] = [];

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  const startOf7DaysAgo = startOfToday - 7 * 24 * 60 * 60 * 1000;

  for (const conversation of conversations) {
    const dateStr = conversation.last_message_at || conversation.created_at;
    const time = new Date(dateStr).getTime();
    if (Number.isNaN(time)) {
      older.push(conversation);
    } else if (time >= startOfToday) {
      today.push(conversation);
    } else if (time >= startOfYesterday) {
      yesterday.push(conversation);
    } else if (time >= startOf7DaysAgo) {
      previous7Days.push(conversation);
    } else {
      older.push(conversation);
    }
  }

  return [
    { title: '今天', items: today },
    { title: '昨天', items: yesterday },
    { title: '前 7 天', items: previous7Days },
    { title: '更早', items: older },
  ].filter((group) => group.items.length > 0);
}

export function AiDesktopConversationHistory(props: {
  conversations: AiConversation[];
  isLoading: boolean;
  activeConversationKey: string | null;
  runningConversationKeys: Set<string>;
  deletingConversationId: string | null;
  onToggleSidebar: (collapsed: boolean) => void;
  onStartNewConversation: () => void;
  onSelectConversation: (conversationKey: string) => void;
  onDeleteConversation: (conversation: AiConversation) => void;
}) {
  const groupedConversations = useMemo(() => groupConversationsByDate(props.conversations), [props.conversations]);

  return (
    <aside className="ai-side-panel">
      <div className="ai-side-head">
        <div>
          <span>AI Workspace</span>
          <h2>历史记录</h2>
        </div>
        <button
          className="ai-sidebar-toggle-btn"
          type="button"
          title="收起侧边栏"
          onClick={() => props.onToggleSidebar(true)}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="9" y1="3" x2="9" y2="21"></line></svg>
        </button>
      </div>
      <button className="ai-new-chat" type="button" onClick={props.onStartNewConversation}>
        + 新会话
      </button>
      <div className="ai-conversation-list">
        {props.isLoading ? (
          <p className="subtle">正在加载会话...</p>
        ) : props.conversations.length > 0 ? (
          groupedConversations.map((group) => (
            <div key={group.title} className="ai-history-group">
              <h3 className="ai-history-group-title">{group.title}</h3>
              <div className="ai-history-group-items">
                {group.items.map((conversation) => (
                  <div
                    key={conversation.id}
                    className={[
                      'ai-conversation-item',
                      conversation.id === props.activeConversationKey ? 'active' : '',
                      props.runningConversationKeys.has(conversation.id) ? 'is-running' : '',
                    ].filter(Boolean).join(' ')}
                  >
                    <button className="ai-conversation-main" type="button" onClick={() => props.onSelectConversation(conversation.id)}>
                      <strong>
                        {props.runningConversationKeys.has(conversation.id) && <i className="ai-history-spinner" aria-hidden="true" />}
                        <span className="ai-history-title-text">{conversation.title || conversation.prompt || 'AI 会话'}</span>
                      </strong>
                    </button>
                    <button
                      className="ai-conversation-delete"
                      type="button"
                      aria-label={`删除会话：${conversation.title || conversation.prompt || 'AI 会话'}`}
                      title="删除"
                      disabled={props.deletingConversationId === conversation.id}
                      onClick={() => props.onDeleteConversation(conversation)}
                    >
                      <TrashIcon />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))
        ) : (
          <EmptyState title="还没有会话" description="先发起一个问题。" />
        )}
      </div>
    </aside>
  );
}
