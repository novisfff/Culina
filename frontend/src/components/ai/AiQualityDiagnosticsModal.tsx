import type { AiQualityMetrics } from '../../api/types';
import { WorkspaceModal, WorkspaceOverlayFrame } from '../ui-kit';
import { AiQualityDiagnosticsCard } from './AiQualityDiagnosticsCard';

type AiQualityDiagnosticsModalProps = {
  metrics?: AiQualityMetrics | null;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  onClose: () => void;
};

export function AiQualityDiagnosticsModal({
  metrics,
  isLoading,
  isError,
  onRetry,
  onClose,
}: AiQualityDiagnosticsModalProps) {
  return (
    <WorkspaceOverlayFrame rootClassName="ai-quality-modal-root" onClose={onClose}>
      <WorkspaceModal
        title="AI 质量诊断"
        eyebrow="最近运行"
        description="给开发和家庭管理员复核用，平时不需要常看。"
        closeLabel="关闭"
        closeAriaLabel="关闭 AI 质量诊断"
        className="ai-quality-modal"
        onClose={onClose}
      >
        <AiQualityDiagnosticsCard
          metrics={metrics}
          isLoading={isLoading}
          isError={isError}
          onRetry={onRetry}
        />
        {metrics ? (
          <section className="ai-quality-lines" aria-label="AI 工作流运行计数">
            <p><span>无效身份拒绝</span><strong>{metrics.operational_metrics.invalidIdentityRejectedCount} 次</strong></p>
            <p><span>跨步骤拒绝</span><strong>{metrics.operational_metrics.continuationRejectedCount} 次</strong></p>
            <p><span>工具预算耗尽</span><strong>{metrics.operational_metrics.toolBudgetExhaustedCount} 次</strong></p>
            <p className="ai-quality-note">这些数字只描述近期 AI 工作流的运行情况，不代表推荐正确率，也不构成健康或营养判断。</p>
          </section>
        ) : null}
      </WorkspaceModal>
    </WorkspaceOverlayFrame>
  );
}
