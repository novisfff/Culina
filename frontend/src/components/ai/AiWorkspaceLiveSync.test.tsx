import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type { AiApprovalRequest, AiChatResponse, AiConversation, AiMessage, AiResultCard, AiRunEvent, AiTaskDraft } from '../../api/types';
import { cleanupTestDomAndMocks, flushAsync, renderWithQuery, waitForAsync } from '../../test/renderWithQuery';
import { AiWorkspace } from './AiWorkspace';
import { approval, conversation, mealPlanApproval, qualityMetrics } from './aiWorkspaceTestFixtures';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function changeInput(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  act(() => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const valueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    valueSetter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

afterEach(() => {
  cleanupTestDomAndMocks();
});

beforeEach(() => {
  vi.spyOn(api, 'getAiStatus').mockResolvedValue({
    enabled: true,
    provider: 'openai-compatible',
    model: 'fake-model',
    supports_vision: true,
    status: 'ready',
    detail: 'AI 已就绪。',
  });
  vi.spyOn(api, 'getAiQualityMetrics').mockResolvedValue(qualityMetrics());
  vi.spyOn(api, 'getFoods').mockResolvedValue([]);
  vi.spyOn(api, 'getIngredients').mockResolvedValue([]);
});

async function advanceTimers(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('AiWorkspace live sync and conversation migration', () => {
  it('keeps streamed local messages visible while the new conversation history query loads', async () => {
    vi.spyOn(api, 'getAiMessages').mockImplementation(() => new Promise(() => undefined));
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
    let streamedRunId = 'agent_run-client';
    vi.spyOn(api, 'streamChatAi').mockImplementation(async (payload) => {
      streamedRunId = payload.client_run_id ?? streamedRunId;
      return {
        conversation_id: 'conversation-new',
        message: {
          id: 'message-final-new',
          conversation_id: 'conversation-new',
          role: 'assistant',
          content: '已生成确认表单。',
          content_type: 'parts',
          parts: [{ id: 'part-final-new', type: 'text', text: '已生成确认表单。' }],
          run_id: streamedRunId,
          status: 'completed',
          metadata: {},
          created_at: '2026-05-30T00:00:00Z',
        },
        run: {
          id: streamedRunId,
          agent_key: 'meal_plan_agent',
          intent: 'meal_plan',
          status: 'completed',
          model: 'rules',
          created_at: '2026-05-30T00:00:00Z',
        },
        events: [],
        included: { result_cards: [], drafts: [], approvals: [] },
      };
    });
    const rendered = await renderWithQuery(<AiWorkspace conversations={[]} isLoading={false} />);
    await flushAsync();
    changeInput(rendered.container.querySelector<HTMLTextAreaElement>('textarea.text-input') as HTMLTextAreaElement, '安排三天晚餐');
    await act(async () => {
      rendered.container.querySelector<HTMLFormElement>('form.ai-composer')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flushAsync();
    const desktopView = rendered.container.querySelector('.ai-desktop-view') as HTMLElement;
    expect(desktopView.textContent).toContain('已生成确认表单。');
    expect(desktopView.textContent).not.toContain('正在加载消息...');
    rendered.unmount();
  });

  it('merges a pending local conversation into the server conversation before the stream settles', async () => {
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
    let streamedRunId = 'agent_run-client';
    vi.spyOn(api, 'streamChatAi').mockImplementation(async (payload, handlers) => {
      streamedRunId = payload.client_run_id ?? streamedRunId;
      handlers?.onMessageDelta?.({
        message_id: 'message-live-new',
        conversation_id: 'conversation-server-new',
        run_id: streamedRunId,
        part_id: 'part-live-new',
        delta: '你好，我正在整理。',
      });
      return new Promise<AiChatResponse>(() => undefined);
    });

    const rendered = await renderWithQuery(<AiWorkspace conversations={[]} isLoading={false} />);
    await flushAsync();
    changeInput(rendered.container.querySelector<HTMLTextAreaElement>('textarea.text-input') as HTMLTextAreaElement, '你好');
    await act(async () => {
      rendered.container.querySelector<HTMLFormElement>('form.ai-composer')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flushAsync();
    expect(rendered.container.querySelectorAll('.ai-desktop-view .ai-conversation-item')).toHaveLength(1);

    const serverConversation: AiConversation = {
      ...conversation(),
      id: 'conversation-server-new',
      prompt: '你好',
      title: '你好',
      response: '你好，我正在整理。',
      summary: '你好，我正在整理。',
      context: { activeRunId: streamedRunId },
      last_run_status: 'running',
      last_message_at: '2026-05-30T00:02:00Z',
    };
    await rendered.rerender(<AiWorkspace conversations={[serverConversation]} isLoading={false} />);
    await flushAsync();

    const desktopView = rendered.container.querySelector('.ai-desktop-view') as HTMLElement;
    const historyItems = Array.from(desktopView.querySelectorAll('.ai-conversation-item'));
    expect(historyItems).toHaveLength(1);
    expect(historyItems[0].textContent).toContain('你好');
    expect(historyItems[0].className).toContain('active');
    expect(historyItems[0].className).toContain('is-running');
    expect(desktopView.textContent).toContain('你好，我正在整理。');
    expect(desktopView.textContent).not.toContain('另一个会话正在后台回复');
    expect(desktopView.querySelector<HTMLButtonElement>('.ai-send-button')?.getAttribute('aria-label')).toBe('中止生成');
    rendered.unmount();
  });

  it('keeps appending streamed text after a pending conversation migrates to the server id', async () => {
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
    let emitSecondDelta: (() => void) | null = null;
    let streamedRunId = 'agent_run-client';
    vi.spyOn(api, 'streamChatAi').mockImplementation(async (payload, handlers) => {
      streamedRunId = payload.client_run_id ?? streamedRunId;
      handlers?.onMessageDelta?.({
        message_id: 'message-live-new',
        conversation_id: 'conversation-server-new',
        run_id: streamedRunId,
        part_id: 'part-live-new',
        delta: '配',
      });
      emitSecondDelta = () => {
        handlers?.onMessageDelta?.({
          message_id: 'message-live-new',
          conversation_id: 'conversation-server-new',
          run_id: streamedRunId,
          part_id: 'part-live-new',
          delta: '菜建议已经整理好了。',
        });
      };
      return new Promise<AiChatResponse>(() => undefined);
    });

    const rendered = await renderWithQuery(<AiWorkspace conversations={[]} isLoading={false} />);
    await flushAsync();
    changeInput(rendered.container.querySelector<HTMLTextAreaElement>('textarea.text-input') as HTMLTextAreaElement, '配菜');
    await act(async () => {
      rendered.container.querySelector<HTMLFormElement>('form.ai-composer')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flushAsync();
    expect((rendered.container.querySelector('.ai-desktop-view') as HTMLElement).textContent).toContain('配');

    const serverConversation: AiConversation = {
      ...conversation(),
      id: 'conversation-server-new',
      prompt: '配菜',
      title: '配菜',
      response: '配',
      summary: '配',
      context: { activeRunId: streamedRunId },
      last_run_status: 'running',
      last_message_at: '2026-05-30T00:02:00Z',
    };
    await rendered.rerender(<AiWorkspace conversations={[serverConversation]} isLoading={false} />);
    await flushAsync();
    await flushAsync();

    await act(async () => {
      emitSecondDelta?.();
    });
    await flushAsync();

    const desktopView = rendered.container.querySelector('.ai-desktop-view') as HTMLElement;
    expect(desktopView.textContent).toContain('配菜建议已经整理好了。');
    rendered.unmount();
  });

  it('replaces the migrated live assistant message when the final response arrives', async () => {
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
    let emitSecondDelta: (() => void) | null = null;
    let resolveStream: ((response: AiChatResponse) => void) | null = null;
    let streamedRunId = 'agent_run-client';
    vi.spyOn(api, 'streamChatAi').mockImplementation(async (payload, handlers) => {
      streamedRunId = payload.client_run_id ?? streamedRunId;
      handlers?.onMessageDelta?.({
        message_id: 'message-live-new',
        conversation_id: 'conversation-server-new',
        run_id: streamedRunId,
        part_id: 'part-live-new',
        delta: '你好，',
      });
      emitSecondDelta = () => {
        handlers?.onMessageDelta?.({
          message_id: 'message-live-new',
          conversation_id: 'conversation-server-new',
          run_id: streamedRunId,
          part_id: 'part-live-new',
          delta: '我是 Culina 的厨房助手。',
        });
      };
      return new Promise<AiChatResponse>((resolve) => {
        resolveStream = resolve;
      });
    });

    const rendered = await renderWithQuery(<AiWorkspace conversations={[]} isLoading={false} />);
    await flushAsync();
    changeInput(rendered.container.querySelector<HTMLTextAreaElement>('textarea.text-input') as HTMLTextAreaElement, '你好');
    await act(async () => {
      rendered.container.querySelector<HTMLFormElement>('form.ai-composer')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flushAsync();

    const serverConversation: AiConversation = {
      ...conversation(),
      id: 'conversation-server-new',
      prompt: '你好',
      title: '你好',
      response: '你好，',
      summary: '你好，',
      context: { activeRunId: streamedRunId },
      last_run_status: 'running',
      last_message_at: '2026-05-30T00:02:00Z',
    };
    await rendered.rerender(<AiWorkspace conversations={[serverConversation]} isLoading={false} />);
    await flushAsync();
    await act(async () => {
      emitSecondDelta?.();
    });
    await flushAsync();

    await act(async () => {
      resolveStream?.({
        conversation_id: 'conversation-server-new',
        message: {
          id: 'message-final-new',
          conversation_id: 'conversation-server-new',
          role: 'assistant',
          content: '你好，我是 Culina 的厨房助手。',
          content_type: 'parts',
          parts: [{ id: 'part-final-new', type: 'text', text: '你好，我是 Culina 的厨房助手。' }],
          run_id: streamedRunId,
          status: 'completed',
          metadata: {},
          created_at: '2026-05-30T00:02:01Z',
        },
        run: {
          id: streamedRunId,
          agent_key: 'general_chat_agent',
          intent: 'general_chat',
          status: 'completed',
          model: 'rules',
          created_at: '2026-05-30T00:02:00Z',
        },
        events: [],
        included: { result_cards: [], drafts: [], approvals: [] },
      });
    });
    await flushAsync();

    const assistantMessages = rendered.container.querySelectorAll('.ai-desktop-view .ai-message-assistant');
    expect(assistantMessages).toHaveLength(1);
    expect((assistantMessages[0] as HTMLElement).textContent).toContain('你好，我是 Culina 的厨房助手。');
    rendered.unmount();
  });

  it('keeps streamed replies attached to the original conversation after switching history', async () => {
    const otherConversation: AiConversation = {
      ...conversation(),
      id: 'conversation-2',
      prompt: '第二个会话',
      title: '第二个会话',
      last_message_at: '2026-05-30T00:01:00Z',
    };
    vi.spyOn(api, 'getAiMessages').mockImplementation(async (conversationId) => {
      if (conversationId === 'conversation-2') {
        return [
          {
            id: 'message-conversation-2',
            conversation_id: 'conversation-2',
            role: 'assistant',
            content: '这是第二个会话的历史消息。',
            content_type: 'parts',
            parts: [{ id: 'part-conversation-2', type: 'text', text: '这是第二个会话的历史消息。' }],
            run_id: 'run-conversation-2',
            status: 'completed',
            metadata: {},
            created_at: '2026-05-30T00:01:00Z',
          },
        ];
      }
      return [];
    });
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
    let emitDelta: (() => void) | null = null;
    let resolveStream: ((response: AiChatResponse) => void) | null = null;
    let streamedRunId = 'agent_run-client';
    vi.spyOn(api, 'streamChatAi').mockImplementation(async (payload, handlers) => {
      streamedRunId = payload.client_run_id ?? streamedRunId;
      emitDelta = () => {
        handlers?.onMessageDelta?.({
          message_id: 'message-streaming-original',
          conversation_id: 'conversation-1',
          run_id: streamedRunId,
          part_id: 'part-streaming-original',
          delta: '这是第一个会话的后台回复。',
        });
      };
      return new Promise<AiChatResponse>((resolve) => {
        resolveStream = resolve;
      });
    });

    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation(), otherConversation]} isLoading={false} />);
    await flushAsync();
    changeInput(rendered.container.querySelector<HTMLTextAreaElement>('textarea.text-input') as HTMLTextAreaElement, '安排三天晚餐');
    await act(async () => {
      rendered.container.querySelector<HTMLFormElement>('form.ai-composer')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flushAsync();

    const desktopHistoryButtons = () => Array.from(rendered.container.querySelectorAll<HTMLButtonElement>('.ai-desktop-view .ai-conversation-main'));
    await act(async () => {
      desktopHistoryButtons().find((button) => button.textContent?.includes('第二个会话'))?.click();
    });
    await flushAsync();
    await act(async () => {
      emitDelta?.();
    });
    await flushAsync();

    const desktopView = rendered.container.querySelector('.ai-desktop-view') as HTMLElement;
    expect(desktopView.textContent).toContain('这是第二个会话的历史消息。');
    expect(desktopView.textContent).not.toContain('这是第一个会话的后台回复。');
    expect(desktopView.querySelector('.ai-conversation-item.is-running .ai-history-spinner')).not.toBeNull();

    await act(async () => {
      desktopHistoryButtons().find((button) => button.textContent?.includes('帮我生成菜谱'))?.click();
    });
    await flushAsync();
    expect(desktopView.textContent).toContain('这是第一个会话的后台回复。');

    await act(async () => {
      resolveStream?.({
        conversation_id: 'conversation-1',
        message: {
          id: 'message-final-original',
          conversation_id: 'conversation-1',
          role: 'assistant',
          content: '这是第一个会话的后台回复。',
          content_type: 'parts',
          parts: [{ id: 'part-final-original', type: 'text', text: '这是第一个会话的后台回复。' }],
          run_id: streamedRunId,
          status: 'completed',
          metadata: {},
          created_at: '2026-05-30T00:00:00Z',
        },
        run: {
          id: streamedRunId,
          agent_key: 'meal_plan_agent',
          intent: 'meal_plan',
          status: 'completed',
          model: 'rules',
          created_at: '2026-05-30T00:00:00Z',
        },
        events: [],
        included: { result_cards: [], drafts: [], approvals: [] },
      });
    });
    await flushAsync();
    rendered.unmount();
  });

  it('shows a remote live reply for the same running conversation', async () => {
    const runningConversation: AiConversation = {
      ...conversation(),
      context: { activeRunId: 'run-live-remote' },
      last_run_status: 'running',
    };
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([
      {
        id: 'message-user-live',
        conversation_id: 'conversation-1',
        role: 'user',
        content: '今晚吃什么？',
        content_type: 'parts',
        parts: [{ id: 'part-user-live', type: 'text', text: '今晚吃什么？' }],
        status: 'completed',
        metadata: {},
        created_at: '2026-05-30T00:00:00Z',
      },
      {
        id: 'message-assistant-live',
        conversation_id: 'conversation-1',
        role: 'assistant',
        content: '我正在看库存，先考虑临期番茄。',
        content_type: 'parts',
        parts: [{ id: 'part-assistant-live', type: 'text', text: '我正在看库存，先考虑临期番茄。' }],
        run_id: 'run-live-remote',
        status: 'running',
        metadata: { liveStreaming: true },
        created_at: '2026-05-30T00:00:01Z',
      },
    ]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
    vi.spyOn(api, 'getAiRunEvents').mockResolvedValue([
      {
        id: 'event-live-remote',
        run_id: 'run-live-remote',
        type: 'skill',
        internal_code: 'meal_plan.start',
        user_message: '调用「餐食计划」技能',
        status: 'running',
        created_at: '2026-05-30T00:00:01Z',
      },
    ]);

    const rendered = await renderWithQuery(<AiWorkspace conversations={[runningConversation]} isLoading={false} />);
    await flushAsync();

    const desktopView = rendered.container.querySelector('.ai-desktop-view') as HTMLElement;
    expect(desktopView.textContent).toContain('我正在看库存，先考虑临期番茄。');
    expect(desktopView.querySelector('.ai-conversation-item.is-running .ai-history-spinner')).not.toBeNull();
    expect(desktopView.querySelector<HTMLButtonElement>('.ai-send-button')?.getAttribute('aria-label')).toBe('中止生成');
    rendered.unmount();
  });

  it('keeps server draft and result cards when a local stream copy has the same run id', async () => {
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
    let streamedRunId = '';
    vi.spyOn(api, 'streamChatAi').mockImplementation(async (payload, handlers) => {
      streamedRunId = payload.client_run_id ?? 'run-local-copy';
      handlers?.onMessageDelta?.({
        message_id: 'message-server-structural',
        conversation_id: 'conversation-1',
        run_id: streamedRunId,
        part_id: 'text-local-stream',
        delta: '我先整理菜谱草稿。',
      });
      return new Promise<AiChatResponse>(() => undefined);
    });

    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flushAsync();
    changeInput(rendered.container.querySelector<HTMLTextAreaElement>('textarea.text-input') as HTMLTextAreaElement, '帮我做一道番茄菜');
    await act(async () => {
      rendered.container.querySelector<HTMLFormElement>('form.ai-composer')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flushAsync();

    const pending = approval({
      id: 'approval-server-structural',
      message_id: 'message-server-structural',
      run_id: streamedRunId,
      draft_id: 'draft-server-structural',
    });
    const draft: AiTaskDraft = {
      id: 'draft-server-structural',
      conversation_id: 'conversation-1',
      message_id: 'message-server-structural',
      run_id: streamedRunId,
      draft_type: 'recipe',
      payload: pending.initial_values.recipe ?? {},
      preview_summary: '番茄菜谱草稿',
      status: 'pending',
      version: 1,
      schema_version: 'recipe.v1',
      validation_errors: [],
      expires_at: null,
      created_at: '2026-05-30T00:00:00Z',
      updated_at: '2026-05-30T00:00:00Z',
    };
    rendered.queryClient.setQueryData<AiMessage[]>(queryKeys.aiMessages('conversation-1'), [
      {
        id: 'message-server-structural',
        conversation_id: 'conversation-1',
        role: 'assistant',
        content: '我先整理菜谱草稿。',
        content_type: 'parts',
        parts: [
          { id: 'text-server-structural', type: 'text', text: '我先整理菜谱草稿。' },
          { id: 'draft-part-server-structural', type: 'draft', draft },
          { id: 'approval-part-server-structural', type: 'approval_request', approval: pending },
          {
            id: 'result-part-server-structural',
            type: 'result_card',
            card: {
              id: 'result-card-server-structural',
              type: 'operation_result',
              title: '已创建菜谱',
              data: {
                actionSummary: '番茄菜谱已写入菜谱库。',
                entityCount: 1,
                entityCountLabel: '1 道菜谱',
                workspaceLabel: '菜谱库',
              },
            } as AiResultCard,
          },
        ],
        run_id: streamedRunId,
        status: 'waiting_approval',
        metadata: {},
        created_at: '2026-05-30T00:00:00Z',
      },
    ]);
    await flushAsync();

    const desktopView = rendered.container.querySelector('.ai-desktop-view') as HTMLElement;
    const mobileView = rendered.container.querySelector('.ai-mobile-page') as HTMLElement;
    expect(desktopView.textContent).toContain('确认创建菜谱');
    expect(desktopView.textContent).toContain('已创建菜谱');
    expect(mobileView.textContent).toContain('确认创建菜谱');
    expect(mobileView.textContent).toContain('已创建菜谱');
    rendered.unmount();
  });

  it('does not pause an idle conversation because another remote conversation is running', async () => {
    const idleConversation = conversation();
    const runningConversation: AiConversation = {
      ...conversation(),
      id: 'conversation-running-remote',
      prompt: '后台会话',
      title: '后台会话',
      context: { activeRunId: 'run-remote-other' },
      last_run_status: 'running',
      last_message_at: '2026-05-30T00:02:00Z',
    };
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);

    const rendered = await renderWithQuery(<AiWorkspace conversations={[idleConversation, runningConversation]} isLoading={false} />);
    await flushAsync();

    const desktopView = rendered.container.querySelector('.ai-desktop-view') as HTMLElement;
    expect(desktopView.querySelector('.ai-conversation-item.is-running .ai-history-spinner')).not.toBeNull();
    const input = desktopView.querySelector<HTMLTextAreaElement>('textarea.text-input') as HTMLTextAreaElement;
    expect(input.disabled).toBe(false);
    changeInput(input, '当前会话继续问一个问题');
    await flushAsync();
    const sendButton = desktopView.querySelector<HTMLButtonElement>('.ai-send-button') as HTMLButtonElement;
    expect(sendButton.getAttribute('aria-label')).toBe('发送消息');
    expect(sendButton.disabled).toBe(false);
    expect(desktopView.textContent).not.toContain('另一个会话正在后台回复');
    rendered.unmount();
  });

  it('marks waiting conversations with the confirmation icon in history', async () => {
    const waitingApprovalConversation: AiConversation = {
      ...conversation(),
      id: 'conversation-waiting-approval',
      title: '等待确认餐食计划',
      prompt: '安排三天晚餐',
      last_run_status: 'waiting_approval',
      last_message_at: '2026-05-30T00:02:00Z',
    };
    const waitingInputConversation: AiConversation = {
      ...conversation(),
      id: 'conversation-waiting-input',
      title: '等待补充信息',
      prompt: '帮我调整购物清单',
      last_run_status: 'waiting_input',
      last_message_at: '2026-05-30T00:01:00Z',
    };
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);

    const rendered = await renderWithQuery(
      <AiWorkspace conversations={[waitingApprovalConversation, waitingInputConversation]} isLoading={false} />,
    );
    await flushAsync();

    const desktopView = rendered.container.querySelector('.ai-desktop-view') as HTMLElement;
    expect(desktopView.querySelectorAll('.ai-conversation-item.is-waiting .ai-history-waiting-icon')).toHaveLength(2);
    expect(desktopView.querySelectorAll('.ai-conversation-item.is-waiting .ai-history-spinner')).toHaveLength(0);
    expect(desktopView.querySelectorAll('.ai-conversation-item.is-running')).toHaveLength(0);
    expect(desktopView.textContent).toContain('等待确认餐食计划');
    expect(desktopView.textContent).toContain('等待补充信息');
    rendered.unmount();
  });

  it('does not mark a completed conversation as running when activeRunId is stale', async () => {
    const completedConversationWithStaleRun: AiConversation = {
      ...conversation(),
      id: 'conversation-completed-stale-run',
      title: '帮我新增一个食材',
      prompt: '帮我新增一个食材',
      response: '已完成处理。',
      summary: '已完成处理。',
      context: { activeRunId: 'agent_run-stale-completed' },
      last_run_status: 'completed',
      last_message_at: '2026-05-30T00:02:00Z',
    };
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
    vi.spyOn(api, 'getAiRunEvents').mockResolvedValue([]);

    const rendered = await renderWithQuery(<AiWorkspace conversations={[completedConversationWithStaleRun]} isLoading={false} />);
    await flushAsync();

    const desktopView = rendered.container.querySelector('.ai-desktop-view') as HTMLElement;
    expect(desktopView.querySelectorAll('.ai-conversation-item.is-running')).toHaveLength(0);
    expect(desktopView.querySelectorAll('.ai-history-spinner')).toHaveLength(0);
    expect(api.getAiRunEvents).not.toHaveBeenCalled();
    rendered.unmount();
  });

  it('shows included approvals immediately when the streamed response settles', async () => {
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([]);
    const pendingApprovalsSpy = vi
      .spyOn(api, 'getPendingAiApprovals')
      .mockResolvedValueOnce([])
      .mockImplementation(() => new Promise<AiApprovalRequest[]>(() => undefined));
    let resolveStream: ((response: AiChatResponse) => void) | null = null;
    let streamedRunId = 'agent_run-client';
    vi.spyOn(api, 'streamChatAi').mockImplementation(async (payload, handlers) => {
      streamedRunId = payload.client_run_id ?? streamedRunId;
      handlers?.onProgress?.({
        id: 'progress-skill',
        run_id: streamedRunId,
        type: 'skill',
        internal_code: 'meal_plan.start',
        user_message: '调用「餐食计划」技能',
        status: 'running',
        created_at: '2026-05-30T00:00:00Z',
      });
      return new Promise<AiChatResponse>((resolve) => {
        resolveStream = resolve;
      });
    });
    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flushAsync();
    changeInput(rendered.container.querySelector<HTMLTextAreaElement>('textarea.text-input') as HTMLTextAreaElement, '安排三天晚餐');
    await act(async () => {
      rendered.container.querySelector<HTMLFormElement>('form.ai-composer')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flushAsync();
    expect(rendered.container.textContent).not.toContain('确认创建菜谱');
    await act(async () => {
      resolveStream?.({
        conversation_id: 'conversation-1',
        message: {
          id: 'message-final',
          conversation_id: 'conversation-1',
          role: 'assistant',
          content: '已生成确认表单。',
          content_type: 'parts',
          parts: [{ id: 'part-final', type: 'text', text: '已生成确认表单。' }],
          run_id: streamedRunId,
          status: 'completed',
          metadata: {},
          created_at: '2026-05-30T00:00:00Z',
        },
        run: {
          id: streamedRunId,
          agent_key: 'meal_plan_agent',
          intent: 'meal_plan',
          status: 'completed',
          model: 'rules',
          created_at: '2026-05-30T00:00:00Z',
        },
        events: [],
        included: {
          result_cards: [],
          drafts: [],
          approvals: [
            approval({
              id: 'approval-streamed',
              message_id: 'message-final',
              run_id: streamedRunId,
              title: '确认创建菜谱',
            }),
          ],
        },
      });
    });
    await flushAsync();
    expect(rendered.container.textContent).toContain('已生成确认表单。');
    expect(rendered.container.textContent).toContain('确认创建菜谱');
    expect(pendingApprovalsSpy).toHaveBeenCalled();
    rendered.unmount();
  });

  it('keeps streamed approvals locked until the draft stream settles', async () => {
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
    let resolveStream: ((response: AiChatResponse) => void) | null = null;
    let streamedRunId = 'agent_run-client';
    const pending = approval({
      id: 'approval-streamed-before-final',
      message_id: 'message-streamed-before-final',
      run_id: streamedRunId,
      title: '确认创建菜谱',
    });
    const streamDecisionSpy = vi.spyOn(api, 'streamAiApprovalDecision').mockResolvedValue({
      conversation_id: 'conversation-1',
      message: {
        id: 'message-streamed-before-final',
        conversation_id: 'conversation-1',
        role: 'assistant',
        content: '已创建菜谱。',
        content_type: 'parts',
        parts: [
          {
            id: 'approval-part-streamed-before-final',
            type: 'approval_request',
            approval: { ...pending, status: 'approved', decision: 'approved', submitted_values: pending.initial_values },
          },
          { id: 'text-after-approval', type: 'text', text: '已创建菜谱。' },
        ],
        run_id: streamedRunId,
        status: 'completed',
        metadata: {},
        created_at: '2026-05-30T00:00:00Z',
      },
      run: {
        id: streamedRunId,
        agent_key: 'recipe_draft_agent',
        intent: 'recipe_draft',
        status: 'completed',
        model: 'rules',
        created_at: '2026-05-30T00:00:00Z',
      },
      events: [],
      included: { result_cards: [], drafts: [], approvals: [] },
    });
    vi.spyOn(api, 'streamChatAi').mockImplementation(async (payload, handlers) => {
      streamedRunId = payload.client_run_id ?? streamedRunId;
      pending.run_id = streamedRunId;
      handlers?.onMessageDelta?.({
        message_id: 'message-streamed-before-final',
        conversation_id: 'conversation-1',
        run_id: streamedRunId,
        part_id: 'text-before-approval',
        delta: '已生成确认表单。',
      });
      handlers?.onMessagePart?.({
        message_id: 'message-streamed-before-final',
        conversation_id: 'conversation-1',
        run_id: streamedRunId,
        part: {
          id: 'approval-part-streamed-before-final',
          type: 'approval_request',
          approval: pending,
        },
      });
      return new Promise<AiChatResponse>((resolve) => {
        resolveStream = resolve;
      });
    });

    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flushAsync();
    changeInput(rendered.container.querySelector<HTMLTextAreaElement>('textarea.text-input') as HTMLTextAreaElement, '生成番茄菜谱');
    await act(async () => {
      rendered.container.querySelector<HTMLFormElement>('form.ai-composer')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flushAsync();

    const desktopView = rendered.container.querySelector('.ai-desktop-view') as HTMLElement;
    expect(desktopView.textContent).toContain('确认创建菜谱');
    expect(desktopView.textContent).toContain('确认入口正在准备，稍后即可确认。');
    expect(desktopView.querySelector('.ai-approval-actions .solid-button')).toBeNull();
    expect(desktopView.querySelector('.ai-conversation-item.is-waiting .ai-history-waiting-icon')).not.toBeNull();
    expect(desktopView.querySelector('.ai-conversation-item.is-waiting .ai-history-spinner')).toBeNull();
    expect(streamDecisionSpy).not.toHaveBeenCalled();

    await act(async () => {
      resolveStream?.({
        conversation_id: 'conversation-1',
        message: {
          id: 'message-streamed-before-final',
          conversation_id: 'conversation-1',
          role: 'assistant',
          content: '已生成确认表单。',
          content_type: 'parts',
          parts: [
            { id: 'text-before-approval', type: 'text', text: '已生成确认表单。' },
            { id: 'approval-part-streamed-before-final', type: 'approval_request', approval: pending },
          ],
          run_id: streamedRunId,
          status: 'waiting_approval',
          metadata: {},
          created_at: '2026-05-30T00:00:00Z',
        },
        run: {
          id: streamedRunId,
          agent_key: 'recipe_draft_agent',
          intent: 'recipe_draft',
          status: 'waiting_approval',
          model: 'rules',
          created_at: '2026-05-30T00:00:00Z',
        },
        events: [],
        included: { result_cards: [], drafts: [], approvals: [pending] },
      });
    });
    await flushAsync();

    expect(desktopView.textContent).not.toContain('确认入口正在准备，稍后即可确认。');
    await act(async () => {
      desktopView.querySelector<HTMLButtonElement>('.ai-approval-actions .solid-button')?.click();
    });
    await flushAsync();
    expect(streamDecisionSpy).toHaveBeenCalled();
    rendered.unmount();
  });

  it('keeps streamed draft approval parts when the final response includes activity parts', async () => {
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
    let resolveStream: ((response: AiChatResponse) => void) | null = null;
    let streamedRunId = 'agent_run-client';
    vi.spyOn(api, 'streamChatAi').mockImplementation(async (payload, handlers) => {
      streamedRunId = payload.client_run_id ?? streamedRunId;
      const draft: AiTaskDraft = {
        id: 'draft-progressive-meal',
        conversation_id: payload.conversation_id ?? 'conversation-1',
        message_id: 'message-progressive',
        run_id: streamedRunId,
        draft_type: 'meal_plan',
        payload: {
          draftType: 'meal_plan',
          schemaVersion: 'meal_plan.v1',
          items: [{ date: '2026-06-10', mealType: 'dinner', title: '番茄炒蛋' }],
        },
        preview_summary: '2026-06-10 晚餐：番茄炒蛋',
        status: 'pending',
        version: 1,
        schema_version: 'meal_plan.v1',
        validation_errors: [],
        expires_at: null,
        created_at: '2026-05-30T00:00:00Z',
        updated_at: '2026-05-30T00:00:00Z',
      };
      const progressiveApproval = mealPlanApproval();
      handlers?.onMessagePart?.({
        message_id: 'message-progressive',
        conversation_id: payload.conversation_id ?? 'conversation-1',
        run_id: streamedRunId,
        part: { id: 'draft-part-progressive-meal', type: 'draft', draft },
      });
      handlers?.onMessagePart?.({
        message_id: 'message-progressive',
        conversation_id: payload.conversation_id ?? 'conversation-1',
        run_id: streamedRunId,
        part: {
          id: 'approval-part-progressive-meal',
          type: 'approval_request',
          approval: {
            ...progressiveApproval,
            id: 'approval-progressive-meal',
            message_id: 'message-progressive',
            run_id: streamedRunId,
            draft_id: draft.id,
          },
        },
      });
      return new Promise<AiChatResponse>((resolve) => {
        resolveStream = resolve;
      });
    });
    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flushAsync();
    changeInput(rendered.container.querySelector<HTMLTextAreaElement>('textarea.text-input') as HTMLTextAreaElement, '安排三天晚餐');
    await act(async () => {
      rendered.container.querySelector<HTMLFormElement>('form.ai-composer')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flushAsync();
    expect(rendered.container.textContent).toContain('确认创建餐食计划');
    await act(async () => {
      resolveStream?.({
        conversation_id: 'conversation-1',
        message: {
          id: 'message-final',
          conversation_id: 'conversation-1',
          role: 'assistant',
          content: '我已生成第一版餐食计划草稿。',
          content_type: 'parts',
          parts: [
            {
              id: 'activity-progressive-final',
              type: 'run_activity',
              activity: {
                id: 'event-progressive-final',
                run_id: streamedRunId,
                type: 'tool',
                internal_code: 'meal_plan.create_draft',
                user_message: '生成「餐食计划草稿」',
                status: 'completed',
                created_at: '2026-05-30T00:00:00Z',
              },
            },
            { id: 'part-final-progressive', type: 'text', text: '我已生成第一版餐食计划草稿。' },
          ],
          run_id: streamedRunId,
          status: 'waiting_approval',
          metadata: {},
          created_at: '2026-05-30T00:00:00Z',
        },
        run: {
          id: streamedRunId,
          agent_key: 'meal_plan_agent',
          intent: 'meal_plan',
          status: 'waiting_approval',
          model: 'rules',
          created_at: '2026-05-30T00:00:00Z',
        },
        events: [],
        included: { result_cards: [], drafts: [], approvals: [] },
      });
    });
    await flushAsync();
    expect(rendered.container.querySelectorAll('.ai-desktop-view .ai-message-assistant')).toHaveLength(1);
    expect(rendered.container.textContent).toContain('我已生成第一版餐食计划草稿。');
    expect(rendered.container.textContent).toContain('确认创建餐食计划');
    expect(rendered.container.querySelectorAll('.ai-desktop-view .ai-approval-panel')).toHaveLength(1);
    rendered.unmount();
  });

  it('shows feedback when inventory operation draft creation fails', async () => {
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([
      {
        id: 'message-inventory',
        conversation_id: 'conversation-1',
        role: 'assistant',
        content: '',
        content_type: 'parts',
        parts: [
          {
            id: 'part-inventory',
            type: 'result_card',
            card: {
              id: 'card-inventory',
              type: 'inventory_summary',
              title: '临期库存',
              data: {
                queryFocus: 'expiring',
                availableCount: 1,
                expiringCount: 1,
                expiredCount: 0,
                lowStockCount: 0,
                foodStockCount: 0,
                items: [
                  {
                    id: 'inventory-tomato',
                    sourceType: 'ingredient',
                    ingredientId: 'ingredient-tomato',
                    foodId: null,
                    inventoryItemId: 'inventory-tomato',
                    name: '番茄',
                    quantity: '2',
                    unit: '个',
                    quantityTrackingMode: 'track_quantity',
                    status: 'fresh',
                    displayStatus: 'expiring',
                    expiryDate: '2026-06-16',
                    suggestedAction: 'dispose',
                  },
                ],
              },
            },
          },
        ],
        run_id: 'run-inventory',
        status: 'completed',
        metadata: {},
        created_at: '2026-05-30T00:00:00Z',
      },
    ]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
    vi.spyOn(api, 'createAiInventoryOperationDraft').mockRejectedValue(new Error('库存批次已变化'));

    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flushAsync();
    const disposeButton = Array.from(rendered.container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === '销毁');
    await act(async () => disposeButton?.click());
    await flushAsync();

    expect(rendered.container.textContent).toContain('番茄的销毁草稿生成失败：库存批次已变化');
    rendered.unmount();
  });

  it('renders streamed assistant text before the final response arrives', async () => {
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
    let resolveStream: ((response: AiChatResponse) => void) | null = null;
    let streamedRunId = 'agent_run-client';
    vi.spyOn(api, 'streamChatAi').mockImplementation(async (payload, handlers) => {
      streamedRunId = payload.client_run_id ?? streamedRunId;
      handlers?.onMessageDelta?.({
        message_id: 'message-streaming',
        conversation_id: payload.conversation_id ?? 'conversation-1',
        run_id: payload.client_run_id,
        part_id: 'part-streaming',
        delta: '先推荐番茄鸡蛋面',
      });
      return new Promise<AiChatResponse>((resolve) => {
        resolveStream = resolve;
      });
    });
    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flushAsync();
    changeInput(rendered.container.querySelector<HTMLTextAreaElement>('textarea.text-input') as HTMLTextAreaElement, '今日吃什么？');
    await act(async () => {
      rendered.container.querySelector<HTMLFormElement>('form.ai-composer')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flushAsync();
    expect(rendered.container.textContent).toContain('先推荐番茄鸡蛋面');
    await act(async () => {
      resolveStream?.({
        conversation_id: 'conversation-1',
        message: {
          id: 'message-final',
          conversation_id: 'conversation-1',
          role: 'assistant',
          content: '先推荐番茄鸡蛋面',
          content_type: 'parts',
          parts: [{ id: 'part-final', type: 'text', text: '先推荐番茄鸡蛋面' }],
          run_id: streamedRunId,
          status: 'completed',
          metadata: {},
          created_at: '2026-05-30T00:00:00Z',
        },
        run: {
          id: streamedRunId,
          agent_key: 'meal_plan_agent',
          intent: 'meal_plan',
          status: 'completed',
          model: 'rules',
          created_at: '2026-05-30T00:00:00Z',
        },
        events: [],
        included: { result_cards: [], drafts: [], approvals: [] },
      });
    });
    await flushAsync();
    rendered.unmount();
  });

  it('deduplicates a completed remote reply against a local live stream copy with the same run id', async () => {
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
    let streamedRunId = 'agent_run-client';
    vi.spyOn(api, 'streamChatAi').mockImplementation(async (payload, handlers) => {
      streamedRunId = payload.client_run_id ?? streamedRunId;
      handlers?.onMessageDelta?.({
        message_id: 'message-live-race',
        conversation_id: payload.conversation_id ?? 'conversation-1',
        run_id: streamedRunId,
        part_id: 'part-live-race',
        delta: '建议今晚做番茄鸡蛋面。',
      });
      return new Promise<AiChatResponse>(() => undefined);
    });

    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flushAsync();
    changeInput(rendered.container.querySelector<HTMLTextAreaElement>('textarea.text-input') as HTMLTextAreaElement, '今晚吃什么？');
    await act(async () => {
      rendered.container.querySelector<HTMLFormElement>('form.ai-composer')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flushAsync();

    await act(async () => {
      rendered.queryClient.setQueryData(queryKeys.aiMessages('conversation-1'), [
        {
          id: 'message-final-race',
          conversation_id: 'conversation-1',
          role: 'assistant',
          content: '建议今晚做番茄鸡蛋面。',
          content_type: 'parts',
          parts: [{ id: 'part-final-race', type: 'text', text: '建议今晚做番茄鸡蛋面。' }],
          run_id: streamedRunId,
          status: 'completed',
          metadata: {},
          created_at: '2026-05-30T00:00:01Z',
        },
      ]);
    });
    await flushAsync();

    const assistantMessages = rendered.container.querySelectorAll('.ai-desktop-view .ai-message-assistant');
    expect(assistantMessages).toHaveLength(1);
    expect((assistantMessages[0] as HTMLElement).textContent).toContain('建议今晚做番茄鸡蛋面。');
    rendered.unmount();
  });

  it('deduplicates a running remote live reply against a local stream copy with the same run id', async () => {
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
    let streamedRunId = 'agent_run-client';
    vi.spyOn(api, 'streamChatAi').mockImplementation(async (payload, handlers) => {
      streamedRunId = payload.client_run_id ?? streamedRunId;
      handlers?.onMessageDelta?.({
        message_id: 'message-live-running',
        conversation_id: payload.conversation_id ?? 'conversation-1',
        run_id: streamedRunId,
        part_id: 'part-live-running',
        delta: '我正在生成食材档案草稿。',
      });
      return new Promise<AiChatResponse>(() => undefined);
    });

    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flushAsync();
    changeInput(rendered.container.querySelector<HTMLTextAreaElement>('textarea.text-input') as HTMLTextAreaElement, '创建秋葵食材档案');
    await act(async () => {
      rendered.container.querySelector<HTMLFormElement>('form.ai-composer')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flushAsync();

    await act(async () => {
      rendered.queryClient.setQueryData(queryKeys.aiMessages('conversation-1'), [
        {
          id: 'message-live-running',
          conversation_id: 'conversation-1',
          role: 'assistant',
          content: '我正在生成食材档案草稿。',
          content_type: 'parts',
          parts: [{ id: 'part-live-running', type: 'text', text: '我正在生成食材档案草稿。' }],
          run_id: streamedRunId,
          status: 'running',
          metadata: { liveStreaming: true },
          created_at: '2026-05-30T00:00:01Z',
        },
      ]);
    });
    await flushAsync();

    const assistantMessages = rendered.container.querySelectorAll('.ai-desktop-view .ai-message-assistant');
    expect(assistantMessages).toHaveLength(1);
    expect((assistantMessages[0] as HTMLElement).textContent).toContain('我正在生成食材档案草稿。');
    rendered.unmount();
  });

  it('starts streamed assistant text on a new paragraph after progress events', async () => {
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
    let resolveStream: ((response: AiChatResponse) => void) | null = null;
    let streamedRunId = 'agent_run-client';
    vi.spyOn(api, 'streamChatAi').mockImplementation(async (payload, handlers) => {
      streamedRunId = payload.client_run_id ?? streamedRunId;
      handlers?.onMessageDelta?.({
        message_id: 'message-streaming',
        conversation_id: payload.conversation_id ?? 'conversation-1',
        run_id: streamedRunId,
        part_id: 'part-streaming',
        delta: '我先查一下库存。',
      });
      handlers?.onProgress?.({
        id: 'progress-tool',
        run_id: streamedRunId,
        type: 'tool',
        internal_code: 'inventory.read_available_items',
        user_message: '调用「可用库存」',
        status: 'completed',
        created_at: '2026-05-30T00:00:00Z',
      });
      handlers?.onMessagePart?.({
        message_id: 'message-streaming',
        conversation_id: payload.conversation_id ?? 'conversation-1',
        run_id: streamedRunId,
        part: {
          id: 'activity-progress-tool',
          type: 'run_activity',
          activity: {
            id: 'progress-tool',
            run_id: streamedRunId,
            type: 'tool',
            internal_code: 'inventory.read_available_items',
            user_message: '调用「可用库存」',
            status: 'completed',
            created_at: '2026-05-30T00:00:00Z',
          },
        },
      });
      handlers?.onMessageDelta?.({
        message_id: 'message-streaming',
        conversation_id: payload.conversation_id ?? 'conversation-1',
        run_id: streamedRunId,
        part_id: 'part-streaming-after-progress',
        delta: '库存看完了，',
      });
      handlers?.onMessageDelta?.({
        message_id: 'message-streaming',
        conversation_id: payload.conversation_id ?? 'conversation-1',
        run_id: streamedRunId,
        part_id: 'part-streaming-after-progress',
        delta: '推荐番茄鸡蛋面。',
      });
      return new Promise<AiChatResponse>((resolve) => {
        resolveStream = resolve;
      });
    });
    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flushAsync();
    changeInput(rendered.container.querySelector<HTMLTextAreaElement>('textarea.text-input') as HTMLTextAreaElement, '今日吃什么？');
    await act(async () => {
      rendered.container.querySelector<HTMLFormElement>('form.ai-composer')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flushAsync();
    const messageBody = rendered.container.querySelector('.ai-desktop-view .ai-message-assistant .ai-message-body') as HTMLElement;
    const markdownBlocks = Array.from(messageBody.querySelectorAll<HTMLElement>('.ai-message-markdown'));
    const paragraphs = markdownBlocks.flatMap((block) => Array.from(block.querySelectorAll('p')).map((item) => item.textContent));
    expect(paragraphs).toEqual(['我先查一下库存。', '库存看完了，推荐番茄鸡蛋面。']);
    const activity = messageBody.querySelector('.ai-run-activity') as HTMLElement;
    expect(markdownBlocks[0]?.compareDocumentPosition(activity) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(activity.compareDocumentPosition(markdownBlocks[1] as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await act(async () => {
      resolveStream?.({
        conversation_id: 'conversation-1',
        message: {
          id: 'message-final',
          conversation_id: 'conversation-1',
          role: 'assistant',
          content: '我先查一下库存。\n\n库存看完了，推荐番茄鸡蛋面。',
          content_type: 'parts',
          parts: [{ id: 'part-final', type: 'text', text: '我先查一下库存。\n\n库存看完了，推荐番茄鸡蛋面。' }],
          run_id: streamedRunId,
          status: 'completed',
          metadata: {},
          created_at: '2026-05-30T00:00:00Z',
        },
        run: {
          id: streamedRunId,
          agent_key: 'meal_plan_agent',
          intent: 'meal_plan',
          status: 'completed',
          model: 'rules',
          created_at: '2026-05-30T00:00:00Z',
        },
        events: [],
        included: { result_cards: [], drafts: [], approvals: [] },
      });
    });
    await flushAsync();
    rendered.unmount();
  });

  it('keeps streamed text after progress events below the inline activity', async () => {
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
    let resolveStream: ((response: AiChatResponse) => void) | null = null;
    let streamedRunId = 'agent_run-client';
    vi.spyOn(api, 'streamChatAi').mockImplementation(async (payload, handlers) => {
      streamedRunId = payload.client_run_id ?? streamedRunId;
      handlers?.onMessageDelta?.({
        message_id: 'message-streaming-fragment',
        conversation_id: payload.conversation_id ?? 'conversation-1',
        run_id: streamedRunId,
        part_id: 'part-streaming-fragment',
        delta: '我查',
      });
      handlers?.onProgress?.({
        id: 'progress-tool-fragment',
        run_id: streamedRunId,
        type: 'tool',
        internal_code: 'inventory.read_available_items',
        user_message: '调用「可用库存」',
        status: 'completed',
        created_at: '2026-05-30T00:00:00Z',
      });
      handlers?.onMessagePart?.({
        message_id: 'message-streaming-fragment',
        conversation_id: payload.conversation_id ?? 'conversation-1',
        run_id: streamedRunId,
        part: {
          id: 'activity-progress-tool-fragment',
          type: 'run_activity',
          activity: {
            id: 'progress-tool-fragment',
            run_id: streamedRunId,
            type: 'tool',
            internal_code: 'inventory.read_available_items',
            user_message: '调用「可用库存」',
            status: 'completed',
            created_at: '2026-05-30T00:00:00Z',
          },
        },
      });
      handlers?.onMessageDelta?.({
        message_id: 'message-streaming-fragment',
        conversation_id: payload.conversation_id ?? 'conversation-1',
        run_id: streamedRunId,
        part_id: 'part-streaming-fragment-after-progress',
        delta: '到当前显示已过期的有 3 项。',
      });
      return new Promise<AiChatResponse>((resolve) => {
        resolveStream = resolve;
      });
    });
    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flushAsync();
    changeInput(rendered.container.querySelector<HTMLTextAreaElement>('textarea.text-input') as HTMLTextAreaElement, '检查过期库存');
    await act(async () => {
      rendered.container.querySelector<HTMLFormElement>('form.ai-composer')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flushAsync();
    const messageBody = rendered.container.querySelector('.ai-desktop-view .ai-message-assistant .ai-message-body') as HTMLElement;
    const markdownBlocks = Array.from(messageBody.querySelectorAll<HTMLElement>('.ai-message-markdown'));
    const paragraphs = markdownBlocks.flatMap((block) => Array.from(block.querySelectorAll('p')).map((item) => item.textContent));
    expect(paragraphs).toEqual(['我查', '到当前显示已过期的有 3 项。']);
    const activity = messageBody.querySelector('.ai-run-activity') as HTMLElement;
    expect(markdownBlocks[0]?.compareDocumentPosition(activity) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(activity.compareDocumentPosition(markdownBlocks[1] as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await act(async () => {
      resolveStream?.({
        conversation_id: 'conversation-1',
        message: {
          id: 'message-final-fragment',
          conversation_id: 'conversation-1',
          role: 'assistant',
          content: '我查到当前显示已过期的有 3 项。',
          content_type: 'parts',
          parts: [{ id: 'part-final-fragment', type: 'text', text: '我查到当前显示已过期的有 3 项。' }],
          run_id: streamedRunId,
          status: 'completed',
          metadata: {},
          created_at: '2026-05-30T00:00:00Z',
        },
        run: {
          id: streamedRunId,
          agent_key: 'inventory_analysis_agent',
          intent: 'inventory_analysis',
          status: 'completed',
          model: 'rules',
          created_at: '2026-05-30T00:00:00Z',
        },
        events: [],
        included: { result_cards: [], drafts: [], approvals: [] },
      });
    });
    await flushAsync();
    rendered.unmount();
  });

  it('keeps local streaming part order when a remote live snapshot has older activity order', async () => {
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
    let streamedRunId = 'agent_run-client';
    vi.spyOn(api, 'streamChatAi').mockImplementation(async (payload, handlers) => {
      streamedRunId = payload.client_run_id ?? streamedRunId;
      handlers?.onMessageDelta?.({
        message_id: 'message-live-order',
        conversation_id: payload.conversation_id ?? 'conversation-1',
        run_id: streamedRunId,
        part_id: 'part-live-order-text',
        delta: '我先把“白切鸡”整理成菜谱草稿。',
      });
      handlers?.onMessagePart?.({
        message_id: 'message-live-order',
        conversation_id: payload.conversation_id ?? 'conversation-1',
        run_id: streamedRunId,
        part: {
          id: 'activity-script-running-new',
          type: 'run_activity',
          activity: {
            id: 'script-running-new',
            run_id: streamedRunId,
            type: 'script',
            internal_code: 'script.lint_recipe_draft',
            user_message: '调用脚本「lint_recipe_draft」',
            status: 'running',
            created_at: '2026-05-30T00:00:02Z',
          },
        },
      });
      return new Promise<AiChatResponse>(() => undefined);
    });

    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flushAsync();
    changeInput(rendered.container.querySelector<HTMLTextAreaElement>('textarea.text-input') as HTMLTextAreaElement, '生成白切鸡菜谱');
    await act(async () => {
      rendered.container.querySelector<HTMLFormElement>('form.ai-composer')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flushAsync();

    await act(async () => {
      rendered.queryClient.setQueryData(queryKeys.aiMessages('conversation-1'), [
        {
          id: 'message-remote-live-order',
          conversation_id: 'conversation-1',
          role: 'assistant',
          content: '我先把“白切鸡”整理成菜谱草稿。',
          content_type: 'parts',
          parts: [
            {
              id: 'activity-script-completed-old',
              type: 'run_activity',
              activity: {
                id: 'script-running-new',
                run_id: streamedRunId,
                type: 'script',
                internal_code: 'script.lint_recipe_draft',
                user_message: '脚本「lint_recipe_draft」执行完成',
                status: 'completed',
                created_at: '2026-05-30T00:00:03Z',
              },
            },
            { id: 'part-remote-live-order-text', type: 'text', text: '我先把“白切鸡”整理成菜谱草稿。' },
          ],
          run_id: streamedRunId,
          status: 'running',
          metadata: { liveStreaming: true },
          created_at: '2026-05-30T00:00:01Z',
        },
      ]);
    });
    await flushAsync();

    const messageBody = rendered.container.querySelector('.ai-desktop-view .ai-message-assistant .ai-message-body') as HTMLElement;
    const textBlock = Array.from(messageBody.querySelectorAll<HTMLElement>('.ai-message-markdown'))
      .find((block) => block.textContent?.includes('我先把“白切鸡”整理成菜谱草稿')) as HTMLElement;
    const scriptActivities = Array.from(messageBody.querySelectorAll<HTMLElement>('.ai-run-activity'))
      .filter((activity) => activity.textContent?.includes('lint_recipe_draft'));
    expect(scriptActivities).toHaveLength(1);
    expect(textBlock.compareDocumentPosition(scriptActivities[0] as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    rendered.unmount();
  });

  async function sendInConversation(
    rendered: Awaited<ReturnType<typeof renderWithQuery>>,
    conversationId: string,
    message: string,
  ) {
    const historyButton = Array.from(
      rendered.container.querySelectorAll<HTMLButtonElement>('.ai-desktop-view .ai-conversation-main'),
    ).find((button) => button.closest('.ai-conversation-item')?.getAttribute('data-conversation-id') === conversationId);
    await act(async () => historyButton?.click());
    const textarea = rendered.container.querySelector<HTMLTextAreaElement>('.ai-desktop-view textarea.text-input');
    if (!textarea) throw new Error(`missing composer for ${conversationId}`);
    changeInput(textarea, message);
    await act(async () => {
      rendered.container.querySelector<HTMLFormElement>('.ai-desktop-view form.ai-composer')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flushAsync();
  }

  function concurrentResponse(conversationId: string, text: string): AiChatResponse {
    return {
      conversation_id: conversationId,
      message: {
        id: `message-${conversationId}`,
        conversation_id: conversationId,
        role: 'assistant',
        content: text,
        content_type: 'parts',
        parts: [{ id: `part-${conversationId}`, type: 'text', text }],
        run_id: `run-${conversationId}`,
        status: 'completed',
        metadata: {},
        created_at: '2026-07-11T12:00:00Z',
      },
      run: {
        id: `run-${conversationId}`,
        agent_key: 'workspace_orchestrator',
        intent: 'general_chat',
        status: 'completed',
        model: 'fake-model',
        created_at: '2026-07-11T12:00:00Z',
      },
      events: [],
      included: { result_cards: [], drafts: [], approvals: [] },
    };
  }

  async function resolveConversationStream(
    pending: Map<string, (response: AiChatResponse) => void>,
    conversationId: string,
    text: string,
  ) {
    await act(async () => pending.get(conversationId)?.(concurrentResponse(conversationId, text)));
    await flushAsync();
  }

  it('sends and completes two different conversations concurrently', async () => {
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
    const pending = new Map<string, (response: AiChatResponse) => void>();
    vi.spyOn(api, 'streamChatAi').mockImplementation((payload) => new Promise((resolve) => {
      pending.set(payload.conversation_id as string, resolve);
    }));
    const rendered = await renderWithQuery(
      <AiWorkspace
        conversations={[conversation({ id: 'conversation-a' }), conversation({ id: 'conversation-b' })]}
        isLoading={false}
      />,
    );
    await sendInConversation(rendered, 'conversation-a', '问题 A');
    await sendInConversation(rendered, 'conversation-b', '问题 B');
    expect(api.streamChatAi).toHaveBeenCalledTimes(2);
    expect(rendered.container.querySelectorAll('.ai-conversation-item.is-running')).toHaveLength(2);
    await resolveConversationStream(pending, 'conversation-b', '回答 B');
    expect(rendered.container.querySelectorAll('.ai-conversation-item.is-running')).toHaveLength(1);
    await resolveConversationStream(pending, 'conversation-a', '回答 A');
    expect(rendered.container.querySelectorAll('.ai-conversation-item.is-running')).toHaveLength(0);
    rendered.unmount();
  });

  it('cancels one conversation stream without aborting another concurrent stream', async () => {
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
    const signals = new Map<string, AbortSignal>();
    const pending = new Map<string, (response: AiChatResponse) => void>();
    vi.spyOn(api, 'streamChatAi').mockImplementation((payload, handlers) => new Promise((resolve, reject) => {
      const conversationId = payload.conversation_id as string;
      if (handlers?.signal) {
        signals.set(conversationId, handlers.signal);
        handlers.signal.addEventListener('abort', () => {
          reject(new Error('BodyStreamBuffer was aborted'));
        });
      }
      pending.set(conversationId, resolve);
    }));
    vi.spyOn(api, 'cancelAiRun').mockResolvedValue({
      run: { id: 'run-cancelled', status: 'cancelled' },
      events: [],
    });

    const rendered = await renderWithQuery(
      <AiWorkspace
        conversations={[conversation({ id: 'conversation-a' }), conversation({ id: 'conversation-b' })]}
        isLoading={false}
      />,
    );
    await sendInConversation(rendered, 'conversation-a', '问题 A');
    await sendInConversation(rendered, 'conversation-b', '问题 B');
    expect(api.streamChatAi).toHaveBeenCalledTimes(2);
    expect(rendered.container.querySelectorAll('.ai-conversation-item.is-running')).toHaveLength(2);

    await act(async () => {
      const historyButton = Array.from(
        rendered.container.querySelectorAll<HTMLButtonElement>('.ai-desktop-view .ai-conversation-main'),
      ).find((button) => button.closest('.ai-conversation-item')?.getAttribute('data-conversation-id') === 'conversation-a');
      historyButton?.click();
    });
    await flushAsync();
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-desktop-view .ai-send-button')?.click();
    });
    await flushAsync();

    expect(signals.get('conversation-a')?.aborted).toBe(true);
    expect(signals.get('conversation-b')?.aborted).toBe(false);
    expect(rendered.container.querySelectorAll('.ai-conversation-item.is-running')).toHaveLength(1);

    await resolveConversationStream(pending, 'conversation-b', '回答 B');
    expect(rendered.container.querySelectorAll('.ai-conversation-item.is-running')).toHaveLength(0);
    rendered.unmount();
  });

  it('does not treat another conversation\'s submitting approval as active while streaming', async () => {
    const pendingB = approval({
      id: 'approval-b',
      conversation_id: 'conversation-b',
      message_id: 'message-b-approval',
      run_id: 'run-b-approval',
      title: '确认创建菜谱 B',
    });
    vi.spyOn(api, 'getAiMessages').mockImplementation(async (conversationId) => {
      if (conversationId === 'conversation-b') {
        return [
          {
            id: 'message-b-approval',
            conversation_id: 'conversation-b',
            role: 'assistant',
            content: '菜谱草稿 B 已生成，请确认。',
            content_type: 'parts',
            parts: [
              { id: 'text-b', type: 'text', text: '菜谱草稿 B 已生成，请确认。' },
              { id: 'approval-part-b', type: 'approval_request', approval: pendingB },
            ],
            run_id: 'run-b-approval',
            status: 'waiting_approval',
            metadata: {},
            created_at: '2026-07-11T12:00:00Z',
          },
        ];
      }
      return [];
    });
    vi.spyOn(api, 'getPendingAiApprovals').mockImplementation(async (conversationId) => {
      if (conversationId === 'conversation-b') return [pendingB];
      return [];
    });
    vi.spyOn(api, 'streamChatAi').mockImplementation(() => new Promise(() => undefined));
    vi.spyOn(api, 'streamAiApprovalDecision').mockImplementation(() => new Promise(() => undefined));

    const rendered = await renderWithQuery(
      <AiWorkspace
        conversations={[
          conversation({ id: 'conversation-a', title: '会话 A', prompt: '会话 A' }),
          conversation({
            id: 'conversation-b',
            title: '会话 B',
            prompt: '会话 B',
            last_run_status: 'waiting_approval',
          }),
        ]}
        isLoading={false}
      />,
    );
    await flushAsync();

    // Start submitting B's approval.
    await act(async () => {
      const historyButton = Array.from(
        rendered.container.querySelectorAll<HTMLButtonElement>('.ai-desktop-view .ai-conversation-main'),
      ).find((button) => button.closest('.ai-conversation-item')?.getAttribute('data-conversation-id') === 'conversation-b');
      historyButton?.click();
    });
    await flushAsync();
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-desktop-view .ai-approval-actions .solid-button')?.click();
    });
    await flushAsync();
    expect(api.streamAiApprovalDecision).toHaveBeenCalled();
    expect(rendered.container.textContent).toContain('正在提交确认结果，AI 会接着处理当前任务。');

    // Switch to A and start a stream. A must not inherit B's submitting approval UI.
    await sendInConversation(rendered, 'conversation-a', '问题 A');
    const desktopView = rendered.container.querySelector('.ai-desktop-view') as HTMLElement;
    expect(desktopView.textContent).not.toContain('正在提交确认结果，AI 会接着处理当前任务。');
    expect(desktopView.querySelector<HTMLButtonElement>('.ai-send-button')?.getAttribute('aria-label')).toBe('中止生成');
    rendered.unmount();
  });

  it('marks the local assistant failed when startChat rejects with a non-abort error', async () => {
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
    vi.spyOn(api, 'streamChatAi').mockRejectedValue(new Error('AI 服务暂时不可用，请稍后重试。'));

    const rendered = await renderWithQuery(
      <AiWorkspace conversations={[conversation({ id: 'conversation-a' })]} isLoading={false} />,
    );
    await sendInConversation(rendered, 'conversation-a', '问题 A');
    await flushAsync();

    const desktopView = rendered.container.querySelector('.ai-desktop-view') as HTMLElement;
    expect(desktopView.textContent).toContain('AI 后续处理失败：AI 服务暂时不可用，请稍后重试。');
    expect(desktopView.querySelectorAll('.ai-conversation-item.is-running')).toHaveLength(0);
    expect(desktopView.querySelector<HTMLButtonElement>('.ai-send-button')?.getAttribute('aria-label')).toBe('发送消息');
    rendered.unmount();
  });
});
