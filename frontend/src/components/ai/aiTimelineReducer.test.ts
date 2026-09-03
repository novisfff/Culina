import { describe, expect, it } from 'vitest';
import type { AiConversationSnapshot, AiMessage, AiTimelineEvent } from '../../api/types';
import {
  applyAiTimelineEvent,
  createAiTimelineState,
  mergeAiTimelineReplay,
  type AiTimelineState,
} from './aiTimelineReducer';

function message(id: string, role: AiMessage['role'], position: number): AiMessage {
  return {
    id,
    conversation_id: 'conversation-1',
    role,
    content: '',
    content_type: 'parts',
    parts: [],
    run_id: role === 'assistant' ? 'run-1' : null,
    status: role === 'assistant' ? 'running' : 'completed',
    metadata: {},
    created_at: '2026-09-03T00:00:00Z',
    timeline_position: position,
    snapshot_sequence: position,
  };
}

function event(sequence: number, eventType: AiTimelineEvent['event_type'], payload: Record<string, unknown>, overrides: Partial<AiTimelineEvent> = {}): AiTimelineEvent {
  return {
    event_id: `event-${sequence}`,
    conversation_id: 'conversation-1',
    run_id: 'run-1',
    message_id: 'assistant-1',
    sequence,
    event_type: eventType,
    operation: eventType === 'part.delta' ? 'delta' : eventType === 'part.replaced' ? 'replace' : 'append',
    part_id: null,
    payload,
    is_terminal: false,
    ...overrides,
  };
}

function snapshot(messages: AiMessage[] = []): AiConversationSnapshot {
  return { conversation_id: 'conversation-1', snapshot_sequence: 0, messages };
}

describe('aiTimelineReducer', () => {
  it('applies user and assistant creation in canonical position order', () => {
    let state = createAiTimelineState(snapshot());
    state = applyAiTimelineEvent(state, event(1, 'message.created', { message: message('user-1', 'user', 1) }, { message_id: 'user-1', run_id: null })).state;
    state = applyAiTimelineEvent(state, event(2, 'message.created', { message: message('assistant-1', 'assistant', 2) })).state;

    expect(state.messageOrder).toEqual(['user-1', 'assistant-1']);
    expect(state.lastSequence).toBe(2);
  });

  it('appends a delta only to the existing text part', () => {
    const assistant = { ...message('assistant-1', 'assistant', 1), parts: [{ id: 'text-1', type: 'text' as const, text: '前' }] };
    let state = createAiTimelineState({ ...snapshot([assistant]), snapshot_sequence: 1 });
    state = applyAiTimelineEvent(state, event(2, 'part.delta', { delta: '后' }, { part_id: 'text-1' })).state;

    expect(state.messagesById['assistant-1']?.parts).toEqual([{ id: 'text-1', type: 'text', text: '前后' }]);
    expect(state.messagesById['assistant-1']?.content).toBe('前后');
  });

  it('replaces a part in place without reordering surrounding parts', () => {
    const assistant = {
      ...message('assistant-1', 'assistant', 1),
      parts: [
        { id: 'before', type: 'text' as const, text: '前' },
        { id: 'draft-1', type: 'draft' as const, text: null },
        { id: 'after', type: 'text' as const, text: '后' },
      ],
    };
    let state = createAiTimelineState({ ...snapshot([assistant]), snapshot_sequence: 1 });
    state = applyAiTimelineEvent(state, event(2, 'part.replaced', { part: { id: 'draft-1', type: 'result_card', text: null } }, { part_id: 'draft-1' })).state;

    expect(state.messagesById['assistant-1']?.parts.map((part) => part.id)).toEqual(['before', 'draft-1', 'after']);
    expect(state.messagesById['assistant-1']?.parts[1]?.type).toBe('result_card');
  });

  it('ignores duplicate event ids without applying the delta twice', () => {
    const assistant = { ...message('assistant-1', 'assistant', 1), parts: [{ id: 'text-1', type: 'text' as const, text: '' }] };
    let state = createAiTimelineState({ ...snapshot([assistant]), snapshot_sequence: 1 });
    const next = event(2, 'part.delta', { delta: '一次' }, { part_id: 'text-1' });
    state = applyAiTimelineEvent(state, next).state;
    state = applyAiTimelineEvent(state, next).state;

    expect(state.messagesById['assistant-1']?.parts[0]?.text).toBe('一次');
    expect(state.lastSequence).toBe(2);
  });

  it('records a sequence gap instead of guessing a missing event', () => {
    const assistant = { ...message('assistant-1', 'assistant', 1), parts: [{ id: 'text-1', type: 'text' as const, text: '' }] };
    const state = createAiTimelineState({ ...snapshot([assistant]), snapshot_sequence: 2 });
    const result = applyAiTimelineEvent(state, event(4, 'part.delta', { delta: '不可直接应用' }, { part_id: 'text-1' }));

    expect(result.needsReplay).toBe(true);
    expect(result.state.gap).toEqual({ from: 3, to: 3 });
    expect(result.state.lastSequence).toBe(2);
    expect(result.state.messagesById['assistant-1']?.parts[0]?.text).toBe('');
  });

  it('replays a contiguous range and clears the gap', () => {
    const assistant = { ...message('assistant-1', 'assistant', 1), parts: [{ id: 'text-1', type: 'text' as const, text: '' }] };
    let state = createAiTimelineState({ ...snapshot([assistant]), snapshot_sequence: 2 });
    state = applyAiTimelineEvent(state, event(4, 'part.delta', { delta: '终' }, { part_id: 'text-1' })).state;
    const replayEvents = [
      event(3, 'part.delta', { delta: '前' }, { part_id: 'text-1' }),
      event(4, 'part.delta', { delta: '终' }, { part_id: 'text-1' }),
    ];
    state = mergeAiTimelineReplay(state, { conversation_id: 'conversation-1', from_sequence: 3, to_sequence: 4, events: replayEvents });

    expect(state.gap).toBeNull();
    expect(state.lastSequence).toBe(4);
    expect(state.messagesById['assistant-1']?.parts[0]?.text).toBe('前终');
  });

  it('rejects an event targeting an unknown message and requests snapshot recovery', () => {
    const state = createAiTimelineState({ ...snapshot([message('assistant-1', 'assistant', 1)]), snapshot_sequence: 1 });
    const result = applyAiTimelineEvent(state, event(2, 'part.appended', { part: { id: 'draft-1', type: 'draft' } }, { message_id: 'missing-message', part_id: 'draft-1' }));

    expect(result.needsReplay).toBe(true);
    expect(result.state.integrityError).toMatch(/unknown message/i);
    expect(result.state.lastSequence).toBe(1);
  });

  it('rejects visible events after a terminal message', () => {
    const assistant = { ...message('assistant-1', 'assistant', 1), parts: [{ id: 'text-1', type: 'text' as const, text: '完成' }] };
    let state = createAiTimelineState({ ...snapshot([assistant]), snapshot_sequence: 1 });
    state = applyAiTimelineEvent(state, event(2, 'run.terminal', { status: 'completed', message: { ...assistant, status: 'completed' } }, { is_terminal: true })).state;
    const result = applyAiTimelineEvent(state, event(3, 'part.delta', { delta: '幽灵' }, { part_id: 'text-1' }));

    expect(result.needsReplay).toBe(true);
    expect(result.state.lastSequence).toBe(2);
    expect(result.state.messagesById['assistant-1']?.content).toBe('完成');
  });

  it('hydrates legacy zero-position snapshots in received order', () => {
    const messages = [message('first', 'user', 0), message('second', 'assistant', 0)];
    const state: AiTimelineState = createAiTimelineState(snapshot(messages));
    expect(state.messageOrder).toEqual(['first', 'second']);
  });

  it('initializes an empty live conversation with the transport conversation id', () => {
    const state = createAiTimelineState([], 'conversation-1');
    const result = applyAiTimelineEvent(
      state,
      event(1, 'message.created', { message: message('user-1', 'user', 1) }, {
        message_id: 'user-1',
        run_id: null,
      }),
    );

    expect(result.needsReplay).toBe(false);
    expect(result.state.conversationId).toBe('conversation-1');
    expect(result.state.messageOrder).toEqual(['user-1']);
  });
});
