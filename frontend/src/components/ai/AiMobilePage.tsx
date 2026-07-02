import { useRef, useEffect, useLayoutEffect, type ClipboardEventHandler, type DragEventHandler, type FormEventHandler, type RefObject } from 'react';
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
import { MessageBubble, type AiApprovalDecisionSubmit, type AiHumanInputResponseSubmit, type AiResourceOptionLoader } from './AiConversationThread';
import { AiComposerAttachments } from './AiComposerAttachments';
import { AiMobileChrome } from './AiMobileChrome';
import { AiWelcomePrompt } from './AiWelcomePrompt';
import type { AiComposerAttachment } from './useAiAttachmentState';
import { aiThreadAutoScrollKey, latestUserMessageScrollKey, useAiThreadAutoScroll } from './useAiThreadAutoScroll';

type Props = {
  conversations: AiConversation[];
  isLoading: boolean;
  activeConversationKey: string | null;
  runningConversationKeys: Set<string>;
  waitingConversationKeys: Set<string>;
  isMobileHistoryOpen: boolean;
  currentUser: UserSummary | null;
  resourceOptionLoader: AiResourceOptionLoader;
  messages: AiMessage[];
  runEventsById: Record<string, AiRunEvent[]>;
  streamProgress: AiRunEvent[];
  thinkingRunIds: Set<string>;
  activeAssistantRunId: string | null;
  activeStreamRunId: string | null;
  submittingApprovalId: string | null;
  draft: string;
  attachments: AiComposerAttachment[];
  canAddAttachment: boolean;
  hasUploadingAttachment: boolean;
  hasFailedAttachment: boolean;
  isSending: boolean;
  isComposerPaused: boolean;
  composerPauseMessage?: string;
  messagesLoading: boolean;
  messagesError?: string;
  onRetryMessages: () => void;
  onBackHome?: () => void;
  onOpenMobileHistory: () => void;
  onCloseMobileHistory: () => void;
  onStartNewConversation: () => void;
  onSelectConversation: (conversationId: string) => void;
  onDraftChange: (value: string) => void;
  onAttachmentFiles: (files: File[]) => void;
  onRemoveAttachment: (clientAttachmentId: string) => void;
  onPasteFiles: ClipboardEventHandler<HTMLTextAreaElement>;
  onDropFiles: DragEventHandler<HTMLFormElement>;
  onPickSuggestion: (value: string) => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
  onApprovalDecision: AiApprovalDecisionSubmit;
  onHumanInputResponse?: AiHumanInputResponseSubmit;
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
  onOpenRunDebug?: (runId: string) => void;
};

function setPixelVariable(element: HTMLElement, name: string, value: number) {
  element.style.setProperty(name, `${Math.max(0, Math.round(value))}px`);
}

function isTextEntryElement(element: Element | null) {
  if (!(element instanceof HTMLElement)) return false;
  if (element.isContentEditable) return true;
  return element.matches('input, textarea, select');
}

function useAiMobileViewport(composerDockRef: RefObject<HTMLDivElement>) {
  const pageRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const page = pageRef.current;
    if (!page) return undefined;

    const viewport = window.visualViewport;
    const raf = window.requestAnimationFrame ?? ((callback: FrameRequestCallback) => window.setTimeout(callback, 16));
    const cancelRaf = window.cancelAnimationFrame ?? window.clearTimeout;
    let frameId: number | undefined;

    const updateViewportVars = () => {
      if (frameId !== undefined) {
        cancelRaf(frameId);
      }
      frameId = raf(() => {
        const currentViewport = window.visualViewport;
        const layoutHeight = window.innerHeight || document.documentElement.clientHeight || 0;
        const viewportHeight = currentViewport?.height ?? layoutHeight;
        const rawKeyboardInset = currentViewport
          ? Math.max(0, layoutHeight - currentViewport.height - currentViewport.offsetTop)
          : 0;
        const isKeyboardOpen = rawKeyboardInset > 80 && page.contains(document.activeElement) && isTextEntryElement(document.activeElement);
        const keyboardInset = isKeyboardOpen ? rawKeyboardInset : 0;
        const measuredComposerHeight = composerDockRef.current?.getBoundingClientRect().height ?? 0;
        const composerHeight = measuredComposerHeight > 0 ? measuredComposerHeight : 88;

        setPixelVariable(page, '--ai-mobile-viewport-height', viewportHeight || layoutHeight);
        setPixelVariable(page, '--ai-mobile-viewport-top', currentViewport?.offsetTop ?? 0);
        setPixelVariable(page, '--ai-mobile-keyboard-inset', keyboardInset);
        setPixelVariable(page, '--ai-mobile-page-height', (viewportHeight || layoutHeight) + keyboardInset);
        setPixelVariable(page, '--ai-mobile-composer-height', composerHeight);
        page.style.setProperty(
          '--ai-mobile-composer-safe-bottom',
          isKeyboardOpen ? '0px' : 'env(safe-area-inset-bottom, 0px)',
        );
      });
    };

    const updateAfterKeyboardTransition = () => {
      updateViewportVars();
      window.setTimeout(updateViewportVars, 80);
      window.setTimeout(updateViewportVars, 260);
    };

    updateViewportVars();
    window.addEventListener('resize', updateViewportVars);
    window.addEventListener('orientationchange', updateAfterKeyboardTransition);
    viewport?.addEventListener('resize', updateViewportVars);
    viewport?.addEventListener('scroll', updateViewportVars);
    document.addEventListener('focusin', updateAfterKeyboardTransition, true);
    document.addEventListener('focusout', updateAfterKeyboardTransition, true);

    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(updateViewportVars);
    if (composerDockRef.current) {
      resizeObserver?.observe(composerDockRef.current);
    }

    return () => {
      if (frameId !== undefined) {
        cancelRaf(frameId);
      }
      resizeObserver?.disconnect();
      window.removeEventListener('resize', updateViewportVars);
      window.removeEventListener('orientationchange', updateAfterKeyboardTransition);
      viewport?.removeEventListener('resize', updateViewportVars);
      viewport?.removeEventListener('scroll', updateViewportVars);
      document.removeEventListener('focusin', updateAfterKeyboardTransition, true);
      document.removeEventListener('focusout', updateAfterKeyboardTransition, true);
      page.style.removeProperty('--ai-mobile-viewport-height');
      page.style.removeProperty('--ai-mobile-viewport-top');
      page.style.removeProperty('--ai-mobile-keyboard-inset');
      page.style.removeProperty('--ai-mobile-page-height');
      page.style.removeProperty('--ai-mobile-composer-height');
      page.style.removeProperty('--ai-mobile-composer-safe-bottom');
    };
  }, [composerDockRef]);

  return pageRef;
}

export function AiMobilePage(props: Props) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composerDockRef = useRef<HTMLDivElement | null>(null);
  const pageRef = useAiMobileViewport(composerDockRef);
  const threadAutoScroll = useAiThreadAutoScroll({
    contentKey: aiThreadAutoScrollKey(props.messages, props.streamProgress, props.thinkingRunIds),
    resetKey: props.activeConversationKey,
    activeOutputKey: props.activeStreamRunId ?? props.activeAssistantRunId,
    forceScrollKey: latestUserMessageScrollKey(props.messages),
  });

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`;
    }
  }, [props.draft]);

  return (
    <section className="ai-mobile-page" ref={pageRef}>
      <AiMobileChrome
        conversations={props.conversations}
        isLoading={props.isLoading}
        activeConversationKey={props.activeConversationKey}
        runningConversationKeys={props.runningConversationKeys}
        waitingConversationKeys={props.waitingConversationKeys}
        isMobileHistoryOpen={props.isMobileHistoryOpen}
        onBackHome={props.onBackHome}
        onOpenMobileHistory={props.onOpenMobileHistory}
        onCloseMobileHistory={props.onCloseMobileHistory}
        onStartNewConversation={props.onStartNewConversation}
        onSelectConversation={props.onSelectConversation}
      />

      <div className="ai-thread-scroll" ref={threadAutoScroll.threadScrollRef}>
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
                  message.run_id && message.run_id === props.activeAssistantRunId
                    ? props.streamProgress
                    : message.run_id
                      ? props.runEventsById[message.run_id] ?? (message.id.startsWith('local-') ? props.streamProgress : [])
                      : message.id.startsWith('local-')
                        ? props.streamProgress
                        : []
                }
                isThinking={Boolean(message.run_id && props.thinkingRunIds.has(message.run_id))}
                isLatestAssistant={message.role === 'assistant' && index === props.messages.length - 1}
                activeStreamRunId={props.activeStreamRunId}
                submittingApprovalId={props.submittingApprovalId}
                isAssistantResponseActive={
                  message.role === 'assistant'
                  && Boolean(
                    (message.run_id && message.run_id === props.activeAssistantRunId)
                    || (message.id.startsWith('local-') && props.activeAssistantRunId),
                  )
                }
                onApprovalDecision={props.onApprovalDecision}
                onHumanInputResponse={props.onHumanInputResponse}
                onAddRecommendationToPlan={props.onAddRecommendationToPlan}
                onInventoryAction={props.onInventoryAction}
                isInventoryActionPending={props.isInventoryActionPending}
                onOpenRunDebug={props.onOpenRunDebug}
              />
            ))}
          </>
        ) : (
          <AiWelcomePrompt onPickSuggestion={props.onPickSuggestion} />
        )}
      </div>

      {threadAutoScroll.isAutoScrollPaused ? (
        <button className="ai-thread-follow-button" type="button" onClick={threadAutoScroll.resumeAutoScroll}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 5v14" />
            <path d="m6 13 6 6 6-6" />
          </svg>
          <span>最新回复</span>
        </button>
      ) : null}

      <div className="ai-composer-dock" ref={composerDockRef}>
        {props.isComposerPaused && <p className="ai-composer-pause-note">{props.composerPauseMessage ?? '请先确认上面的草稿，确认后可以继续对话。'}</p>}
        <AiComposerAttachments attachments={props.attachments} disabled={props.isComposerPaused || props.isSending} onRemove={props.onRemoveAttachment} />
        <form className="ai-composer" onSubmit={props.onSubmit} onDrop={props.onDropFiles} onDragOver={(event) => event.preventDefault()}>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/bmp"
            multiple
            hidden
            onChange={(event) => {
              props.onAttachmentFiles(Array.from(event.target.files ?? []));
              event.currentTarget.value = '';
            }}
          />
          <button
            type="button"
            className="ai-attachment-button"
            title="添加图片"
            aria-label="添加图片"
            disabled={props.isComposerPaused || props.isSending || !props.canAddAttachment}
            onClick={() => fileInputRef.current?.click()}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
          </button>
          <textarea
            ref={textareaRef}
            className="text-input"
            rows={1}
            value={props.draft}
            placeholder={props.isComposerPaused ? props.composerPauseMessage ?? '等待你确认草稿...' : '问问 AI 厨房助手...'}
            disabled={props.isComposerPaused}
            onChange={(event) => props.onDraftChange(event.target.value)}
            onPaste={props.onPasteFiles}
          />
          <div className="ai-composer-actions">
            <button
              className={`ai-send-button ${props.isSending ? 'is-sending' : ''}`}
              type={props.isSending ? 'button' : 'submit'}
              disabled={
                !props.isSending
                && (
                  props.isComposerPaused
                  || props.hasUploadingAttachment
                  || props.hasFailedAttachment
                  || (!props.draft.trim() && props.attachments.every((item) => item.status !== 'ready'))
                )
              }
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
