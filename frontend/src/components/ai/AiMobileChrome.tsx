import { useMemo } from 'react';
import type { AiConversation } from '../../api/types';
import { EmptyState } from '../ui-kit';

export function AiMobileChrome(props: {
  conversations: AiConversation[];
  isLoading: boolean;
  activeConversationId: string | null;
  isMobileHistoryOpen: boolean;
  onBackHome?: () => void;
  onOpenMobileHistory: () => void;
  onCloseMobileHistory: () => void;
  onStartNewConversation: () => void;
  onSelectConversation: (conversationId: string) => void;
}) {
  const groupedConversations = useMemo(() => {
    const today: AiConversation[] = [];
    const yesterday: AiConversation[] = [];
    const previous7Days: AiConversation[] = [];
    const older: AiConversation[] = [];

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
    const startOf7DaysAgo = startOfToday - 7 * 24 * 60 * 60 * 1000;

    for (const c of props.conversations) {
      const dateStr = c.last_message_at || c.created_at;
      const time = new Date(dateStr).getTime();
      if (Number.isNaN(time)) {
        older.push(c);
        continue;
      }

      if (time >= startOfToday) {
        today.push(c);
      } else if (time >= startOfYesterday) {
        yesterday.push(c);
      } else if (time >= startOf7DaysAgo) {
        previous7Days.push(c);
      } else {
        older.push(c);
      }
    }

    return [
      { title: '今天', items: today },
      { title: '昨天', items: yesterday },
      { title: '前 7 天', items: previous7Days },
      { title: '更早', items: older },
    ].filter(group => group.items.length > 0);
  }, [props.conversations]);

  return (
    <>
      {props.isMobileHistoryOpen && (
        <div className="ai-mobile-history-root">
          <button
            className="ai-mobile-history-backdrop"
            type="button"
            aria-label="关闭历史记录"
            onClick={props.onCloseMobileHistory}
          />
          <aside className="ai-mobile-history-panel" aria-label="AI 历史记录">
            <div className="ai-mobile-history-head">
              <div>
                <span>历史记录</span>
                <strong>AI 厨房助手</strong>
              </div>
              <button className="ai-mobile-icon-button" type="button" aria-label="关闭" onClick={props.onCloseMobileHistory}>
                ×
              </button>
            </div>
            <button className="ai-mobile-new-chat" type="button" onClick={props.onStartNewConversation}>
              新会话
            </button>
            <div className="ai-mobile-conversation-list">
              {props.isLoading ? (
                <p className="subtle">正在加载会话...</p>
              ) : props.conversations.length > 0 ? (
                groupedConversations.map((group) => (
                  <div key={group.title} className="ai-mobile-history-group">
                    <h3 className="ai-mobile-history-group-title">{group.title}</h3>
                    <div className="ai-mobile-history-group-items">
                      {group.items.map((conversation) => (
                        <button
                          key={conversation.id}
                          className={conversation.id === props.activeConversationId ? 'ai-mobile-conversation active' : 'ai-mobile-conversation'}
                          type="button"
                          onClick={() => props.onSelectConversation(conversation.id)}
                        >
                          <strong>{conversation.title || conversation.prompt || 'AI 会话'}</strong>
                          <span>{conversation.summary || conversation.response || '等待继续对话'}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ))
              ) : (
                <EmptyState title="还没有会话" description="先发起一个问题。" />
              )}
            </div>

          </aside>
        </div>
      )}

      <div className="ai-mobile-topbar">
        <button className="ai-mobile-icon-button" type="button" aria-label="返回首页" onClick={props.onBackHome}>
          ‹
        </button>
        <div className="ai-mobile-title">
          <strong>AI 厨房助手</strong>
          <span><i aria-hidden="true" />在线 · 可随时帮你安排做饭</span>
        </div>
        <div className="ai-mobile-actions">
          <button className="ai-mobile-history-trigger" type="button" aria-label="打开历史记录" onClick={props.onOpenMobileHistory}>
            <span className="ai-mobile-menu-mark" aria-hidden="true" />
          </button>
          <button className="ai-mobile-new-session" type="button" aria-label="新会话" onClick={props.onStartNewConversation}>
            <span aria-hidden="true">⊕</span>
            新会话
          </button>
        </div>
      </div>
    </>
  );
}
