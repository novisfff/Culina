import { afterEach, describe, expect, it, vi } from 'vitest';
import { AI_DRAFT_CONTRACTS_HEADER, aiApi } from './aiApi';
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

const emptyChatResponse: AiChatResponse = {
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
    agent_key: 'workspace_orchestrator',
    intent: 'workspace_orchestrator',
    status: 'completed',
    model: 'fake',
    created_at: '2026-05-30T00:00:00Z',
  },
  events: [],
  included: { result_cards: [], drafts: [], approvals: [] },
};

function jsonResponse(body: unknown = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function lastFetchHeaders(fetchSpy: { mock: { calls: unknown[][] } }) {
  const init = fetchSpy.mock.calls.at(-1)?.[1] as RequestInit | undefined;
  return new Headers(init?.headers);
}

async function invokeAiMethod(method: typeof CAPABILITY_METHODS[number]) {
  switch (method) {
    case 'getAiConversations':
      return aiApi.getAiConversations();
    case 'updateAiConversationVisibility':
      return aiApi.updateAiConversationVisibility('conversation-1', 'family');
    case 'chatAi':
      return aiApi.chatAi({ message: '你好' });
    case 'retryAiRun':
      return aiApi.retryAiRun('run-1');
    case 'getAiMessages':
      return aiApi.getAiMessages('conversation-1');
    case 'recordAiRecommendationSelection':
      return aiApi.recordAiRecommendationSelection('message-1', {
        part_id: 'part-1',
        card_id: 'card-1',
        entity_id: 'entity-1',
        food_plan_item_id: 'plan-1',
      });
    case 'createAiInventoryOperationDraft':
      return aiApi.createAiInventoryOperationDraft('message-1', {
        part_id: 'part-1',
        card_id: 'card-1',
        item_id: 'item-1',
        action: 'consume',
      });
    case 'getPendingAiApprovals':
      return aiApi.getPendingAiApprovals('conversation-1');
    case 'decideAiApproval':
      return aiApi.decideAiApproval('conversation-1', 'approval-1', {
        decision: 'approved',
        draft_version: 1,
        values: { draft: {} },
      });
    case 'respondAiHumanInput':
      return aiApi.respondAiHumanInput('conversation-1', 'human-input-1', {
        selected_option_ids: ['option-1'],
      });
    default: {
      const _exhaustive: never = method;
      throw new Error(`Unhandled method ${_exhaustive}`);
    }
  }
}

async function invokeAiStream(method: typeof STREAM_METHODS[number]) {
  switch (method) {
    case 'streamChatAi':
      return aiApi.streamChatAi({ message: '你好' });
    case 'streamAiApprovalDecision':
      return aiApi.streamAiApprovalDecision('conversation-1', 'approval-1', {
        decision: 'approved',
        draft_version: 1,
        values: { draft: {} },
      });
    case 'streamAiHumanInputResponse':
      return aiApi.streamAiHumanInputResponse('conversation-1', 'human-input-1', {
        selected_option_ids: ['option-1'],
      });
    default: {
      const _exhaustive: never = method;
      throw new Error(`Unhandled stream method ${_exhaustive}`);
    }
  }
}

const CAPABILITY_METHODS = [
  'getAiConversations',
  'updateAiConversationVisibility',
  'chatAi',
  'retryAiRun',
  'getAiMessages',
  'recordAiRecommendationSelection',
  'createAiInventoryOperationDraft',
  'getPendingAiApprovals',
  'decideAiApproval',
  'respondAiHumanInput',
] as const;

const STREAM_METHODS = [
  'streamChatAi',
  'streamAiApprovalDecision',
  'streamAiHumanInputResponse',
] as const;

describe('aiApi', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(CAPABILITY_METHODS)('%s sends both recipe-cook capabilities', async (method) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(method === 'chatAi' || method === 'retryAiRun' || method === 'respondAiHumanInput' ? emptyChatResponse : method === 'getAiConversations' ? [] : method === 'getAiMessages' ? [] : method === 'getPendingAiApprovals' ? [] : method === 'updateAiConversationVisibility' ? {
      id: 'conversation-1',
      owner_user_id: 'user-1',
      owner_display_name: '小林',
      visibility: 'family',
      is_owner: true,
    } : method === 'recordAiRecommendationSelection' || method === 'createAiInventoryOperationDraft' ? emptyChatResponse.message : { status: 'ok' }));

    await invokeAiMethod(method);

    expect(lastFetchHeaders(fetchSpy).get(AI_DRAFT_CONTRACTS_HEADER))
      .toBe('recipe_cook_operation.v1,recipe_cook_operation.v2');
  });

  it.each(STREAM_METHODS)('%s sends capability on every stream connection', async (method) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(streamFrom(sseBlock('response', emptyChatResponse)), { status: 200 }),
    );

    await invokeAiStream(method);

    expect(lastFetchHeaders(fetchSpy).get(AI_DRAFT_CONTRACTS_HEADER))
      .toBe('recipe_cook_operation.v1,recipe_cook_operation.v2');
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

  it('sends image attachments in streamed chat payloads', async () => {
    const response: AiChatResponse = {
      conversation_id: 'conversation-1',
      message: {
        id: 'message-1',
        conversation_id: 'conversation-1',
        role: 'assistant',
        content: '我看到了这张图片。',
        content_type: 'parts',
        parts: [{ id: 'part-1', type: 'text', text: '我看到了这张图片。' }],
        run_id: 'run-1',
        status: 'completed',
        metadata: {},
        created_at: '2026-05-30T00:00:00Z',
      },
      run: {
        id: 'run-1',
        agent_key: 'workspace_orchestrator',
        intent: 'workspace_orchestrator',
        status: 'completed',
        model: 'fake',
        created_at: '2026-05-30T00:00:00Z',
      },
      events: [],
      included: { result_cards: [], drafts: [], approvals: [] },
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(streamFrom(sseBlock('response', response)), { status: 200 }));

    await aiApi.streamChatAi({
      message: '',
      attachments: [{ type: 'image', media_id: 'media-image-1', client_attachment_id: 'local-image-1' }],
    });

    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({
      message: '',
      attachments: [{ type: 'image', media_id: 'media-image-1', client_attachment_id: 'local-image-1' }],
    });
  });

  it('fetches AI run observability endpoints', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/api/ai/runs/run-1/trace')) {
        return new Response(JSON.stringify({ runId: 'run-1', traceId: 'trace-1', status: 'completed', spans: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/api/ai/runs/run-1/trace/tree')) {
        return new Response(JSON.stringify({ runId: 'run-1', traceId: 'trace-1', status: 'completed', tree: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/api/ai/runs/run-1/llm-exchanges')) {
        return new Response(JSON.stringify({ runId: 'run-1', traceId: 'trace-1', exchanges: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/api/ai/runs/run-1/llm-exchanges?includePayload=false')) {
        return new Response(JSON.stringify({ runId: 'run-1', traceId: 'trace-1', exchanges: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/api/ai/runs/run-1/llm-exchanges/exchange-1')) {
        return new Response(JSON.stringify({
          id: 'exchange-1',
          runId: 'run-1',
          traceId: 'trace-1',
          spanId: 'span-1',
          providerRound: 1,
          attemptIndex: 1,
          mode: 'tools',
          model: 'fake',
          requestToolCount: 0,
          requestToolNames: [],
          responseToolCallCount: 0,
          responseToolCallNames: [],
          payloadIncluded: true,
          requestMessages: [],
          requestTools: [],
          requestOptions: {},
          requestOriginalDigest: '',
          requestOriginalBytes: 0,
          requestDigest: '',
          requestBytes: 0,
          requestTruncated: false,
          responseMessage: {},
          responseText: null,
          responseToolCalls: [],
          streamChunks: [],
          responseOriginalDigest: '',
          responseOriginalBytes: 0,
          responseDigest: '',
          responseBytes: 0,
          responseTruncated: false,
          tokenUsage: {},
          status: 'completed',
          startedAt: '2026-05-30T00:00:00Z',
          durationMs: 0,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    });

    await expect(aiApi.getAiRunTrace('run-1')).resolves.toEqual({ runId: 'run-1', traceId: 'trace-1', status: 'completed', spans: [] });
    await expect(aiApi.getAiRunTraceTree('run-1')).resolves.toEqual({ runId: 'run-1', traceId: 'trace-1', status: 'completed', tree: [] });
    await expect(aiApi.getAiRunLlmExchanges('run-1')).resolves.toEqual({ runId: 'run-1', traceId: 'trace-1', exchanges: [] });
    await expect(aiApi.getAiRunLlmExchanges('run-1', { includePayload: false })).resolves.toEqual({ runId: 'run-1', traceId: 'trace-1', exchanges: [] });
    await expect(aiApi.getAiRunLlmExchange('run-1', 'exchange-1')).resolves.toMatchObject({ id: 'exchange-1', payloadIncluded: true });
    expect(fetchSpy.mock.calls.map((call) => String(call[0]))).toEqual([
      expect.stringContaining('/api/ai/runs/run-1/trace'),
      expect.stringContaining('/api/ai/runs/run-1/trace/tree'),
      expect.stringContaining('/api/ai/runs/run-1/llm-exchanges'),
      expect.stringContaining('/api/ai/runs/run-1/llm-exchanges?includePayload=false'),
      expect.stringContaining('/api/ai/runs/run-1/llm-exchanges/exchange-1'),
    ]);
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
        agent_key: 'workspace_orchestrator',
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
    const part = { id: 'activity-event-1', type: 'run_activity' as const, activity: progress };
    const messagePart = { message_id: 'message-1', conversation_id: 'conversation-1', run_id: 'run-1', part };
    const delta = { message_id: 'message-1', conversation_id: 'conversation-1', run_id: 'run-1', part_id: 'part-1', delta: '已继续处理。' };
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(streamFrom(`${sseBlock('message_part', messagePart)}${sseBlock('progress', progress)}${sseBlock('message_delta', delta)}${sseBlock('response', response)}`), { status: 200 }));
    const progressSpy = vi.fn();
    const partSpy = vi.fn();
    const deltaSpy = vi.fn();

    await expect(
      aiApi.streamAiApprovalDecision(
        'conversation-1',
        'approval-1',
        { decision: 'approved', draft_version: 1, values: { draft: {} } },
        { onProgress: progressSpy, onMessagePart: partSpy, onMessageDelta: deltaSpy },
      ),
    ).resolves.toEqual(response);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('/api/ai/conversations/conversation-1/approvals/approval-1/decision/stream');
    expect(partSpy).toHaveBeenCalledWith(messagePart);
    expect(progressSpy).toHaveBeenCalledWith(progress);
    expect(deltaSpy).toHaveBeenCalledWith(delta);
  });

  it('parses streamed cooking assistant audio events', async () => {
    const response: AiChatResponse = {
      conversation_id: 'conversation-1',
      message: {
        id: 'message-1',
        conversation_id: 'conversation-1',
        role: 'assistant',
        content: '收到。',
        content_type: 'parts',
        parts: [{ id: 'part-1', type: 'text', text: '收到。' }],
        run_id: 'run-1',
        status: 'completed',
        metadata: {},
        created_at: '2026-05-30T00:00:00Z',
      },
      run: {
        id: 'run-1',
        agent_key: 'workspace_orchestrator',
        intent: 'recipe_cook',
        status: 'completed',
        model: 'fake',
        created_at: '2026-05-30T00:00:00Z',
      },
      events: [],
      included: { result_cards: [], drafts: [], approvals: [] },
    };
    const audioStart = { content_type: 'audio/pcm', format: 'pcm16', sample_rate: 24000, channels: 1 };
    const audioDelta = { audio: 'ZmFrZS1hdWRpbw==', sequence: 1 };
    const audioDone = { sequence: 1 };
    const audioTrace = { stage: 'tts_segment_commit', elapsed_ms: 120, segment_sequence: 1 };
    const messageDelta = { delta: '收' };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(streamFrom(
      `${sseBlock('assistant_audio_start', audioStart)}${sseBlock('assistant_audio_trace', audioTrace)}${sseBlock('message_delta', messageDelta)}${sseBlock('assistant_audio_delta', audioDelta)}${sseBlock('assistant_audio_done', audioDone)}${sseBlock('response', response)}`,
    ), { status: 200 }));
    const startSpy = vi.fn();
    const messageDeltaSpy = vi.fn();
    const deltaSpy = vi.fn();
    const doneSpy = vi.fn();
    const traceSpy = vi.fn();

    await expect(
      aiApi.streamCookingAssistantVoiceAi(
        { message: '下一步', subject: { source: 'recipe_cook_page' } },
        {
          onAssistantAudioStart: startSpy,
          onMessageDelta: messageDeltaSpy,
          onAssistantAudioDelta: deltaSpy,
          onAssistantAudioDone: doneSpy,
          onAssistantAudioTrace: traceSpy,
        },
      ),
    ).resolves.toEqual(response);
    expect(startSpy).toHaveBeenCalledWith(audioStart);
    expect(traceSpy).toHaveBeenCalledWith(audioTrace);
    expect(messageDeltaSpy).toHaveBeenCalledWith(messageDelta);
    expect(deltaSpy).toHaveBeenCalledWith(audioDelta);
    expect(doneSpy).toHaveBeenCalledWith(audioDone);
  });


  it('patches AI conversation visibility', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      id: 'conversation-1',
      owner_user_id: 'user-1',
      owner_display_name: '小林',
      visibility: 'family',
      is_owner: true,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await aiApi.updateAiConversationVisibility('conversation-1', 'family');
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/api/ai/conversations/conversation-1/visibility'),
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ visibility: 'family' }) }),
    );
  });

  it('streams human input responses through the shared SSE parser', async () => {
    const response: AiChatResponse = {
      conversation_id: 'conversation-1',
      message: {
        id: 'message-1',
        conversation_id: 'conversation-1',
        role: 'assistant',
        content: '已按你的补充继续处理。',
        content_type: 'parts',
        parts: [{ id: 'part-1', type: 'text', text: '已按你的补充继续处理。' }],
        run_id: 'run-1',
        status: 'completed',
        metadata: {},
        created_at: '2026-05-30T00:00:00Z',
      },
      run: {
        id: 'run-1',
        agent_key: 'workspace_orchestrator',
        intent: 'workspace_orchestrator',
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
      internal_code: 'inventory.read_available_items',
      user_message: '调用「可用库存」',
      status: 'completed',
      created_at: '2026-05-30T00:00:00Z',
    };
    const part = { id: 'activity-event-1', type: 'run_activity' as const, activity: progress };
    const messagePart = { message_id: 'message-1', conversation_id: 'conversation-1', run_id: 'run-1', part };
    const delta = { message_id: 'message-1', conversation_id: 'conversation-1', run_id: 'run-1', part_id: 'part-1', delta: '已按你的补充继续处理。' };
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(streamFrom(`${sseBlock('message_part', messagePart)}${sseBlock('progress', progress)}${sseBlock('message_delta', delta)}${sseBlock('response', response)}`), { status: 200 }));
    const progressSpy = vi.fn();
    const partSpy = vi.fn();
    const deltaSpy = vi.fn();

    await expect(
      aiApi.streamAiHumanInputResponse(
        'conversation-1',
        'human-input-1',
        { selected_option_ids: ['three-days'], text: '三天' },
        { onProgress: progressSpy, onMessagePart: partSpy, onMessageDelta: deltaSpy },
      ),
    ).resolves.toEqual(response);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('/api/ai/conversations/conversation-1/human-input/human-input-1/response/stream');
    expect(partSpy).toHaveBeenCalledWith(messagePart);
    expect(progressSpy).toHaveBeenCalledWith(progress);
    expect(deltaSpy).toHaveBeenCalledWith(delta);
  });
});
