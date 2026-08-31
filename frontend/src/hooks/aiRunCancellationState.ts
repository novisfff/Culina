import type { AiRunCancellationPhase } from '../api/types';

export type CancellationStateProjection = {
  phase: AiRunCancellationPhase;
  error: string;
};

export function cancellationStateFromPhase(phase: AiRunCancellationPhase): CancellationStateProjection {
  return { phase, error: '' };
}

export function cancellationStateFromError(error: unknown): CancellationStateProjection {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return { phase: 'cancelled', error: '' };
  }
  return {
    phase: 'failed',
    error: error instanceof Error && error.message.trim() ? error.message : '停止失败，请稍后重试。',
  };
}
