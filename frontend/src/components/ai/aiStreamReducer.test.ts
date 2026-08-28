import { describe, expect, it } from 'vitest';
import { aiStreamReducer, initialAiStreamState, type AiStreamAction } from './state/aiStreamReducer';

describe('AI stream reducer', () => {
  it('merges deltas only for the active conversation and run', () => {
    const started = aiStreamReducer(initialAiStreamState, { type: 'run-started', conversationKey: 'c-1', runId: 'r-1' });
    const withDelta = aiStreamReducer(started, { type: 'message-delta', conversationKey: 'c-1', runId: 'r-1', messageId: 'm-1', delta: '你好' });
    const stale = aiStreamReducer(withDelta, { type: 'message-delta', conversationKey: 'c-1', runId: 'r-2', messageId: 'm-1', delta: '旧' });
    expect(withDelta.messages['m-1']).toBe('你好');
    expect(stale.messages['m-1']).toBe('你好');
  });

  it('keeps visible content on failure and marks cancellation without an error', () => {
    let state = aiStreamReducer(initialAiStreamState, { type: 'run-started', conversationKey: 'c-1', runId: 'r-1' });
    state = aiStreamReducer(state, { type: 'message-delta', conversationKey: 'c-1', runId: 'r-1', messageId: 'm-1', delta: '内容' });
    state = aiStreamReducer(state, { type: 'stream-failed', conversationKey: 'c-1', runId: 'r-1', message: '网络失败' });
    expect(state.messages['m-1']).toBe('内容');
    expect(state.status).toBe('failed');
    state = aiStreamReducer(state, { type: 'run-cancelled', conversationKey: 'c-1', runId: 'r-1' });
    expect(state.status).toBe('cancelled');
    expect(state.error).toBeNull();
  });
});
