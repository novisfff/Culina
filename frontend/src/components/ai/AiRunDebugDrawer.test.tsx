import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/client';
import type { AiRunLLMExchangeResponse, AiRunTraceTreeResponse } from '../../api/types';
import { AiRunDebugDrawer } from './AiRunDebugDrawer';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const traceTree: AiRunTraceTreeResponse = {
  runId: 'run-debug-1',
  traceId: 'trace-debug-1',
  status: 'completed',
  tree: [
    {
      id: 'span-run',
      runId: 'run-debug-1',
      conversationId: 'conversation-1',
      traceId: 'trace-debug-1',
      spanId: 'span-run',
      parentSpanId: null,
      spanType: 'run',
      name: 'workspace_orchestrator',
      status: 'completed',
      roundIndex: null,
      attemptIndex: null,
      startedAt: '2026-06-28T00:00:00Z',
      endedAt: '2026-06-28T00:00:03Z',
      durationMs: 3000,
      inputSummary: { status: 'running', agentRounds: 1 },
      outputSummary: { status: 'completed', toolCallCount: 1, draftCount: 0 },
      errorCode: null,
      errorMessage: null,
      exceptionType: null,
      payload: {},
      children: [
        {
          id: 'span-tool',
          runId: 'run-debug-1',
          conversationId: 'conversation-1',
          traceId: 'trace-debug-1',
          spanId: 'span-tool',
          parentSpanId: 'span-run',
          spanType: 'tool_call',
          name: 'ingredient.search',
          status: 'completed',
          roundIndex: 1,
          attemptIndex: null,
          startedAt: '2026-06-28T00:00:01Z',
          endedAt: '2026-06-28T00:00:02Z',
          durationMs: 120,
          inputSummary: {
            inputKeys: ['query', 'limit'],
            sideEffect: 'read',
            permission: 'member',
            requiresConfirmation: false,
          },
          outputSummary: { status: 'completed', outputKeys: ['items'], cardCount: 0 },
          errorCode: null,
          errorMessage: null,
          exceptionType: null,
          payload: {},
          children: [],
        },
      ],
    },
  ],
};

const llmExchanges: AiRunLLMExchangeResponse = {
  runId: 'run-debug-1',
  traceId: 'trace-debug-1',
  exchanges: [
    {
      id: 'exchange-1',
      runId: 'run-debug-1',
      conversationId: 'conversation-1',
      traceId: 'trace-debug-1',
      spanId: 'span-tool',
      providerRound: 1,
      attemptIndex: 1,
      mode: 'tools',
      model: 'gpt-test',
      requestToolCount: 1,
      requestToolNames: ['ingredient.search'],
      responseToolCallCount: 1,
      responseToolCallNames: ['ingredient.search'],
      payloadIncluded: false,
      requestMessages: [],
      requestTools: [],
      requestOptions: {},
      requestOriginalDigest: 'request-original',
      requestOriginalBytes: 100,
      requestDigest: 'request',
      requestBytes: 80,
      requestTruncated: false,
      responseMessage: {},
      responseText: null,
      responseToolCalls: [],
      streamChunks: [],
      responseOriginalDigest: 'response-original',
      responseOriginalBytes: 100,
      responseDigest: 'response',
      responseBytes: 80,
      responseTruncated: false,
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      cachedTokens: 0,
      estimatedCostUsd: null,
      tokenUsage: { totalTokens: 120 },
      status: 'completed',
      errorCode: null,
      errorMessage: null,
      startedAt: '2026-06-28T00:00:00Z',
      endedAt: '2026-06-28T00:00:01Z',
      durationMs: 800,
    },
  ],
};

async function renderDrawer() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <QueryClientProvider client={queryClient}>
        <AiRunDebugDrawer runId="run-debug-1" open onClose={vi.fn()} />
      </QueryClientProvider>,
    );
  });
  await flushQueries();
  return {
    container,
    unmount: () => {
      act(() => {
        root?.unmount();
        container.remove();
      });
    },
  };
}

async function flushQueries(times = 2) {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

async function waitForText(container: HTMLElement, text: string) {
  for (let index = 0; index < 20; index += 1) {
    if (container.textContent?.includes(text)) return;
    await flushQueries(1);
  }
  expect(container.textContent).toContain(text);
}

describe('AiRunDebugDrawer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('keeps tool and model details connected in the timeline', async () => {
    vi.spyOn(api, 'getAiRunTraceTree').mockResolvedValue(traceTree);
    const exchangesSpy = vi.spyOn(api, 'getAiRunLlmExchanges').mockResolvedValue(llmExchanges);
    const detailSpy = vi.spyOn(api, 'getAiRunLlmExchange').mockResolvedValue({
      ...llmExchanges.exchanges[0],
      payloadIncluded: true,
      requestMessages: [{ role: 'user', content: '番茄还有吗' }],
      requestTools: [{ type: 'function', function: { name: 'ingredient.search', parameters: { type: 'object' } } }],
      requestOptions: {},
      responseMessage: {},
      responseToolCalls: [{ name: 'ingredient.search', args: { query: '番茄', limit: 5 } }],
    });

    const rendered = await renderDrawer();

    expect(rendered.container.textContent).toContain('触发条件');
    expect(rendered.container.textContent).toContain('执行结果');
    expect(rendered.container.textContent).toContain('工具: ingredient.search');
    expect(rendered.container.textContent).toContain('原始触发摘要');
    expect(exchangesSpy).toHaveBeenCalledWith('run-debug-1', { includePayload: false });
    expect(detailSpy).not.toHaveBeenCalled();

    const modelSummary = Array.from(rendered.container.querySelectorAll('summary')).find((summary) => summary.textContent?.includes('模型 1 · 模型轮次 1'));
    expect(modelSummary).toBeTruthy();
    await act(async () => {
      modelSummary?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushQueries();

    expect(rendered.container.textContent).toContain('请求可用工具 1');
    expect(rendered.container.textContent).toContain('模型返回调用 1');
    expect(rendered.container.textContent).toContain('模型返回 tool calls');
    expect(detailSpy).not.toHaveBeenCalled();

    const rawRequestSummary = Array.from(rendered.container.querySelectorAll('summary')).find((summary) => summary.textContent === '请求消息原文');
    expect(rawRequestSummary).toBeTruthy();
    await act(async () => {
      rawRequestSummary?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await waitForText(rendered.container, '番茄还有吗');

    expect(detailSpy).toHaveBeenCalledWith('run-debug-1', 'exchange-1');
    expect(rendered.container.textContent).toContain('番茄还有吗');

    rendered.unmount();
  });
});
