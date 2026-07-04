import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/client';
import type { AiChatResponse, AiResultCard, AiRunEvent, AiUiActionsCardData } from '../../api/types';
import type { CookingAssistantActionResult } from './cookingAssistantModel';
import { useCookingAssistantStream, type CookingAssistantMessage } from './useCookingAssistantStream';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type ProbeValue = {
  messages: CookingAssistantMessage[];
  isSending: boolean;
  sendMessage: (message: string) => Promise<void>;
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let latest: ProbeValue | null = null;
let actionCardHandler: (card: AiResultCard) => CookingAssistantActionResult | null = () => null;

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
  });

  useEffect(() => {
    latest = {
      messages: assistant.messages,
      isSending: assistant.isSending,
      sendMessage: assistant.sendMessage,
    };
  }, [assistant.isSending, assistant.messages, assistant.sendMessage]);

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
