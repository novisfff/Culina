import type { AiRunViewState } from '../aiStateMatrix';

export type AiRunStateInput = {
  status?: string | null;
  waitingFor?: 'approval' | 'human-input' | string | null;
};

export function deriveAiRunViewState(input: AiRunStateInput): AiRunViewState {
  const status = (input.status ?? '').toLowerCase();
  if (status === 'pending') return 'requesting';
  if (status === 'running') return 'running';
  if (status === 'waiting') {
    if (input.waitingFor === 'approval') return 'waiting-approval';
    if (input.waitingFor === 'human-input') return 'waiting-human-input';
    return 'partial';
  }
  if (status === 'cancelled') return 'cancelled';
  if (status === 'failed') return 'failed';
  if (status === 'completed') return 'idle';
  return 'partial';
}
