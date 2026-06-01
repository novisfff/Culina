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
                props.conversations.map((conversation) => (
                  <button
                    key={conversation.id}
                    className={conversation.id === props.activeConversationId ? 'ai-mobile-conversation active' : 'ai-mobile-conversation'}
                    type="button"
                    onClick={() => props.onSelectConversation(conversation.id)}
                  >
                    <strong>{conversation.title || conversation.prompt || 'AI 会话'}</strong>
                    <span>{conversation.summary || conversation.response || '等待继续对话'}</span>
                  </button>
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
