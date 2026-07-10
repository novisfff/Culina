import { useMemo, useState } from 'react';
import type { AiQualityMetrics } from '../../api/types';
import {
  AI_INTENT_LABELS,
  AI_SKILL_LABELS,
  AI_TOKEN_USAGE_WINDOWS,
  type AiTokenUsageWindowKey,
  aiRunSuccessRate,
  formatAiDuration,
  formatAiRate,
  formatAiMetricLabel,
  formatAiTokenCost,
  formatAiTokenCount,
  sumAiNestedStatus,
  topAiMetricEntry,
} from './AiQualityMetricsModel';

type AiQualityDiagnosticsCardProps = {
  metrics?: AiQualityMetrics | null;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
};

type MetricTone = 'success' | 'warning' | 'danger' | 'neutral';

function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <article className="ai-quality-stat">
      <span className="ai-quality-stat-label">{label}</span>
      <strong className="ai-quality-stat-value">{value}</strong>
      <small className="ai-quality-stat-hint">{hint}</small>
    </article>
  );
}

function SignalItem({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  tone?: MetricTone;
}) {
  return (
    <div className={`ai-quality-signal is-${tone}`}>
      <span className="ai-quality-signal-label">{label}</span>
      <strong className="ai-quality-signal-value">{value}</strong>
    </div>
  );
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="ai-quality-mini">
      <span className="ai-quality-mini-label">{label}</span>
      <strong className="ai-quality-mini-value">{value}</strong>
    </div>
  );
}

export function AiQualityDiagnosticsCard({ metrics, isLoading, isError, onRetry }: AiQualityDiagnosticsCardProps) {
  const [tokenWindow, setTokenWindow] = useState<AiTokenUsageWindowKey>('24h');
  const topSkill = topAiMetricEntry(metrics?.routing_skill_counts);
  const topIntent = topAiMetricEntry(metrics?.intent_counts);
  const topClarification = topAiMetricEntry(metrics?.clarification_reasons);
  const topDiagnostic = topAiMetricEntry(metrics?.skill_diagnostics);
  const topTraceError = topAiMetricEntry(metrics?.trace_metrics.errorCodes);
  const failedRuns = metrics?.status_counts.failed ?? 0;
  const failedTraceItems = (metrics?.trace_metrics.failedSpanCount ?? 0) + (metrics?.trace_metrics.failedExchangeCount ?? 0);
  const pendingApprovals = sumAiNestedStatus(metrics?.approval_by_draft_type, 'pending');
  const hasRunWarning = failedRuns > 0 || failedTraceItems > 0;
  const selectedTokenUsage = useMemo(() => {
    const windows = metrics?.token_usage?.windows ?? {};
    return (
      windows[tokenWindow] ?? {
        hours: tokenWindow === '24h' ? 24 : tokenWindow === '7d' ? 168 : 720,
        exchangeCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cachedTokens: 0,
        estimatedCostUsd: 0,
      }
    );
  }, [metrics?.token_usage?.windows, tokenWindow]);

  if (isLoading && !metrics) {
    return (
      <section className="ai-quality-card" aria-label="AI 质量诊断">
        <div className="ai-quality-card-head">
          <div>
            <span className="ai-quality-eyebrow">运行概览</span>
            <strong>正在读取最近运行</strong>
          </div>
        </div>
        <p className="ai-quality-note">稍等一下，我在整理最近的 AI 运行状态。</p>
      </section>
    );
  }

  if (isError) {
    return (
      <section className="ai-quality-card is-warning" aria-label="AI 质量诊断">
        <div className="ai-quality-card-head">
          <div>
            <span className="ai-quality-eyebrow">运行概览</span>
            <strong>暂时读不到指标</strong>
          </div>
        </div>
        <button className="tertiary-button ai-quality-retry" type="button" onClick={onRetry}>
          重新读取
        </button>
      </section>
    );
  }

  if (!metrics || metrics.run_count === 0) {
    return (
      <section className="ai-quality-card" aria-label="AI 质量诊断">
        <div className="ai-quality-card-head">
          <div>
            <span className="ai-quality-eyebrow">运行概览</span>
            <strong>还没有运行记录</strong>
          </div>
        </div>
        <p className="ai-quality-note">发起一次 AI 任务后，这里会显示澄清、审批和 Skill 诊断。</p>
      </section>
    );
  }

  const runAlertValue = hasRunWarning
    ? `失败 ${failedRuns} 次 · Trace ${failedTraceItems} 项`
    : '状态平稳';
  const watchValue = topTraceError
    ? `${formatAiMetricLabel(topTraceError.key)} · ${topTraceError.count}`
    : topClarification
      ? `${formatAiMetricLabel(topClarification.key)} · ${topClarification.count}`
      : topDiagnostic
        ? `${topDiagnostic.key} · ${topDiagnostic.count}`
        : pendingApprovals
          ? `待审批 · ${pendingApprovals}`
          : '状态平稳';
  const hasWatchItem = Boolean(topTraceError || topClarification || topDiagnostic || pendingApprovals);
  const providerValue = metrics.trace_metrics.llmExchangeCount
    ? `${formatAiDuration(metrics.trace_metrics.averageProviderDurationMs)} · ${metrics.trace_metrics.averageProviderRounds} 轮`
    : '暂无样本';
  const toolValue = metrics.trace_metrics.traceSpanCount
    ? formatAiDuration(metrics.trace_metrics.averageToolDurationMs)
    : '暂无样本';
  const scriptValue = metrics.trace_metrics.traceSpanCount
    ? formatAiDuration(metrics.trace_metrics.averageScriptDurationMs)
    : '暂无样本';
  const tokenCost = formatAiTokenCost(selectedTokenUsage.estimatedCostUsd);
  const tokenHint =
    selectedTokenUsage.exchangeCount > 0
      ? `${selectedTokenUsage.exchangeCount} 次调用${tokenCost === '—' ? '' : ` · 约 ${tokenCost}`}`
      : '暂无样本';

  return (
    <section className="ai-quality-card" aria-label="AI 质量诊断">
      <div className="ai-quality-card-head">
        <div>
          <span className="ai-quality-eyebrow">表现概览</span>
          <strong>最近 {metrics.run_count} 次运行</strong>
        </div>
        <span className={`ai-quality-health ${hasRunWarning ? 'is-attention' : 'is-stable'}`}>
          {hasRunWarning ? '有运行提醒' : '运行平稳'}
        </span>
      </div>

      <div className="ai-quality-stats" aria-label="核心表现指标">
        <StatCard
          label="运行成功率"
          value={aiRunSuccessRate(metrics)}
          hint={`${metrics.status_counts.completed ?? 0}/${metrics.run_count} 次完成`}
        />
        <StatCard
          label="草稿一次通过"
          value={formatAiRate(metrics.operational_metrics.draftFirstPassRate)}
          hint="首次校验无需返工"
        />
        <StatCard
          label="跨步骤完成"
          value={formatAiRate(metrics.operational_metrics.continuationCompletionRate)}
          hint="连续任务完整衔接"
        />
        <StatCard
          label="确认时未修改"
          value={formatAiRate(metrics.operational_metrics.approvalUneditedRate)}
          hint="草稿直接确认"
        />
      </div>

      <div className="ai-quality-block" aria-labelledby="ai-quality-routing-title">
        <div className="ai-quality-block-head">
          <h4 id="ai-quality-routing-title">运行信号</h4>
        </div>
        <div className="ai-quality-signals" aria-label="运行信号指标">
          <SignalItem
            label="运行提醒"
            value={runAlertValue}
            tone={hasRunWarning ? 'danger' : 'success'}
          />
          <SignalItem
            label="高频意图"
            value={
              topIntent
                ? `${formatAiMetricLabel(topIntent.key, AI_INTENT_LABELS)} · ${topIntent.count}`
                : '暂无样本'
            }
          />
          <SignalItem
            label="常用 Skill"
            value={
              topSkill
                ? `${formatAiMetricLabel(topSkill.key, AI_SKILL_LABELS)} · ${topSkill.count}`
                : '暂无样本'
            }
          />
          <SignalItem
            label="待关注"
            value={watchValue}
            tone={hasWatchItem ? 'warning' : 'neutral'}
          />
        </div>
      </div>

      <div className="ai-quality-block" aria-labelledby="ai-quality-token-title">
        <div className="ai-quality-block-head ai-quality-block-head-row">
          <div>
            <h4 id="ai-quality-token-title">Token 用量</h4>
          </div>
          <div className="ai-quality-window-switch" role="tablist" aria-label="Token 统计窗口">
            {AI_TOKEN_USAGE_WINDOWS.map((window) => {
              const selected = tokenWindow === window.key;
              return (
                <button
                  key={window.key}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  className={selected ? 'is-active' : undefined}
                  onClick={() => setTokenWindow(window.key)}
                >
                  {window.label}
                </button>
              );
            })}
          </div>
        </div>
        <div className="ai-quality-token-summary">
          <div>
            <span>总 Token</span>
            <strong>{formatAiTokenCount(selectedTokenUsage.totalTokens)}</strong>
            <small>{tokenHint}</small>
          </div>
          <div className="ai-quality-minis" aria-label={`${tokenWindow} token 明细`}>
            <MiniMetric label="输入" value={formatAiTokenCount(selectedTokenUsage.inputTokens)} />
            <MiniMetric label="输出" value={formatAiTokenCount(selectedTokenUsage.outputTokens)} />
            <MiniMetric label="缓存" value={formatAiTokenCount(selectedTokenUsage.cachedTokens)} />
          </div>
        </div>
      </div>

      <div className="ai-quality-block" aria-labelledby="ai-quality-performance-title">
        <div className="ai-quality-block-head">
          <h4 id="ai-quality-performance-title">耗时表现</h4>
        </div>
        <div className="ai-quality-minis" aria-label="耗时表现指标">
          <MiniMetric label="Provider" value={providerValue} />
          <MiniMetric label="Tool" value={toolValue} />
          <MiniMetric label="Script" value={scriptValue} />
        </div>
      </div>

      <div className="ai-quality-block is-soft" aria-labelledby="ai-quality-guardrails-title">
        <div className="ai-quality-block-head">
          <h4 id="ai-quality-guardrails-title">安全护栏</h4>
        </div>
        <div className="ai-quality-minis" aria-label="AI 工作流运行计数">
          <MiniMetric
            label="无效身份拒绝"
            value={`${metrics.operational_metrics.invalidIdentityRejectedCount} 次`}
          />
          <MiniMetric
            label="跨步骤拒绝"
            value={`${metrics.operational_metrics.continuationRejectedCount} 次`}
          />
          <MiniMetric
            label="工具预算耗尽"
            value={`${metrics.operational_metrics.toolBudgetExhaustedCount} 次`}
          />
        </div>
        <p className="ai-quality-note">仅用于复核近期 AI 工作流，不代表推荐正确率。</p>
      </div>
    </section>
  );
}
