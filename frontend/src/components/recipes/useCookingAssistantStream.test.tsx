import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aiApi } from '../../api/aiApi';
import { api, ApiError } from '../../api/client';
import type { AiChatResponse, AiResultCard, AiRunCancellationPhase, AiRunCancellationResponse, AiRunEvent, AiUiActionsCardData } from '../../api/types';
import type { CookingAssistantActionResult } from './cookingAssistantModel';
import { useCookingAssistantStream, type CookingAssistantMessage } from './useCookingAssistantStream';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type ProbeValue = {
  messages: CookingAssistantMessage[];
  isSending: boolean;
  sendMessage: (message: string) => Promise<void>;
  stop: () => Promise<void>;
  cancellationPhase: AiRunCancellationPhase;
  cancellationError: string;
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let latest: ProbeValue | null = null;
let actionCardHandler: (card: AiResultCard) => CookingAssistantActionResult | null = () => null;
let cancellationAcceptedHandler = vi.fn();

function cancellationResponse(runId: string, outcome: AiRunCancellationResponse['outcome']): AiRunCancellationResponse {
  const cancelled = outcome !== 'cancel_requested';
  return {
    outcome,
    request: {
      run_id: runId,
      status: cancelled ? 'applied' : 'requested',
      requested_at: '2026-07-23T00:00:00Z',
      resolved_at: cancelled ? '2026-07-23T00:00:01Z' : null,
    },
    run: {
      id: runId,
      agent_key: 'cooking_assistant',
      intent: 'recipe_cook',
      status: cancelled ? 'cancelled' : 'cancelling',
      model: 'fake-model',
      created_at: '2026-07-23T00:00:00Z',
    },
    events: [],
  };
}

function chatResponse(content: string): AiChatResponse {
  return {
    conversation_id: 'conversation-1',
    message: {
      id: 'message-1',
      conversation_id: 'conversation-1',
      role: 'assistant',
      content,
      content_type: 'parts',
      parts: [{ id: 'part-1', type: 'text', text: content }],
      run_id: 'run-1',
      status: 'completed',
      metadata: {},
      created_at: '2026-07-03T00:00:00Z',
    },
    run: {
      id: 'run-1',
      agent_key: 'workspace_orchestrator',
      intent: 'recipe_cook',
      status: 'completed',
      model: 'fake',
      created_at: '2026-07-03T00:00:00Z',
    },
    events: [],
    included: { result_cards: [], drafts: [], approvals: [] },
  };
}

function progressEvent(overrides: Partial<AiRunEvent>): AiRunEvent {
  return {
    id: 'event-1',
    run_id: 'run-1',
    type: 'tool',
    internal_code: 'recipe.read_current_step',
    user_message: '调用「当前步骤」',
    status: 'completed',
    created_at: '2026-07-03T00:00:00Z',
    ...overrides,
  };
}

function Probe() {
  const assistant = useCookingAssistantStream({
    buildSubject: () => ({ source: 'recipe_cook_page' }),
    onActionCard: actionCardHandler,
    initialMessagesKey: 'cook-session-1',
    initialMessages: [],
    onMessagesChange: vi.fn(),
    onCancellationAccepted: cancellationAcceptedHandler,
  });

  useEffect(() => {
    latest = {
      messages: assistant.messages,
      isSending: assistant.isSending,
      sendMessage: assistant.sendMessage,
      stop: assistant.stop,
      cancellationPhase: assistant.cancellationPhase,
      cancellationError: assistant.cancellationError,
    };
  }, [
    assistant.cancellationError,
    assistant.cancellationPhase,
    assistant.isSending,
    assistant.messages,
    assistant.sendMessage,
    assistant.stop,
  ]);

  return null;
}

function renderProbe() {
  act(() => {
    root?.render(<Probe />);
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  latest = null;
  actionCardHandler = () => null;
  cancellationAcceptedHandler = vi.fn();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  latest = null;
  vi.restoreAllMocks();
});

describe('useCookingAssistantStream', () => {
  it('does not abort cooking stream when cancel API fails', async () => {
    let streamSignal: AbortSignal | undefined;
    vi.spyOn(api, 'streamChatAi').mockImplementation((_payload, handlers) => new Promise((_resolve, reject) => {
      streamSignal = handlers?.signal;
      handlers?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    vi.spyOn(aiApi, 'cancelAiRun').mockRejectedValue(new ApiError({
      status: 500,
      detail: '小灶停止失败',
      path: '/api/ai/runs/cook-run/cancel',
      payload: {},
    }));
    renderProbe();
    await act(async () => {
      void latest?.sendMessage('下一步');
      await Promise.resolve();
    });

    await act(async () => {
      await latest?.stop();
    });

    expect(streamSignal?.aborted).toBe(false);
    expect(latest?.isSending).toBe(true);
    expect(latest?.cancellationPhase).toBe('failed');
    expect(latest?.cancellationError).toContain('小灶停止失败');
    expect(cancellationAcceptedHandler).not.toHaveBeenCalled();
  });

  it('shows cancelling after 202 and waits for cancellation polling', async () => {
    let streamSignal: AbortSignal | undefined;
    let clientRunId = '';
    vi.spyOn(api, 'streamChatAi').mockImplementation((payload, handlers) => new Promise((_resolve, reject) => {
      clientRunId = payload.client_run_id ?? '';
      streamSignal = handlers?.signal;
      handlers?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    vi.spyOn(aiApi, 'cancelAiRun').mockImplementation((runId) => Promise.resolve(cancellationResponse(runId, 'cancel_requested')));
    vi.spyOn(aiApi, 'getAiRunCancellation').mockImplementation((runId) => Promise.resolve(cancellationResponse(runId, 'cancelled')));
    renderProbe();
    await act(async () => {
      void latest?.sendMessage('下一步');
      await Promise.resolve();
    });
    vi.useFakeTimers();

    let stopPromise: Promise<void> | undefined;
    await act(async () => {
      stopPromise = latest?.stop();
      await Promise.resolve();
    });
    expect(aiApi.cancelAiRun).toHaveBeenCalledWith(clientRunId);
    expect(streamSignal?.aborted).toBe(true);
    expect(latest?.cancellationPhase).toBe('cancelling');
    expect(latest?.messages.at(-1)?.text).not.toContain('已取消这次回复');
    expect(cancellationAcceptedHandler).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
      await stopPromise;
    });
    expect(latest?.cancellationPhase).toBe('cancelled');
    expect(latest?.messages.at(-1)?.text).toContain('已取消这次回复');
    vi.useRealTimers();
  });

  it('aborts cooking text and audio only after cancel is accepted', async () => {
    let acceptCancellation!: (response: AiRunCancellationResponse) => void;
    let clientRunId = '';
    let streamSignal: AbortSignal | undefined;
    vi.spyOn(api, 'streamChatAi').mockImplementation((payload, handlers) => new Promise((_resolve, reject) => {
      clientRunId = payload.client_run_id ?? '';
      streamSignal = handlers?.signal;
      handlers?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    vi.spyOn(aiApi, 'cancelAiRun').mockImplementation((runId) => new Promise((resolve) => {
      acceptCancellation = resolve;
      void runId;
    }));
    renderProbe();
    await act(async () => {
      void latest?.sendMessage('下一步');
      await Promise.resolve();
    });
    let stopPromise: Promise<void> | undefined;
    act(() => {
      stopPromise = latest?.stop();
    });
    expect(streamSignal?.aborted).toBe(false);
    expect(cancellationAcceptedHandler).not.toHaveBeenCalled();

    await act(async () => {
      acceptCancellation(cancellationResponse(clientRunId, 'cancelled'));
      await stopPromise;
    });
    expect(streamSignal?.aborted).toBe(true);
    expect(cancellationAcceptedHandler).toHaveBeenCalledTimes(1);
  });

  it('keeps an untyped AbortError as a visible connection failure', async () => {
    vi.spyOn(api, 'streamChatAi').mockRejectedValue(new DOMException('The operation was aborted', 'AbortError'));
    renderProbe();

    await act(async () => {
      await latest?.sendMessage('下一步');
    });

    expect(latest?.messages.at(-1)?.text).toContain('连接中断');
    expect(latest?.messages.at(-1)?.text).not.toContain('已停止这次回复');
    expect(latest?.messages.at(-1)?.tone).toBe('danger');
  });

  it('renders cancelled cooking progress separately from failure', async () => {
    vi.spyOn(api, 'streamChatAi').mockImplementation(async (_payload, handlers) => {
      handlers?.onProgress?.(progressEvent({
        id: 'cancelled-progress',
        status: 'cancelled',
        internal_code: 'user_cancel',
        user_message: '已取消这次任务',
      }));
      return chatResponse('');
    });
    renderProbe();

    await act(async () => {
      await latest?.sendMessage('下一步');
    });

    const cancelledPart = latest?.messages.at(-1)?.parts?.find((part) => part.id === 'assistant-progress-cancelled-progress');
    expect(cancelledPart).toMatchObject({ status: '已取消', tone: 'warning' });
    expect(JSON.stringify(cancelledPart)).not.toContain('失败');
  });

  it('hides fixed cooking skill progress while keeping useful tool progress', async () => {
    vi.spyOn(api, 'streamChatAi').mockImplementation(async (_payload, handlers) => {
      handlers?.onProgress?.(progressEvent({
        id: 'skill-event',
        type: 'skill',
        internal_code: 'recipe-cook',
        user_message: '调用「做菜助手」技能',
      }));
      handlers?.onProgress?.(progressEvent({ id: 'tool-event' }));
      handlers?.onMessageDelta?.({ delta: '在呢。' });
      return chatResponse('在呢。');
    });

    renderProbe();

    await act(async () => {
      await latest?.sendMessage('你好');
    });

    const messageText = JSON.stringify(latest?.messages ?? []);
    expect(messageText).not.toContain('技能调用');
    expect(messageText).not.toContain('做菜助手');
    expect(messageText).toContain('调用「当前步骤」');
  });

  it('hides generic ui action progress and shows the executed action summary', async () => {
    const data: AiUiActionsCardData = {
      surface: 'recipe_cook_page',
      recipeId: 'recipe-1',
      cookSessionId: 'cook-session-1',
      sessionRevision: 1,
      actions: [{ type: 'set_timer', timerId: 'timer-main', seconds: 300, name: '焖煮' }],
      requiresConfirmation: false,
    };
    const card: AiResultCard = {
      id: 'card-ui-action',
      type: 'ui_actions',
      title: '页面操作建议',
      data: { ...data },
    };
    actionCardHandler = () => ({
      status: 'executed',
      message: '页面操作已执行。',
      data,
    });
    vi.spyOn(api, 'streamChatAi').mockImplementation(async (_payload, handlers) => {
      handlers?.onProgress?.(progressEvent({
        id: 'ui-progress',
        internal_code: 'ui.propose_actions',
        user_message: '调用「页面操作建议」',
      }));
      handlers?.onMessagePart?.({
        message_id: 'message-1',
        conversation_id: 'conversation-1',
        run_id: 'run-1',
        part: { id: 'part-ui-action', type: 'result_card', card },
      });
      handlers?.onMessageDelta?.({ delta: '好了，5 分钟倒计时开始了。' });
      return chatResponse('好了，5 分钟倒计时开始了。');
    });

    renderProbe();

    await act(async () => {
      await latest?.sendMessage('帮我计时');
    });

    const messageText = JSON.stringify(latest?.messages ?? []);
    expect(messageText).toContain('设置 05:00 倒计时');
    expect(messageText).toContain('已执行');
    expect(messageText).not.toContain('工具调用');
    expect(messageText).not.toContain('页面操作建议');
  });

  it('marks the reply complete when the final response arrives before the stream closes', async () => {
    let releaseStream = () => {};
    vi.spyOn(api, 'streamChatAi').mockImplementation(async (_payload, handlers) => {
      handlers?.onMessageDelta?.({ delta: '在呢。' });
      handlers?.onResponse?.(chatResponse('在呢。'));
      await new Promise<void>((resolve) => {
        releaseStream = resolve;
      });
      return chatResponse('在呢。');
    });

    renderProbe();

    let sendPromise: Promise<void> | undefined;
    await act(async () => {
      sendPromise = latest?.sendMessage('你好');
      await Promise.resolve();
    });

    expect(latest?.isSending).toBe(false);
    expect(latest?.messages.at(-1)?.text).toBe('在呢。');

    releaseStream?.();
    await act(async () => {
      await sendPromise;
    });
  });
});
