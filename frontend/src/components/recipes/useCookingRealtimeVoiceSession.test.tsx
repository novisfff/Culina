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
  Reflect.deleteProperty(window, 'WebSocket');
});

describe('useCookingRealtimeVoiceSession', () => {
  it.each<CookingRealtimeVoiceStatus>(['listening', 'recording', 'transcribing', 'thinking', 'speaking'])(
    'keeps the call microphone available while status is %s',
    (status) => {
      expect(isCookingRealtimeVoiceMicDisabled(status)).toBe(false);
    },
  );

  it.each<CookingRealtimeVoiceStatus>(['connecting', 'muted', 'closed', 'failed'])(
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
