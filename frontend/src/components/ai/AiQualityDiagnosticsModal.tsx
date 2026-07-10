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
      </WorkspaceModal>
    </WorkspaceOverlayFrame>
  );
}
