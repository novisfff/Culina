import { describe, expect, it } from 'vitest';
import { deriveAiRunViewState } from './state/aiRunStateModel';

describe('AI run state model', () => {
  it('maps server statuses and approval/input waits to safe UI states', () => {
    expect(deriveAiRunViewState({ status: 'pending' })).toBe('requesting');
    expect(deriveAiRunViewState({ status: 'running' })).toBe('running');
    expect(deriveAiRunViewState({ status: 'waiting', waitingFor: 'approval' })).toBe('waiting-approval');
    expect(deriveAiRunViewState({ status: 'waiting', waitingFor: 'human-input' })).toBe('waiting-human-input');
    expect(deriveAiRunViewState({ status: 'failed' })).toBe('failed');
    expect(deriveAiRunViewState({ status: 'cancelled' })).toBe('cancelled');
  });
});
