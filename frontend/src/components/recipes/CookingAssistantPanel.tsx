import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { AiResultCard, CookRecipePreviewResponse, RecipeStep } from '../../api/types';
import { ActionButton } from '../ui-kit';
import { RecipeUiIcon } from './RecipeWorkspaceCards';
import { DashboardIcon } from '../../app/shellIcons';
import { AiVoiceInputButton } from '../ai/AiVoiceInputButton';
import { useAiThreadAutoScroll } from '../ai/useAiThreadAutoScroll';
import { useVoicePlayback } from '../../hooks/useVoicePlayback';
import {
  buildCookingAssistantRuntimeState,
  buildCookingAssistantSubject,
  describeCookingAction,
  executeCookingUiActions,
  parseCookingUiActionsCard,
  type CookingAssistantActionHandlers,
  type CookingAssistantMobileTab,
} from './cookingAssistantModel';
import type { CookTimerState, RecipeCookAssistantMessage, RecipeCookAssistantMessagePart, RecipeCookSessionState } from './RecipeWorkspaceModel';
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

function isFixedCookingSkillToolCard(part: RecipeCookAssistantMessagePart) {
  return part.type === 'tool_card' && part.label === '技能调用';
}

function cookingAssistantPartScrollKey(part: RecipeCookAssistantMessagePart) {
  if (part.type === 'text') return `${part.id}:text:${part.text.length}`;
  return `${part.id}:tool:${part.label}:${part.detail.length}:${part.status}`;
}

function cookingAssistantAutoScrollKey(messages: RecipeCookAssistantMessage[], isSending: boolean) {
  return messages
    .map((message) => `${message.id}:${message.role}:${message.text.length}:${message.tone ?? ''}:${message.parts?.map(cookingAssistantPartScrollKey).join(',') ?? ''}`)
    .join('|')
    + `::sending:${isSending ? '1' : '0'}`;
}

function latestCookingUserMessageKey(messages: RecipeCookAssistantMessage[]) {
  return [...messages].reverse().find((message) => message.role === 'user')?.id ?? null;
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
  const [pendingVoiceSend, setPendingVoiceSend] = useState('');
  const playback = useVoicePlayback();
  const playbackStreamOptionsRef = useRef({ sampleRate: 24000, channels: 1, contentType: 'audio/pcm' });
  const recordBackendAudioTrace = useCallback((event: { stage: string; elapsed_ms?: number; [key: string]: unknown }) => {
    const { stage, ...details } = event;
    const traceStage = stage.startsWith('backend_') || stage.startsWith('tts_') ? stage : `backend_${stage}`;
    playback.recordTrace(traceStage, details);
  }, [playback]);
  const pendingVoiceSendTimerRef = useRef<number | null>(null);

  const [voiceInputStatus, setVoiceInputStatus] = useState<'idle' | 'recording' | 'recognizing'>('idle');
  const shouldSendImmediatelyRef = useRef(false);
  const voiceButtonRef = useRef<HTMLButtonElement>(null);
  const isVoiceRecording = voiceInputStatus === 'recording';
  const isVoiceRecognizing = voiceInputStatus === 'recognizing';

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
    voicePlaybackEnabled: playback.isEnabled,
    onAssistantAudioStart: (event) => {
      playbackStreamOptionsRef.current = {
        sampleRate: event.sample_rate,
        channels: event.channels,
        contentType: event.content_type,
      };
      playback.startPcmStream({
        sampleRate: event.sample_rate,
        channels: event.channels,
        contentType: event.content_type,
      });
    },
    onAssistantAudioDelta: (event) => {
      playback.appendPcmChunk(event.audio, playbackStreamOptionsRef.current);
    },
    onAssistantAudioDone: () => {
      playback.finishStream();
    },
    onAssistantAudioError: (event) => {
      playback.failStream(event.message);
    },
    onAssistantAudioTrace: recordBackendAudioTrace,
  });

  function mergeVoiceTranscript(current: string, text: string) {
    const transcript = text.trim();
    if (!transcript) return current;
    return current.trim() ? `${current.trimEnd()} ${transcript}` : transcript;
  }

  function handleVoiceTranscript(text: string, context?: { interaction: 'tap' | 'hold' }) {
    const nextDraft = mergeVoiceTranscript(assistantState.draftMessage, text);
    if (!nextDraft.trim()) return;
    const shouldSubmit = context?.interaction === 'hold' || shouldSendImmediatelyRef.current;
    shouldSendImmediatelyRef.current = false;
    if (shouldSubmit) {
      handleUserMessage(nextDraft);
    } else {
      assistantState.setDraftMessage(nextDraft);
    }
  }

  function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    cancelPendingVoiceSend();
    if (isVoiceRecording) {
      shouldSendImmediatelyRef.current = true;
      voiceButtonRef.current?.click();
      return;
    }
    if (isVoiceRecognizing) {
      shouldSendImmediatelyRef.current = true;
      return;
    }
    const message = assistantState.draftMessage.trim();
    if (!message) return;
    assistantState.setDraftMessage('');
    handleUserMessage(message);
  }

  function handleUserMessage(message: string) {
    cancelPendingVoiceSend();
    assistantState.clearTransientNotice();
    assistantState.openPanel();
    playback.stop();
    void assistant.sendMessage(message);
  }

  function cancelPendingVoiceSend() {
    if (pendingVoiceSendTimerRef.current !== null) {
      window.clearTimeout(pendingVoiceSendTimerRef.current);
      pendingVoiceSendTimerRef.current = null;
    }
    setPendingVoiceSend('');
  }

  function queueVoiceSend(text: string) {
    const transcript = text.trim();
    if (!transcript) return;
    cancelPendingVoiceSend();
    assistantState.clearTransientNotice();
    assistantState.openPanel();
    playback.stop();
    setPendingVoiceSend(transcript);
    pendingVoiceSendTimerRef.current = window.setTimeout(() => {
      pendingVoiceSendTimerRef.current = null;
      setPendingVoiceSend('');
      void assistant.sendMessage(transcript);
    }, 1000);
  }

  useEffect(() => () => {
    if (pendingVoiceSendTimerRef.current !== null) {
      window.clearTimeout(pendingVoiceSendTimerRef.current);
      pendingVoiceSendTimerRef.current = null;
    }
  }, []);


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
  const messagesAutoScroll = useAiThreadAutoScroll({
    contentKey: cookingAssistantAutoScrollKey(assistant.messages, assistant.isSending),
    resetKey: runtimeState.cookSessionId,
    activeOutputKey: assistant.isSending ? lastAssistantMessageId : null,
    forceScrollKey: latestCookingUserMessageKey(assistant.messages),
  });
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
              className={`recipe-cook-ai-icon-btn voice ${playback.isEnabled ? 'active' : ''}`}
              type="button"
              onClick={() => {
                if (playback.isEnabled) playback.stop();
                playback.setIsEnabled(!playback.isEnabled);
              }}
              aria-label={playback.isEnabled ? '关闭小灶播报' : '打开小灶播报'}
              title={playback.isEnabled ? '关闭播报' : '打开播报'}
            >
              <DashboardIcon name={playback.isEnabled ? 'speaker' : 'speaker-off'} />
            </button>
            <button
              className="recipe-cook-ai-icon-btn clear"
              type="button"
              onClick={requestClearConversation}
              disabled={!hasClearableMessages || assistant.isSending}
              aria-label="清除小灶对话记录"
              title="清除对话"
            >
              <DashboardIcon name="trash" />
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

        <div className="recipe-cook-ai-messages" ref={messagesAutoScroll.threadScrollRef} aria-live="polite">
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
            const visibleParts = message.parts?.filter((part) => !isFixedCookingSkillToolCard(part)) ?? [];
            if (message.parts?.length && visibleParts.length === 0) return null;
            const parts = visibleParts.length ? visibleParts : null;
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
        {messagesAutoScroll.isAutoScrollPaused ? (
          <button className="recipe-cook-ai-follow-button" type="button" onClick={messagesAutoScroll.resumeAutoScroll}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 5v14" />
              <path d="m6 13 6 6 6-6" />
            </svg>
            <span>最新回复</span>
          </button>
        ) : null}

        <div className="recipe-cook-ai-footer">
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

          {pendingVoiceSend ? (
            <div className="recipe-cook-ai-voice-pending" role="status" aria-live="polite">
              <span>识别到：{pendingVoiceSend}</span>
              <button type="button" onClick={cancelPendingVoiceSend}>取消</button>
            </div>
          ) : null}

          {playback.error ? (
            <div className="recipe-cook-ai-confirm-note">{playback.error}</div>
          ) : null}

          <form className="recipe-cook-ai-composer" onSubmit={submitMessage}>
            <input
              value={assistantState.draftMessage}
              onChange={(event) => assistantState.setDraftMessage(event.target.value)}
              placeholder="问这一步、食材或计时..."
              disabled={assistant.isSending}
            />
            <AiVoiceInputButton
              surface="recipe_cook_page"
              className="recipe-cook-ai-voice-btn"
              disabled={assistant.isSending}
              buttonRef={voiceButtonRef}
              enableHoldToSend
              onStateChange={(state) => setVoiceInputStatus(state.status)}
              onStartRecording={() => {
                playback.stop();
              }}
              onTranscript={handleVoiceTranscript}
            />
            {assistant.isSending ? (
              <button className="recipe-cook-ai-send-btn stop-mode" type="button" onClick={assistant.stop} title="停止">
                <DashboardIcon name="x" />
              </button>
            ) : (
              <button className="recipe-cook-ai-send-btn" type="submit" disabled={!isVoiceRecording && !isVoiceRecognizing && !assistantState.draftMessage.trim()} title="发送">
                <DashboardIcon name="chevron" />
              </button>
            )}
          </form>
        </div>
      </div>
    </section>
  );
}
