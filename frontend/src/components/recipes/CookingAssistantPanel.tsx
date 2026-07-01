import { useCallback, useMemo, useRef, useState, type FormEvent } from 'react';
import type { AiResultCard, CookRecipePreviewResponse, RecipeStep } from '../../api/types';
import { ActionButton } from '../ui-kit';
import { RecipeUiIcon } from './RecipeWorkspaceCards';
import { DashboardIcon } from '../../app/shellIcons';
import {
  buildCookingAssistantRuntimeState,
  buildCookingAssistantSubject,
  describeCookingAction,
  executeCookingUiActions,
  parseCookingUiActionsCard,
  type CookingAssistantActionHandlers,
  type CookingAssistantMobileTab,
} from './cookingAssistantModel';
import type { CookTimerState, RecipeCookAssistantMessage, RecipeCookSessionState } from './RecipeWorkspaceModel';
import type { RecipeCardViewModel } from './workspaceModel';
import { useCookingAssistantState } from './useCookingAssistantState';
import { useCookingAssistantStream } from './useCookingAssistantStream';

type CookingAssistantPanelProps = {
  activeCookCard: RecipeCardViewModel;
  cookSession: RecipeCookSessionState;
  cookSteps: RecipeStep[];
  currentCookStep: RecipeStep | null;
  cookPreview: CookRecipePreviewResponse | null;
  timers: CookTimerState[];
  activeTimerId: string;
  activeMobileTab: CookingAssistantMobileTab;
  actions: CookingAssistantActionHandlers;
  onMessagesChange: (messages: RecipeCookAssistantMessage[]) => void;
};

function CookingAssistantTypingCue() {
  return (
    <span className="recipe-cook-ai-typing" aria-label="小灶正在回复">
      小灶正在回复
      <span aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    </span>
  );
}

export function CookingAssistantPanel({
  activeCookCard,
  cookSession,
  cookSteps,
  currentCookStep,
  cookPreview,
  timers,
  activeTimerId,
  activeMobileTab,
  actions,
  onMessagesChange,
}: CookingAssistantPanelProps) {
  const assistantState = useCookingAssistantState();
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);

  const subjectArgs = useMemo(() => ({
    activeCookCard,
    cookSession,
    cookSteps,
    currentCookStep,
    cookPreview,
    timers,
    activeTimerId,
    activeMobileTab,
  }), [activeCookCard, activeMobileTab, activeTimerId, cookPreview, cookSession, cookSteps, currentCookStep, timers]);
  const runtimeState = useMemo(() => buildCookingAssistantRuntimeState(subjectArgs), [subjectArgs]);
  const runtimeStateRef = useRef(runtimeState);
  runtimeStateRef.current = runtimeState;

  const handleActionCard = useCallback((card: AiResultCard) => {
    const data = parseCookingUiActionsCard(card);
    if (!data) return null;
    const result = executeCookingUiActions(data, runtimeStateRef.current, actions);
    if (result.status === 'needs_confirmation') {
      assistantState.setPendingActionCard(data);
    }
    return result;
  }, [actions, assistantState]);

  const assistant = useCookingAssistantStream({
    buildSubject: () => buildCookingAssistantSubject(subjectArgs),
    onActionCard: handleActionCard,
    initialMessagesKey: runtimeState.cookSessionId,
    initialMessages: cookSession.aiAssistantMessages,
    onMessagesChange,
  });

  function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = assistantState.draftMessage.trim();
    if (!message) return;
    assistantState.setDraftMessage('');
    handleUserMessage(message);
  }

  function handleUserMessage(message: string) {
    assistantState.clearTransientNotice();
    assistantState.openPanel();
    void assistant.sendMessage(message);
  }


  function confirmPendingAction() {
    if (!assistantState.pendingActionCard) return;
    const result = executeCookingUiActions(assistantState.pendingActionCard, runtimeStateRef.current, actions, { confirmed: true });
    assistantState.setPendingActionCard(null);
    assistantState.setConfirmationNotice(result.message);
  }

  const pendingActionCard = assistantState.pendingActionCard;
  const hasClearableMessages = assistant.messages.some((message) => message.id !== 'assistant-welcome');

  function requestClearConversation() {
    if (!hasClearableMessages || assistant.isSending) return;
    setClearConfirmOpen(true);
  }

  function confirmClearConversation() {
    if (assistant.isSending) return;
    assistant.clearMessages();
    assistantState.setPendingActionCard(null);
    assistantState.clearTransientNotice();
    setClearConfirmOpen(false);
  }

  const lastAssistantMessageId = [...assistant.messages].reverse().find((message) => message.role === 'assistant')?.id ?? '';
  const assistantClassName = [
    'recipe-cook-ai-assistant',
    assistantState.isOpen ? 'open' : 'collapsed',
    assistantState.isClosing ? 'closing' : '',
    assistantState.isFloatingPositioned ? 'floating-positioned' : '',
    assistantState.isFloatingDragging ? 'dragging' : '',
  ].filter(Boolean).join(' ');

  return (
    <section ref={assistantState.floatingRef} className={assistantClassName} aria-label="小灶">
      <button
        className="recipe-cook-ai-toggle"
        type="button"
        onPointerDown={assistantState.startFloatingDrag}
        onPointerMove={assistantState.moveFloatingDrag}
        onPointerUp={assistantState.endFloatingDrag}
        onPointerCancel={assistantState.endFloatingDrag}
        onClick={(event) => {
          if (assistantState.consumeFloatingDragClick()) {
            event.preventDefault();
            return;
          }
          assistantState.togglePanel();
        }}
        aria-expanded={assistantState.isOpen && !assistantState.isClosing}
      >
        <span><img src="/assets/ai-tab-chef-bot-active.webp" alt="小灶头像" draggable={false} /></span>
        <strong>问小灶</strong>
        {assistant.isSending ? <small className="busy">回复中</small> : null}
      </button>

      <div className="recipe-cook-ai-panel" aria-hidden={!assistantState.isOpen || assistantState.isClosing}>
        <div
          className="recipe-cook-ai-drag-bar"
          onPointerDown={(event) => {
            assistantState.startMobileSheetDrag(event);
            assistantState.startFloatingDrag(event);
          }}
          onPointerMove={assistantState.moveFloatingDrag}
          onPointerUp={assistantState.endFloatingDrag}
          onPointerCancel={assistantState.endFloatingDrag}
          aria-label="拖动小灶窗口，向下拖动可收起"
        />
        <div className="recipe-cook-ai-head">
          <div className="recipe-cook-ai-head-logo">
            <img src="/assets/ai-tab-chef-bot-active.webp" alt="小灶头像" draggable={false} />
          </div>
          <div className="recipe-cook-ai-head-copy">
            <span>小灶</span>
            <strong>{assistant.progressText || '可以问步骤、食材和计时'}</strong>
          </div>
          <div className="recipe-cook-ai-head-actions">
            <button
              className="recipe-cook-ai-icon-btn clear"
              type="button"
              onClick={requestClearConversation}
              disabled={!hasClearableMessages || assistant.isSending}
              aria-label="清除小灶对话记录"
              title="清除对话"
            >
              <DashboardIcon name="clear" />
            </button>
            <button className="recipe-cook-ai-icon-btn close" type="button" onClick={assistantState.closePanel} aria-label="收起小灶" title="收起">
              <DashboardIcon name="x" />
            </button>
          </div>
        </div>

        {clearConfirmOpen ? (
          <div className="recipe-cook-ai-clear-confirm" role="dialog" aria-modal="true" aria-labelledby="recipe-cook-ai-clear-title">
            <div className="recipe-cook-ai-clear-card">
              <span className="recipe-cook-ai-clear-icon" aria-hidden="true">
                <DashboardIcon name="clear" />
              </span>
              <div className="recipe-cook-ai-clear-copy">
                <strong id="recipe-cook-ai-clear-title">清除小灶对话？</strong>
                <span>只会清空这次做菜里的聊天记录，不影响步骤、计时器和做菜进度。</span>
              </div>
              <div className="recipe-cook-ai-clear-actions">
                <button className="recipe-cook-ai-clear-secondary" type="button" onClick={() => setClearConfirmOpen(false)}>
                  先留着
                </button>
                <button className="recipe-cook-ai-clear-primary" type="button" onClick={confirmClearConversation}>
                  清除
                </button>
              </div>
            </div>
          </div>
        ) : null}

        <div className="recipe-cook-ai-messages" aria-live="polite">
          {assistant.messages.map((message) => {
            if (message.role === 'system') {
              const [label = '页面操作', detail = message.text, status = '已处理'] = message.text.split('\n');
              return (
                <div key={message.id} className={`recipe-cook-ai-tool-card ${message.tone ?? 'normal'}`} role="status">
                  <span>{label}</span>
                  <strong>{detail}</strong>
                  <small>{status}</small>
                </div>
              );
            }
            const parts = message.parts?.length ? message.parts : null;
            return (
              <div key={message.id} className={`recipe-cook-ai-message ${message.role} ${message.tone ?? 'normal'} ${parts ? 'has-parts' : ''}`}>
                {parts ? (
                  <>
                    {parts.map((part) => {
                      if (part.type === 'tool_card') {
                        return (
                          <div key={part.id} className={`recipe-cook-ai-tool-card ${part.tone ?? message.tone ?? 'normal'}`} role="status">
                            <span>{part.label}</span>
                            <strong>{part.detail}</strong>
                            <small>{part.status}</small>
                          </div>
                        );
                      }
                      return <span key={part.id} className="recipe-cook-ai-message-text">{part.text}</span>;
                    })}
                    {assistant.isSending && message.id === lastAssistantMessageId ? <CookingAssistantTypingCue /> : null}
                  </>
                ) : message.text ? (
                  <>
                    {message.text}
                    {assistant.isSending && message.id === lastAssistantMessageId ? (
                      <span className="recipe-cook-ai-stream-cursor" aria-hidden="true" />
                    ) : null}
                  </>
                ) : message.role === 'assistant' ? (
                  <CookingAssistantTypingCue />
                ) : null}
              </div>
            );
          })}
        </div>

        {pendingActionCard ? (
          <div className="recipe-cook-ai-confirm">
            <span>需要确认</span>
            <strong>{pendingActionCard.actions.map(describeCookingAction).join('、')}</strong>
            <div>
              <ActionButton tone="secondary" type="button" onClick={() => assistantState.setPendingActionCard(null)}>
                先不做
              </ActionButton>
              <ActionButton tone="primary" type="button" onClick={confirmPendingAction}>
                确认执行
              </ActionButton>
            </div>
          </div>
        ) : null}

        {assistantState.confirmationNotice ? (
          <div className="recipe-cook-ai-confirm-note">{assistantState.confirmationNotice}</div>
        ) : null}


        <form className="recipe-cook-ai-composer" onSubmit={submitMessage}>
          <input
            value={assistantState.draftMessage}
            onChange={(event) => assistantState.setDraftMessage(event.target.value)}
            placeholder="问这一步、食材或计时..."
            disabled={assistant.isSending}
          />
          {assistant.isSending ? (
            <button className="recipe-cook-ai-send-btn stop-mode" type="button" onClick={assistant.stop} title="停止">
              <DashboardIcon name="x" />
            </button>
          ) : (
            <button className="recipe-cook-ai-send-btn" type="submit" disabled={!assistantState.draftMessage.trim()} title="发送">
              <DashboardIcon name="chevron" />
            </button>
          )}
        </form>
      </div>
    </section>
  );
}
