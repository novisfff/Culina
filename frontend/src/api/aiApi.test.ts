import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiApi } from './aiApi';
import type { AiChatResponse } from './types';

function streamFrom(text: string) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function sseBlock(event: string, data: unknown) {
  const dataLines = JSON.stringify(data, null, 2)
    .split('\n')
    .map((line) => `data: ${line}`)
    .join('\n');
  return `event: ${event}\n${dataLines}\n\n`;
}

describe('aiApi', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses streamed events with multi-line data fields', async () => {
    const response: AiChatResponse = {
      conversation_id: 'conversation-1',
      message: {
        id: 'message-1',
        conversation_id: 'conversation-1',
        role: 'assistant',
        content: '完成',
        content_type: 'parts',
        parts: [{ id: 'part-1', type: 'text', text: '完成' }],
        run_id: 'run-1',
        status: 'completed',
        metadata: {},
        created_at: '2026-05-30T00:00:00Z',
      },
      run: {
        id: 'run-1',
        agent_key: 'general_chat_agent',
        intent: 'general_chat',
        status: 'completed',
        model: 'fake',
        created_at: '2026-05-30T00:00:00Z',
      },
      events: [],
      included: { result_cards: [], drafts: [], approvals: [] },
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(streamFrom(sseBlock('response', response)), { status: 200 }));

    await expect(aiApi.streamChatAi({ message: '你好' })).resolves.toEqual(response);
  });

  it('streams approval decisions through the shared SSE parser', async () => {
    const response: AiChatResponse = {
      conversation_id: 'conversation-1',
      message: {
        id: 'message-1',
        conversation_id: 'conversation-1',
        role: 'assistant',
        content: '已继续处理。',
        content_type: 'parts',
        parts: [{ id: 'part-1', type: 'text', text: '已继续处理。' }],
        run_id: 'run-1',
        status: 'completed',
        metadata: {},
        created_at: '2026-05-30T00:00:00Z',
      },
      run: {
        id: 'run-1',
        agent_key: 'workspace_planner',
        intent: 'multi_skill',
        status: 'completed',
        model: 'fake',
        created_at: '2026-05-30T00:00:00Z',
      },
      events: [],
      included: { result_cards: [], drafts: [], approvals: [] },
    };
    const progress = {
      id: 'event-1',
      run_id: 'run-1',
      type: 'tool',
      internal_code: 'shopping.create_draft',
      user_message: '生成「购物清单确认表单」',
      status: 'completed',
      created_at: '2026-05-30T00:00:00Z',
    };
    const delta = { message_id: 'message-1', conversation_id: 'conversation-1', run_id: 'run-1', part_id: 'part-1', delta: '已继续处理。' };
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(streamFrom(`${sseBlock('progress', progress)}${sseBlock('message_delta', delta)}${sseBlock('response', response)}`), { status: 200 }));
    const progressSpy = vi.fn();
    const deltaSpy = vi.fn();

    await expect(
      aiApi.streamAiApprovalDecision(
        'conversation-1',
        'approval-1',
        { decision: 'approved', draft_version: 1, values: { draft: {} } },
        { onProgress: progressSpy, onMessageDelta: deltaSpy },
      ),
    ).resolves.toEqual(response);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('/api/ai/conversations/conversation-1/approvals/approval-1/decision/stream');
    expect(progressSpy).toHaveBeenCalledWith(progress);
    expect(deltaSpy).toHaveBeenCalledWith(delta);
  });
});
