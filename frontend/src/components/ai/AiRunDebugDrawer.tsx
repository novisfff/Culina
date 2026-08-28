import { useMemo, useState, type CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { isApiError } from '../../api/request';
import { queryKeys } from '../../api/queryKeys';
import type { AiRunLLMExchange, AiRunTraceTreeNode } from '../../api/types';
import { WorkspaceDrawer, WorkspaceOverlayFrame } from '../ui-kit';

type AiRunDebugDrawerProps = {
  runId: string | null;
  open: boolean;
  onClose: () => void;
};

type DebugTab = 'timeline' | 'errors';

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
  { key: 'errors', label: '异常' },
];

const STATUS_LABELS: Record<string, string> = {
  running: '运行中',
  queued: '排队中',
  pending: '等待处理',
  in_progress: '处理中',
  completed: '完成',
  failed: '失败',
  waiting: '等待',
  cancelled: '已取消',
  skipped: '已跳过',
  timeout: '已超时',
  partial: '部分完成',
  partially_completed: '部分完成',
};

function statusLabel(status: string) {
  return STATUS_LABELS[status] ?? '状态未知';
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
  run: '整次处理',
  graph_node: '处理入口',
  orchestrator_round: '决策步骤',
  approval_followup: '确认后的处理',
  draft_publish: '生成确认内容',
  skill_execution: '能力处理',
  tool_call: '工具处理',
  script_call: '自动处理',
  provider_round: '模型处理阶段',
  provider_attempt: '模型重试',
  skill_injection: '准备功能',
};

const SUMMARY_KEY_LABELS: Record<string, string> = {
  status: '状态',
  agentRounds: '处理轮次',
  injectedSkills: '使用的功能',
  initialInjectedSkills: '初始功能',
  historicalArtifactCount: '历史结果',
  runArtifactCount: '本次结果',
  conversationMessageCount: '对话条数',
  pendingApprovalId: '待确认内容',
  terminalStatus: '最终状态',
  approvalId: '确认记录',
  decision: '处理决定',
  model: '模型',
  draftCount: '待确认草稿',
  cardCount: '结果卡片',
  toolCallCount: '工具处理数',
  readTools: '读取操作',
  draftType: '内容类型',
  schemaVersion: '数据格式',
  tool: '处理方式',
  alreadyInjected: '已准备',
  availableTools: '可用处理方式',
  requested: '请求',
  added: '新增',
  messageId: '消息记录',
  inputKeys: '涉及输入',
  outputKeys: '产生输出',
  sideEffect: '影响范围',
  permission: '访问范围',
  requiresConfirmation: '需要确认',
  functionName: '处理名称',
  scriptPath: '处理步骤',
  timeoutSeconds: '最长等待',
};

const EXCHANGE_MODE_LABELS: Record<string, string> = {
  tools: '操作模式',
  chat: '对话模式',
  completion: '回复模式',
};

const SUMMARY_VALUE_LABELS: Record<string, Record<string, string>> = {
  sideEffect: { read: '只读取', write: '会保存', update: '会更新', delete: '会删除' },
  permission: { member: '家庭成员', owner: '家庭主理人', admin: '家庭管理员' },
  draftType: {
    recipe: '菜谱',
    meal_log: '餐食记录',
    meal_plan: '餐食计划',
    shopping_list: '采购清单',
    ingredient: '食材信息',
    food: '食物信息',
  },
};

const TOOL_SPAN_TYPES = new Set(['tool_call', 'script_call', 'skill_execution', 'skill_injection']);

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
  if (value === null || value === undefined || !Number.isFinite(value)) return '未记录';
  return `$${value.toFixed(value < 0.01 ? 6 : 4)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringField(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const field = value[key];
  return typeof field === 'string' && field.trim() ? field.trim() : null;
}

function uniqueStrings(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function toolNameFromItem(item: unknown): string | null {
  if (!isRecord(item)) return null;
  const direct = stringField(item, 'name')
    ?? stringField(item, 'tool')
    ?? stringField(item, 'functionName')
    ?? stringField(item, 'internal_code');
  if (direct) return direct;
  const fn = item.function;
  if (isRecord(fn)) return stringField(fn, 'name');
  return null;
}

function toolNamesFromItems(items: unknown[]) {
  return uniqueStrings(items.map(toolNameFromItem));
}

function isToolSpan(span: AiRunTraceTreeNode) {
  return TOOL_SPAN_TYPES.has(span.spanType);
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
    <div className={`ai-debug-token-chips${compact ? ' is-compact' : ''}`} aria-label="文本用量">
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
  if (span.spanType === 'run') return '整次处理';
  if (span.spanType === 'graph_node') return `${round ? `${round} ` : ''}${span.name === 'orchestrator' ? '处理入口' : span.name}`;
  if (span.spanType === 'orchestrator_round') return `${round ? `${round} ` : ''}AI 决策`;
  if (span.spanType === 'approval_followup') return '确认后的回复';
  if (span.spanType === 'draft_publish') return '生成确认内容';
  if (span.spanType === 'tool_call') return `工具处理：${span.name}`;
  if (span.spanType === 'script_call') return `自动处理：${span.name}`;
  return `${TRACE_SPAN_TYPE_LABELS[span.spanType] ?? '处理步骤'}：${span.name}`;
}

function spanMeta(span: AiRunTraceTreeNode) {
  return [
    roundLabel(span),
    span.attemptIndex !== null && span.attemptIndex !== undefined ? `第 ${span.attemptIndex} 次` : null,
    formatDuration(span.durationMs),
  ].filter(Boolean).join(' · ');
}

function spanDisplayName(span: AiRunTraceTreeNode | undefined) {
  if (!span) return '未关联步骤';
  return traceStepTitle(span);
}

function formatSummaryValue(value: unknown, key?: string): string {
  if (key === 'status' || key === 'terminalStatus') return statusLabel(String(value));
  if (key && /(?:Id|ID|_id)$/.test(key)) return value ? '已关联' : '无';
  if (key && typeof value === 'string' && SUMMARY_VALUE_LABELS[key]?.[value]) return SUMMARY_VALUE_LABELS[key][value];
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
    .filter(([key, value]) => key in SUMMARY_KEY_LABELS && value !== undefined && value !== null && value !== '')
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
  const providerLabel = `第 ${exchange.providerRound} 轮处理 · 第 ${exchange.attemptIndex} 次`;
  const modeLabel = EXCHANGE_MODE_LABELS[exchange.mode] ?? '处理模式';
  const runtimeLabel = `${modeLabel} · ${exchange.model} · ${formatDuration(exchange.durationMs)}`;
  const spanLabel = spanDisplayName(span);
  const totalTokens = exchange.totalTokens ?? ((exchange.inputTokens ?? 0) + (exchange.outputTokens ?? 0));
  const tokenLabel = exchange.totalTokens !== null && exchange.totalTokens !== undefined ? ` · 用量 ${formatTokenCount(totalTokens)}` : '';
  return {
    title: `模型处理 ${index + 1}`,
    providerLabel,
    runtimeLabel,
    spanLabel,
    compactLabel: `模型处理 ${index + 1} · ${providerLabel}${tokenLabel} · ${statusLabel(exchange.status)}`,
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
          <strong>触发条件</strong>
          <div className="ai-debug-summary-chips">
            {inputItems.map((item) => (
              <span key={`input-${item.key}`}>{item.label}: {item.value}</span>
            ))}
          </div>
        </div>
      ) : null}
      {outputItems.length > 0 ? (
        <div>
          <strong>执行结果</strong>
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

function ToolSpanSummary({ node }: { node: AiRunTraceTreeNode }) {
  const inputKeys = Array.isArray(node.inputSummary['inputKeys']) ? node.inputSummary['inputKeys'].map(String) : [];
  const outputKeys = Array.isArray(node.outputSummary['outputKeys']) ? node.outputSummary['outputKeys'].map(String) : [];
  const sideEffect = formatSummaryValue(node.inputSummary['sideEffect']);
  const permission = formatSummaryValue(node.inputSummary['permission']);
  const status = formatSummaryValue(node.outputSummary['status'] ?? node.status, 'status');
  return (
    <div className="ai-debug-tool-run" aria-label={`${traceStepTitle(node)} 自动处理信息`}>
      <span>{node.spanType === 'script_call' ? '自动处理' : node.spanType === 'skill_injection' ? '功能' : '工具处理'}：{node.name}</span>
      {inputKeys.length > 0 ? <span>涉及输入：{inputKeys.slice(0, 6).join('、')}{inputKeys.length > 6 ? ` +${inputKeys.length - 6}` : ''}</span> : null}
      {outputKeys.length > 0 ? <span>产生输出：{outputKeys.slice(0, 6).join('、')}{outputKeys.length > 6 ? ` +${outputKeys.length - 6}` : ''}</span> : null}
      <span>状态：{status}</span>
      {node.inputSummary['sideEffect'] ? <span>额外影响：{sideEffect}</span> : null}
      {node.inputSummary['permission'] ? <span>权限：{permission}</span> : null}
      {node.inputSummary['requiresConfirmation'] !== undefined ? <span>需要确认：{formatSummaryValue(node.inputSummary['requiresConfirmation'])}</span> : null}
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
    <div className="ai-debug-overview-panel" aria-label="处理流程概览">
      <div className="ai-debug-overview">
        <span>处理步骤 {spans.length}</span>
        <span>模型处理 {exchanges.length}</span>
        <span>工具处理 {toolCount}</span>
        <span>总耗时 {formatDuration(runDuration)}</span>
        <span>等待 {waitingCount}</span>
        <span className={failedCount > 0 ? 'is-danger' : undefined}>异常 {failedCount}</span>
      </div>
      <TokenUsageChips summary={tokenSummary} />
    </div>
  );
}

function ModelTraceSummaryState({ loading, error }: { loading: boolean; error: unknown }) {
  if (loading) {
    return <div className="ai-debug-lazy-panel">正在加载模型处理摘要…</div>;
  }
  if (!error) return null;
  const isPermissionDenied = isApiError(error) && error.status === 403;
  return (
    <div className="ai-debug-lazy-panel is-error">
      <div>
        <strong>{isPermissionDenied ? '当前账号无权查看模型处理摘要' : '模型处理摘要加载失败'}</strong>
        <span>{isPermissionDenied ? '模型处理详情仅限家庭主理人查看。' : error instanceof Error ? error.message : '请稍后重试。'}</span>
      </div>
    </div>
  );
}

function TraceNode({
  runId,
  node,
  exchangesBySpanId,
  exchangeDisplayById,
  depth = 0,
}: {
  runId: string;
  node: AiRunTraceTreeNode;
  exchangesBySpanId: Map<string, AiRunLLMExchange[]>;
  exchangeDisplayById: Map<string, ExchangeDisplayInfo>;
  depth?: number;
}) {
  const linkedExchanges = exchangesBySpanId.get(node.spanId) ?? [];
  const nodeExchanges = collectNodeExchanges(node, exchangesBySpanId);
  const nodeUsage = summarizeUsage(nodeExchanges);
  const tokenLabel = node.spanType === 'run'
    ? '本次用量'
    : linkedExchanges.length > 0
      ? '本步骤用量'
      : '下级用量';
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
        <div className="ai-debug-node-token-row" aria-label={`${traceStepTitle(node)} 文本用量`}>
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
          {isToolSpan(node) ? <ToolSpanSummary node={node} /> : null}
          <TraceSummary inputSummary={node.inputSummary} outputSummary={node.outputSummary} />
          <div className="ai-debug-span-json">
            <JsonBlock title="触发信息" value={node.inputSummary} />
            <JsonBlock title="结果信息" value={node.outputSummary} />
          </div>
        </div>
      ) : null}
      {linkedExchanges.length > 0 ? (
        <div className="ai-debug-inline-exchanges" aria-label="相关模型处理">
          {linkedExchanges.map((exchange) => (
            <details key={exchange.id} className={`ai-debug-inline-exchange is-${exchange.status}`}>
              <summary>
                <span>{exchangeDisplayById.get(exchange.id)?.compactLabel ?? `模型处理 · ${statusLabel(exchange.status)}`}</span>
                <em>展开明细</em>
              </summary>
              <ExchangeCard
                runId={runId}
                exchange={exchange}
                display={exchangeDisplayById.get(exchange.id) ?? buildExchangeDisplayInfo(exchange, 0)}
              />
            </details>
          ))}
        </div>
      ) : null}
      {node.children.length > 0 ? (
        <ol className="ai-debug-tree">
          {node.children.map((child) => (
            <TraceNode key={child.id} runId={runId} node={child} exchangesBySpanId={exchangesBySpanId} exchangeDisplayById={exchangeDisplayById} depth={depth + 1} />
          ))}
        </ol>
      ) : null}
    </li>
  );
}

function ToolSummaryList({ title, names, count, emptyLabel }: { title: string; names: string[]; count: number; emptyLabel: string }) {
  return (
    <div className="ai-debug-tool-list">
      <strong>{title}</strong>
      {count > 0 ? (
        <div className="ai-debug-tool-pills">
          {names.slice(0, 10).map((name) => <span key={name}>{name}</span>)}
          {names.length === 0 ? <span>{count} 项</span> : null}
          {count > Math.max(names.length, 10) ? <em>还有 {count - Math.max(names.length, 10)} 个</em> : null}
        </div>
      ) : (
        <p>{emptyLabel}</p>
      )}
    </div>
  );
}

function LazyExchangeJsonBlock({
  runId,
  exchangeId,
  title,
  selectValue,
}: {
  runId: string;
  exchangeId: string;
  title: string;
  selectValue: (exchange: AiRunLLMExchange) => unknown;
}) {
  const [open, setOpen] = useState(false);
  const detailQuery = useQuery({
    queryKey: queryKeys.aiRunLlmExchange(runId, exchangeId),
    queryFn: () => api.getAiRunLlmExchange(runId, exchangeId),
    enabled: open,
    staleTime: 5 * 60 * 1000,
  });
  let content: string;
  if (!open) {
    content = '展开后加载。';
  } else if (detailQuery.isLoading) {
    content = '正在加载…';
  } else if (detailQuery.error) {
    content = detailQuery.error instanceof Error ? detailQuery.error.message : '加载失败，请稍后重试。';
  } else {
    content = formatJson(detailQuery.data ? selectValue(detailQuery.data) : null);
  }
  return (
    <details className="ai-debug-json-block" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{title}</summary>
      <pre>{content}</pre>
    </details>
  );
}

function ExchangeCard({ runId, exchange, display }: { runId: string; exchange: AiRunLLMExchange; display: ExchangeDisplayInfo }) {
  const tokenSummary = summarizeUsage([exchange]);
  const requestToolNames = exchange.requestToolNames.length > 0 ? exchange.requestToolNames : toolNamesFromItems(exchange.requestTools);
  const responseToolNames = exchange.responseToolCallNames.length > 0 ? exchange.responseToolCallNames : toolNamesFromItems(exchange.responseToolCalls);
  const requestToolCount = exchange.requestToolCount ?? requestToolNames.length;
  const responseToolCallCount = exchange.responseToolCallCount ?? responseToolNames.length;
  return (
    <article className={`ai-debug-exchange is-${exchange.status}`}>
      <header>
        <div>
          <strong>{display.title}</strong>
          <span>{display.runtimeLabel}</span>
          <span>{display.providerLabel}</span>
          <span>{display.spanLabel}</span>
          <span>
            请求 {exchange.requestBytes} 字节{exchange.requestTruncated ? ' · 已截断' : ''}
            {' · '}
            响应 {exchange.responseBytes} 字节{exchange.responseTruncated ? ' · 已截断' : ''}
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
      <div className="ai-debug-exchange-tool-summary">
        <span>可用处理方式 {requestToolCount}</span>
        <span>AI 生成的操作 {responseToolCallCount}</span>
        {responseToolNames.length > 0 ? <strong>{responseToolNames.slice(0, 4).join('、')}{responseToolNames.length > 4 ? ` +${responseToolNames.length - 4}` : ''}</strong> : null}
      </div>
      <div className="ai-debug-tool-grid">
        <ToolSummaryList title="可用处理方式" names={requestToolNames} count={requestToolCount} emptyLabel="本轮没有可用处理方式。" />
        <ToolSummaryList title="AI 生成的操作" names={responseToolNames} count={responseToolCallCount} emptyLabel="本轮没有生成操作。" />
      </div>
      <div className="ai-debug-json-grid">
        <LazyExchangeJsonBlock runId={runId} exchangeId={exchange.id} title="请求消息" selectValue={(detail) => detail.requestMessages} />
        <LazyExchangeJsonBlock runId={runId} exchangeId={exchange.id} title="可用处理方式详情" selectValue={(detail) => detail.requestTools} />
        <LazyExchangeJsonBlock runId={runId} exchangeId={exchange.id} title="请求设置详情" selectValue={(detail) => detail.requestOptions} />
        <JsonBlock title="请求内容概览" value={{
          originalDigest: exchange.requestOriginalDigest,
          originalBytes: exchange.requestOriginalBytes,
          storedDigest: exchange.requestDigest,
          storedBytes: exchange.requestBytes,
          truncated: exchange.requestTruncated,
        }} />
        <LazyExchangeJsonBlock runId={runId} exchangeId={exchange.id} title="响应消息详情" selectValue={(detail) => detail.responseMessage} />
        <LazyExchangeJsonBlock runId={runId} exchangeId={exchange.id} title="响应文本详情" selectValue={(detail) => detail.responseText} />
        <LazyExchangeJsonBlock runId={runId} exchangeId={exchange.id} title="AI 生成的操作详情" selectValue={(detail) => detail.responseToolCalls} />
        <LazyExchangeJsonBlock runId={runId} exchangeId={exchange.id} title="文本用量详情" selectValue={(detail) => detail.tokenUsage} />
        <JsonBlock title="回复内容概览" value={{
          originalDigest: exchange.responseOriginalDigest,
          originalBytes: exchange.responseOriginalBytes,
          storedDigest: exchange.responseDigest,
          storedBytes: exchange.responseBytes,
          truncated: exchange.responseTruncated,
        }} />
        <LazyExchangeJsonBlock runId={runId} exchangeId={exchange.id} title="分段响应详情" selectValue={(detail) => detail.streamChunks} />
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
    queryKey: queryKeys.aiRunLlmExchanges(runId, false),
    queryFn: () => api.getAiRunLlmExchanges(runId as string, { includePayload: false }),
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
  const isLoading = traceQuery.isLoading;
  const error = traceQuery.error ?? null;
  const isPermissionDenied = isApiError(error) && error.status === 403;
  const exchangeError = exchangesQuery.error ?? null;
  const tracePayload = {
    runId,
    exportedAt: new Date().toISOString(),
    traceTree: traceQuery.data ?? null,
    traceSpans: spans,
    llmExchanges: exchangesQuery.data ?? null,
    traceConfig: {
      traceId: traceQuery.data?.traceId || exchangesQuery.data?.traceId || '',
      spanCount: spans.length,
      toolSpanCount: spans.filter(isToolSpan).length,
      llmExchangeCount: exchanges.length,
      tokenUsage: summarizeUsage(exchanges),
    },
  };

  if (!open || !runId) return null;

  return (
    <WorkspaceOverlayFrame rootClassName="ai-debug-drawer-root" onClose={onClose}>
      <WorkspaceDrawer
        title="处理详情"
        eyebrow="AI 处理记录"
        description="查看本次 AI 处理过程和结果。"
        closeLabel="关闭"
        closeAriaLabel="关闭处理详情"
        className="ai-debug-drawer"
        onClose={onClose}
      >
        <div className="ai-debug-toolbar">
          <div className="ai-debug-tabs" role="tablist" aria-label="处理详情视图">
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
            导出处理记录
          </button>
        </div>
        {isLoading ? (
          <div className="ai-debug-state">正在加载处理详情…</div>
        ) : error ? (
          <div className="ai-debug-state is-error">
            <strong>{isPermissionDenied ? '当前账号无权查看完整处理详情' : '处理详情加载失败'}</strong>
            <span>{isPermissionDenied ? '完整 AI 处理记录仅限家庭主理人查看。' : error instanceof Error ? error.message : '请稍后重试。'}</span>
          </div>
        ) : activeTab === 'timeline' ? (
          traceQuery.data?.tree.length ? (
            <div className="ai-debug-timeline">
              <TraceOverview spans={spans} exchanges={exchanges} />
              <ModelTraceSummaryState loading={exchangesQuery.isLoading} error={exchangeError} />
              <ol className="ai-debug-tree">
                {traceQuery.data.tree.map((node) => (
                  <TraceNode key={node.id} runId={runId} node={node} exchangesBySpanId={exchangesBySpanId} exchangeDisplayById={exchangeDisplayById} />
                ))}
              </ol>
            </div>
          ) : (
            <div className="ai-debug-state">还没有处理步骤。</div>
          )
        ) : (
          <div className="ai-debug-errors">
            {failedSpans.length === 0 && failedExchanges.length === 0 ? (
              <div className="ai-debug-state">没有发现异常。</div>
            ) : null}
            {failedSpans.map((span) => (
              <article key={span.id} className="ai-debug-error-card">
                <strong>{span.name}</strong>
                <span>{TRACE_SPAN_TYPE_LABELS[span.spanType] ?? '处理步骤'} · {statusLabel(span.status)} · {span.durationMs}ms</span>
                {span.errorCode ? <code>{span.errorCode}</code> : null}
                {span.errorMessage ? <p>{span.errorMessage}</p> : null}
              </article>
            ))}
            {failedExchanges.map((exchange) => (
              <article key={exchange.id} className="ai-debug-error-card">
                <strong>{exchangeDisplayById.get(exchange.id)?.title ?? '模型处理'}</strong>
                <span>{EXCHANGE_MODE_LABELS[exchange.mode] ?? '处理模式'} · {exchange.model} · {exchange.durationMs}ms</span>
                <span>{exchangeDisplayById.get(exchange.id)?.providerLabel ?? `第 ${exchange.providerRound} 轮处理 · 第 ${exchange.attemptIndex} 次`}</span>
                {exchange.errorCode ? <code>{exchange.errorCode}</code> : null}
                {exchange.errorMessage ? <p>{exchange.errorMessage}</p> : null}
              </article>
            ))}
          </div>
        )}
      </WorkspaceDrawer>
    </WorkspaceOverlayFrame>
  );
}
