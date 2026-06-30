import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import type { AiChatResponse, AiMessagePart, AiResultCard, AiRunEvent } from '../../api/types';
import type { CookingAssistantActionResult } from './cookingAssistantModel';
import type { RecipeCookAssistantMessage, RecipeCookAssistantMessagePart } from './RecipeWorkspaceModel';

export type CookingAssistantMessage = RecipeCookAssistantMessage;

type CookingAssistantStreamArgs = {
  buildSubject: () => Record<string, unknown>;
  onActionCard: (card: AiResultCard) => CookingAssistantActionResult | null;
  initialMessagesKey: string;
  initialMessages: CookingAssistantMessage[];
  onMessagesChange: (messages: CookingAssistantMessage[]) => void;
};

function newClientId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function streamFailureMessage(error: unknown) {
  if (error instanceof DOMException && error.name === 'AbortError') return '已停止这次回复。';
  if (error instanceof Error && error.message) return error.message;
  return 'AI 小助手暂时没连上，请稍后再试。';
}

function resultTone(result: CookingAssistantActionResult): CookingAssistantMessage['tone'] {
  if (result.status === 'executed') return 'success';
  if (result.status === 'needs_confirmation') return 'warning';
  return 'danger';
}

function progressStatusText(status: AiRunEvent['status']) {
  if (status === 'completed') return '已完成';
  if (status === 'failed') return '失败';
  if (status === 'waiting') return '等待中';
  return '调用中';
}

function progressTone(status: AiRunEvent['status']): CookingAssistantMessage['tone'] {
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'danger';
  if (status === 'waiting') return 'warning';
  return 'normal';
}

function progressLabel(event: AiRunEvent) {
  if (event.type === 'skill') return '技能调用';
  if (event.type === 'script') return '脚本调用';
  return '工具调用';
}

function progressDetail(event: AiRunEvent) {
  const message = event.user_message.trim();
  return message || event.internal_code || '调用工具';
}

function isAiRunEvent(event: AiRunEvent | { user_message?: string }): event is AiRunEvent {
  return typeof (event as AiRunEvent).id === 'string'
    && typeof (event as AiRunEvent).status === 'string'
    && typeof (event as AiRunEvent).internal_code === 'string';
}

function responseFallbackText(response: AiChatResponse) {
  const content = response.message.content.trim();
  if (content) return content;
  return '';
}

function isGenericTaskFallback(value: string) {
  const text = value.trim();
  return !text;
}

function messageTextFromParts(parts: RecipeCookAssistantMessagePart[]) {
  return parts.map((part) => {
    if (part.type === 'text') return part.text;
    return `${part.label}：${part.detail}（${part.status}）`;
  }).filter(Boolean).join('\n');
}

function messagePartsWithText(message: CookingAssistantMessage): RecipeCookAssistantMessagePart[] {
  if (message.parts?.length) return message.parts;
  return message.text ? [{ id: newClientId('assistant-text-part'), type: 'text', text: message.text }] : [];
}

const WELCOME_MESSAGE: CookingAssistantMessage = {
  id: 'assistant-welcome',
  role: 'assistant',
  text: '我在，小灶可以帮你看步骤、食材和计时。你也可以直接说“下一步”。',
};

export function useCookingAssistantStream({
  buildSubject,
  onActionCard,
  initialMessagesKey,
  initialMessages,
  onMessagesChange,
}: CookingAssistantStreamArgs) {
  const [messages, setMessages] = useState<CookingAssistantMessage[]>(() => initialMessages.length ? initialMessages : [WELCOME_MESSAGE]);
  const [isSending, setIsSending] = useState(false);
  const [progressText, setProgressText] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const handledCardIdsRef = useRef<Set<string>>(new Set());
  const onMessagesChangeRef = useRef(onMessagesChange);
  const lastInitialMessagesKeyRef = useRef(initialMessagesKey);

  useEffect(() => {
    onMessagesChangeRef.current = onMessagesChange;
  }, [onMessagesChange]);

  useEffect(() => {
    if (lastInitialMessagesKeyRef.current === initialMessagesKey) return;
    lastInitialMessagesKeyRef.current = initialMessagesKey;
    handledCardIdsRef.current = new Set();
    setMessages(initialMessages.length ? initialMessages : [WELCOME_MESSAGE]);
  }, [initialMessages, initialMessagesKey]);

  useEffect(() => {
    onMessagesChangeRef.current(messages.slice(-40));
  }, [messages]);

  const appendMessage = useCallback((message: CookingAssistantMessage) => {
    setMessages((current) => [...current, message]);
  }, []);

  const appendAssistantDelta = useCallback((messageId: string, delta: string) => {
    if (!delta) return;
    setMessages((current) => current.map((message) => {
      if (message.id !== messageId) return message;
      const parts = messagePartsWithText(message);
      const lastPart = parts[parts.length - 1];
      const nextParts = lastPart?.type === 'text'
        ? parts.map((part, index) => index === parts.length - 1 && part.type === 'text' ? { ...part, text: `${part.text}${delta}` } : part)
        : [...parts, { id: newClientId('assistant-text-part'), type: 'text' as const, text: delta }];
      return { ...message, text: messageTextFromParts(nextParts), parts: nextParts };
    }));
  }, []);

  const upsertAssistantPart = useCallback((messageId: string, part: RecipeCookAssistantMessagePart, tone?: CookingAssistantMessage['tone']) => {
    setMessages((current) => current.map((message) => {
      if (message.id !== messageId) return message;
      const existingParts = messagePartsWithText(message);
      const partIndex = existingParts.findIndex((item) => item.id === part.id);
      const nextParts = partIndex >= 0
        ? existingParts.map((item, index) => index === partIndex ? part : item)
        : [...existingParts, part];
      return { ...message, tone: tone ?? message.tone, text: messageTextFromParts(nextParts), parts: nextParts };
    }));
  }, []);

  const handleProgressEvent = useCallback((event: AiRunEvent | { user_message?: string }, assistantMessageId: string) => {
    if (event.user_message) {
      setProgressText(event.user_message);
    }
    if (!isAiRunEvent(event) || !event.user_message) return;
    const tone = progressTone(event.status);
    upsertAssistantPart(assistantMessageId, {
      id: `assistant-progress-${event.id}`,
      type: 'tool_card',
      label: progressLabel(event),
      detail: progressDetail(event),
      status: progressStatusText(event.status),
      tone,
    });
  }, [upsertAssistantPart]);

  const handleActionCard = useCallback((card: AiResultCard, assistantMessageId: string) => {
    if (handledCardIdsRef.current.has(card.id)) return;
    handledCardIdsRef.current.add(card.id);
    const result = onActionCard(card);
    if (!result) return;
    if (result.status !== 'executed' && result.data) {
      upsertAssistantPart(assistantMessageId, {
        id: `assistant-action-${card.id}`,
        type: 'tool_card',
        label: '页面操作',
        detail: result.message,
        status: result.status === 'needs_confirmation' ? '等待确认' : '未执行',
        tone: resultTone(result),
      }, resultTone(result));
    }
  }, [onActionCard, upsertAssistantPart]);

  const handleMessagePart = useCallback((part: AiMessagePart, assistantMessageId: string) => {
    if (part.type === 'result_card' && part.card) {
      handleActionCard(part.card, assistantMessageId);
    }
  }, [handleActionCard]);

  const handleResponse = useCallback((response: AiChatResponse, assistantMessageId: string) => {
    response.message.parts.forEach((part) => handleMessagePart(part, assistantMessageId));
    response.included.result_cards.forEach((card) => handleActionCard(card, assistantMessageId));
    setMessages((current) => current.map((message) => {
      if (message.id !== assistantMessageId || !isGenericTaskFallback(message.text)) return message;
      const text = responseFallbackText(response);
      if (!text) return message;
      return { ...message, text, parts: [{ id: newClientId('assistant-text-part'), type: 'text', text }] };
    }));
  }, [handleActionCard, handleMessagePart]);

  const sendMessage = useCallback(async (rawMessage: string) => {
    const message = rawMessage.trim();
    if (!message || isSending) return;
    const clientMessageId = newClientId('cook-user');
    const clientRunId = newClientId('cook-run');
    const assistantMessageId = newClientId('cook-assistant');
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    setIsSending(true);
    setProgressText('小助手在看当前步骤');
    appendMessage({ id: clientMessageId, role: 'user', text: message });
    appendMessage({ id: assistantMessageId, role: 'assistant', text: '' });
    try {
      const response = await api.streamChatAi({
        message,
        client_message_id: clientMessageId,
        client_run_id: clientRunId,
        quick_task: 'cooking_assistant',
        subject: buildSubject(),
        persist_history: false,
      }, {
        signal: controller.signal,
        onProgress: (event: AiRunEvent | { user_message?: string }) => handleProgressEvent(event, assistantMessageId),
        onMessageDelta: (event) => appendAssistantDelta(assistantMessageId, event.delta),
        onMessagePart: (event) => handleMessagePart(event.part, assistantMessageId),
      });
      handleResponse(response, assistantMessageId);
    } catch (error) {
      const messageText = streamFailureMessage(error);
      setMessages((current) => current.map((messageItem) => (
        messageItem.id === assistantMessageId
          ? {
              ...messageItem,
              text: messageText,
              tone: messageText.includes('停止') ? 'warning' : 'danger',
              parts: [{ id: newClientId('assistant-text-part'), type: 'text', text: messageText }],
            }
          : messageItem
      )));
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
      setProgressText('');
      setIsSending(false);
    }
  }, [appendAssistantDelta, appendMessage, buildSubject, handleMessagePart, handleProgressEvent, handleResponse, isSending]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const clearMessages = useCallback(() => {
    handledCardIdsRef.current = new Set();
    setMessages([WELCOME_MESSAGE]);
  }, []);

  return {
    messages,
    isSending,
    progressText,
    sendMessage,
    stop,
    clearMessages,
  };
}
