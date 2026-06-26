import { useMemo, useState, type CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { isApiError } from '../../api/request';
import { queryKeys } from '../../api/queryKeys';
import type { AiRunLLMExchange, AiRunTraceTreeNode } from '../../api/types';
import { WorkspaceDrawer } from '../ui-kit';

type AiRunDebugDrawerProps = {
  runId: string | null;
  open: boolean;
  onClose: () => void;
};

type DebugTab = 'timeline' | 'llm' | 'errors';

const DEBUG_TABS: Array<{ key: DebugTab; label: string }> = [
  { key: 'timeline', label: 'Timeline' },
  { key: 'llm', label: 'LLM' },
  { key: 'errors', label: 'Errors' },
];

const STATUS_LABELS: Record<string, string> = {
  running: '运行中',
  completed: '完成',
  failed: '失败',
  waiting: '等待',
  cancelled: '已取消',
  skipped: '已跳过',
};

function statusLabel(status: string) {
  return STATUS_LABELS[status] ?? status;
}

function formatJson(value: unknown) {
  if (value === undefined || value === null || value === '') return 'null';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function spanMeta(span: AiRunTraceTreeNode) {
  return [
    span.spanType,
    span.roundIndex !== null && span.roundIndex !== undefined ? `round ${span.roundIndex}` : null,
    span.attemptIndex !== null && span.attemptIndex !== undefined ? `attempt ${span.attemptIndex}` : null,
    `${span.durationMs}ms`,
  ].filter(Boolean).join(' · ');
}

function spanDisplayName(span: AiRunTraceTreeNode | undefined) {
  if (!span) return '未关联 span';
  return `${span.name} · ${span.spanType}`;
}

function flattenTraceTree(nodes: AiRunTraceTreeNode[]): AiRunTraceTreeNode[] {
  const items: AiRunTraceTreeNode[] = [];
  const walk = (node: AiRunTraceTreeNode) => {
    items.push(node);
    node.children.forEach(walk);
  };
  nodes.forEach(walk);
  return items;
}

function downloadTraceJson(runId: string, payload: unknown) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `ai-run-trace-${runId}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function JsonBlock({ title, value }: { title: string; value: unknown }) {
  return (
    <details className="ai-debug-json-block">
      <summary>{title}</summary>
      <pre>{formatJson(value)}</pre>
    </details>
  );
}

function TraceNode({
  node,
  exchangesBySpanId,
  depth = 0,
}: {
  node: AiRunTraceTreeNode;
  exchangesBySpanId: Map<string, AiRunLLMExchange[]>;
  depth?: number;
}) {
  const linkedExchanges = exchangesBySpanId.get(node.spanId) ?? [];
  return (
    <li className={`ai-debug-span is-${node.status}`} style={{ '--ai-debug-depth': depth } as CSSProperties}>
      <div className="ai-debug-span-main">
        <span className={`ai-debug-status-dot is-${node.status}`} aria-hidden="true" />
        <div>
          <strong>{node.name}</strong>
          <span>{spanMeta(node)}</span>
        </div>
        <em>{statusLabel(node.status)}</em>
      </div>
      {node.errorCode || node.errorMessage ? (
        <p className="ai-debug-error-line">
          {node.errorCode ? <code>{node.errorCode}</code> : null}
          {node.errorMessage ? <span>{node.errorMessage}</span> : null}
        </p>
      ) : null}
      {(Object.keys(node.inputSummary ?? {}).length > 0 || Object.keys(node.outputSummary ?? {}).length > 0) ? (
        <div className="ai-debug-span-json">
          <JsonBlock title="Input" value={node.inputSummary} />
          <JsonBlock title="Output" value={node.outputSummary} />
        </div>
      ) : null}
      {linkedExchanges.length > 0 ? (
        <div className="ai-debug-linked-exchanges" aria-label="关联 LLM 调用">
          <strong>LLM exchange x {linkedExchanges.length}</strong>
          {linkedExchanges.slice(0, 4).map((exchange) => (
            <span key={exchange.id}>
              Round {exchange.providerRound} · Attempt {exchange.attemptIndex} · {exchange.mode} · {statusLabel(exchange.status)}
            </span>
          ))}
          {linkedExchanges.length > 4 ? <em>还有 {linkedExchanges.length - 4} 条</em> : null}
        </div>
      ) : null}
      {node.children.length > 0 ? (
        <ol className="ai-debug-tree">
          {node.children.map((child) => (
            <TraceNode key={child.id} node={child} exchangesBySpanId={exchangesBySpanId} depth={depth + 1} />
          ))}
        </ol>
      ) : null}
    </li>
  );
}

function ExchangeCard({ exchange, span }: { exchange: AiRunLLMExchange; span?: AiRunTraceTreeNode }) {
  return (
    <article className={`ai-debug-exchange is-${exchange.status}`}>
      <header>
        <div>
          <strong>Round {exchange.providerRound} · Attempt {exchange.attemptIndex}</strong>
          <span>{exchange.mode} · {exchange.model} · {exchange.durationMs}ms</span>
          <span>{spanDisplayName(span)}</span>
          <span>
            request {exchange.requestBytes} bytes{exchange.requestTruncated ? ' · truncated' : ''}
            {' · '}
            response {exchange.responseBytes} bytes{exchange.responseTruncated ? ' · truncated' : ''}
          </span>
        </div>
        <em>{statusLabel(exchange.status)}</em>
      </header>
      {exchange.errorCode || exchange.errorMessage ? (
        <p className="ai-debug-error-line">
          {exchange.errorCode ? <code>{exchange.errorCode}</code> : null}
          {exchange.errorMessage ? <span>{exchange.errorMessage}</span> : null}
        </p>
      ) : null}
      {exchange.responseText ? <p className="ai-debug-response-text">{exchange.responseText}</p> : null}
      <div className="ai-debug-json-grid">
        <JsonBlock title="Request messages" value={exchange.requestMessages} />
        <JsonBlock title="Request tools" value={exchange.requestTools} />
        <JsonBlock title="Request options" value={exchange.requestOptions} />
        <JsonBlock title="Request digest" value={{
          originalDigest: exchange.requestOriginalDigest,
          originalBytes: exchange.requestOriginalBytes,
          storedDigest: exchange.requestDigest,
          storedBytes: exchange.requestBytes,
          truncated: exchange.requestTruncated,
        }} />
        <JsonBlock title="Response message" value={exchange.responseMessage} />
        <JsonBlock title="Response tool calls" value={exchange.responseToolCalls} />
        <JsonBlock title="Response digest" value={{
          originalDigest: exchange.responseOriginalDigest,
          originalBytes: exchange.responseOriginalBytes,
          storedDigest: exchange.responseDigest,
          storedBytes: exchange.responseBytes,
          truncated: exchange.responseTruncated,
        }} />
        {exchange.streamChunks.length > 0 ? <JsonBlock title="Stream chunks" value={exchange.streamChunks} /> : null}
      </div>
    </article>
  );
}

export function AiRunDebugDrawer({ runId, open, onClose }: AiRunDebugDrawerProps) {
  const [activeTab, setActiveTab] = useState<DebugTab>('timeline');
  const enabled = Boolean(open && runId);
  const traceQuery = useQuery({
    queryKey: queryKeys.aiRunTraceTree(runId),
    queryFn: () => api.getAiRunTraceTree(runId as string),
    enabled,
  });
  const exchangesQuery = useQuery({
    queryKey: queryKeys.aiRunLlmExchanges(runId),
    queryFn: () => api.getAiRunLlmExchanges(runId as string),
    enabled,
  });
  const spans = useMemo(() => flattenTraceTree(traceQuery.data?.tree ?? []), [traceQuery.data?.tree]);
  const spanBySpanId = useMemo(() => new Map(spans.map((span) => [span.spanId, span])), [spans]);
  const exchangesBySpanId = useMemo(() => {
    const grouped = new Map<string, AiRunLLMExchange[]>();
    for (const exchange of exchangesQuery.data?.exchanges ?? []) {
      if (!exchange.spanId) continue;
      const list = grouped.get(exchange.spanId) ?? [];
      list.push(exchange);
      grouped.set(exchange.spanId, list);
    }
    return grouped;
  }, [exchangesQuery.data?.exchanges]);
  const failedSpans = useMemo(() => spans.filter((span) => span.status === 'failed' || span.errorCode || span.errorMessage), [spans]);
  const failedExchanges = useMemo(
    () => (exchangesQuery.data?.exchanges ?? []).filter((exchange) => exchange.status === 'failed' || exchange.errorCode || exchange.errorMessage),
    [exchangesQuery.data?.exchanges],
  );
  const isLoading = traceQuery.isLoading || exchangesQuery.isLoading;
  const error = traceQuery.error ?? exchangesQuery.error ?? null;
  const isPermissionDenied = isApiError(error) && error.status === 403;
  const tracePayload = {
    runId,
    exportedAt: new Date().toISOString(),
    traceTree: traceQuery.data ?? null,
    traceSpans: spans,
    llmExchanges: exchangesQuery.data ?? null,
    traceConfig: {
      traceId: traceQuery.data?.traceId || exchangesQuery.data?.traceId || '',
      spanCount: spans.length,
      llmExchangeCount: exchangesQuery.data?.exchanges.length ?? 0,
    },
  };

  if (!open || !runId) return null;

  return (
    <div className="workspace-overlay-root ai-debug-drawer-root">
      <div className="workspace-overlay-backdrop" onClick={onClose} />
      <WorkspaceDrawer
        title="运行调试"
        eyebrow="AI Trace"
        description={runId}
        closeLabel="关闭"
        closeAriaLabel="关闭运行调试"
        className="ai-debug-drawer"
        onClose={onClose}
      >
        <div className="ai-debug-toolbar">
          <div className="ai-debug-tabs" role="tablist" aria-label="运行调试视图">
            {DEBUG_TABS.map((tab) => (
              <button
                key={tab.key}
                className={activeTab === tab.key ? 'active' : ''}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.key}
                onClick={() => setActiveTab(tab.key)}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <button className="ghost-button ai-debug-export" type="button" disabled={isLoading || Boolean(error)} onClick={() => downloadTraceJson(runId, tracePayload)}>
            导出 JSON
          </button>
        </div>
        {isLoading ? (
          <div className="ai-debug-state">正在加载调试信息...</div>
        ) : error ? (
          <div className="ai-debug-state is-error">
            <strong>{isPermissionDenied ? '当前账号无权查看完整调试信息' : '调试信息加载失败'}</strong>
            <span>{isPermissionDenied ? '完整 LLM exchange 仅限 Owner 查看。' : error instanceof Error ? error.message : '请稍后重试。'}</span>
          </div>
        ) : activeTab === 'timeline' ? (
          traceQuery.data?.tree.length ? (
            <ol className="ai-debug-tree">
              {traceQuery.data.tree.map((node) => (
                <TraceNode key={node.id} node={node} exchangesBySpanId={exchangesBySpanId} />
              ))}
            </ol>
          ) : (
            <div className="ai-debug-state">暂无 trace span。</div>
          )
        ) : activeTab === 'llm' ? (
          exchangesQuery.data?.exchanges.length ? (
            <div className="ai-debug-exchanges">
              {exchangesQuery.data.exchanges.map((exchange) => (
                <ExchangeCard key={exchange.id} exchange={exchange} span={exchange.spanId ? spanBySpanId.get(exchange.spanId) : undefined} />
              ))}
            </div>
          ) : (
            <div className="ai-debug-state">暂无 LLM exchange。</div>
          )
        ) : (
          <div className="ai-debug-errors">
            {failedSpans.length === 0 && failedExchanges.length === 0 ? (
              <div className="ai-debug-state">没有失败 span 或 exchange。</div>
            ) : null}
            {failedSpans.map((span) => (
              <article key={span.id} className="ai-debug-error-card">
                <strong>{span.name}</strong>
                <span>{span.spanType} · {statusLabel(span.status)} · {span.durationMs}ms</span>
                {span.errorCode ? <code>{span.errorCode}</code> : null}
                {span.errorMessage ? <p>{span.errorMessage}</p> : null}
              </article>
            ))}
            {failedExchanges.map((exchange) => (
              <article key={exchange.id} className="ai-debug-error-card">
                <strong>LLM Round {exchange.providerRound} · Attempt {exchange.attemptIndex}</strong>
                <span>{exchange.mode} · {exchange.model} · {exchange.durationMs}ms</span>
                {exchange.errorCode ? <code>{exchange.errorCode}</code> : null}
                {exchange.errorMessage ? <p>{exchange.errorMessage}</p> : null}
              </article>
            ))}
          </div>
        )}
      </WorkspaceDrawer>
    </div>
  );
}
