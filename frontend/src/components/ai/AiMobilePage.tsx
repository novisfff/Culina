import type { FormEventHandler } from 'react';
import type { AiApprovalRequest, AiConversation, AiMessage, UserSummary } from '../../api/types';
import { ApprovalPanel, MessageBubble } from './AiConversationThread';
import { AiMobileChrome } from './AiMobileChrome';

export const AI_WELCOME_SUGGESTIONS = [
  '今晚用现有食材做什么？',
  '帮我安排三天晚餐',
  '快过期食材怎么处理？',
];

type Props = {
  conversations: AiConversation[];
  isLoading: boolean;
  activeConversationId: string | null;
  isMobileHistoryOpen: boolean;
  currentUser: UserSummary | null;
  messages: AiMessage[];
  restoredPendingApprovals: AiApprovalRequest[];
  draft: string;
  isSending: boolean;
  sendError?: string;
  onBackHome?: () => void;
  onOpenMobileHistory: () => void;
  onCloseMobileHistory: () => void;
  onStartNewConversation: () => void;
  onSelectConversation: (conversationId: string) => void;
  onDraftChange: (value: string) => void;
  onPickSuggestion: (value: string) => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
  onApprovalSettled: () => void;
};

export function AiMobilePage(props: Props) {
  return (
    <section className="ai-mobile-page">
      <AiMobileChrome
        conversations={props.conversations}
        isLoading={props.isLoading}
        activeConversationId={props.activeConversationId}
        isMobileHistoryOpen={props.isMobileHistoryOpen}
        onBackHome={props.onBackHome}
        onOpenMobileHistory={props.onOpenMobileHistory}
        onCloseMobileHistory={props.onCloseMobileHistory}
        onStartNewConversation={props.onStartNewConversation}
        onSelectConversation={props.onSelectConversation}
      />

      <div className="ai-thread-scroll">
        {props.messages.length > 0 ? (
          <>
            {props.messages.map((message) => (
              <MessageBubble key={message.id} message={message} user={props.currentUser} onApprovalSettled={props.onApprovalSettled} />
            ))}
          </>
        ) : props.restoredPendingApprovals.length > 0 ? (
          <section className="ai-pending-approval-restore">
            <strong>待处理确认</strong>
            {props.restoredPendingApprovals.map((approval) => (
              <ApprovalPanel key={approval.id} approval={approval} onSettled={props.onApprovalSettled} />
            ))}
          </section>
        ) : (
          <div className="ai-empty-prompt">
            <section className="ai-welcome-card">
              <div className="ai-welcome-visual" aria-hidden="true">
                <img src="/assets/bot_area.png" alt="" />
              </div>
              <div className="ai-welcome-copy">
                <strong>你好，我是你的 AI 厨房助手 👋</strong>
                <span>我可以帮你根据现有食材推荐菜谱、安排晚餐、分析临期食材、生成采购清单。</span>
              </div>
            </section>
            <div className="ai-welcome-suggestions" aria-label="快捷问题">
              {AI_WELCOME_SUGGESTIONS.map((suggestion) => (
                <button key={suggestion} type="button" onClick={() => props.onPickSuggestion(suggestion)}>
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}
        {props.messages.length > 0 && props.restoredPendingApprovals.length > 0 && (
          <section className="ai-pending-approval-restore">
            <strong>待处理确认</strong>
            {props.restoredPendingApprovals.map((approval) => (
              <ApprovalPanel key={approval.id} approval={approval} onSettled={props.onApprovalSettled} />
            ))}
          </section>
        )}
      </div>

      <div className="ai-composer-dock">
        {props.sendError && <p className="form-error">{props.sendError}</p>}
        <form className="ai-composer" onSubmit={props.onSubmit}>
          <textarea
            className="text-input"
            rows={2}
            value={props.draft}
            placeholder="输入你的问题，或让 AI 帮你安排一餐..."
            onChange={(event) => props.onDraftChange(event.target.value)}
          />
          <div className="ai-composer-meta">
            <span>{props.draft.length}/2000</span>
            <button className="ai-send-button" type="submit" disabled={props.isSending} aria-label="发送消息">
              {props.isSending ? '...' : '↗'}
            </button>
          </div>
        </form>
        <p className="ai-disclaimer">AI 可能会出错，请核对重要信息</p>
      </div>
    </section>
  );
}
