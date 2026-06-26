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

type ExchangeDisplayInfo = {
  title: string;
  providerLabel: string;
  runtimeLabel: string;
  spanLabel: string;
  compactLabel: string;
};

type TokenUsageSummary = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens: number;
  estimatedCostUsd: number | null;
  hasUsage: boolean;
};

const DEBUG_TABS: Array<{ key: DebugTab; label: string }> = [
  { key: 'timeline', label: '流程' },
  { key: 'llm', label: '模型' },
  { key: 'errors', label: '异常' },
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

const TRACE_SPAN_TYPE_LABELS: Record<string, string> = {
  run: '整次运行',
  graph_node: '编排入口',
  orchestrator_round: '编排轮次',
  approval_followup: '人工确认后续响应',
  draft_publish: '确认草稿',
  skill_execution: 'Skill 执行',
  tool_call: '工具调用',
  script_call: '脚本调用',
  provider_round: '模型轮次',
  provider_attempt: '模型尝试',
};

const SUMMARY_KEY_LABELS: Record<string, string> = {
  status: '状态',
  agentRounds: '已完成轮次',
  injectedSkills: '注入 Skill',
  initialInjectedSkills: '初始 Skill',
  historicalArtifactCount: '历史产物',
  runArtifactCount: '运行产物',
  conversationMessageCount: '对话消息',
  pendingApprovalId: '等待确认',
  terminalStatus: '终态',
  approvalId: '确认',
  decision: '决策',
  model: '模型',
  draftCount: '草稿',
  cardCount: '结果卡',
  toolCallCount: '工具调用',
  readTools: '读取工具',
  draftType: '草稿类型',
  schemaVersion: 'Schema',
  tool: '工具',
  messageId: '消息',
  inputKeys: '输入字段',
  outputKeys: '输出字段',
  sideEffect: '副作用',
  permission: '权限',
  requiresConfirmation: '需确认',
  functionName: '函数',
  scriptPath: '脚本',
  timeoutSeconds: '超时',
};

function formatDuration(durationMs: number) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return '0ms';
  if (durationMs < 1000) return `${durationMs}ms`;
  if (durationMs < 60000) return `${(durationMs / 1000).toFixed(durationMs < 10000 ? 1 : 0)}s`;
  const minutes = Math.floor(durationMs / 60000);
  const seconds = Math.round((durationMs % 60000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

function formatTokenCount(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '未记录';
  return new Intl.NumberFormat('zh-CN').format(value);
}

function formatCost(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '未配置';
  return `$${value.toFixed(value < 0.01 ? 6 : 4)}`;
}

function emptyTokenSummary(): TokenUsageSummary {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0, estimatedCostUsd: null, hasUsage: false };
}

function summarizeUsage(exchanges: AiRunLLMExchange[]): TokenUsageSummary {
  return exchanges.reduce<TokenUsageSummary>((summary, exchange) => {
    const inputTokens = exchange.inputTokens ?? 0;
    const outputTokens = exchange.outputTokens ?? 0;
    const totalTokens = exchange.totalTokens ?? inputTokens + outputTokens;
    const cachedTokens = exchange.cachedTokens ?? 0;
    const estimatedCostUsd = exchange.estimatedCostUsd ?? null;
    summary.inputTokens += inputTokens;
    summary.outputTokens += outputTokens;
    summary.totalTokens += totalTokens;
    summary.cachedTokens += cachedTokens;
    if (estimatedCostUsd !== null) {
      summary.estimatedCostUsd = (summary.estimatedCostUsd ?? 0) + estimatedCostUsd;
    }
    summary.hasUsage = summary.hasUsage
      || (exchange.inputTokens !== null && exchange.inputTokens !== undefined)
      || (exchange.outputTokens !== null && exchange.outputTokens !== undefined)
      || (exchange.totalTokens !== null && exchange.totalTokens !== undefined)
      || (exchange.cachedTokens !== null && exchange.cachedTokens !== undefined)
      || estimatedCostUsd !== null;
    return summary;
  }, emptyTokenSummary());
}

function TokenUsageChips({ summary, compact = false }: { summary: TokenUsageSummary; compact?: boolean }) {
  const cacheLabel = summary.cachedTokens > 0 ? `缓存 ${formatTokenCount(summary.cachedTokens)}` : '缓存未命中';
  return (
    <div className={`ai-debug-token-chips${compact ? ' is-compact' : ''}`} aria-label="Token 用量">
      <span>输入 {summary.hasUsage ? formatTokenCount(summary.inputTokens) : '未记录'}</span>
      <span>输出 {summary.hasUsage ? formatTokenCount(summary.outputTokens) : '未记录'}</span>
      <span>总计 {summary.hasUsage ? formatTokenCount(summary.totalTokens) : '未记录'}</span>
      <span className={summary.cachedTokens > 0 ? 'is-cache-hit' : undefined}>{cacheLabel}</span>
      {!compact ? <span>费用 {formatCost(summary.estimatedCostUsd)}</span> : null}
    </div>
  );
}

function roundLabel(span: AiRunTraceTreeNode) {
  return span.roundIndex !== null && span.roundIndex !== undefined ? `第 ${span.roundIndex} 轮` : null;
}

function traceStepTitle(span: AiRunTraceTreeNode) {
  const round = roundLabel(span);
  if (span.spanType === 'run') return '整次运行';
  if (span.spanType === 'graph_node') return `${round ? `${round} ` : ''}${span.name === 'orchestrator' ? '编排入口' : span.name}`;
  if (span.spanType === 'orchestrator_round') return `${round ? `${round} ` : ''}AI 决策`;
  if (span.spanType === 'approval_followup') return '确认后的回复';
  if (span.spanType === 'draft_publish') return '生成确认草稿';
  if (span.spanType === 'tool_call') return `工具调用：${span.name}`;
  if (span.spanType === 'script_call') return `脚本调用：${span.name}`;
  return `${TRACE_SPAN_TYPE_LABELS[span.spanType] ?? span.spanType}：${span.name}`;
}

function spanMeta(span: AiRunTraceTreeNode) {
  const typeLabel = TRACE_SPAN_TYPE_LABELS[span.spanType] ?? span.spanType;
  return [
    typeLabel,
    roundLabel(span),
    span.attemptIndex !== null && span.attemptIndex !== undefined ? `第 ${span.attemptIndex} 次尝试` : null,
    formatDuration(span.durationMs),
  ].filter(Boolean).join(' · ');
}

function spanDisplayName(span: AiRunTraceTreeNode | undefined) {
  if (!span) return '未关联步骤';
  return `${TRACE_SPAN_TYPE_LABELS[span.spanType] ?? span.spanType} · ${traceStepTitle(span)}`;
}

function formatSummaryValue(value: unknown, key?: string): string {
  if (key === 'status' || key === 'terminalStatus') return statusLabel(String(value));
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value.trim() || '空';
  if (Array.isArray(value)) {
    if (value.length === 0) return '无';
    const simpleItems = value.filter((item) => ['string', 'number', 'boolean'].includes(typeof item));
    if (simpleItems.length === value.length && simpleItems.length <= 3) return simpleItems.map(String).join('、');
    return `${value.length} 项`;
  }
  if (value && typeof value === 'object') return `${Object.keys(value).length} 项`;
  return '无';
}

function summaryItems(summary: Record<string, unknown>) {
  return Object.entries(summary)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .slice(0, 6)
    .map(([key, value]) => ({
      key,
      label: SUMMARY_KEY_LABELS[key] ?? key,
      value: formatSummaryValue(value, key),
    }));
}

function buildExchangeDisplayInfo(
  exchange: AiRunLLMExchange,
  index: number,
  span?: AiRunTraceTreeNode,
): ExchangeDisplayInfo {
  const providerLabel = `模型轮次 ${exchange.providerRound} · 尝试 ${exchange.attemptIndex}`;
  const runtimeLabel = `${exchange.mode} · ${exchange.model} · ${formatDuration(exchange.durationMs)}`;
  const spanLabel = spanDisplayName(span);
  const totalTokens = exchange.totalTokens ?? ((exchange.inputTokens ?? 0) + (exchange.outputTokens ?? 0));
  const tokenLabel = exchange.totalTokens !== null && exchange.totalTokens !== undefined ? ` · Token ${formatTokenCount(totalTokens)}` : '';
  return {
    title: `模型调用 ${index + 1}`,
    providerLabel,
    runtimeLabel,
    spanLabel,
    compactLabel: `模型 ${index + 1} · ${providerLabel}${tokenLabel} · ${statusLabel(exchange.status)}`,
  };
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

function collectNodeExchanges(node: AiRunTraceTreeNode, exchangesBySpanId: Map<string, AiRunLLMExchange[]>): AiRunLLMExchange[] {
  return [
    ...(exchangesBySpanId.get(node.spanId) ?? []),
    ...node.children.flatMap((child) => collectNodeExchanges(child, exchangesBySpanId)),
  ];
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

function TraceSummary({ inputSummary, outputSummary }: { inputSummary: Record<string, unknown>; outputSummary: Record<string, unknown> }) {
  const inputItems = summaryItems(inputSummary);
  const outputItems = summaryItems(outputSummary);
  if (inputItems.length === 0 && outputItems.length === 0) return null;
  return (
    <div className="ai-debug-step-summary">
      {inputItems.length > 0 ? (
        <div>
          <strong>输入</strong>
          <div className="ai-debug-summary-chips">
            {inputItems.map((item) => (
              <span key={`input-${item.key}`}>{item.label}: {item.value}</span>
            ))}
          </div>
        </div>
      ) : null}
      {outputItems.length > 0 ? (
        <div>
          <strong>结果</strong>
          <div className="ai-debug-summary-chips">
            {outputItems.map((item) => (
              <span key={`output-${item.key}`}>{item.label}: {item.value}</span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function TraceOverview({ spans, exchanges }: { spans: AiRunTraceTreeNode[]; exchanges: AiRunLLMExchange[] }) {
  const failedCount = spans.filter((span) => span.status === 'failed' || span.errorCode || span.errorMessage).length;
  const waitingCount = spans.filter((span) => span.status === 'waiting').length;
  const toolCount = spans.filter((span) => span.spanType === 'tool_call' || span.spanType === 'script_call').length;
  const tokenSummary = summarizeUsage(exchanges);
  const runDuration = spans.find((span) => span.spanType === 'run')?.durationMs ?? spans.reduce((total, span) => Math.max(total, span.durationMs), 0);
  return (
    <div className="ai-debug-overview-panel" aria-label="流程概览">
      <div className="ai-debug-overview">
        <span>步骤 {spans.length}</span>
        <span>模型调用 {exchanges.length}</span>
        <span>工具/脚本 {toolCount}</span>
        <span>总耗时 {formatDuration(runDuration)}</span>
        <span>等待 {waitingCount}</span>
        <span className={failedCount > 0 ? 'is-danger' : undefined}>异常 {failedCount}</span>
      </div>
      <TokenUsageChips summary={tokenSummary} />
    </div>
  );
}

function TraceNode({
  node,
  exchangesBySpanId,
  exchangeDisplayById,
  depth = 0,
}: {
  node: AiRunTraceTreeNode;
  exchangesBySpanId: Map<string, AiRunLLMExchange[]>;
  exchangeDisplayById: Map<string, ExchangeDisplayInfo>;
  depth?: number;
}) {
  const linkedExchanges = exchangesBySpanId.get(node.spanId) ?? [];
  const nodeExchanges = collectNodeExchanges(node, exchangesBySpanId);
  const nodeUsage = summarizeUsage(nodeExchanges);
  const tokenLabel = node.spanType === 'run'
    ? '本次 Token'
    : linkedExchanges.length > 0
      ? '本步骤 Token'
      : '下级 Token';
  return (
    <li className={`ai-debug-span is-${node.status}`} style={{ '--ai-debug-depth': depth } as CSSProperties}>
      <div className="ai-debug-span-main">
        <span className={`ai-debug-status-dot is-${node.status}`} aria-hidden="true" />
        <div>
          <strong>{traceStepTitle(node)}</strong>
          <span>{spanMeta(node)}</span>
        </div>
        <em>{statusLabel(node.status)}</em>
      </div>
      {nodeExchanges.length > 0 ? (
        <div className="ai-debug-node-token-row" aria-label={`${traceStepTitle(node)} Token 用量`}>
          <strong>{tokenLabel}</strong>
          <TokenUsageChips summary={nodeUsage} compact />
        </div>
      ) : null}
      {node.errorCode || node.errorMessage ? (
        <p className="ai-debug-error-line">
          {node.errorCode ? <code>{node.errorCode}</code> : null}
          {node.errorMessage ? <span>{node.errorMessage}</span> : null}
        </p>
      ) : null}
      {(Object.keys(node.inputSummary ?? {}).length > 0 || Object.keys(node.outputSummary ?? {}).length > 0) ? (
        <div className="ai-debug-span-details">
          <TraceSummary inputSummary={node.inputSummary} outputSummary={node.outputSummary} />
          <div className="ai-debug-span-json">
            <JsonBlock title="调试输入" value={node.inputSummary} />
            <JsonBlock title="调试输出" value={node.outputSummary} />
          </div>
        </div>
      ) : null}
      {linkedExchanges.length > 0 ? (
        <div className="ai-debug-linked-exchanges" aria-label="关联 LLM 调用">
          <strong>模型调用 x {linkedExchanges.length}</strong>
          {linkedExchanges.slice(0, 4).map((exchange) => (
            <span key={exchange.id}>{exchangeDisplayById.get(exchange.id)?.compactLabel ?? `模型 · ${statusLabel(exchange.status)}`}</span>
          ))}
          {linkedExchanges.length > 4 ? <em>还有 {linkedExchanges.length - 4} 条</em> : null}
        </div>
      ) : null}
      {node.children.length > 0 ? (
        <ol className="ai-debug-tree">
          {node.children.map((child) => (
            <TraceNode key={child.id} node={child} exchangesBySpanId={exchangesBySpanId} exchangeDisplayById={exchangeDisplayById} depth={depth + 1} />
          ))}
        </ol>
      ) : null}
    </li>
  );
}

function ExchangeCard({ exchange, display }: { exchange: AiRunLLMExchange; display: ExchangeDisplayInfo }) {
  const tokenSummary = summarizeUsage([exchange]);
  return (
    <article className={`ai-debug-exchange is-${exchange.status}`}>
      <header>
        <div>
          <strong>{display.title}</strong>
          <span>{display.runtimeLabel}</span>
          <span>{display.providerLabel}</span>
          <span>{display.spanLabel}</span>
          <span>
            request {exchange.requestBytes} bytes{exchange.requestTruncated ? ' · truncated' : ''}
            {' · '}
            response {exchange.responseBytes} bytes{exchange.responseTruncated ? ' · truncated' : ''}
          </span>
        </div>
        <em>{statusLabel(exchange.status)}</em>
      </header>
      <TokenUsageChips summary={tokenSummary} />
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
        <JsonBlock title="Token usage" value={exchange.tokenUsage} />
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
  const exchanges = exchangesQuery.data?.exchanges ?? [];
  const exchangeDisplayById = useMemo(() => {
    const displayById = new Map<string, ExchangeDisplayInfo>();
    (exchangesQuery.data?.exchanges ?? []).forEach((exchange, index) => {
      displayById.set(
        exchange.id,
        buildExchangeDisplayInfo(exchange, index, exchange.spanId ? spanBySpanId.get(exchange.spanId) : undefined),
      );
    });
    return displayById;
  }, [exchangesQuery.data?.exchanges, spanBySpanId]);
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
      llmExchangeCount: exchanges.length,
      tokenUsage: summarizeUsage(exchanges),
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
            <div className="ai-debug-timeline">
              <TraceOverview spans={spans} exchanges={exchanges} />
              <ol className="ai-debug-tree">
                {traceQuery.data.tree.map((node) => (
                  <TraceNode key={node.id} node={node} exchangesBySpanId={exchangesBySpanId} exchangeDisplayById={exchangeDisplayById} />
                ))}
              </ol>
            </div>
          ) : (
            <div className="ai-debug-state">暂无 trace span。</div>
          )
        ) : activeTab === 'llm' ? (
          exchangesQuery.data?.exchanges.length ? (
            <div className="ai-debug-exchanges">
              {exchangesQuery.data.exchanges.map((exchange) => (
                <ExchangeCard
                  key={exchange.id}
                  exchange={exchange}
                  display={exchangeDisplayById.get(exchange.id) ?? buildExchangeDisplayInfo(exchange, 0)}
                />
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
                <strong>{exchangeDisplayById.get(exchange.id)?.title ?? '模型调用'}</strong>
                <span>{exchange.mode} · {exchange.model} · {exchange.durationMs}ms</span>
                <span>{exchangeDisplayById.get(exchange.id)?.providerLabel ?? `模型轮次 ${exchange.providerRound} · 尝试 ${exchange.attemptIndex}`}</span>
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
