import { describe, expect, it } from 'vitest';
import { deriveAiStatus, isEventForActiveRun, type AiRunViewState } from './aiStateMatrix';

describe('AI state matrix', () => {
  it.each<[AiRunViewState, boolean, boolean, boolean]>([
    ['idle', false, false, false],
    ['requesting', true, false, false],
    ['running', true, false, false],
    ['waiting-approval', false, true, false],
    ['waiting-human-input', false, true, false],
    ['cancelling', true, false, false],
    ['cancelled', false, false, true],
    ['failed', false, false, true],
    ['partial', false, false, true],
  ])('derives stable flags for %s', (state, isRunning, isWaiting, canRetry) => {
    expect(deriveAiStatus(state)).toMatchObject({ isRunning, isWaiting, canRetry });
  });

  it('rejects events from another conversation or run', () => {
    expect(isEventForActiveRun({ conversationKey: 'family:conversation-1', runId: 'run-1' }, 'family:conversation-1', 'run-1')).toBe(true);
    expect(isEventForActiveRun({ conversationKey: 'family:conversation-1', runId: 'run-2' }, 'family:conversation-1', 'run-1')).toBe(false);
    expect(isEventForActiveRun({ conversationKey: 'family:conversation-2', runId: 'run-1' }, 'family:conversation-1', 'run-1')).toBe(false);
  });
});
