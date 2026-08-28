import { describe, expect, it } from 'vitest';
import { aiComposerReducer, initialAiComposerState } from './state/aiComposerState';

describe('AI composer state', () => {
  it('keeps submit disabled for empty text or an active request', () => {
    expect(initialAiComposerState.canSubmit).toBe(false);
    let state = aiComposerReducer(initialAiComposerState, { type: 'text-changed', text: '帮我安排晚餐' });
    expect(state.canSubmit).toBe(true);
    state = aiComposerReducer(state, { type: 'busy-changed', busy: true });
    expect(state.canSubmit).toBe(false);
    expect(state.disabledReason).toBe('busy');
  });

  it('isolates attachment updates and preserves draft text', () => {
    let state = aiComposerReducer(initialAiComposerState, { type: 'text-changed', text: '看这张图' });
    state = aiComposerReducer(state, { type: 'attachments-changed', attachments: ['attachment-1'] });
    expect(state.text).toBe('看这张图');
    expect(state.attachments).toEqual(['attachment-1']);
    expect(state.canSubmit).toBe(true);
  });
});
