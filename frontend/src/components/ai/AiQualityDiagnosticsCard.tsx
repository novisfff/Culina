import type { AiQualityMetrics } from '../../api/types';
import {
  AI_INTENT_LABELS,
  AI_SKILL_LABELS,
  aiRunSuccessRate,
  formatAiDuration,
  formatAiMetricLabel,
  sumAiNestedStatus,
  topAiMetricEntry,
} from './AiQualityMetricsModel';

type AiQualityDiagnosticsCardProps = {
  metrics?: AiQualityMetrics | null;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
};

export function AiQualityDiagnosticsCard({ metrics, isLoading, isError, onRetry }: AiQualityDiagnosticsCardProps) {
  const topSkill = topAiMetricEntry(metrics?.routing_skill_counts);
  const topIntent = topAiMetricEntry(metrics?.intent_counts);
  const topClarification = topAiMetricEntry(metrics?.clarification_reasons);
  const topDiagnostic = topAiMetricEntry(metrics?.skill_diagnostics);
  const topTraceError = topAiMetricEntry(metrics?.trace_metrics.errorCodes);
  const failedRuns = metrics?.status_counts.failed ?? 0;
  const failedTraceItems = (metrics?.trace_metrics.failedSpanCount ?? 0) + (metrics?.trace_metrics.failedExchangeCount ?? 0);
  const pendingApprovals = sumAiNestedStatus(metrics?.approval_by_draft_type, 'pending');

  if (isLoading && !metrics) {
    return (
      <section className="ai-quality-card" aria-label="AI 质量诊断">
        <div className="ai-quality-card-head">
          <span>质量诊断</span>
          <strong>正在读取最近运行</strong>
        </div>
        <p className="ai-quality-note">稍等一下，我在整理最近的 AI 运行状态。</p>
      </section>
    );
  }

  if (isError) {
    return (
      <section className="ai-quality-card is-warning" aria-label="AI 质量诊断">
        <div className="ai-quality-card-head">
          <span>质量诊断</span>
          <strong>暂时读不到指标</strong>
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
          <span>质量诊断</span>
          <strong>还没有运行记录</strong>
        </div>
        <p className="ai-quality-note">发起一次 AI 任务后，这里会显示澄清、审批和 Skill 诊断。</p>
      </section>
    );
  }

  return (
    <section className="ai-quality-card" aria-label="AI 质量诊断">
      <div className="ai-quality-card-head">
        <span>质量诊断</span>
        <strong>最近 {metrics.run_count} 次运行</strong>
      </div>
      <div className="ai-quality-metrics">
        <div>
          <span>完成率</span>
          <strong>{aiRunSuccessRate(metrics)}</strong>
        </div>
        <div className={failedRuns > 0 ? 'needs-attention' : ''}>
          <span>失败</span>
          <strong>{failedRuns}</strong>
        </div>
        <div>
          <span>澄清</span>
          <strong>{metrics.totals.clarificationCount}</strong>
        </div>
        <div>
          <span>审批</span>
          <strong>{metrics.totals.approvalRequestCount}</strong>
        </div>
        <div className={failedTraceItems > 0 ? 'needs-attention' : ''}>
          <span>Trace 失败</span>
          <strong>{failedTraceItems}</strong>
        </div>
      </div>
      <div className="ai-quality-lines">
        <p>
          <span>高频意图</span>
          <strong>{topIntent ? `${formatAiMetricLabel(topIntent.key, AI_INTENT_LABELS)} · ${topIntent.count}` : '暂无'}</strong>
        </p>
        <p>
          <span>常用 Skill</span>
          <strong>{topSkill ? `${formatAiMetricLabel(topSkill.key, AI_SKILL_LABELS)} · ${topSkill.count}` : '暂无'}</strong>
        </p>
        <p>
          <span>待关注</span>
          <strong>{topTraceError ? `${formatAiMetricLabel(topTraceError.key)} · ${topTraceError.count}` : topClarification ? `${formatAiMetricLabel(topClarification.key)} · ${topClarification.count}` : topDiagnostic ? `${topDiagnostic.key} · ${topDiagnostic.count}` : pendingApprovals ? `待审批 · ${pendingApprovals}` : '状态平稳'}</strong>
        </p>
        <p>
          <span>Provider</span>
          <strong>{metrics.trace_metrics.llmExchangeCount ? `${formatAiDuration(metrics.trace_metrics.averageProviderDurationMs)} · ${metrics.trace_metrics.averageProviderRounds} 轮` : '暂无'}</strong>
        </p>
        <p>
          <span>Tool / Script</span>
          <strong>{metrics.trace_metrics.traceSpanCount ? `${formatAiDuration(metrics.trace_metrics.averageToolDurationMs)} / ${formatAiDuration(metrics.trace_metrics.averageScriptDurationMs)}` : '暂无'}</strong>
        </p>
      </div>
    </section>
  );
}
