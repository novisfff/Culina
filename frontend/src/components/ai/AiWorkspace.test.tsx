import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aiApi } from '../../api/aiApi';
import { api, ApiError } from '../../api/client';
import type { AiChatResponse, AiMessage, AiResultCard, AiRunCancellationResponse, AiRunEvent } from '../../api/types';
import { cleanupTestDomAndMocks, flushAsync, renderWithQuery, waitForAsync } from '../../test/renderWithQuery';
import { AiWorkspace } from './AiWorkspace';
import { approval, conversation, qualityMetrics } from './aiWorkspaceTestFixtures';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function changeInput(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  act(() => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const valueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    valueSetter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function cancellationResponse(
  runId: string,
  outcome: AiRunCancellationResponse['outcome'],
): AiRunCancellationResponse {
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
      agent_key: 'workspace_orchestrator',
      intent: 'general_chat',
      status: cancelled ? 'cancelled' : 'cancelling',
      model: 'fake-model',
      created_at: '2026-07-23T00:00:00Z',
    },
    events: cancelled
      ? [{
        id: `cancel-event-${runId}`,
        run_id: runId,
        type: 'cancel',
        internal_code: 'user_cancel',
        user_message: '已取消这次任务',
        status: 'cancelled',
        created_at: '2026-07-23T00:00:01Z',
      }]
      : [],
  };
}

async function renderActiveWorkspaceStream() {
  vi.spyOn(api, 'getAiMessages').mockResolvedValue([]);
  vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
  let streamSignal: AbortSignal | undefined;
  let runId = '';
  vi.spyOn(api, 'streamChatAi').mockImplementation((payload, handlers) => {
    runId = payload.client_run_id ?? '';
    streamSignal = handlers?.signal;
    return new Promise<AiChatResponse>((_resolve, reject) => {
      handlers?.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted', 'AbortError'));
      });
    });
  });
  const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
  await flushAsync();
  changeInput(rendered.container.querySelector<HTMLTextAreaElement>('textarea.text-input') as HTMLTextAreaElement, '安排三天晚餐');
  await act(async () => {
    rendered.container.querySelector<HTMLFormElement>('form.ai-composer')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await flushAsync();
  return {
    rendered,
    get runId() { return runId; },
    get streamSignal() { return streamSignal; },
  };
}

afterEach(() => {
  cleanupTestDomAndMocks();
  window.localStorage.clear();
  setViewportWidth(1024);
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

function setViewportWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: width,
  });
}

async function advanceTimers(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('AiWorkspace pending approval restore', () => {
  it('defaults to collapsed history on iPad width even when desktop preference is expanded', async () => {
    setViewportWidth(1180);
    window.localStorage.setItem('ai_sidebar_collapsed', 'false');
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);

    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flushAsync();

    expect(rendered.container.querySelector('.ai-workspace-shell')?.classList.contains('is-collapsed')).toBe(true);
    expect(rendered.container.querySelector('.ai-sidebar-trigger-btn')).not.toBeNull();
    rendered.unmount();
  });

  it('keeps desktop history expanded when the saved desktop preference is expanded', async () => {
    setViewportWidth(1440);
    window.localStorage.setItem('ai_sidebar_collapsed', 'false');
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);

    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flushAsync();

    expect(rendered.container.querySelector('.ai-workspace-shell')?.classList.contains('is-collapsed')).toBe(false);
    expect(rendered.container.querySelector('.ai-side-panel')).not.toBeNull();
    rendered.unmount();
  });

  it('restores pending approvals as an assistant message when history is missing', async () => {
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([approval()]);
    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flushAsync();
    expect(rendered.container.textContent).not.toContain('待处理确认');
    expect(rendered.container.textContent).toContain('AI 厨房助手');
    expect(rendered.container.textContent).toContain('确认创建菜谱');
    expect(rendered.container.querySelector<HTMLInputElement>('input.text-input')?.value).toBe('原始草稿');
    rendered.unmount();
  });

  it('unlocks an embedded pending approval when the restored message is still marked running', async () => {
    const pending = approval({
      message_id: 'message-background-approval',
      run_id: 'run-background-approval',
    });
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([
      {
        id: 'message-background-approval',
        conversation_id: 'conversation-1',
        role: 'assistant',
        content: '菜谱草稿已经生成，请确认。',
        content_type: 'parts',
        parts: [
          { id: 'text-background-approval', type: 'text', text: '菜谱草稿已经生成，请确认。' },
          { id: 'approval-background-approval', type: 'approval_request', approval: pending },
        ],
        run_id: 'run-background-approval',
        status: 'running',
        metadata: {},
        created_at: '2026-05-30T00:00:00Z',
      },
    ]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([pending]);
    const rendered = await renderWithQuery(
      <AiWorkspace
        conversations={[
          {
            ...conversation(),
            context: { activeRunId: 'run-background-approval' },
            last_run_status: 'waiting_approval',
          },
        ]}
        isLoading={false}
      />,
    );
    await flushAsync();

    const desktopView = rendered.container.querySelector('.ai-desktop-view') as HTMLElement;
    expect(desktopView.textContent).toContain('确认创建菜谱');
    expect(desktopView.textContent).not.toContain('确认入口正在准备，稍后即可确认。');
    expect(desktopView.querySelector('.ai-approval-actions .solid-button')).not.toBeNull();
    rendered.unmount();
  });

  it('pauses both composers but keeps the pending approval run cancellable', async () => {
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([approval()]);
    const streamSpy = vi.spyOn(api, 'streamChatAi').mockResolvedValue({
      conversation_id: 'conversation-1',
      message: {
        id: 'message-final',
        conversation_id: 'conversation-1',
        role: 'assistant',
        content: '不应该发送',
        content_type: 'parts',
        parts: [{ id: 'part-final', type: 'text', text: '不应该发送' }],
        run_id: 'run-blocked',
        status: 'completed',
        metadata: {},
        created_at: '2026-05-30T00:00:00Z',
      },
      run: {
        id: 'run-blocked',
        agent_key: 'general_chat_agent',
        intent: 'general_chat',
        status: 'completed',
        model: 'rules',
        created_at: '2026-05-30T00:00:00Z',
      },
      events: [],
      included: { result_cards: [], drafts: [], approvals: [] },
    });
    const cancelSpy = vi.spyOn(aiApi, 'cancelAiRun').mockResolvedValue({
      outcome: 'cancelled',
      request: {
        run_id: 'run-1',
        status: 'applied',
        requested_at: '2026-05-30T00:00:00Z',
      },
      run: {
        id: 'run-1',
        agent_key: 'workspace_orchestrator',
        intent: 'workspace_orchestrator',
        status: 'cancelled',
        model: 'fake',
        created_at: '2026-05-30T00:00:00Z',
      },
      events: [
        {
          id: 'cancel-event',
          run_id: 'run-1',
          type: 'cancel',
          internal_code: 'user_cancel',
          user_message: '已取消这次任务',
          status: 'cancelled',
          created_at: '2026-05-30T00:00:00Z',
        },
      ],
    });
    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flushAsync();
    const pauseMessage = '请先确认上面的草稿，确认后可以继续对话。';
    expect(rendered.container.textContent).not.toContain(pauseMessage);
    expect(
      Array.from(rendered.container.querySelectorAll<HTMLTextAreaElement>('.ai-composer textarea'))
        .every((textarea) => textarea.placeholder === pauseMessage),
    ).toBe(true);
    expect(Array.from(rendered.container.querySelectorAll<HTMLTextAreaElement>('.ai-composer textarea')).every((textarea) => textarea.disabled)).toBe(true);
    expect(Array.from(rendered.container.querySelectorAll<HTMLButtonElement>('.ai-send-button')).every((button) => !button.disabled)).toBe(true);
    expect(Array.from(rendered.container.querySelectorAll<HTMLButtonElement>('.ai-send-button')).every((button) => button.getAttribute('aria-label') === '中止生成')).toBe(true);
    await act(async () => {
      rendered.container.querySelector<HTMLFormElement>('form.ai-composer')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flushAsync();
    expect(streamSpy).not.toHaveBeenCalled();
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-send-button')?.click();
    });
    await flushAsync();
    expect(cancelSpy).toHaveBeenCalledWith('run-1');
    rendered.unmount();
  });

  it('pauses both composers and blocks sending when AI is not configured', async () => {
    vi.spyOn(api, 'getAiStatus').mockResolvedValue({
      enabled: false,
      provider: 'disabled',
      model: 'gpt-4o-mini',
      supports_vision: false,
      status: 'disabled',
      detail: 'AI 模型未配置。',
    });
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
    const streamSpy = vi.spyOn(api, 'streamChatAi').mockResolvedValue({} as AiChatResponse);
    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flushAsync();

    expect(rendered.container.textContent).toContain('AI 未配置');
    expect(rendered.container.textContent).not.toContain('AI 模型未配置。');
    expect(
      Array.from(rendered.container.querySelectorAll<HTMLTextAreaElement>('.ai-composer textarea'))
        .every((textarea) => textarea.placeholder === 'AI 模型未配置。'),
    ).toBe(true);
    expect(Array.from(rendered.container.querySelectorAll<HTMLTextAreaElement>('.ai-composer textarea')).every((textarea) => textarea.disabled)).toBe(true);
    await act(async () => {
      rendered.container.querySelector<HTMLFormElement>('form.ai-composer')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flushAsync();
    expect(streamSpy).not.toHaveBeenCalled();
    rendered.unmount();
  });

  it('does not pause composers for answered human input request parts', async () => {
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([
      {
        id: 'message-human-input',
        conversation_id: 'conversation-1',
        role: 'assistant',
        content: '你想安排几天晚餐？\n\n好的，我继续整理。',
        content_type: 'parts',
        parts: [
          { id: 'text-question', type: 'text', text: '你想安排几天晚餐？' },
          {
            id: 'human-input-part',
            type: 'human_input_request',
            status: 'completed',
            responded_at: '2026-05-30T00:01:00Z',
            request: {
              id: 'human-input-1',
              question: '你想安排几天晚餐？',
              inputMode: 'choice_or_text',
              options: [{ id: 'three-days', label: '三天' }],
              allowMultiple: false,
              required: true,
              reason: null,
              sourceSkills: ['meal_plan'],
              resumeHint: {},
            },
          },
          { id: 'text-resumed', type: 'text', text: '好的，我继续整理。' },
        ],
        run_id: 'run-1',
        status: 'completed',
        metadata: {},
        created_at: '2026-05-30T00:00:00Z',
      },
    ]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flushAsync();

    expect(rendered.container.textContent).not.toContain('请先回答上面的问题，AI 会接着处理当前任务。');
    expect(Array.from(rendered.container.querySelectorAll<HTMLTextAreaElement>('.ai-composer textarea')).every((textarea) => !textarea.disabled)).toBe(true);
    rendered.unmount();
  });

  it('keeps both composers on the cancellable pause button while human input is pending', async () => {
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([
      {
        id: 'message-human-input',
        conversation_id: 'conversation-1',
        role: 'assistant',
        content: '你想怎么处理缺少的青椒？',
        content_type: 'parts',
        parts: [
          { id: 'text-question', type: 'text', text: '你想怎么处理缺少的青椒？' },
          {
            id: 'human-input-part',
            type: 'human_input_request',
            status: 'pending',
            request: {
              id: 'human-input-1',
              question: '你想怎么处理缺少的青椒？',
              inputMode: 'choice_or_text',
              options: [{ id: 'restock', label: '先补青椒库存后再做' }],
              allowMultiple: false,
              required: true,
              reason: null,
              sourceSkills: ['recipe_draft'],
              resumeHint: {},
            },
          },
        ],
        run_id: 'run-human-input',
        status: 'completed',
        metadata: {},
        created_at: '2026-05-30T00:00:00Z',
      },
    ]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
    const cancelSpy = vi.spyOn(aiApi, 'cancelAiRun').mockResolvedValue({
      outcome: 'cancelled',
      request: {
        run_id: 'run-human-input',
        status: 'applied',
        requested_at: '2026-05-30T00:00:00Z',
      },
      run: {
        id: 'run-human-input',
        agent_key: 'workspace_orchestrator',
        intent: 'workspace_orchestrator',
        status: 'cancelled',
        model: 'fake',
        created_at: '2026-05-30T00:00:00Z',
      },
      events: [
        {
          id: 'cancel-event',
          run_id: 'run-human-input',
          type: 'cancel',
          internal_code: 'user_cancel',
          user_message: '已取消这次任务',
          status: 'cancelled',
          created_at: '2026-05-30T00:00:00Z',
        },
      ],
    });
    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flushAsync();

    expect(rendered.container.textContent).toContain('手动输入');
    const pauseMessage = '请先回答上面的问题，AI 会接着处理当前任务。';
    expect(rendered.container.textContent).not.toContain(pauseMessage);
    expect(
      Array.from(rendered.container.querySelectorAll<HTMLTextAreaElement>('.ai-composer textarea'))
        .every((textarea) => textarea.placeholder === pauseMessage),
    ).toBe(true);
    expect(Array.from(rendered.container.querySelectorAll<HTMLTextAreaElement>('.ai-composer textarea')).every((textarea) => textarea.disabled)).toBe(true);
    expect(Array.from(rendered.container.querySelectorAll<HTMLButtonElement>('.ai-send-button')).every((button) => !button.disabled)).toBe(true);
    expect(Array.from(rendered.container.querySelectorAll<HTMLButtonElement>('.ai-send-button')).every((button) => button.getAttribute('aria-label') === '中止生成')).toBe(true);

    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-send-button')?.click();
    });
    await flushAsync();

    expect(cancelSpy).toHaveBeenCalledWith('run-human-input');
    rendered.unmount();
  });

  it('keeps the human input submission status in composer placeholders only', async () => {
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([
      {
        id: 'message-human-input',
        conversation_id: 'conversation-1',
        role: 'assistant',
        content: '你想怎么处理缺少的青椒？',
        content_type: 'parts',
        parts: [
          { id: 'text-question', type: 'text', text: '你想怎么处理缺少的青椒？' },
          {
            id: 'human-input-part',
            type: 'human_input_request',
            status: 'pending',
            request: {
              id: 'human-input-1',
              question: '你想怎么处理缺少的青椒？',
              inputMode: 'choice_or_text',
              options: [{ id: 'restock', label: '先补青椒库存后再做' }],
              allowMultiple: false,
              required: true,
              reason: null,
              sourceSkills: ['recipe_draft'],
              resumeHint: {},
            },
          },
        ],
        run_id: 'run-human-input',
        status: 'completed',
        metadata: {},
        created_at: '2026-05-30T00:00:00Z',
      },
    ]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
    vi.spyOn(api, 'streamAiHumanInputResponse').mockImplementation(() => new Promise<AiChatResponse>(() => undefined));

    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flushAsync();
    const desktopView = rendered.container.querySelector('.ai-desktop-view') as HTMLElement;
    vi.useFakeTimers();

    await act(async () => {
      desktopView.querySelector<HTMLButtonElement>('.ai-clarification-option')?.click();
      await Promise.resolve();
    });
    await advanceTimers(300);

    const submitStatus = '正在提交你的回答，AI 会接着处理当前任务。';
    expect(desktopView.textContent).not.toContain(submitStatus);
    expect(
      Array.from(rendered.container.querySelectorAll<HTMLTextAreaElement>('.ai-composer textarea'))
        .every((textarea) => textarea.placeholder === submitStatus),
    ).toBe(true);
    expect(desktopView.querySelector('.ai-thinking-cue')?.textContent).toContain('正在思考');
    expect(rendered.container.querySelector('.ai-mobile-page .ai-thinking-cue')?.textContent).toContain('正在思考');
    expect(desktopView.textContent).not.toContain('另一个会话正在后台回复');
    rendered.unmount();
  });

  it('streams assistant text after submitting a human input answer', async () => {
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([
      {
        id: 'message-human-input-stream',
        conversation_id: 'conversation-1',
        role: 'assistant',
        content: '你想安排几天？',
        content_type: 'parts',
        parts: [
          { id: 'text-question', type: 'text', text: '你想安排几天？' },
          {
            id: 'human-input-part',
            type: 'human_input_request',
            status: 'pending',
            request: {
              id: 'human-input-stream',
              question: '你想安排几天？',
              inputMode: 'choice',
              options: [{ id: 'three-days', label: '三天' }],
              allowMultiple: false,
              required: true,
              reason: null,
              sourceSkills: ['meal_plan'],
              resumeHint: {},
            },
          },
        ],
        run_id: 'run-human-input-stream',
        status: 'completed',
        metadata: {},
        created_at: '2026-05-30T00:00:00Z',
      },
    ]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
    vi.spyOn(api, 'streamAiHumanInputResponse').mockImplementation((_conversationId, _requestId, _payload, handlers) => {
      handlers?.onMessageDelta?.({
        message_id: 'message-human-input-stream',
        conversation_id: 'conversation-1',
        run_id: 'run-human-input-stream',
        part_id: 'part-after-human-input',
        delta: '已按三天继续安排。',
      });
      return new Promise<AiChatResponse>(() => undefined);
    });

    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flushAsync();
    const desktopView = rendered.container.querySelector('.ai-desktop-view') as HTMLElement;

    await act(async () => {
      desktopView.querySelector<HTMLButtonElement>('.ai-clarification-option')?.click();
      await Promise.resolve();
    });
    await flushAsync();

    const assistantMessages = desktopView.querySelectorAll('.ai-message-assistant');
    expect(assistantMessages).toHaveLength(1);
    expect((assistantMessages[0] as HTMLElement).textContent).toContain('已按三天继续安排。');
    expect(desktopView.querySelector('.ai-thinking-cue')).toBeNull();
    rendered.unmount();
  });

  it('keeps thinking after a human input answer is submitted before the next output arrives', async () => {
    vi.useFakeTimers();
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([
      {
        id: 'message-human-input-resume',
        conversation_id: 'conversation-1',
        role: 'assistant',
        content: '要把西红柿合并到哪一条采购项？',
        content_type: 'parts',
        parts: [
          { id: 'text-question', type: 'text', text: '要把西红柿合并到哪一条采购项？' },
          {
            id: 'human-input-part',
            type: 'human_input_request',
            status: 'pending',
            request: {
              id: 'human-input-resume',
              question: '要把西红柿合并到哪一条采购项？',
              inputMode: 'choice',
              options: [{ id: 'single', label: '单独新增“番茄 1 个”' }],
              allowMultiple: false,
              required: true,
              reason: null,
              sourceSkills: ['shopping_list'],
              resumeHint: {},
            },
          },
        ],
        run_id: null,
        status: 'completed',
        metadata: {},
        created_at: '2026-05-30T00:00:00Z',
      },
    ]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
    vi.spyOn(api, 'streamAiHumanInputResponse').mockImplementation(() => new Promise<AiChatResponse>(() => undefined));

    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await advanceTimers(0);
    const desktopView = rendered.container.querySelector('.ai-desktop-view') as HTMLElement;
    await act(async () => {
      desktopView.querySelector<HTMLButtonElement>('.ai-clarification-option')?.click();
      await Promise.resolve();
    });
    await advanceTimers(300);

    const messageBody = desktopView.querySelector<HTMLElement>('.ai-message-assistant .ai-message-body') as HTMLElement;
    expect(messageBody.textContent).toContain('回答');
    expect(messageBody.textContent).toContain('单独新增“番茄 1 个”');
    expect(messageBody.querySelector('.ai-thinking-cue')?.textContent).toContain('正在思考');
    rendered.unmount();
  });

  it('resumes the composers after the pending approval is settled and refetched', async () => {
    const pending = approval();
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([]);
    let pendingRequestCount = 0;
    vi.spyOn(api, 'getPendingAiApprovals').mockImplementation(async () => {
      pendingRequestCount += 1;
      return pendingRequestCount === 1 ? [pending] : [];
    });
    const decideSpy = vi.spyOn(api, 'decideAiApproval').mockResolvedValue({
      approval: { ...pending, status: 'approved', decision: 'approved', submitted_values: pending.initial_values },
      draft: {
        id: pending.draft_id,
        conversation_id: pending.conversation_id,
        message_id: pending.message_id,
        run_id: pending.run_id,
        draft_type: 'recipe',
        payload: pending.initial_values.recipe ?? {},
        preview_summary: '菜谱草稿',
        status: 'confirmed',
        version: pending.draft_version,
        schema_version: 'recipe.v1',
        validation_errors: [],
        expires_at: null,
        created_at: '2026-05-30T00:00:00Z',
        updated_at: '2026-05-30T00:00:00Z',
      },
      operation: { status: 'succeeded' },
      business_entity: {},
    });
    const streamDecisionSpy = vi.spyOn(api, 'streamAiApprovalDecision').mockResolvedValue({
      conversation_id: 'conversation-1',
      message: {
        id: 'message-1',
        conversation_id: 'conversation-1',
        role: 'assistant',
        content: '菜谱已经创建完成。',
        content_type: 'parts',
        parts: [
          { id: 'approval-part-1', type: 'approval_request', approval: { ...pending, status: 'approved', decision: 'approved', submitted_values: pending.initial_values } },
          { id: 'text-final', type: 'text', text: '菜谱已经创建完成。' },
        ],
        run_id: pending.run_id,
        status: 'completed',
        metadata: {},
        created_at: '2026-05-30T00:00:00Z',
      },
      run: {
        id: pending.run_id as string,
        agent_key: 'recipe_draft_agent',
        intent: 'recipe_draft',
        status: 'completed',
        model: 'rules',
        created_at: '2026-05-30T00:00:00Z',
      },
      events: [],
      included: { result_cards: [], drafts: [], approvals: [] },
    });
    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flushAsync();
    expect(Array.from(rendered.container.querySelectorAll<HTMLTextAreaElement>('.ai-composer textarea')).every((textarea) => textarea.disabled)).toBe(true);
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-approval-actions .solid-button')?.click();
    });
    await flushAsync();
    expect(decideSpy).not.toHaveBeenCalled();
    expect(streamDecisionSpy).toHaveBeenCalledWith(
      'conversation-1',
      'approval-1',
      expect.objectContaining({
        decision: 'approved',
        draft_version: 1,
        values: expect.objectContaining({ recipe: expect.any(Object) }),
      }),
      expect.any(Object),
    );
    expect(Array.from(rendered.container.querySelectorAll<HTMLTextAreaElement>('.ai-composer textarea')).every((textarea) => !textarea.disabled)).toBe(true);
    rendered.unmount();
  });

  it('resumes the current composer when approval continuation has produced the final response', async () => {
    const pending = approval();
    const runId = pending.run_id as string;
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([
      {
        id: 'message-1',
        conversation_id: 'conversation-1',
        role: 'assistant',
        content: '菜谱草稿已经生成，请确认。',
        content_type: 'parts',
        parts: [
          { id: 'text-1', type: 'text', text: '菜谱草稿已经生成，请确认。' },
          { id: 'approval-part-1', type: 'approval_request', approval: pending },
        ],
        run_id: runId,
        status: 'waiting_approval',
        metadata: {},
        created_at: '2026-05-30T00:00:00Z',
      },
    ]);
    let pendingRequestCount = 0;
    vi.spyOn(api, 'getPendingAiApprovals').mockImplementation(async () => {
      pendingRequestCount += 1;
      return pendingRequestCount === 1 ? [pending] : [];
    });
    const approved = { ...pending, status: 'approved' as const, decision: 'approved' as const, submitted_values: pending.initial_values };
    vi.spyOn(api, 'decideAiApproval').mockResolvedValue({
      approval: approved,
      draft: {
        id: pending.draft_id,
        conversation_id: pending.conversation_id,
        message_id: pending.message_id,
        run_id: runId,
        draft_type: 'recipe',
        payload: pending.initial_values.recipe ?? {},
        preview_summary: '菜谱草稿',
        status: 'confirmed',
        version: pending.draft_version,
        schema_version: 'recipe.v1',
        validation_errors: [],
        expires_at: null,
        created_at: '2026-05-30T00:00:00Z',
        updated_at: '2026-05-30T00:00:00Z',
      },
      operation: { status: 'succeeded' },
      business_entity: {},
    });
    vi.spyOn(api, 'streamAiApprovalDecision').mockImplementation(async () => ({
      conversation_id: 'conversation-1',
      message: {
        id: 'message-1',
        conversation_id: 'conversation-1',
        role: 'assistant',
        content: '菜谱已经创建完成。',
        content_type: 'parts',
        parts: [
          { id: 'text-1', type: 'text', text: '菜谱草稿已经生成，请确认。' },
          { id: 'approval-part-1', type: 'approval_request', approval: approved },
          { id: 'text-final', type: 'text', text: '菜谱已经创建完成。' },
        ],
        run_id: runId,
        status: 'completed',
        metadata: {},
        created_at: '2026-05-30T00:00:00Z',
      },
      run: {
        id: runId,
        agent_key: 'recipe_draft_agent',
        intent: 'recipe_draft',
        status: 'completed',
        model: 'rules',
        created_at: '2026-05-30T00:00:00Z',
      },
      events: [],
      included: { result_cards: [], drafts: [], approvals: [] },
    }));

    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flushAsync();
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-approval-actions .solid-button')?.click();
      await Promise.resolve();
    });
    await flushAsync();

    const desktopView = rendered.container.querySelector('.ai-desktop-view') as HTMLElement;
    expect(desktopView.textContent).toContain('菜谱已经创建完成。');
    expect(desktopView.textContent).not.toContain('另一个会话正在后台回复');
    expect(Array.from(rendered.container.querySelectorAll<HTMLTextAreaElement>('.ai-composer textarea')).every((textarea) => !textarea.disabled)).toBe(true);
    expect(Array.from(rendered.container.querySelectorAll<HTMLButtonElement>('.ai-send-button')).every((button) => button.getAttribute('aria-label') === '发送消息')).toBe(true);
    rendered.unmount();
  });

  it('does not pause the composer when the pending approvals query is stale after approval settled', async () => {
    const pending = approval();
    const approved = {
      ...pending,
      status: 'approved' as const,
      decision: 'approved' as const,
      submitted_values: pending.initial_values,
      resolved_at: '2026-05-30T00:01:00Z',
    };
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([
      {
        id: 'message-1',
        conversation_id: 'conversation-1',
        role: 'assistant',
        content: '菜谱已经创建完成。',
        content_type: 'parts',
        parts: [
          { id: 'text-1', type: 'text', text: '菜谱草稿已经生成，请确认。' },
          { id: 'approval-part-1', type: 'approval_request', approval: approved },
          {
            id: 'operation-result-part-1',
            type: 'result_card',
            card: {
              id: 'operation-result-card-1',
              type: 'operation_result',
              title: '已创建菜谱',
              data: {
                approvalId: pending.id,
                actionSummary: '番茄鸡蛋面已写入菜谱库。',
                entityCount: 1,
                entityCountLabel: '1 道菜谱',
                workspaceLabel: '菜谱库',
              },
            } as AiResultCard,
          },
          { id: 'text-final', type: 'text', text: '菜谱已经创建完成。' },
        ],
        run_id: pending.run_id,
        status: 'completed',
        metadata: {},
        created_at: '2026-05-30T00:00:00Z',
      },
    ]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([pending]);

    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flushAsync();

    expect(rendered.container.textContent).toContain('已创建菜谱');
    expect(rendered.container.textContent).not.toContain('请先确认上面的草稿，确认后可以继续对话。');
    expect(Array.from(rendered.container.querySelectorAll<HTMLTextAreaElement>('.ai-composer textarea')).every((textarea) => !textarea.disabled)).toBe(true);
    rendered.unmount();
  });

  it('stops the approval resume stream and shows an error when downstream AI fails', async () => {
    const pending = approval();
    let decisionApplied = false;
    const pendingMessage: AiMessage = {
      id: 'message-1',
      conversation_id: 'conversation-1',
      role: 'assistant',
      content: '菜谱草稿已经生成，请确认。',
      content_type: 'parts',
      parts: [
        { id: 'text-1', type: 'text', text: '菜谱草稿已经生成，请确认。' },
        { id: 'approval-part-1', type: 'approval_request', approval: pending },
      ],
      run_id: 'run-1',
      status: 'waiting_approval',
      metadata: {},
      created_at: '2026-05-30T00:00:00Z',
    };
    const approved = { ...pending, status: 'approved' as const, decision: 'approved' as const, submitted_values: pending.initial_values };
    const approvedMessage: AiMessage = {
      ...pendingMessage,
      status: 'completed',
      parts: pendingMessage.parts.map((part) => (part.type === 'approval_request' ? { ...part, approval: approved } : part)),
    };
    vi.spyOn(api, 'getAiMessages').mockImplementation(async () => [decisionApplied ? approvedMessage : pendingMessage]);
    vi.spyOn(api, 'getPendingAiApprovals').mockImplementation(async () => (decisionApplied ? [] : [pending]));
    vi.spyOn(api, 'decideAiApproval').mockImplementation(async () => {
      decisionApplied = true;
      return {
        approval: approved,
        draft: {
          id: pending.draft_id,
          conversation_id: pending.conversation_id,
          message_id: pending.message_id,
          run_id: pending.run_id,
          draft_type: 'recipe',
          payload: pending.initial_values.recipe ?? {},
          preview_summary: '菜谱草稿',
          status: 'confirmed',
          version: pending.draft_version,
          schema_version: 'recipe.v1',
          validation_errors: [],
          expires_at: null,
          created_at: '2026-05-30T00:00:00Z',
          updated_at: '2026-05-30T00:00:00Z',
        },
        operation: { status: 'succeeded' },
        business_entity: {},
      };
    });
    vi.spyOn(api, 'streamAiApprovalDecision').mockRejectedValue(new Error('AI 服务暂时不可用，请稍后重试。'));

    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flushAsync();
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-approval-actions .solid-button')?.click();
    });
    await flushAsync();
    await flushAsync();

    expect(rendered.container.textContent).toContain('AI 服务暂时不可用，请稍后重试。');
    expect(Array.from(rendered.container.querySelectorAll<HTMLTextAreaElement>('.ai-composer textarea')).every((textarea) => textarea.disabled)).toBe(true);
    rendered.unmount();
  });

  it('continues approval resume output inside the original assistant message', async () => {
    const pending = approval();
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([
      {
        id: 'message-1',
        conversation_id: 'conversation-1',
        role: 'assistant',
        content: '菜谱草稿已经生成，请确认。',
        content_type: 'parts',
        parts: [
          { id: 'text-1', type: 'text', text: '菜谱草稿已经生成，请确认。' },
          { id: 'approval-part-1', type: 'approval_request', approval: pending },
        ],
        run_id: 'run-1',
        status: 'waiting_approval',
        metadata: {},
        created_at: '2026-05-30T00:00:00Z',
      },
    ]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValueOnce([pending]).mockResolvedValue([]);
    vi.spyOn(api, 'decideAiApproval').mockResolvedValue({
      approval: { ...pending, status: 'approved', decision: 'approved', submitted_values: pending.initial_values },
      draft: {
        id: pending.draft_id,
        conversation_id: pending.conversation_id,
        message_id: pending.message_id,
        run_id: pending.run_id,
        draft_type: 'recipe',
        payload: pending.initial_values.recipe ?? {},
        preview_summary: '菜谱草稿',
        status: 'confirmed',
        version: pending.draft_version,
        schema_version: 'recipe.v1',
        validation_errors: [],
        expires_at: null,
        created_at: '2026-05-30T00:00:00Z',
        updated_at: '2026-05-30T00:00:00Z',
      },
      operation: { status: 'succeeded' },
      business_entity: {},
    });
    vi.spyOn(api, 'streamAiApprovalDecision').mockImplementation(async (_conversationId, _approvalId, _payload, handlers) => {
      handlers?.onMessageDelta?.({
        message_id: 'new-message-should-not-render',
        conversation_id: 'conversation-1',
        run_id: 'run-1',
        part_id: 'resume-text-1',
        delta: '确认完成，我继续整理下一步。',
      });
      return {
        conversation_id: 'conversation-1',
        message: {
          id: 'message-1',
          conversation_id: 'conversation-1',
          role: 'assistant',
          content: '菜谱草稿已经生成，请确认。\n\n确认完成，我继续整理下一步。',
          content_type: 'parts',
          parts: [
            { id: 'text-1', type: 'text', text: '菜谱草稿已经生成，请确认。' },
            { id: 'approval-part-1', type: 'approval_request', approval: { ...pending, status: 'approved', decision: 'approved', submitted_values: pending.initial_values } },
            { id: 'resume-text-1', type: 'text', text: '确认完成，我继续整理下一步。' },
          ],
          run_id: 'run-1',
          status: 'completed',
          metadata: {},
          created_at: '2026-05-30T00:00:00Z',
        },
        run: {
          id: 'run-1',
          agent_key: 'workspace_orchestrator',
          intent: 'multi_skill',
          status: 'completed',
          model: 'rules',
          created_at: '2026-05-30T00:00:00Z',
        },
        events: [],
        included: { result_cards: [], drafts: [], approvals: [] },
      };
    });
    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flushAsync();
    expect(rendered.container.querySelectorAll('.ai-desktop-view .ai-message-assistant')).toHaveLength(1);
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-desktop-view .ai-approval-actions .solid-button')?.click();
    });
    await flushAsync();
    const assistantMessages = rendered.container.querySelectorAll('.ai-desktop-view .ai-message-assistant');
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]?.textContent).toContain('确认创建菜谱');
    expect(assistantMessages[0]?.textContent).toContain('确认完成，我继续整理下一步。');
    rendered.unmount();
  });

  it('does not duplicate approval continuation when final stream response resolves after its event', async () => {
    const pending = approval();
    const approved = { ...pending, status: 'approved' as const, decision: 'approved' as const, submitted_values: pending.initial_values };
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([
      {
        id: 'message-1',
        conversation_id: 'conversation-1',
        role: 'assistant',
        content: '菜谱草稿已经生成，请确认。',
        content_type: 'parts',
        parts: [
          { id: 'text-1', type: 'text', text: '菜谱草稿已经生成，请确认。' },
          { id: 'approval-part-1', type: 'approval_request', approval: pending },
        ],
        run_id: 'run-1',
        status: 'waiting_approval',
        metadata: {},
        created_at: '2026-05-30T00:00:00Z',
      },
    ]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValueOnce([pending]).mockResolvedValue([]);
    vi.spyOn(api, 'decideAiApproval').mockResolvedValue({
      approval: approved,
      draft: {
        id: pending.draft_id,
        conversation_id: pending.conversation_id,
        message_id: pending.message_id,
        run_id: pending.run_id,
        draft_type: 'recipe',
        payload: pending.initial_values.recipe ?? {},
        preview_summary: '菜谱草稿',
        status: 'confirmed',
        version: pending.draft_version,
        schema_version: 'recipe.v1',
        validation_errors: [],
        expires_at: null,
        created_at: '2026-05-30T00:00:00Z',
        updated_at: '2026-05-30T00:00:00Z',
      },
      operation: { status: 'succeeded' },
      business_entity: {},
    });
    const finalResponse: AiChatResponse = {
      conversation_id: 'conversation-1',
      message: {
        id: 'message-1',
        conversation_id: 'conversation-1',
        role: 'assistant',
        content: '菜谱草稿已经生成，请确认。\n\n确认完成，我继续整理下一步。',
        content_type: 'parts',
        parts: [
          { id: 'text-1', type: 'text', text: '菜谱草稿已经生成，请确认。' },
          { id: 'approval-part-1', type: 'approval_request', approval: approved },
          { id: 'resume-text-1', type: 'text', text: '确认完成，我继续整理下一步。' },
        ],
        run_id: 'run-1',
        status: 'completed',
        metadata: {},
        created_at: '2026-05-30T00:00:00Z',
      },
      run: {
        id: 'run-1',
        agent_key: 'workspace_orchestrator',
        intent: 'multi_skill',
        status: 'completed',
        model: 'rules',
        created_at: '2026-05-30T00:00:00Z',
      },
      events: [],
      included: { result_cards: [], drafts: [], approvals: [] },
    };
    vi.spyOn(api, 'streamAiApprovalDecision').mockImplementation(async (_conversationId, _approvalId, _payload, handlers) => {
      handlers?.onMessageDelta?.({
        message_id: 'message-1',
        conversation_id: 'conversation-1',
        run_id: 'run-1',
        part_id: 'resume-text-1',
        delta: '确认完成，我继续整理下一步。',
      });
      handlers?.onResponse?.(finalResponse);
      return finalResponse;
    });
    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flushAsync();
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-desktop-view .ai-approval-actions .solid-button')?.click();
    });
    await flushAsync();

    const assistantMessages = rendered.container.querySelectorAll('.ai-desktop-view .ai-message-assistant');
    expect(assistantMessages).toHaveLength(1);
    const text = assistantMessages[0]?.textContent ?? '';
    expect(text.match(/确认完成，我继续整理下一步。/g) ?? []).toHaveLength(1);
    rendered.unmount();
  });

  it('keeps approval continuation text below the confirmed draft after final response settles', async () => {
    const pending = approval();
    const approved = { ...pending, status: 'approved' as const, decision: 'approved' as const, submitted_values: pending.initial_values };
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([
      {
        id: 'message-1',
        conversation_id: 'conversation-1',
        role: 'assistant',
        content: '我先根据图片整理第 1 份菜谱「白切鸡」草稿。',
        content_type: 'parts',
        parts: [
          { id: 'text-1', type: 'text', text: '我先根据图片整理第 1 份菜谱「白切鸡」草稿。' },
          {
            id: 'activity-before-approval',
            type: 'run_activity',
            activity: {
              id: 'progress-before-approval',
              run_id: 'run-1',
              type: 'script',
              internal_code: 'script.lint_recipe_draft',
              user_message: '调用脚本「lint_recipe_draft」',
              status: 'completed',
              created_at: '2026-05-30T00:00:00Z',
            },
          },
          { id: 'approval-part-1', type: 'approval_request', approval: pending },
        ],
        run_id: 'run-1',
        status: 'waiting_approval',
        metadata: {},
        created_at: '2026-05-30T00:00:00Z',
      },
    ]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValueOnce([pending]).mockResolvedValue([]);
    vi.spyOn(api, 'decideAiApproval').mockResolvedValue({
      approval: approved,
      draft: {
        id: pending.draft_id,
        conversation_id: pending.conversation_id,
        message_id: pending.message_id,
        run_id: pending.run_id,
        draft_type: 'recipe',
        payload: pending.initial_values.recipe ?? {},
        preview_summary: '白切鸡',
        status: 'confirmed',
        version: pending.draft_version,
        schema_version: 'recipe.v1',
        validation_errors: [],
        expires_at: null,
        created_at: '2026-05-30T00:00:00Z',
        updated_at: '2026-05-30T00:00:00Z',
      },
      operation: { status: 'succeeded' },
      business_entity: {},
    });
    const finalResponse: AiChatResponse = {
      conversation_id: 'conversation-1',
      message: {
        id: 'message-1',
        conversation_id: 'conversation-1',
        role: 'assistant',
        content: '已创建「白切鸡」。接下来我继续根据图片整理第 2 份菜谱「榨菜咸肉烧丝瓜」草稿，一次仍只提交一份，待你确认后再继续下一道。',
        content_type: 'parts',
        parts: [
          {
            id: 'resume-text-after-operation',
            type: 'text',
            text: '已创建「白切鸡」。接下来我继续根据图片整理第 2 份菜谱「榨菜咸肉烧丝瓜」草稿，一次仍只提交一份，待你确认后再继续下一道。',
          },
          { id: 'approval-part-1', type: 'approval_request', approval: approved },
          {
            id: 'operation-result-part-1',
            type: 'result_card',
            card: {
              id: 'operation-result-card-1',
              type: 'operation_result',
              title: '已创建菜谱',
              data: {
                approvalId: pending.id,
                actionSummary: '白切鸡已写入菜谱库。',
                entityCount: 1,
                entityCountLabel: '1 个菜谱',
                workspaceLabel: '菜谱库',
              },
            } as AiResultCard,
          },
        ],
        run_id: 'run-1',
        status: 'completed',
        metadata: {},
        created_at: '2026-05-30T00:00:00Z',
      },
      run: {
        id: 'run-1',
        agent_key: 'workspace_orchestrator',
        intent: 'multi_skill',
        status: 'completed',
        model: 'rules',
        created_at: '2026-05-30T00:00:00Z',
      },
      events: [],
      included: { result_cards: [], drafts: [], approvals: [] },
    };
    vi.spyOn(api, 'streamAiApprovalDecision').mockImplementation(async (_conversationId, _approvalId, _payload, handlers) => {
      handlers?.onMessagePart?.({
        message_id: 'message-1',
        conversation_id: 'conversation-1',
        run_id: 'run-1',
        part: finalResponse.message.parts[2],
      });
      handlers?.onMessageDelta?.({
        message_id: 'message-1',
        conversation_id: 'conversation-1',
        run_id: 'run-1',
        part_id: 'resume-text-after-operation',
        delta: '已创建「白切鸡」。接下来我继续根据图片整理第 2 份菜谱「榨菜咸肉烧丝瓜」草稿，一次仍只提交一份，待你确认后再继续下一道。',
      });
      return finalResponse;
    });
    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flushAsync();
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-desktop-view .ai-approval-actions .solid-button')?.click();
    });
    await flushAsync();

    const messageBody = rendered.container.querySelector<HTMLElement>('.ai-desktop-view .ai-message-assistant .ai-message-body') as HTMLElement;
    const continuationText = Array.from(messageBody.querySelectorAll<HTMLElement>('.ai-message-text-block'))
      .find((block) => block.textContent?.includes('接下来我继续根据图片整理第 2 份菜谱')) as HTMLElement;
    const operationCard = messageBody.querySelector<HTMLElement>('.ai-operation-result-card') as HTMLElement;
    expect(operationCard.textContent).toContain('已创建菜谱');
    expect(operationCard.compareDocumentPosition(continuationText) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    rendered.unmount();
  });

  it('keeps thinking below an approval operation result until the continuation emits content', async () => {
    vi.useFakeTimers();
    const pending = approval();
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([
      {
        id: 'message-1',
        conversation_id: 'conversation-1',
        role: 'assistant',
        content: '菜谱草稿已经生成，请确认。',
        content_type: 'parts',
        parts: [
          { id: 'text-1', type: 'text', text: '菜谱草稿已经生成，请确认。' },
          { id: 'approval-part-1', type: 'approval_request', approval: pending },
        ],
        run_id: 'run-1',
        status: 'waiting_approval',
        metadata: {},
        created_at: '2026-05-30T00:00:00Z',
      },
    ]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValueOnce([pending]).mockResolvedValue([]);
    vi.spyOn(api, 'decideAiApproval').mockResolvedValue({
      approval: { ...pending, status: 'approved', decision: 'approved', submitted_values: pending.initial_values },
      draft: {
        id: pending.draft_id,
        conversation_id: pending.conversation_id,
        message_id: pending.message_id,
        run_id: pending.run_id,
        draft_type: 'recipe',
        payload: pending.initial_values.recipe ?? {},
        preview_summary: '菜谱草稿',
        status: 'confirmed',
        version: pending.draft_version,
        schema_version: 'recipe.v1',
        validation_errors: [],
        expires_at: null,
        created_at: '2026-05-30T00:00:00Z',
        updated_at: '2026-05-30T00:00:00Z',
      },
      operation: { status: 'succeeded' },
      business_entity: {},
    });
    let streamHandlers: Parameters<typeof api.streamAiApprovalDecision>[3] | undefined;
    vi.spyOn(api, 'streamAiApprovalDecision').mockImplementation(async (_conversationId, _approvalId, _payload, handlers) => {
      streamHandlers = handlers;
      handlers?.onMessagePart?.({
        message_id: 'message-1',
        conversation_id: 'conversation-1',
        run_id: 'run-1',
        part: {
          id: 'operation-result-part-1',
          type: 'result_card',
          card: {
            id: 'operation-result-card-1',
            type: 'operation_result',
            title: '已创建菜谱',
            data: {
              approvalId: pending.id,
              actionSummary: '番茄鸡蛋面已写入菜谱库。',
              entityCount: 1,
              entityCountLabel: '1 道菜谱',
              workspaceLabel: '菜谱库',
            },
          } as AiResultCard,
        },
      });
      return new Promise<AiChatResponse>(() => undefined);
    });
    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await advanceTimers(0);
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-desktop-view .ai-approval-actions .solid-button')?.click();
    });
    await advanceTimers(300);

    const desktopBody = rendered.container.querySelector<HTMLElement>('.ai-desktop-view .ai-message-assistant .ai-message-body') as HTMLElement;
    const operationCard = desktopBody.querySelector<HTMLElement>('.ai-operation-result-card') as HTMLElement;
    const thinkingCue = desktopBody.querySelector<HTMLElement>('.ai-thinking-cue') as HTMLElement;
    expect(operationCard?.textContent).toContain('已创建菜谱');
    expect(thinkingCue?.textContent).toContain('正在思考');
    expect(operationCard.compareDocumentPosition(thinkingCue) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(rendered.container.textContent).not.toContain('请先确认上面的草稿，确认后可以继续对话。');
    expect(Array.from(rendered.container.querySelectorAll<HTMLTextAreaElement>('.ai-composer textarea')).every((textarea) => !textarea.disabled)).toBe(true);
    expect(Array.from(rendered.container.querySelectorAll<HTMLButtonElement>('.ai-send-button')).every((button) => button.getAttribute('aria-label') === '中止生成')).toBe(true);

    await act(async () => {
      streamHandlers?.onMessageDelta?.({
        message_id: 'message-1',
        conversation_id: 'conversation-1',
        run_id: 'run-1',
        part_id: 'resume-text-after-operation',
        delta: '接下来我继续处理下一道菜。',
      });
    });
    await advanceTimers(0);
    expect(rendered.container.textContent).toContain('接下来我继续处理下一道菜。');
    expect(rendered.container.querySelector('.ai-thinking-cue')).toBeNull();
    rendered.unmount();
  });

  it('keeps mobile approval continuation text after existing approval parts when the delta part id collides', async () => {
    const pending = approval();
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([
      {
        id: 'message-1',
        conversation_id: 'conversation-1',
        role: 'assistant',
        content: '我会先整理第一份菜谱。',
        content_type: 'parts',
        parts: [
          { id: 'shared-text-part', type: 'text', text: '我会先整理第一份菜谱。' },
          {
            id: 'activity-before-approval',
            type: 'run_activity',
            activity: {
              id: 'progress-before-approval',
              run_id: 'run-1',
              type: 'script',
              internal_code: 'script.lint_recipe_draft',
              user_message: '调用脚本「lint_recipe_draft」',
              status: 'completed',
              created_at: '2026-05-30T00:00:00Z',
            },
          },
          { id: 'approval-part-1', type: 'approval_request', approval: pending },
        ],
        run_id: 'run-1',
        status: 'waiting_approval',
        metadata: {},
        created_at: '2026-05-30T00:00:00Z',
      },
    ]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValueOnce([pending]).mockResolvedValue([]);
    vi.spyOn(api, 'decideAiApproval').mockResolvedValue({
      approval: { ...pending, status: 'approved', decision: 'approved', submitted_values: pending.initial_values },
      draft: {
        id: pending.draft_id,
        conversation_id: pending.conversation_id,
        message_id: pending.message_id,
        run_id: pending.run_id,
        draft_type: 'recipe',
        payload: pending.initial_values.recipe ?? {},
        preview_summary: '菜谱草稿',
        status: 'confirmed',
        version: pending.draft_version,
        schema_version: 'recipe.v1',
        validation_errors: [],
        expires_at: null,
        created_at: '2026-05-30T00:00:00Z',
        updated_at: '2026-05-30T00:00:00Z',
      },
      operation: { status: 'succeeded' },
      business_entity: {},
    });
    let streamHandlers: Parameters<typeof api.streamAiApprovalDecision>[3] | undefined;
    vi.spyOn(api, 'streamAiApprovalDecision').mockImplementation(async (_conversationId, _approvalId, _payload, handlers) => {
      streamHandlers = handlers;
      handlers?.onMessagePart?.({
        message_id: 'message-1',
        conversation_id: 'conversation-1',
        run_id: 'run-1',
        part: {
          id: 'operation-result-part-1',
          type: 'result_card',
          card: {
            id: 'operation-result-card-1',
            type: 'operation_result',
            title: '已创建菜谱',
            data: {
              approvalId: pending.id,
              actionSummary: '白切鸡已写入菜谱库。',
              entityCount: 1,
              entityCountLabel: '1 道菜谱',
              workspaceLabel: '菜谱库',
            },
          } as AiResultCard,
        },
      });
      return new Promise<AiChatResponse>(() => undefined);
    });
    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flushAsync();
    const mobileView = rendered.container.querySelector('.ai-mobile-page') as HTMLElement;
    await act(async () => {
      mobileView.querySelector<HTMLButtonElement>('.ai-approval-actions .solid-button')?.click();
      await Promise.resolve();
    });
    await flushAsync();

    await act(async () => {
      streamHandlers?.onMessageDelta?.({
        message_id: 'message-1',
        conversation_id: 'conversation-1',
        run_id: 'run-1',
        part_id: 'shared-text-part',
        delta: '已创建「白切鸡」。接下来我继续整理第二份菜。',
      });
    });
    await flushAsync();

    const mobileBody = mobileView.querySelector<HTMLElement>('.ai-message-assistant .ai-message-body') as HTMLElement;
    const operationCard = mobileBody.querySelector<HTMLElement>('.ai-operation-result-card') as HTMLElement;
    const textBlocks = Array.from(mobileBody.querySelectorAll<HTMLElement>('.ai-message-text-block'));
    const firstTextBlock = textBlocks.find((block) => block.textContent?.includes('我会先整理第一份菜谱')) as HTMLElement;
    const continuationTextBlock = textBlocks.find((block) => block.textContent?.includes('接下来我继续整理第二份菜')) as HTMLElement;
    expect(firstTextBlock.textContent).not.toContain('接下来我继续整理第二份菜');
    expect(operationCard.textContent).toContain('已创建菜谱');
    expect(operationCard.compareDocumentPosition(continuationTextBlock) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    vi.useFakeTimers();
    await act(async () => {
      streamHandlers?.onMessagePart?.({
        message_id: 'message-1',
        conversation_id: 'conversation-1',
        run_id: 'run-1',
        part: {
          id: 'activity-after-continuation',
          type: 'run_activity',
          activity: {
            id: 'progress-before-approval',
            run_id: 'run-1',
            type: 'script',
            internal_code: 'script.lint_recipe_draft',
            user_message: '调用脚本「lint_recipe_draft」',
            status: 'running',
            created_at: '2026-05-30T00:00:02Z',
          },
        },
      });
    });
    await advanceTimers(0);

    const updatedMobileBody = mobileView.querySelector<HTMLElement>('.ai-message-assistant .ai-message-body') as HTMLElement;
    const updatedTextBlocks = Array.from(updatedMobileBody.querySelectorAll<HTMLElement>('.ai-message-text-block'));
    const updatedContinuationTextBlock = updatedTextBlocks.find((block) => block.textContent?.includes('接下来我继续整理第二份菜')) as HTMLElement;
    const scriptActivityRows = Array.from(updatedMobileBody.querySelectorAll<HTMLElement>('.ai-run-activity'))
      .filter((activity) => activity.textContent?.includes('lint_recipe_draft'));
    expect(scriptActivityRows).toHaveLength(1);
    expect(updatedContinuationTextBlock.compareDocumentPosition(scriptActivityRows[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await advanceTimers(300);
    const rerenderedMobileBody = mobileView.querySelector<HTMLElement>('.ai-message-assistant .ai-message-body') as HTMLElement;
    const rerenderedContinuationTextBlock = Array.from(rerenderedMobileBody.querySelectorAll<HTMLElement>('.ai-message-text-block'))
      .find((block) => block.textContent?.includes('接下来我继续整理第二份菜')) as HTMLElement;
    const rerenderedScriptActivityRows = Array.from(rerenderedMobileBody.querySelectorAll<HTMLElement>('.ai-run-activity'))
      .filter((activity) => activity.textContent?.includes('lint_recipe_draft'));
    expect(rerenderedScriptActivityRows).toHaveLength(1);
    expect(rerenderedContinuationTextBlock.compareDocumentPosition(rerenderedScriptActivityRows[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    rendered.unmount();
  });

  it('merges a restored approval into its original assistant message', async () => {
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([
      {
        id: 'message-1',
        conversation_id: 'conversation-1',
        role: 'assistant',
        content: '菜谱草稿已经生成，请确认。',
        content_type: 'parts',
        parts: [{ id: 'text-1', type: 'text', text: '菜谱草稿已经生成，请确认。' }],
        run_id: 'run-1',
        status: 'completed',
        metadata: {},
        created_at: '2026-05-30T00:00:00Z',
      },
    ]);
    vi.spyOn(api, 'getAiRunEvents').mockResolvedValue([]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([approval()]);
    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flushAsync();
    expect(rendered.container.querySelectorAll('.ai-desktop-view .ai-message-assistant')).toHaveLength(1);
    expect(rendered.container.querySelectorAll('.ai-mobile-page .ai-message-assistant')).toHaveLength(1);
    expect(rendered.container.textContent).toContain('菜谱草稿已经生成，请确认。');
    expect(rendered.container.textContent).toContain('确认创建菜谱');
    expect(rendered.container.textContent).not.toContain('待处理确认');
    rendered.unmount();
  });

  it('renders assistant text parts as markdown', async () => {
    await act(async () => {
      await import('./MarkdownMessage');
    });
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([
      {
        id: 'message-1',
        conversation_id: 'conversation-1',
        role: 'assistant',
        content: '**晚餐建议**\n\n- 番茄鸡蛋面\n\n记得用 `小火`。',
        content_type: 'parts',
        parts: [{ id: 'text-1', type: 'text', text: '**晚餐建议**\n\n- 番茄鸡蛋面\n\n记得用 `小火`。' }],
        run_id: null,
        status: 'completed',
        metadata: {},
        created_at: '2026-05-30T00:00:00Z',
      },
    ]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flushAsync();
    await flushAsync();
    const desktopView = rendered.container.querySelector('.ai-desktop-view') as HTMLElement;
    expect(desktopView.querySelector('.ai-message-markdown strong')?.textContent).toBe('晚餐建议');
    expect(desktopView.querySelector('.ai-message-markdown li')?.textContent).toBe('番茄鸡蛋面');
    expect(desktopView.querySelector('.ai-message-markdown code')?.textContent).toBe('小火');
    rendered.unmount();
  });

  it('restores collapsed run progress when reopening a conversation', async () => {
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([
      {
        id: 'message-1',
        conversation_id: 'conversation-1',
        role: 'assistant',
        content: '已安排好晚餐。',
        content_type: 'parts',
        parts: [{ id: 'text-1', type: 'text', text: '已安排好晚餐。' }],
        run_id: 'run-1',
        status: 'completed',
        metadata: {},
        created_at: '2026-05-30T00:00:00Z',
      },
    ]);
    vi.spyOn(api, 'getAiRunEvents').mockResolvedValue([
      {
        id: 'progress-skill',
        run_id: 'run-1',
        type: 'skill',
        internal_code: 'meal_plan.start',
        user_message: '调用「餐食计划」技能',
        status: 'completed',
        created_at: '2026-05-30T00:00:00Z',
      },
      {
        id: 'progress-tool',
        run_id: 'run-1',
        type: 'tool',
        internal_code: 'inventory.read_available_items',
        user_message: '调用「可用库存」',
        status: 'completed',
        created_at: '2026-05-30T00:00:01Z',
      },
    ]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flushAsync();
    await flushAsync();
    const desktopView = rendered.container.querySelector('.ai-desktop-view') as HTMLElement;
    const activityText = Array.from(desktopView.querySelectorAll<HTMLElement>('.ai-run-activity')).map((item) => item.textContent).join('\n');
    expect(activityText).toContain('餐食计划');
    expect(activityText).toContain('调用「可用库存」');
    expect(desktopView.querySelector('.ai-run-activity-toggle')).toBeNull();
    expect(desktopView.querySelector('.ai-run-activity-detail')).toBeNull();
    rendered.unmount();
  });

  it('shows a confirmation modal before deleting a conversation from history', async () => {
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
    const deleteSpy = vi.spyOn(api, 'deleteAiConversation').mockResolvedValue(undefined);
    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('[aria-label^="管理会话"]')?.click();
    });
    await flushAsync();
    await act(async () => {
      Array.from(rendered.container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
        .find((button) => button.textContent?.includes('删除'))
        ?.click();
    });
    await flushAsync();
    expect(rendered.container.textContent).toContain('删除这条历史？');
    expect(rendered.container.textContent).toContain('帮我生成菜谱');
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-delete-confirm-actions .solid-button')?.click();
    });
    await flushAsync();
    expect(deleteSpy.mock.calls[0]?.[0]).toBe('conversation-1');
    rendered.unmount();
  });

  it('shows owner controls only on owned conversations', async () => {
    const owned = conversation({ visibility: 'private', is_owner: true });
    const shared = conversation({ id: 'conversation-shared', visibility: 'family', is_owner: false, owner_display_name: '家人' });
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
    const rendered = await renderWithQuery(<AiWorkspace conversations={[owned, shared]} isLoading={false} />);
    await flushAsync();
    expect(rendered.container.textContent).toContain('家庭公开');
    expect(rendered.container.textContent).toContain('家人');
    expect(rendered.container.querySelectorAll('[aria-label^="管理会话"]')).toHaveLength(1);
    rendered.unmount();
  });

  it('closes the manage menu when another conversation is selected', async () => {
    const first = conversation({ id: 'conversation-1', title: '第一会话', prompt: '第一会话' });
    const second = conversation({ id: 'conversation-2', title: '第二会话', prompt: '第二会话' });
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
    const rendered = await renderWithQuery(<AiWorkspace conversations={[first, second]} isLoading={false} />);
    await flushAsync();

    const desktopView = rendered.container.querySelector('.ai-desktop-view') as HTMLElement;
    const manageButtons = Array.from(desktopView.querySelectorAll<HTMLButtonElement>('[aria-label^="管理会话"]'));
    expect(manageButtons).toHaveLength(2);

    await act(async () => {
      manageButtons[0]?.click();
    });
    await flushAsync();
    expect(manageButtons[0]?.getAttribute('aria-expanded')).toBe('true');
    expect(desktopView.querySelector('.ai-conversation-action-menu')).not.toBeNull();

    const secondMain = Array.from(desktopView.querySelectorAll<HTMLButtonElement>('.ai-conversation-main'))
      .find((button) => button.textContent?.includes('第二会话'));
    await act(async () => {
      secondMain?.click();
    });
    await flushAsync();

    expect(manageButtons[0]?.getAttribute('aria-expanded')).toBe('false');
    expect(desktopView.querySelector('.ai-conversation-action-menu')).toBeNull();
    rendered.unmount();
  });

  it('deduplicates rapid stop clicks for one run', async () => {
    const pendingCancellation = deferred<AiRunCancellationResponse>();
    const cancel = vi.fn(() => pendingCancellation.promise);
    vi.spyOn(api, 'cancelAiRun').mockImplementation(cancel);
    vi.spyOn(aiApi, 'cancelAiRun').mockImplementation(cancel);
    const active = await renderActiveWorkspaceStream();
    const stopButton = active.rendered.container.querySelector<HTMLButtonElement>('.ai-desktop-view .ai-send-button');

    act(() => {
      stopButton?.click();
      stopButton?.click();
    });

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(active.streamSignal?.aborted).toBe(false);
    await act(async () => {
      pendingCancellation.resolve(cancellationResponse(active.runId, 'cancelled'));
      await pendingCancellation.promise;
    });
    await flushAsync();
    expect(active.streamSignal?.aborted).toBe(true);
    active.rendered.unmount();
  });

  it('shows cancelling for 202 and waits for backend cancelled status', async () => {
    const post = deferred<AiRunCancellationResponse>();
    const get = deferred<AiRunCancellationResponse>();
    const cancel = vi.fn(() => post.promise);
    vi.spyOn(api, 'cancelAiRun').mockImplementation(cancel);
    vi.spyOn(aiApi, 'cancelAiRun').mockImplementation(cancel);
    vi.spyOn(aiApi, 'getAiRunCancellation').mockReturnValue(get.promise);
    const active = await renderActiveWorkspaceStream();
    vi.useFakeTimers();

    act(() => {
      active.rendered.container.querySelector<HTMLButtonElement>('.ai-desktop-view .ai-send-button')?.click();
    });
    await act(async () => {
      post.resolve(cancellationResponse(active.runId, 'cancel_requested'));
      await Promise.resolve();
    });

    const stoppingButton = active.rendered.container.querySelector<HTMLButtonElement>('.ai-desktop-view .ai-send-button');
    expect(stoppingButton?.getAttribute('aria-label')).toContain('正在停止');
    expect(stoppingButton?.disabled).toBe(true);
    expect(active.rendered.container.textContent).not.toContain('已取消这次任务');
    expect(active.streamSignal?.aborted).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
      get.resolve(cancellationResponse(active.runId, 'cancelled'));
      await Promise.resolve();
    });
    vi.useRealTimers();
    await flushAsync();
    expect(active.rendered.container.textContent).toContain('已取消这次任务');
    active.rendered.unmount();
  });

  it.each([404, 409, 500])('keeps the stream alive when cancel returns %s', async (status) => {
    const error = new ApiError({
      status,
      detail: `停止失败 ${status}`,
      path: '/api/ai/runs/run-failure/cancel',
      payload: {},
    });
    const cancel = vi.fn().mockRejectedValue(error);
    vi.spyOn(api, 'cancelAiRun').mockImplementation(cancel);
    vi.spyOn(aiApi, 'cancelAiRun').mockImplementation(cancel);
    const active = await renderActiveWorkspaceStream();

    await act(async () => {
      active.rendered.container.querySelector<HTMLButtonElement>('.ai-desktop-view .ai-send-button')?.click();
      await Promise.resolve();
    });
    await flushAsync();

    expect(active.streamSignal?.aborted).toBe(false);
    expect(active.rendered.container.querySelector('[role="alert"]')?.textContent).toContain(`停止失败 ${status}`);
    expect(active.rendered.container.textContent).not.toContain('已取消这次任务');
    expect(active.rendered.container.textContent).not.toContain('user_cancel');
    active.rendered.unmount();
  });

  it('does not render approval AbortError after accepted cancellation', async () => {
    const pending = approval();
    const pendingMessage: AiMessage = {
      id: pending.message_id as string,
      conversation_id: pending.conversation_id,
      role: 'assistant',
      content: '菜谱草稿已经生成，请确认。',
      content_type: 'parts',
      parts: [
        { id: 'approval-text', type: 'text', text: '菜谱草稿已经生成，请确认。' },
        { id: 'approval-part', type: 'approval_request', approval: pending },
      ],
      run_id: pending.run_id,
      status: 'waiting_approval',
      metadata: {},
      created_at: '2026-07-23T00:00:00Z',
    };
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([pendingMessage]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([pending]);
    let approvalSignal: AbortSignal | undefined;
    vi.spyOn(api, 'streamAiApprovalDecision').mockImplementation((_conversationId, _approvalId, _payload, handlers) => {
      approvalSignal = handlers?.signal;
      return new Promise<AiChatResponse>((_resolve, reject) => {
        handlers?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')));
      });
    });
    vi.spyOn(aiApi, 'cancelAiRun').mockImplementation((runId) => Promise.resolve(cancellationResponse(runId, 'cancelled')));
    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flushAsync();

    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-desktop-view .ai-approval-actions .solid-button')?.click();
      await Promise.resolve();
    });
    await flushAsync();
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-desktop-view .ai-send-button')?.click();
      await Promise.resolve();
    });
    await flushAsync();

    expect(approvalSignal?.aborted).toBe(true);
    expect(rendered.container.textContent).not.toContain('AbortError');
    expect(rendered.container.textContent).not.toContain('The operation was aborted');
    expect(rendered.container.textContent).not.toContain('AI 后续处理失败');
    rendered.unmount();
  });

  it('does not render human input AbortError or a submitted answer after accepted cancellation', async () => {
    const requestPart: AiMessage['parts'][number] = {
      id: 'human-input-part-cancel',
      type: 'human_input_request',
      status: 'pending',
      request: {
        id: 'human-input-cancel',
        question: '你想安排几天？',
        inputMode: 'choice',
        options: [{ id: 'three-days', label: '三天' }],
        allowMultiple: false,
        required: true,
        reason: null,
        sourceSkills: ['meal_plan'],
        resumeHint: {},
      },
    };
    const pendingMessage: AiMessage = {
      id: 'message-human-input-cancel',
      conversation_id: 'conversation-1',
      role: 'assistant',
      content: '你想安排几天？',
      content_type: 'parts',
      parts: [{ id: 'human-input-text-cancel', type: 'text', text: '你想安排几天？' }, requestPart],
      run_id: 'run-human-input-cancel',
      status: 'waiting_input',
      metadata: {},
      created_at: '2026-07-23T00:00:00Z',
    };
    const cancelledMessage: AiMessage = {
      ...pendingMessage,
      status: 'cancelled',
      parts: pendingMessage.parts.map((part) => (
        part.type === 'human_input_request'
          ? { ...part, status: 'cancelled' as const }
          : part
      )),
    };
    let messageReads = 0;
    vi.spyOn(api, 'getAiMessages').mockImplementation(async () => {
      messageReads += 1;
      return messageReads === 1 ? [pendingMessage] : [cancelledMessage];
    });
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
    let inputSignal: AbortSignal | undefined;
    vi.spyOn(api, 'streamAiHumanInputResponse').mockImplementation((_conversationId, _requestId, _payload, handlers) => {
      inputSignal = handlers?.signal;
      return new Promise<AiChatResponse>((_resolve, reject) => {
        handlers?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')));
      });
    });
    vi.spyOn(aiApi, 'cancelAiRun').mockImplementation((runId) => Promise.resolve(cancellationResponse(runId, 'cancelled')));
    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flushAsync();

    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-desktop-view .ai-clarification-option')?.click();
      await Promise.resolve();
    });
    await flushAsync();
    expect(rendered.container.querySelector('.ai-desktop-view .ai-human-input-answer-summary')?.textContent).toContain('三天');
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-desktop-view .ai-send-button')?.click();
      await Promise.resolve();
    });
    await flushAsync();
    await flushAsync();

    expect(inputSignal?.aborted).toBe(true);
    expect(rendered.container.textContent).not.toContain('AbortError');
    expect(rendered.container.textContent).not.toContain('The operation was aborted');
    expect(rendered.container.querySelector('.ai-desktop-view .ai-human-input-answer-summary')).toBeNull();
    rendered.unmount();
  });

  it('restores cancelled status from refreshed messages', async () => {
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([{
      id: 'message-refreshed-cancelled',
      conversation_id: 'conversation-1',
      role: 'assistant',
      content: '你想安排几天？',
      content_type: 'parts',
      parts: [{
        id: 'human-input-refreshed-cancelled',
        type: 'human_input_request',
        status: 'cancelled',
        request: {
          id: 'request-refreshed-cancelled',
          question: '你想安排几天？',
          inputMode: 'choice',
          options: [{ id: 'three-days', label: '三天' }],
          allowMultiple: false,
          required: true,
          reason: null,
          sourceSkills: ['meal_plan'],
          resumeHint: {},
        },
      }],
      run_id: 'run-refreshed-cancelled',
      status: 'cancelled',
      metadata: {},
      created_at: '2026-07-23T00:00:00Z',
    }]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
    const rendered = await renderWithQuery(
      <AiWorkspace
        conversations={[conversation({ context: {}, last_run_status: 'cancelled' })]}
        isLoading={false}
      />,
    );
    await flushAsync();

    expect(rendered.container.textContent).toContain('任务已取消，未提交回答');
    expect(
      Array.from(rendered.container.querySelectorAll<HTMLButtonElement>('.ai-desktop-view .ai-clarification-option'))
        .every((button) => button.disabled),
    ).toBe(true);
    expect(rendered.container.querySelector<HTMLButtonElement>('.ai-desktop-view .ai-send-button')?.getAttribute('aria-label')).toBe('发送消息');
    rendered.unmount();
  });

  it('cancels the server run for an in-flight streamed message', async () => {
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
    let streamAborted = false;
    vi.spyOn(api, 'streamChatAi').mockImplementation(async (_payload, handlers) => {
      handlers?.onProgress?.({
        id: 'progress-1',
        run_id: 'pending',
        type: 'skill',
        internal_code: 'meal_plan.start',
        user_message: '调用「餐食计划」技能',
        status: 'running',
        created_at: '2026-05-30T00:00:00Z',
      });
      await new Promise<void>((_resolve, reject) => {
        handlers?.signal?.addEventListener('abort', () => {
          streamAborted = true;
          reject(new Error('BodyStreamBuffer was aborted'));
        });
      });
      throw new Error('stream unexpectedly resolved');
    });
    const cancelSpy = vi.spyOn(aiApi, 'cancelAiRun').mockResolvedValue({
      outcome: 'cancelled',
      request: {
        run_id: 'agent_run-client',
        status: 'applied',
        requested_at: '2026-05-30T00:00:00Z',
      },
      run: {
        id: 'agent_run-client',
        agent_key: 'workspace_orchestrator',
        intent: 'workspace_orchestrator',
        status: 'cancelled',
        model: 'fake',
        created_at: '2026-05-30T00:00:00Z',
      },
      events: [
        {
          id: 'cancel-event',
          run_id: 'agent_run-client',
          type: 'cancel',
          internal_code: 'user_cancel',
          user_message: '已取消这次任务',
          status: 'cancelled',
          created_at: '2026-05-30T00:00:00Z',
        },
      ],
    });
    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flushAsync();
    changeInput(rendered.container.querySelector<HTMLTextAreaElement>('textarea.text-input') as HTMLTextAreaElement, '安排三天晚餐');
    await act(async () => {
      rendered.container.querySelector<HTMLFormElement>('form.ai-composer')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flushAsync();
    await flushAsync();
    expect(rendered.container.textContent).toContain('餐食计划');
    expect(rendered.container.textContent).not.toContain('等待工具调用');
    expect(rendered.container.querySelector('.ai-run-activity-row.kind-tool')).toBeNull();
    expect(rendered.container.querySelector('.ai-stream-progress-strip')).toBeNull();
    expect(rendered.container.querySelector<HTMLButtonElement>('.ai-send-button')?.getAttribute('aria-label')).toBe('中止生成');
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-send-button')?.click();
    });
    await flushAsync();
    expect(cancelSpy.mock.calls[0]?.[0]).toMatch(/^agent_run-/);
    expect(streamAborted).toBe(true);
    expect(rendered.container.textContent).toContain('已取消这次任务');
    expect(rendered.container.textContent).not.toContain('BodyStreamBuffer was aborted');
    rendered.unmount();
  });

  it('shows a local thinking cue until the first streamed delta or active tool progress', async () => {
    vi.useFakeTimers();
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
    let resolveStream: ((response: AiChatResponse) => void) | null = null;
    let streamHandlers: Parameters<typeof api.streamChatAi>[1] | undefined;
    let streamedRunId = 'agent_run-client';
    vi.spyOn(api, 'streamChatAi').mockImplementation(async (payload, handlers) => {
      streamedRunId = payload.client_run_id ?? streamedRunId;
      streamHandlers = handlers;
      return new Promise<AiChatResponse>((resolve) => {
        resolveStream = resolve;
      });
    });
    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await advanceTimers(0);
    changeInput(rendered.container.querySelector<HTMLTextAreaElement>('textarea.text-input') as HTMLTextAreaElement, '安排三天晚餐');
    await act(async () => {
      rendered.container.querySelector<HTMLFormElement>('form.ai-composer')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await advanceTimers(299);
    expect(rendered.container.querySelector('.ai-thinking-cue')).toBeNull();
    await advanceTimers(1);
    expect(rendered.container.querySelector('.ai-desktop-view .ai-thinking-cue')?.textContent).toContain('正在思考');
    expect(rendered.container.querySelector('.ai-mobile-page .ai-thinking-cue')?.textContent).toContain('正在思考');

    await act(async () => {
      streamHandlers?.onProgress?.({
        id: 'progress-tool-running',
        run_id: streamedRunId,
        type: 'tool',
        internal_code: 'inventory.read_available_items',
        user_message: '调用「可用库存」',
        status: 'running',
        created_at: '2026-05-30T00:00:00Z',
      });
    });
    await advanceTimers(0);
    expect(rendered.container.querySelector('.ai-thinking-cue')).toBeNull();
    expect(rendered.container.textContent).toContain('调用「可用库存」');

    await act(async () => {
      resolveStream?.({
        conversation_id: 'conversation-1',
        message: {
          id: 'message-final-thinking',
          conversation_id: 'conversation-1',
          role: 'assistant',
          content: '已整理好建议。',
          content_type: 'parts',
          parts: [{ id: 'part-final-thinking', type: 'text', text: '已整理好建议。' }],
          run_id: streamedRunId,
          status: 'completed',
          metadata: {},
          created_at: '2026-05-30T00:00:00Z',
        },
        run: {
          id: streamedRunId,
          agent_key: 'workspace_orchestrator',
          intent: 'multi_skill',
          status: 'completed',
          model: 'rules',
          created_at: '2026-05-30T00:00:00Z',
        },
        events: [],
        included: { result_cards: [], drafts: [], approvals: [] },
      });
    });
    await advanceTimers(0);
    expect(rendered.container.textContent).toContain('已整理好建议。');
    expect(rendered.container.querySelector('.ai-thinking-cue')).toBeNull();
    rendered.unmount();
  });

  it('shows a thinking cue between a completed tool call and the next streamed content', async () => {
    vi.useFakeTimers();
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
    let streamHandlers: Parameters<typeof api.streamChatAi>[1] | undefined;
    let streamedRunId = 'agent_run-client';
    vi.spyOn(api, 'streamChatAi').mockImplementation(async (payload, handlers) => {
      streamedRunId = payload.client_run_id ?? streamedRunId;
      streamHandlers = handlers;
      return new Promise<AiChatResponse>(() => undefined);
    });
    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await advanceTimers(0);
    changeInput(rendered.container.querySelector<HTMLTextAreaElement>('textarea.text-input') as HTMLTextAreaElement, '看看库存再安排晚餐');
    await act(async () => {
      rendered.container.querySelector<HTMLFormElement>('form.ai-composer')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await advanceTimers(300);
    expect(rendered.container.querySelector('.ai-desktop-view .ai-thinking-cue')?.textContent).toContain('正在思考');

    const runningTool: AiRunEvent = {
      id: 'progress-tool-gap',
      run_id: streamedRunId,
      type: 'tool',
      internal_code: 'inventory.read_available_items',
      user_message: '调用「可用库存」',
      status: 'running',
      created_at: '2026-05-30T00:00:00Z',
    };
    await act(async () => {
      streamHandlers?.onProgress?.(runningTool);
    });
    await advanceTimers(0);
    expect(rendered.container.querySelector('.ai-thinking-cue')).toBeNull();
    expect(rendered.container.textContent).toContain('调用「可用库存」');

    await act(async () => {
      streamHandlers?.onProgress?.({ ...runningTool, status: 'completed', created_at: '2026-05-30T00:00:01Z' });
    });
    await advanceTimers(299);
    expect(rendered.container.querySelector('.ai-thinking-cue')).toBeNull();
    await advanceTimers(1);
    expect(rendered.container.querySelector('.ai-desktop-view .ai-thinking-cue')?.textContent).toContain('正在思考');
    expect(rendered.container.querySelector('.ai-mobile-page .ai-thinking-cue')?.textContent).toContain('正在思考');

    await act(async () => {
      streamHandlers?.onMessageDelta?.({
        message_id: 'message-tool-gap',
        conversation_id: 'conversation-1',
        run_id: streamedRunId,
        part_id: 'part-tool-gap',
        delta: '已经看过库存，今晚可以安排番茄鸡蛋面。',
      });
    });
    await advanceTimers(0);
    expect(rendered.container.textContent).toContain('已经看过库存');
    expect(rendered.container.querySelector('.ai-thinking-cue')).toBeNull();
    rendered.unmount();
  });

  it('renders streamed progress in an assistant message before any text delta arrives', async () => {
    vi.useFakeTimers();
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
    let resolveStream: ((response: AiChatResponse) => void) | null = null;
    let streamedRunId = 'agent_run-client';
    vi.spyOn(api, 'streamChatAi').mockImplementation(async (payload, handlers) => {
      streamedRunId = payload.client_run_id ?? streamedRunId;
      const skillEvent = {
        id: 'progress-skill',
        run_id: streamedRunId,
        type: 'skill',
        internal_code: 'meal_plan.start',
        user_message: '调用「餐食计划」技能',
        status: 'running',
        created_at: '2026-05-30T00:00:00Z',
      } as const;
      const inventoryEvent = {
        id: 'progress-1',
        run_id: streamedRunId,
        type: 'tool',
        internal_code: 'inventory.read_available_items',
        user_message: '调用「可用库存」',
        status: 'completed',
        created_at: '2026-05-30T00:00:00Z',
      } as const;
      const draftEvent = {
        id: 'progress-2',
        run_id: streamedRunId,
        type: 'tool',
        internal_code: 'meal_plan.create_draft',
        user_message: '生成「餐食计划确认表单」',
        status: 'completed',
        created_at: '2026-05-30T00:00:00Z',
      } as const;
      handlers?.onMessagePart?.({ message_id: 'message-streaming-draft', conversation_id: payload.conversation_id ?? 'conversation-1', run_id: streamedRunId, part: { id: 'activity-progress-skill', type: 'run_activity', activity: skillEvent } });
      handlers?.onProgress?.(skillEvent);
      handlers?.onMessagePart?.({ message_id: 'message-streaming-draft', conversation_id: payload.conversation_id ?? 'conversation-1', run_id: streamedRunId, part: { id: 'activity-progress-1', type: 'run_activity', activity: inventoryEvent } });
      handlers?.onProgress?.(inventoryEvent);
      handlers?.onMessageDelta?.({
        message_id: 'message-streaming-draft',
        conversation_id: payload.conversation_id ?? 'conversation-1',
        run_id: streamedRunId,
        part_id: 'part-streaming-draft',
        delta: '我会先整理计划。',
      });
      handlers?.onMessagePart?.({ message_id: 'message-streaming-draft', conversation_id: payload.conversation_id ?? 'conversation-1', run_id: streamedRunId, part: { id: 'activity-progress-2', type: 'run_activity', activity: draftEvent } });
      handlers?.onProgress?.(draftEvent);
      return new Promise<AiChatResponse>((resolve) => {
        resolveStream = resolve;
      });
    });
    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await advanceTimers(0);
    changeInput(rendered.container.querySelector<HTMLTextAreaElement>('textarea.text-input') as HTMLTextAreaElement, '安排三天晚餐');
    await act(async () => {
      rendered.container.querySelector<HTMLFormElement>('form.ai-composer')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await advanceTimers(0);
    await advanceTimers(0);
    const desktopView = rendered.container.querySelector('.ai-desktop-view') as HTMLElement;
    const activity = desktopView.querySelector('.ai-run-activity') as HTMLElement;
    expect(rendered.container.querySelectorAll('.ai-desktop-view .ai-message-assistant')).toHaveLength(1);
    expect(activity.textContent).toContain('调用技能');
    expect(activity.textContent).toContain('餐食计划');
    expect(activity.textContent).not.toContain('调用「餐食计划」技能');
    expect(desktopView.textContent).toContain('正在准备可确认草稿');
    const messageBody = desktopView.querySelector('.ai-message-assistant .ai-message-body') as HTMLElement;
    const markdown = messageBody.querySelector('.ai-message-markdown') as HTMLElement;
    const draftCue = messageBody.querySelector('.ai-draft-generating-cue') as HTMLElement;
    expect(markdown.textContent).toContain('我会先整理计划。');
    expect(activity.compareDocumentPosition(markdown) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(markdown.compareDocumentPosition(draftCue) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(desktopView.querySelector('.ai-run-progress-bar')).toBeNull();
    expect(desktopView.querySelector('.ai-run-tool-marquee')).toBeNull();
    let activityRows = Array.from(desktopView.querySelectorAll<HTMLElement>('.ai-run-activity-summary .ai-run-activity-row'));
    expect(activityRows.map((row) => row.textContent)).toEqual(['调用技能：餐食计划', '调用「可用库存」', '生成「餐食计划确认表单」']);
    expect(activityRows[0]?.className).toContain('status-called');
    expect(activityRows[0]?.className).not.toContain('status-running');
    expect(activityRows[0]?.className).not.toContain('is-active');
    expect(activityRows[0]?.querySelector('.ai-run-skill-icon')).not.toBeNull();
    await advanceTimers(1999);
    activityRows = Array.from(desktopView.querySelectorAll<HTMLElement>('.ai-run-activity-summary .ai-run-activity-row'));
    expect(activityRows.map((row) => row.textContent)).toEqual(['调用技能：餐食计划', '调用「可用库存」', '生成「餐食计划确认表单」']);
    await advanceTimers(1);
    activityRows = Array.from(desktopView.querySelectorAll<HTMLElement>('.ai-run-activity-summary .ai-run-activity-row'));
    expect(activityRows.map((row) => row.textContent)).toEqual(['调用技能：餐食计划', '调用「可用库存」', '生成「餐食计划确认表单」']);
    expect(activityRows[2]?.className).toContain('kind-draft');
    expect(activityRows[2]?.querySelector('.ai-run-tool-icon.icon-form')).not.toBeNull();
    expect(activityRows[1]?.className).toContain('kind-tool');
    expect(activityRows[1]?.querySelector('.ai-run-tool-icon.icon-tool')).not.toBeNull();
    expect(desktopView.textContent).not.toContain('meal_plan.create_draft');
    expect(desktopView.querySelector('.ai-run-activity-toggle')).toBeNull();
    expect(desktopView.querySelector('.ai-run-activity-detail')).toBeNull();
    expect(rendered.container.querySelector('.ai-stream-progress-strip')).toBeNull();
    expect(desktopView.querySelector('.ai-run-step-status')).toBeNull();
    expect(desktopView.querySelector('.ai-run-step-type')).toBeNull();
    expect(desktopView.textContent).not.toContain('复制执行日志');
    expect(desktopView.textContent).not.toContain('展开执行细节');
    expect(desktopView.textContent).not.toContain('收起执行细节');
    await act(async () => {
      resolveStream?.({
        conversation_id: 'conversation-1',
        message: {
          id: 'message-final',
          conversation_id: 'conversation-1',
          role: 'assistant',
          content: '已安排好晚餐。',
          content_type: 'parts',
          parts: [{ id: 'part-final', type: 'text', text: '已安排好晚餐。' }],
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
    await advanceTimers(0);
    expect(rendered.container.textContent).toContain('已安排好晚餐。');
    const settledActivityText = Array.from(desktopView.querySelectorAll<HTMLElement>('.ai-run-activity')).map((item) => item.textContent).join('\n');
    expect(settledActivityText).toContain('调用技能');
    expect(settledActivityText).not.toContain('已完成：餐食计划');
    expect(settledActivityText).toContain('餐食计划');
    expect(settledActivityText).toContain('调用「可用库存」');
    expect(settledActivityText).toContain('生成「餐食计划确认表单」');
    expect(desktopView.textContent).not.toContain('正在准备可确认草稿');
    expect(desktopView.querySelector('.ai-run-activity-detail')).toBeNull();
    rendered.unmount();
  });

  it('does not render inventory intake candidate product-loop buttons', async () => {
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([
      {
        id: 'message-inventory-summary',
        conversation_id: 'conversation-1',
        role: 'assistant',
        content: '库存摘要。',
        content_type: 'parts',
        parts: [
          {
            id: 'part-inventory-summary',
            type: 'result_card',
            card: {
              id: 'inventory-summary-card',
              type: 'inventory_summary',
              title: '库存摘要',
              data: {
                items: [],
                availableCount: 0,
                expiringCount: 0,
                expiredCount: 0,
                lowStockCount: 0,
              },
            },
          },
        ],
        run_id: 'run-inventory-summary',
        status: 'completed',
        metadata: {},
        created_at: '2026-05-30T00:00:00Z',
      },
    ] as AiMessage[]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flushAsync();

    expect(rendered.container.textContent || '').not.toContain('按选中项准备入库');
    expect(
      Array.from(rendered.container.querySelectorAll<HTMLButtonElement>('button'))
        .some((button) => button.textContent?.includes('按选中项准备入库')),
    ).toBe(false);
    rendered.unmount();
  });
});
