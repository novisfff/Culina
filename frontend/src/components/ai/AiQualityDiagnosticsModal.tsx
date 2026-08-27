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
        title="AI 使用情况"
        eyebrow="最近处理"
        description="查看最近的处理结果、用量和安全限制。"
        closeLabel="关闭"
        closeAriaLabel="关闭 AI 使用情况"
        className="ai-quality-modal"
        onClose={onClose}
      >
        <AiQualityDiagnosticsCard
          metrics={metrics}
          isLoading={isLoading}
          isError={isError}
          onRetry={onRetry}
        />
      </WorkspaceModal>
    </WorkspaceOverlayFrame>
  );
}
