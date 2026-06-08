import React, { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { AiApprovalRequest, AiChatResponse, AiConversation, AiGeneratedRecipeDraft } from '../../api/types';
import { AiWorkspace, ApprovalPanel } from './AiWorkspace';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function recipeDraft(title = '番茄鸡蛋面'): AiGeneratedRecipeDraft {
  return {
    title,
    servings: 2,
    prep_minutes: 20,
    difficulty: 'easy',
    ingredient_items: [{ ingredient_id: null, ingredient_name: '番茄', quantity: 2, unit: '个', note: '切块' }],
    steps: [
      { title: '备菜', text: '番茄切块。', icon: 'bowl', summary: '备菜', estimated_minutes: 5, tip: '', key_points: [] },
      { title: '烹调', text: '中火煮熟。', icon: 'pan', summary: '烹调', estimated_minutes: 10, tip: '', key_points: [] },
    ],
    tips: '少油少盐',
    scene_tags: ['家常菜'],
    media_ids: [],
  };
}

function approval(overrides: Partial<AiApprovalRequest> = {}): AiApprovalRequest {
  const initial = recipeDraft('原始草稿');
  return {
    id: 'approval-1',
    conversation_id: 'conversation-1',
    message_id: 'message-1',
    run_id: 'run-1',
    draft_id: 'draft-1',
    draft_version: 1,
    draft_schema_version: 'recipe.v1',
    approval_type: 'recipe.create',
    status: 'pending',
    title: '确认创建菜谱',
    instruction: '确认后会创建菜谱。',
    approve_label: '创建菜谱',
    reject_label: '暂不创建',
    require_reject_comment: false,
    field_schema: [{ name: 'recipe', label: '菜谱草稿', type: 'string', widget: 'textarea', required: true }],
    initial_values: { recipe: initial },
    submitted_values: {},
    decision: null,
    comment: null,
    resolved_at: null,
    expires_at: null,
    created_at: '2026-05-30T00:00:00Z',
    ...overrides,
  };
}

function shoppingApproval(): AiApprovalRequest {
  const draft = {
    draftType: 'shopping_list',
    schemaVersion: 'shopping_list.v1',
    items: [{ title: '鸡蛋', quantity: 1, unit: '盒', reason: '补充常用食材' }],
  };
  return approval({
    approval_type: 'shopping_list.create',
    title: '确认创建购物清单',
    approve_label: '加入购物清单',
    reject_label: '暂不加入',
    draft_schema_version: 'shopping_list.v1',
    field_schema: [{ name: 'draft', label: '草稿内容', type: 'object', widget: 'textarea', required: true }],
    initial_values: { draft },
    submitted_values: {},
  });
}

function conversation(): AiConversation {
  return {
    id: 'conversation-1',
    family_id: 'family-1',
    mode: 'recommendation',
    prompt: '帮我生成菜谱',
    response: '',
    created_at: '2026-05-30T00:00:00Z',
    created_by: 'user-1',
    context: {},
    title: '帮我生成菜谱',
    summary: '',
    status: 'active',
    last_message_at: '2026-05-30T00:00:00Z',
    last_run_status: 'completed',
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function renderWithQuery(element: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  let root: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<QueryClientProvider client={queryClient}>{element}</QueryClientProvider>);
  });
  return {
    container,
    queryClient,
    unmount: () => {
      act(() => {
        root.unmount();
        container.remove();
      });
    },
  };
}

function changeInput(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  act(() => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const valueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    valueSetter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('ApprovalPanel', () => {
  it('shows submitted recipe values after approval is resolved', async () => {
    const resolvedApproval = approval({
      status: 'approved',
      submitted_values: { recipe: recipeDraft('最终提交菜谱') },
      decision: 'approved',
    });
    const rendered = await renderWithQuery(<ApprovalPanel approval={resolvedApproval} onSettled={() => undefined} />);
    const titleInput = rendered.container.querySelector<HTMLInputElement>('input.text-input');
    expect(titleInput?.value).toBe('最终提交菜谱');
    expect(titleInput?.disabled).toBe(true);
    rendered.unmount();
  });

  it('submits edited recipe values and keeps the returned values visible', async () => {
    const pending = approval();
    const submitted = recipeDraft('用户编辑后的菜谱');
    const decideSpy = vi.spyOn(api, 'decideAiApproval').mockResolvedValue({
      approval: { ...pending, status: 'approved', submitted_values: { recipe: submitted }, decision: 'approved' },
      draft: {
        id: 'draft-1',
        conversation_id: 'conversation-1',
        message_id: 'message-1',
        run_id: 'run-1',
        draft_type: 'recipe',
        payload: submitted,
        preview_summary: '用户编辑后的菜谱',
        status: 'confirmed',
        version: 1,
        schema_version: 'recipe.v1',
        validation_errors: [],
        created_at: '2026-05-30T00:00:00Z',
        updated_at: '2026-05-30T00:00:00Z',
      },
      operation: { status: 'succeeded' },
      business_entity: null,
    });
    const rendered = await renderWithQuery(<ApprovalPanel approval={pending} onSettled={() => undefined} />);
    const titleInput = rendered.container.querySelector<HTMLInputElement>('input.text-input');
    expect(titleInput).not.toBeNull();
    changeInput(titleInput as HTMLInputElement, '用户编辑后的菜谱');
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('button.solid-button')?.click();
    });
    await flush();
    expect(decideSpy).toHaveBeenCalledWith(
      'conversation-1',
      'approval-1',
      expect.objectContaining({
        decision: 'approved',
        values: { recipe: expect.objectContaining({ title: '用户编辑后的菜谱' }) },
      })
    );
    expect((rendered.container.querySelector('input.text-input') as HTMLInputElement).value).toBe('用户编辑后的菜谱');
    rendered.unmount();
  });

  it('keeps the editor retryable when operation fails and backend returns a retry approval', async () => {
    const pending = approval();
    const submitted = recipeDraft('等待重试的菜谱');
    vi.spyOn(api, 'decideAiApproval').mockResolvedValue({
      approval: {
        ...pending,
        id: 'approval-retry',
        approval_type: 'recipe.create.retry',
        status: 'pending',
        title: '重试创建菜谱',
        approve_label: '重试创建',
        initial_values: { recipe: submitted },
        submitted_values: {},
      },
      draft: {
        id: 'draft-1',
        conversation_id: 'conversation-1',
        message_id: 'message-1',
        run_id: 'run-1',
        draft_type: 'recipe',
        payload: submitted,
        preview_summary: '等待重试的菜谱',
        status: 'pending_retry',
        version: 1,
        schema_version: 'recipe.v1',
        validation_errors: [],
        created_at: '2026-05-30T00:00:00Z',
        updated_at: '2026-05-30T00:00:00Z',
      },
      operation: { status: 'failed', error_message: 'sync failed' },
      business_entity: null,
    });
    const rendered = await renderWithQuery(<ApprovalPanel approval={pending} onSettled={() => undefined} />);
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('button.solid-button')?.click();
    });
    await flush();
    const titleInput = rendered.container.querySelector<HTMLInputElement>('input.text-input');
    expect(rendered.container.textContent).toContain('sync failed');
    expect(rendered.container.textContent).toContain('重试创建');
    expect(titleInput?.disabled).toBe(false);
    rendered.unmount();
  });

  it('submits shopping list drafts from structured fields instead of raw JSON', async () => {
    const pending = shoppingApproval();
    const decideSpy = vi.spyOn(api, 'decideAiApproval').mockResolvedValue({
      approval: { ...pending, status: 'approved', submitted_values: { draft: pending.initial_values.draft }, decision: 'approved' },
      draft: {
        id: 'draft-1',
        conversation_id: 'conversation-1',
        message_id: 'message-1',
        run_id: 'run-1',
        draft_type: 'shopping_list',
        payload: pending.initial_values.draft ?? {},
        preview_summary: '1 个待采购项',
        status: 'confirmed',
        version: 1,
        schema_version: 'shopping_list.v1',
        validation_errors: [],
        created_at: '2026-05-30T00:00:00Z',
        updated_at: '2026-05-30T00:00:00Z',
      },
      operation: { status: 'succeeded' },
      business_entity: null,
    });
    const rendered = await renderWithQuery(<ApprovalPanel approval={pending} onSettled={() => undefined} />);
    const titleInput = Array.from(rendered.container.querySelectorAll<HTMLInputElement>('input.text-input')).find((input) => input.value === '鸡蛋');
    expect(titleInput).toBeTruthy();
    changeInput(titleInput as HTMLInputElement, '牛奶');
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('button.solid-button')?.click();
    });
    await flush();
    expect(decideSpy).toHaveBeenCalledWith(
      'conversation-1',
      'approval-1',
      expect.objectContaining({
        values: { draft: expect.objectContaining({ items: [expect.objectContaining({ title: '牛奶' })] }) },
      })
    );
    rendered.unmount();
  });
});

describe('AiWorkspace pending approval restore', () => {
  it('restores pending approvals as an assistant message when history is missing', async () => {
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([approval()]);
    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flush();
    expect(rendered.container.textContent).not.toContain('待处理确认');
    expect(rendered.container.textContent).toContain('AI 厨房助手');
    expect(rendered.container.textContent).toContain('确认创建菜谱');
    expect(rendered.container.querySelector<HTMLInputElement>('input.text-input')?.value).toBe('原始草稿');
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
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([approval()]);
    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flush();
    expect(rendered.container.querySelectorAll('.ai-desktop-view .ai-message-assistant')).toHaveLength(1);
    expect(rendered.container.querySelectorAll('.ai-mobile-page .ai-message-assistant')).toHaveLength(1);
    expect(rendered.container.textContent).toContain('菜谱草稿已经生成，请确认。');
    expect(rendered.container.textContent).toContain('确认创建菜谱');
    expect(rendered.container.textContent).not.toContain('待处理确认');
    rendered.unmount();
  });

  it('shows a confirmation modal before deleting a conversation from history', async () => {
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
    const deleteSpy = vi.spyOn(api, 'deleteAiConversation').mockResolvedValue(undefined);
    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-conversation-delete')?.click();
    });
    await flush();
    expect(rendered.container.textContent).toContain('删除这条历史？');
    expect(rendered.container.textContent).toContain('帮我生成菜谱');
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-delete-confirm-actions .solid-button')?.click();
    });
    await flush();
    expect(deleteSpy.mock.calls[0]?.[0]).toBe('conversation-1');
    rendered.unmount();
  });

  it('cancels the server run for an in-flight streamed message', async () => {
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([]);
    vi.spyOn(api, 'streamChatAi').mockImplementation(async (_payload, handlers) => {
      handlers?.onProgress?.({
        id: 'progress-1',
        run_id: 'pending',
        type: 'intent',
        internal_code: 'detect_intent',
        user_message: '正在理解你的需求',
        status: 'running',
        created_at: '2026-05-30T00:00:00Z',
      });
      await new Promise((resolve) => window.setTimeout(resolve, 50));
      throw new Error('aborted');
    });
    const cancelSpy = vi.spyOn(api, 'cancelAiRun').mockResolvedValue({
      run: { id: 'agent_run-client', status: 'cancelled' },
      events: [
        {
          id: 'cancel-event',
          run_id: 'agent_run-client',
          type: 'cancel',
          internal_code: 'user_cancel',
          user_message: '已取消这次任务',
          status: 'failed',
          created_at: '2026-05-30T00:00:00Z',
        },
      ],
    });
    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flush();
    changeInput(rendered.container.querySelector<HTMLTextAreaElement>('textarea.text-input') as HTMLTextAreaElement, '安排三天晚餐');
    await act(async () => {
      rendered.container.querySelector<HTMLFormElement>('form.ai-composer')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('.ai-stream-progress-strip .ghost-button')?.click();
    });
    await flush();
    expect(cancelSpy.mock.calls[0]?.[0]).toMatch(/^agent_run-/);
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
    await flush();
    changeInput(rendered.container.querySelector<HTMLTextAreaElement>('textarea.text-input') as HTMLTextAreaElement, '今日吃什么？');
    await act(async () => {
      rendered.container.querySelector<HTMLFormElement>('form.ai-composer')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();
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
          agent_key: 'today_recommendation_agent',
          intent: 'today_recommendation',
          status: 'completed',
          model: 'rules',
          created_at: '2026-05-30T00:00:00Z',
        },
        events: [],
        included: { result_cards: [], drafts: [], approvals: [] },
      });
    });
    await flush();
    rendered.unmount();
  });
});
