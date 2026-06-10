import type { FormEventHandler } from 'react';
import type { AiConversation, AiMessage, AiRunEvent, UserSummary } from '../../api/types';
import { MessageBubble, type AiApprovalDecisionSubmit, type AiResourceOptionLoader } from './AiConversationThread';
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
  onBackHome?: () => void;
  onOpenMobileHistory: () => void;
  onCloseMobileHistory: () => void;
  onStartNewConversation: () => void;
  onSelectConversation: (conversationId: string) => void;
  onDraftChange: (value: string) => void;
  onPickSuggestion: (value: string) => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
  onApprovalDecision: AiApprovalDecisionSubmit;
  onRetryRun: (runId: string) => void;
  onRegeneratePart: (messageId: string, partId: string) => void;
  onCancelSending: () => void;
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
            {props.messages.map((message, index) => (
              <MessageBubble
                key={message.id}
                message={message}
                user={props.currentUser}
                resourceOptionLoader={props.resourceOptionLoader}
                runEvents={message.run_id && message.run_id === props.activeStreamRunId ? props.streamProgress : message.run_id ? props.runEventsById[message.run_id] ?? [] : []}
                isLatestAssistant={message.role === 'assistant' && index === props.messages.length - 1}
                onApprovalDecision={props.onApprovalDecision}
                onRetryRun={props.onRetryRun}
                onRegeneratePart={props.onRegeneratePart}
              />
            ))}
          </>
        ) : (
          <div className="ai-empty-prompt">
            <section className="ai-welcome-card">
              <div className="ai-welcome-visual" aria-hidden="true">
                <img src="/assets/bot_area.webp" alt="" />
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
      </div>

      <div className="ai-composer-dock">
        {props.sendError && <p className="form-error">{props.sendError}</p>}
        {props.isComposerPaused && <p className="ai-composer-pause-note">{props.composerPauseMessage ?? '请先确认上面的草稿，确认后可以继续对话。'}</p>}
        <form className="ai-composer" onSubmit={props.onSubmit}>
          <textarea
            className="text-input"
            rows={2}
            value={props.draft}
            placeholder={props.isComposerPaused ? props.composerPauseMessage ?? '等待你确认草稿...' : '输入你的问题，或让 AI 帮你安排一餐...'}
            disabled={props.isComposerPaused}
            onChange={(event) => props.onDraftChange(event.target.value)}
          />
          <div className="ai-composer-meta">
            <span>{props.draft.length}/2000</span>
            <button
              className={`ai-send-button ${props.isSending ? 'is-sending' : ''}`}
              type={props.isSending ? 'button' : 'submit'}
              disabled={props.isComposerPaused && !props.isSending}
              aria-label={props.isSending ? '中止生成' : '发送消息'}
              onClick={props.isSending ? props.onCancelSending : undefined}
            >
              {props.isSending ? <span className="ai-stop-icon" aria-hidden="true" /> : '↗'}
            </button>
          </div>
        </form>
        <p className="ai-disclaimer">AI 可能会出错，请核对重要信息</p>
      </div>
    </section>
  );
}
