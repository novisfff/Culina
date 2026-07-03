import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useVoicePlayback } from './useVoicePlayback';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type PlaybackProbeValue = ReturnType<typeof useVoicePlayback>;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let latest: PlaybackProbeValue | null = null;
let startedAtValues: number[] = [];
let latestAudioContext: FakeAudioContext | null = null;

class FakeAudioBuffer {
  duration: number;

  constructor(public length: number, public sampleRate: number) {
    this.duration = length / sampleRate;
  }

  copyToChannel() {}
}

class FakeBufferSource {
  buffer: FakeAudioBuffer | null = null;
  onended: (() => void) | null = null;

  connect() {}

  disconnect() {}

  start(at: number) {
    startedAtValues.push(at);
  }

  stop() {
    this.onended?.();
  }
}

class FakeAudioContext {
  state: AudioContextState = 'running';
  currentTime = 0;
  destination = {};

  constructor() {
    latestAudioContext = this;
  }

  createBuffer(_channels: number, length: number, sampleRate: number) {
    return new FakeAudioBuffer(length, sampleRate);
  }

  createBufferSource() {
    return new FakeBufferSource();
  }

  resume() {
    this.state = 'running';
    return Promise.resolve();
  }
}

function Probe() {
  const playback = useVoicePlayback();
  useEffect(() => {
    latest = playback;
  }, [playback]);
  return <span>{playback.isSpeaking ? 'speaking' : 'idle'}</span>;
}

function renderProbe() {
  act(() => {
    root?.render(<Probe />);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  latest = null;
  startedAtValues = [];
  latestAudioContext = null;
  Object.defineProperty(window, 'AudioContext', { configurable: true, value: FakeAudioContext });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  latest = null;
  latestAudioContext = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, 'AudioContext');
});

describe('useVoicePlayback', () => {
  it('schedules PCM chunks and marks the stream finished after playback drains', () => {
    renderProbe();

    act(() => {
      latest?.startPcmStream({ sampleRate: 24000, channels: 1, contentType: 'audio/pcm' });
      latest?.appendPcmChunk('AAABAA==', { sampleRate: 24000, channels: 1, contentType: 'audio/pcm' });
    });

    expect(latest?.isSpeaking).toBe(true);
    expect(startedAtValues).toHaveLength(0);

    act(() => {
      latest?.finishStream();
      vi.advanceTimersByTime(1000);
    });

    expect(startedAtValues[0]).toBeGreaterThan(0);
    expect(latest?.isSpeaking).toBe(false);
  });

  it('waits for a small initial buffer before scheduling PCM playback', () => {
    renderProbe();

    const smallChunk = new Uint8Array(200);
    const bufferedChunk = new Uint8Array(30000);

    act(() => {
      latest?.startPcmStream({ sampleRate: 24000, channels: 1, contentType: 'audio/pcm' });
      latest?.appendPcmChunk(smallChunk, { sampleRate: 24000, channels: 1, contentType: 'audio/pcm' });
    });

    expect(startedAtValues).toHaveLength(0);

    act(() => {
      latest?.appendPcmChunk(bufferedChunk, { sampleRate: 24000, channels: 1, contentType: 'audio/pcm' });
    });

    expect(startedAtValues).toHaveLength(1);
  });

  it('records playback trace events for first audio delta and actual start', () => {
    renderProbe();

    act(() => {
      latest?.startPcmStream({ sampleRate: 24000, channels: 1, contentType: 'audio/pcm' });
      latest?.appendPcmChunk(new Uint8Array(30000), { sampleRate: 24000, channels: 1, contentType: 'audio/pcm' });
    });

    expect(latest?.traceEvents.some((event) => event.stage === 'frontend_first_audio_delta_received')).toBe(true);

    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(latest?.traceEvents.some((event) => event.stage === 'frontend_playback_start')).toBe(true);
  });

  it('rebuffers instead of scheduling tiny chunks after low water', () => {
    renderProbe();

    act(() => {
      latest?.startPcmStream({ sampleRate: 24000, channels: 1, contentType: 'audio/pcm' });
      latest?.appendPcmChunk(new Uint8Array(30000), { sampleRate: 24000, channels: 1, contentType: 'audio/pcm' });
    });

    expect(startedAtValues).toHaveLength(1);
    if (latestAudioContext) latestAudioContext.currentTime = 0.7;

    act(() => {
      latest?.appendPcmChunk(new Uint8Array(2000), { sampleRate: 24000, channels: 1, contentType: 'audio/pcm' });
    });

    expect(startedAtValues).toHaveLength(1);
    expect(latest?.traceEvents.some((event) => event.stage === 'frontend_playback_rebuffering')).toBe(true);

    act(() => {
      latest?.appendPcmChunk(new Uint8Array(30000), { sampleRate: 24000, channels: 1, contentType: 'audio/pcm' });
    });

    expect(startedAtValues).toHaveLength(2);
    expect(latest?.traceEvents.some((event) => event.stage === 'frontend_playback_rebuffered')).toBe(true);
  });
});
