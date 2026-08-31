import { describe, expect, it } from 'vitest';
import { cancellationStateFromError, cancellationStateFromPhase } from './aiRunCancellationState';

describe('AI cancellation state model', () => {
  it('keeps phase transitions explicit', () => {
    expect(cancellationStateFromPhase('requesting').phase).toBe('requesting');
    expect(cancellationStateFromPhase('cancelling').phase).toBe('cancelling');
    expect(cancellationStateFromPhase('cancelled').phase).toBe('cancelled');
  });

  it('maps abort errors to cancelled instead of user-visible failure', () => {
    const state = cancellationStateFromError(new DOMException('aborted', 'AbortError'));
    expect(state.phase).toBe('cancelled');
    expect(state.error).toBe('');
  });
});
