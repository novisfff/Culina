import { useRef, useEffect, type FormEventHandler } from 'react';
import type {
  AiConversation,
  AiInventoryOperationAction,
  AiInventoryResultItem,
  AiMessage,
  AiResultCard,
  AiRunEvent,
  AiTodayRecommendationItem,
  UserSummary,
} from '../../api/types';
import { MessageBubble, type AiApprovalDecisionSubmit, type AiResourceOptionLoader } from './AiConversationThread';
import { AiMobileChrome } from './AiMobileChrome';
import { AI_WELCOME_SUGGESTIONS } from './AiWorkspaceOptions';

type Props = {
  conversations: AiConversation[];
  isLoading: boolean;
  activeConversationId: string | null;
  isMobileHistoryOpen: boolean;
  currentUser: UserSummary | null;
  resourceOptionLoader: AiResourceOptionLoader;
  messages: AiMessage[];
  runEventsById: Record<string, AiRunEvent[]>;
  streamProgress: AiRunEvent[];
  activeStreamRunId: string | null;
  draft: string;
  isSending: boolean;
  isComposerPaused: boolean;
  composerPauseMessage?: string;
  sendError?: string;
  messagesLoading: boolean;
  messagesError?: string;
  onRetryMessages: () => void;
  onBackHome?: () => void;
  onOpenMobileHistory: () => void;
  onCloseMobileHistory: () => void;
  onStartNewConversation: () => void;
  onSelectConversation: (conversationId: string) => void;
  onDraftChange: (value: string) => void;
  onPickSuggestion: (value: string) => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
  onApprovalDecision: AiApprovalDecisionSubmit;
  onAddRecommendationToPlan: (item: AiTodayRecommendationItem, card: AiResultCard, messageId: string, partId: string) => void;
  onInventoryAction: (
    item: AiInventoryResultItem,
    action: AiInventoryOperationAction,
    card: AiResultCard,
    messageId: string,
    partId: string,
  ) => void;
  isInventoryActionPending: boolean;
  onCancelSending: () => void;
};

export function AiMobilePage(props: Props) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`;
    }
  }, [props.draft]);

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
        {props.messagesLoading ? (
          <p className="subtle">正在加载消息...</p>
        ) : props.messagesError ? (
          <div className="ai-query-empty ai-message-load-error">
            <strong>历史消息加载失败</strong>
            <span>{props.messagesError}</span>
            <button className="ghost-button" type="button" onClick={props.onRetryMessages}>重新加载</button>
          </div>
        ) : props.messages.length > 0 ? (
          <>
            {props.messages.map((message, index) => (
              <MessageBubble
                key={message.id}
                message={message}
                user={props.currentUser}
                resourceOptionLoader={props.resourceOptionLoader}
                runEvents={
                  message.run_id && message.run_id === props.activeStreamRunId
                    ? props.streamProgress
                    : message.run_id
                      ? props.runEventsById[message.run_id] ?? (message.id.startsWith('local-') ? props.streamProgress : [])
                      : message.id.startsWith('local-')
                        ? props.streamProgress
                        : []
                }
                isLatestAssistant={message.role === 'assistant' && index === props.messages.length - 1}
                onApprovalDecision={props.onApprovalDecision}
                onAddRecommendationToPlan={props.onAddRecommendationToPlan}
                onInventoryAction={props.onInventoryAction}
                isInventoryActionPending={props.isInventoryActionPending}
              />
            ))}
          </>
        ) : (
          <div className="ai-empty-prompt">
            <section className="ai-welcome-card">
              <div className="ai-welcome-visual" aria-hidden="true">
                <img src="/assets/bot_area.webp" alt="" className="ai-bot-visual-img" />
              </div>
              <div className="ai-welcome-copy">
                <strong>你好，我是你的 AI 厨房助手 👋</strong>
                <span>我可以帮你根据现有食材推荐菜谱、安排晚餐、分析临期食材、生成采购清单。</span>
              </div>
            </section>
            <div className="ai-welcome-grid" aria-label="快捷问题">
              {AI_WELCOME_SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion.title}
                  type="button"
                  className="ai-suggestion-grid-card"
                  onClick={() => props.onPickSuggestion(suggestion.prompt)}
                >
                  <strong>{suggestion.title}</strong>
                  <span>{suggestion.desc}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="ai-composer-dock">
        {props.sendError && <p className="form-error">{props.sendError}</p>}
        {props.isComposerPaused && <p className="ai-composer-pause-note">{props.composerPauseMessage ?? '请先确认上面的草稿，确认后可以继续对话。'}</p>}
        <form className="ai-composer" onSubmit={props.onSubmit}>
          <button
            type="button"
            className="ai-attachment-button"
            title="添加图片"
            aria-label="添加图片"
            onClick={() => alert('已接入媒体库，可以在下方对话中输入食材名称或生成请求。')}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
          </button>
          <textarea
            ref={textareaRef}
            className="text-input"
            rows={1}
            value={props.draft}
            placeholder={props.isComposerPaused ? props.composerPauseMessage ?? '等待你确认草稿...' : '输入你的问题，或让 AI 帮你安排一餐...'}
            disabled={props.isComposerPaused}
            onChange={(event) => props.onDraftChange(event.target.value)}
          />
          <div className="ai-composer-actions">
            <button
              className={`ai-send-button ${props.isSending ? 'is-sending' : ''}`}
              type={props.isSending ? 'button' : 'submit'}
              disabled={!props.isSending && (props.isComposerPaused || !props.draft.trim())}
              aria-label={props.isSending ? '中止生成' : '发送消息'}
              onClick={props.isSending ? props.onCancelSending : undefined}
            >
              {props.isSending ? (
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"></rect></svg>
              ) : (
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg>
              )}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
