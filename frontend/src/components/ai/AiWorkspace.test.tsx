import React, { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { AiApprovalRequest, AiConversation, AiGeneratedRecipeDraft } from '../../api/types';
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
});

describe('AiWorkspace pending approval restore', () => {
  it('renders pending approvals when messages are empty after refresh', async () => {
    vi.spyOn(api, 'getAiMessages').mockResolvedValue([]);
    vi.spyOn(api, 'getPendingAiApprovals').mockResolvedValue([approval()]);
    const rendered = await renderWithQuery(<AiWorkspace conversations={[conversation()]} isLoading={false} />);
    await flush();
    expect(rendered.container.textContent).toContain('待处理确认');
    expect(rendered.container.querySelector<HTMLInputElement>('input.text-input')?.value).toBe('原始草稿');
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
});
