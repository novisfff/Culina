import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aiVoiceApi } from '../../api/aiVoiceApi';
import { isCookingRealtimeVoiceMicDisabled, useCookingRealtimeVoiceSession, type CookingRealtimeVoiceStatus } from './useCookingRealtimeVoiceSession';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type ProbeValue = ReturnType<typeof useCookingRealtimeVoiceSession>;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let latest: ProbeValue | null = null;
let latestSocket: FakeWebSocket | null = null;

class FakeWebSocket {
  static OPEN = 1;

  readyState = FakeWebSocket.OPEN;
  closeCount = 0;
  sentMessages: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(public url: string) {
    latestSocket = this;
  }

  send(value: string) {
    this.sentMessages.push(JSON.parse(value));
  }

  close() {
    this.closeCount += 1;
    this.readyState = 3;
    this.onclose?.();
  }

  emit(message: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

function Probe(props: {
  onAssistantAudioDelta?: (event: { audio: string; sequence: number }) => void;
  onVoiceTrace?: (event: { stage: string; details?: Record<string, unknown> }) => void;
}) {
  const session = useCookingRealtimeVoiceSession({
    onAssistantAudioDelta: props.onAssistantAudioDelta,
    onVoiceTrace: props.onVoiceTrace,
  });

  useEffect(() => {
    latest = session;
  }, [session]);

  return <span>{session.status}</span>;
}

function renderProbe(props: {
  onAssistantAudioDelta?: (event: { audio: string; sequence: number }) => void;
  onVoiceTrace?: (event: { stage: string; details?: Record<string, unknown> }) => void;
} = {}) {
  act(() => {
    root?.render(<Probe {...props} />);
  });
}

async function startSession() {
  await act(async () => {
    await latest?.start({
      recipeId: 'recipe-1',
      cookSessionId: 'cook-session-1',
      sessionRevision: 1,
      subject: { source: 'recipe_cook_page', extra: { surface: 'recipe_cook_page' } },
    });
  });
  act(() => {
    latestSocket?.onopen?.();
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  latest = null;
  latestSocket = null;
  vi.spyOn(aiVoiceApi, 'createCookingRealtimeSession').mockResolvedValue({
    provider: 'dashscope',
    mode: 'agent_backed_websocket',
    session_id: 'voice-session-1',
    websocket_url: '/api/ai/realtime/cooking/sessions/voice-session-1/ws',
    expires_at: '2026-07-03T12:00:00Z',
  });
  vi.spyOn(aiVoiceApi, 'cookingRealtimeWebSocketUrl').mockReturnValue('ws://localhost/voice-session-1');
  Object.defineProperty(window, 'WebSocket', { configurable: true, value: FakeWebSocket });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  latest = null;
  latestSocket = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
  Reflect.deleteProperty(window, 'WebSocket');
});

describe('useCookingRealtimeVoiceSession', () => {
  it('waits for turn cancellation acknowledgement before returning to listening', async () => {
    renderProbe();
    await startSession();
    act(() => {
      latest?.sendTranscript('下一步');
    });
    const turn = latestSocket?.sentMessages.at(-1) as { turn_id: string };

    let cancelPromise: Promise<void> | undefined;
    act(() => {
      cancelPromise = latest?.cancelTurn();
    });
    expect(latestSocket?.readyState).toBe(FakeWebSocket.OPEN);
    expect(latestSocket?.sentMessages.at(-1)).toEqual({ type: 'cancel_turn', turn_id: turn.turn_id });
    expect(latest?.status).toBe('stopping');

    await act(async () => {
      latestSocket?.emit({ type: 'turn_cancelled', turn_id: turn.turn_id });
      await cancelPromise;
    });
    expect(latestSocket?.readyState).toBe(FakeWebSocket.OPEN);
    expect(latest?.status).toBe('listening');
  });

  it('keeps a requested cancellation in stopping until the terminal acknowledgement arrives', async () => {
    vi.useFakeTimers();
    renderProbe();
    await startSession();
    act(() => {
      latest?.sendTranscript('下一步');
    });
    const turn = latestSocket?.sentMessages.at(-1) as { turn_id: string };

    let cancelSettled = false;
    let cancelPromise: Promise<void> | undefined;
    act(() => {
      cancelPromise = latest?.cancelTurn().then(() => {
        cancelSettled = true;
      });
    });
    expect(latest?.status).toBe('stopping');

    await act(async () => {
      latestSocket?.emit({ type: 'turn_cancel_requested', turn_id: turn.turn_id });
      await Promise.resolve();
    });
    expect(cancelSettled).toBe(false);
    expect(latest?.status).toBe('stopping');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(cancelSettled).toBe(false);
    expect(latest?.status).toBe('stopping');
    expect(latest?.error).toBe('');

    await act(async () => {
      latestSocket?.emit({ type: 'turn_cancelled', turn_id: turn.turn_id });
      await cancelPromise;
    });
    expect(cancelSettled).toBe(true);
    expect(latest?.status).toBe('listening');
  });

  it('sends one cancel message when the same turn is stopped repeatedly', async () => {
    renderProbe();
    await startSession();
    act(() => {
      latest?.sendTranscript('下一步');
    });
    const turn = latestSocket?.sentMessages.at(-1) as { turn_id: string };

    let firstCancel: Promise<void> | undefined;
    let secondCancel: Promise<void> | undefined;
    act(() => {
      firstCancel = latest?.cancelTurn();
      secondCancel = latest?.cancelTurn();
    });

    expect(latestSocket?.sentMessages.filter((message) => (
      message as { type?: string }
    ).type === 'cancel_turn')).toEqual([
      { type: 'cancel_turn', turn_id: turn.turn_id },
    ]);

    await act(async () => {
      latestSocket?.emit({ type: 'turn_cancelled', turn_id: turn.turn_id });
      await Promise.all([firstCancel, secondCancel]);
    });
  });

  it('keeps the active turn and exposes a recoverable cancellation conflict', async () => {
    renderProbe();
    await startSession();
    act(() => {
      latest?.sendTranscript('下一步');
    });
    const turn = latestSocket?.sentMessages.at(-1) as { turn_id: string };

    act(() => {
      void latest?.cancelTurn();
    });
    expect(latest?.status).toBe('stopping');

    await act(async () => {
      latestSocket?.emit({
        type: 'turn_cancel_conflict',
        turn_id: turn.turn_id,
        code: 'run_not_cancellable',
        run_status: 'completed',
        recovery_hint: 'refresh',
        message: '这次回复已经结束，请刷新状态。',
      });
      await Promise.resolve();
    });

    expect(latest?.error).toBe('这次回复已经结束，请刷新状态。');
    expect(latest?.status).toBe('thinking');
  });

  it('waits for active turn cancellation acknowledgement before hangup closes locally', async () => {
    renderProbe();
    await startSession();
    act(() => {
      latest?.sendTranscript('下一步');
    });
    const turn = latestSocket?.sentMessages.at(-1) as { turn_id: string };

    let hangupPromise: Promise<void> | undefined;
    act(() => {
      hangupPromise = latest?.hangup();
    });
    expect(latestSocket?.readyState).toBe(FakeWebSocket.OPEN);
    expect(latestSocket?.sentMessages.at(-1)).toEqual({ type: 'hangup', turn_id: turn.turn_id });

    await act(async () => {
      latestSocket?.emit({ type: 'turn_cancelled', turn_id: turn.turn_id });
      await hangupPromise;
    });
    expect(latestSocket?.readyState).toBe(3);
    expect(latest?.status).toBe('closed');
  });

  it('sends one hangup message while the same acknowledgement is pending', async () => {
    renderProbe();
    await startSession();
    act(() => {
      latest?.sendTranscript('下一步');
    });
    const turn = latestSocket?.sentMessages.at(-1) as { turn_id: string };

    let firstHangup: Promise<void> | undefined;
    let secondHangup: Promise<void> | undefined;
    act(() => {
      firstHangup = latest?.hangup();
      secondHangup = latest?.hangup();
    });

    expect(latestSocket?.sentMessages.filter((message) => (
      message as { type?: string }
    ).type === 'hangup')).toEqual([
      { type: 'hangup', turn_id: turn.turn_id },
    ]);

    await act(async () => {
      latestSocket?.emit({ type: 'status', status: 'closed', turn_id: turn.turn_id });
      await Promise.all([firstHangup, secondHangup]);
    });
    expect(latestSocket?.closeCount).toBe(1);
    expect(latest?.status).toBe('closed');
  });

  it.each<CookingRealtimeVoiceStatus>(['listening', 'recording', 'transcribing', 'thinking', 'speaking'])(
    'keeps the call microphone available while status is %s',
    (status) => {
      expect(isCookingRealtimeVoiceMicDisabled(status)).toBe(false);
    },
  );

  it.each<CookingRealtimeVoiceStatus>(['connecting', 'stopping', 'muted', 'closed', 'failed'])(
    'disables the call microphone while status is %s',
    (status) => {
      expect(isCookingRealtimeVoiceMicDisabled(status)).toBe(true);
    },
  );

  it('attaches turn ids to transcript turns and ignores stale assistant audio deltas', async () => {
    const audioDeltaSpy = vi.fn();
    renderProbe({ onAssistantAudioDelta: audioDeltaSpy });
    await startSession();

    act(() => {
      latest?.sendTranscript('第一句');
    });
    const firstTurn = latestSocket?.sentMessages[0] as { turn_id: string };
    expect(firstTurn).toMatchObject({ type: 'user_transcript_done', text: '第一句' });
    expect(firstTurn.turn_id).toMatch(/^voice_turn-/);
    expect(latest?.status).toBe('thinking');

    act(() => {
      latestSocket?.emit({ type: 'status', status: 'speaking', turn_id: firstTurn.turn_id });
    });
    expect(latest?.status).toBe('speaking');

    act(() => {
      latest?.sendTranscript('第二句');
    });
    const secondTurn = latestSocket?.sentMessages[1] as { turn_id: string };
    expect(secondTurn.turn_id).not.toBe(firstTurn.turn_id);
    expect(latest?.status).toBe('thinking');

    act(() => {
      latestSocket?.emit({ type: 'assistant_audio_delta', audio: 'stale', sequence: 1, turn_id: firstTurn.turn_id });
      latestSocket?.emit({ type: 'assistant_audio_delta', audio: 'fresh', sequence: 1, turn_id: secondTurn.turn_id });
    });

    expect(audioDeltaSpy).toHaveBeenCalledTimes(1);
    expect(audioDeltaSpy).toHaveBeenCalledWith({ audio: 'fresh', sequence: 1 });
  });

  it('records client trace points when sending a completed recording', async () => {
    const traceSpy = vi.fn();
    renderProbe({ onVoiceTrace: traceSpy });
    await startSession();

    await act(async () => {
      await latest?.sendRecording({
        blob: new Blob(['voice-audio'], { type: 'audio/pcm' }),
        mimeType: 'audio/pcm',
        durationMs: 720,
      });
    });

    expect(traceSpy.mock.calls.map(([event]) => event.stage)).toEqual([
      'frontend_recording_done',
      'frontend_audio_sent',
    ]);
  });
});
