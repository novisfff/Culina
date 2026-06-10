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
});
