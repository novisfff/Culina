import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AI_DRAFT_CONTRACTS_HEADER,
  aiApi,
  aiOperationRevertConflictFromError,
} from './aiApi';
import { ApiError } from './request';
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

function autoExecutionSettingsResponse() {
  const preference = {
    action_key: 'food.set_favorite',
    enabled: false,
    effective_enabled: false,
    row_version: 0,
    consent_notice_version: null,
    requires_reconsent: false,
  };
  return {
    catalog_version: 'auto-execution.v1',
    consent_notice: { version: 'auto-execution-consent.v1', acknowledged: true },
    member_preferences: [
      preference,
      { ...preference, action_key: 'meal_log.rate_food' },
      { ...preference, action_key: 'shopping_list.safe_write' },
      { ...preference, action_key: 'meal_log.simple_create' },
      { ...preference, action_key: 'meal_plan.simple_create' },
    ],
    family_policies: [{ ...preference, action_key: 'shopping_list.safe_write' }],
    limits: { 'shopping_list.safe_write': { add_or_restore_items: 5, update_items: 1 } },
    server_now: '2026-08-24T10:00:00Z',
  };
}

function operationProjection(overrides: Record<string, unknown> = {}) {
  return {
    draft_id: 'draft-1',
    operation_id: 'operation-1',
    result_status: 'completed',
    execution_mode: 'policy_auto',
    operation_status: 'completed',
    execution_explanation: '已完成',
    revert_availability: 'available',
    revertible_until: '2026-08-24T10:15:00Z',
    revert_blocked_code: null,
    server_now: '2026-08-24T10:00:00Z',
    entities: [{ id: 'food-1', label: '番茄' }],
    cache_scopes: ['food', 'ai_conversation'],
    ...overrides,
  };
}

function operationResultCard(projection = operationProjection()) {
  return {
    id: 'card-1',
    type: 'operation_result',
    title: '操作已完成',
    data: {
      ...projection,
      actionSummary: '已完成',
      entityCount: 1,
      entityCountLabel: '1 项',
      workspaceLabel: '食物',
      workspaceHint: '可前往食物查看',
    },
  };
}

function permanentConflictDetail() {
  const projection = operationProjection({
    revert_availability: 'blocked',
    revert_blocked_code: 'revert_target_changed',
  });
  return {
    code: 'revert_target_changed',
    message: '目标已变化',
    projection,
    result_card: operationResultCard(projection),
    cache_scopes: projection.cache_scopes,
    server_now: projection.server_now,
    replayed: false,
  };
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

  it('test_cancel_ai_run_uses_post_path', async () => {
    const cancellation = {
      outcome: 'cancelled',
      request: {
        run_id: 'run-1',
        status: 'applied',
        requested_at: '2026-07-23T00:00:00Z',
        resolved_at: '2026-07-23T00:00:01Z',
      },
      run: { ...emptyChatResponse.run, status: 'cancelled' },
      events: [],
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(cancellation));

    await expect(aiApi.cancelAiRun('run-1')).resolves.toEqual(cancellation);

    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('/api/ai/runs/run-1/cancel');
    expect((fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined)?.method).toBe('POST');
  });

  it('test_get_ai_run_cancellation_uses_get_path', async () => {
    const cancellation = {
      outcome: 'cancel_requested',
      request: {
        run_id: 'run-1',
        status: 'requested',
        requested_at: '2026-07-23T00:00:00Z',
        resolved_at: null,
      },
      run: { ...emptyChatResponse.run, status: 'cancelling' },
      events: [],
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(cancellation));

    await expect(aiApi.getAiRunCancellation('run-1')).resolves.toEqual(cancellation);

    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('/api/ai/runs/run-1/cancellation');
    expect((fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined)?.method ?? 'GET').toBe('GET');
  });

  it('sends current row version and receives the complete auto-execution settings envelope', async () => {
    const settings = autoExecutionSettingsResponse();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(settings));

    await expect(aiApi.updateAiAutoExecutionPreference('food.set_favorite', {
      enabled: true,
      expected_row_version: 2,
      consent_notice_version: 'auto-execution-consent.v1',
    })).resolves.toEqual(settings);

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/api/ai/auto-execution/preferences/food.set_favorite'),
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          enabled: true,
          expected_row_version: 2,
          consent_notice_version: 'auto-execution-consent.v1',
        }),
      }),
    );
  });

  it('encodes auto-execution action keys for family policy updates', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(autoExecutionSettingsResponse()));

    await aiApi.updateAiAutoExecutionFamilyPolicy('shopping_list.safe_write', {
      enabled: false,
      expected_row_version: 3,
    });

    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain(
      '/api/ai/auto-execution/family-policies/shopping_list.safe_write',
    );
    expect((fetchSpy.mock.calls[0]?.[1] as RequestInit).body).toBe(JSON.stringify({
      enabled: false,
      expected_row_version: 3,
    }));
  });

  it('posts an idempotent operation revert request', async () => {
    const response = {
      projection: operationProjection({ result_status: 'reverted', operation_status: 'reverted' }),
      result_card: operationResultCard(),
      cache_scopes: ['food', 'ai_conversation'],
      server_now: '2026-08-24T10:00:00Z',
      replayed: false,
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(response));

    await expect(aiApi.revertAiOperation('operation/1', { client_request_id: 'request-1' }))
      .resolves.toEqual(response);

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/api/ai/operations/operation%2F1/revert'),
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ client_request_id: 'request-1' }) }),
    );
  });

  it('accepts only complete permanent revert conflicts', () => {
    const blockedProjection = operationProjection({
      revert_availability: 'blocked',
      revert_blocked_code: 'revert_target_changed',
    });
    const detail = {
      code: 'revert_target_changed',
      message: '目标已变化',
      projection: blockedProjection,
      result_card: operationResultCard(blockedProjection),
      cache_scopes: blockedProjection.cache_scopes,
      server_now: blockedProjection.server_now,
      replayed: false,
    };
    const permanent = new ApiError({ status: 409, detail: '目标已变化', path: '/api/ai/operations/operation-1/revert', payload: { detail } });
    const incomplete = new ApiError({ status: 409, detail: '目标已变化', path: '/api/ai/operations/operation-1/revert', payload: { detail: { ...detail, projection: { draft_id: 'draft-1' } } } });
    const transient = new ApiError({ status: 503, detail: '稍后重试', path: '/api/ai/operations/operation-1/revert', payload: { detail } });
    const unsupportedCode = new ApiError({ status: 409, detail: '不可撤销', path: '/api/ai/operations/operation-1/revert', payload: { detail: { ...detail, code: 'operation_not_revertible' } } });

    expect(aiOperationRevertConflictFromError(permanent)).toEqual(detail);
    expect(aiOperationRevertConflictFromError(incomplete)).toBeNull();
    expect(aiOperationRevertConflictFromError(transient)).toBeNull();
    expect(aiOperationRevertConflictFromError(unsupportedCode)).toBeNull();
  });

  it.each([
    ['result status', (detail: ReturnType<typeof permanentConflictDetail>) => ({
      ...detail,
      result_card: {
        ...detail.result_card,
        data: { ...detail.result_card.data, result_status: 'failed' },
      },
    })],
    ['entity list', (detail: ReturnType<typeof permanentConflictDetail>) => ({
      ...detail,
      result_card: {
        ...detail.result_card,
        data: { ...detail.result_card.data, entities: [{ id: 'food-1', label: '旧番茄' }] },
      },
    })],
    ['top-level scopes', (detail: ReturnType<typeof permanentConflictDetail>) => ({
      ...detail,
      cache_scopes: ['ai_conversation'],
    })],
    ['card scopes', (detail: ReturnType<typeof permanentConflictDetail>) => ({
      ...detail,
      result_card: {
        ...detail.result_card,
        data: { ...detail.result_card.data, cache_scopes: ['ai_conversation'] },
      },
    })],
    ['card server time', (detail: ReturnType<typeof permanentConflictDetail>) => ({
      ...detail,
      result_card: {
        ...detail.result_card,
        data: { ...detail.result_card.data, server_now: '2026-08-24T10:00:01Z' },
      },
    })],
    ['top-level server time', (detail: ReturnType<typeof permanentConflictDetail>) => ({
      ...detail,
      server_now: '2026-08-24T10:00:01Z',
    })],
    ['blocked code', (detail: ReturnType<typeof permanentConflictDetail>) => ({
      ...detail,
      code: 'revert_dependency_exists',
    })],
  ])('rejects permanent conflicts with mismatched canonical %s', (_label, mismatch) => {
    const detail = mismatch(permanentConflictDetail());
    const error = new ApiError({
      status: 409,
      detail: detail.message,
      path: '/api/ai/operations/operation-1/revert',
      payload: { detail },
    });

    expect(aiOperationRevertConflictFromError(error)).toBeNull();
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

  it('delivers persisted operation results through the existing message_part callback', async () => {
    const persistedPart = {
      message_id: 'message-1',
      conversation_id: 'conversation-1',
      run_id: 'run-1',
      part: {
        id: 'part-operation-1',
        type: 'result_card',
        card: operationResultCard(),
      },
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      streamFrom(`${sseBlock('message_part', persistedPart)}${sseBlock('response', emptyChatResponse)}`),
      { status: 200 },
    ));
    const onMessagePart = vi.fn();

    await expect(aiApi.streamChatAi({ message: '收藏番茄' }, { onMessagePart })).resolves.toEqual(emptyChatResponse);

    expect(onMessagePart).toHaveBeenCalledWith(persistedPart);
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
    const audioError = { message: '语音播报失败', code: 'model_usage_capability_limit_exceeded' };
    const audioTrace = { stage: 'tts_segment_commit', elapsed_ms: 120, segment_sequence: 1 };
    const messageDelta = { delta: '收' };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(streamFrom(
      `${sseBlock('assistant_audio_start', audioStart)}${sseBlock('assistant_audio_trace', audioTrace)}${sseBlock('message_delta', messageDelta)}${sseBlock('assistant_audio_delta', audioDelta)}${sseBlock('assistant_audio_done', audioDone)}${sseBlock('assistant_audio_error', audioError)}${sseBlock('response', response)}`,
    ), { status: 200 }));
    const startSpy = vi.fn();
    const messageDeltaSpy = vi.fn();
    const deltaSpy = vi.fn();
    const doneSpy = vi.fn();
    const errorSpy = vi.fn();
    const traceSpy = vi.fn();

    await expect(
      aiApi.streamCookingAssistantVoiceAi(
        { message: '下一步', subject: { source: 'recipe_cook_page' } },
        {
          onAssistantAudioStart: startSpy,
          onMessageDelta: messageDeltaSpy,
          onAssistantAudioDelta: deltaSpy,
          onAssistantAudioDone: doneSpy,
          onAssistantAudioError: errorSpy,
          onAssistantAudioTrace: traceSpy,
        },
      ),
    ).resolves.toEqual(response);
    expect(startSpy).toHaveBeenCalledWith(audioStart);
    expect(traceSpy).toHaveBeenCalledWith(audioTrace);
    expect(messageDeltaSpy).toHaveBeenCalledWith(messageDelta);
    expect(deltaSpy).toHaveBeenCalledWith(audioDelta);
    expect(doneSpy).toHaveBeenCalledWith(audioDone);
    expect(errorSpy).toHaveBeenCalledWith(audioError);
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
