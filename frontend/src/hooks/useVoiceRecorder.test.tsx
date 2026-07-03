import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useVoiceRecorder, type VoiceRecording, type VoiceRecorderStatus } from './useVoiceRecorder';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type RecorderProbeValue = {
  status: VoiceRecorderStatus;
  error: string;
  start: () => Promise<boolean>;
  stop: () => Promise<VoiceRecording | null>;
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let latest: RecorderProbeValue | null = null;

function Probe() {
  const recorder = useVoiceRecorder();
  useEffect(() => {
    latest = {
      status: recorder.status,
      error: recorder.error,
      start: recorder.start,
      stop: recorder.stop,
    };
  }, [recorder.error, recorder.start, recorder.status, recorder.stop]);
  return <span>{recorder.status}</span>;
}

class FakeMediaRecorder {
  static isTypeSupported() {
    return true;
  }

  mimeType = 'audio/webm';
  state: 'inactive' | 'recording' = 'inactive';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;

  start() {
    this.state = 'recording';
  }

  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['audio'], { type: this.mimeType }) });
    this.onstop?.();
  }
}

function renderProbe() {
  act(() => {
    root?.render(<Probe />);
  });
}

function expectRecording(value: VoiceRecording | null): VoiceRecording {
  expect(value).not.toBeNull();
  return value as VoiceRecording;
}

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  latest = null;
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  latest = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
  Reflect.deleteProperty(globalThis, 'MediaRecorder');
});

describe('useVoiceRecorder', () => {
  it('reports an error when recording is not supported', async () => {
    renderProbe();

    await act(async () => {
      await latest?.start();
    });

    expect(latest?.status).toBe('error');
    expect(latest?.error).toBe('当前浏览器不支持录音');
  });

  it('returns a recording when MediaRecorder stops', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue({
          getTracks: () => [{ stop: vi.fn() }],
        }),
      },
    });
    Object.defineProperty(globalThis, 'MediaRecorder', {
      configurable: true,
      value: FakeMediaRecorder,
    });
    renderProbe();

    await act(async () => {
      await latest?.start();
    });
    expect(latest?.status).toBe('recording');

    let recording: VoiceRecording | null = null;
    await act(async () => {
      recording = await latest?.stop() ?? null;
    });

    const completed = expectRecording(recording);
    expect(completed.mimeType).toBe('audio/webm');
    expect(completed.blob.size).toBeGreaterThan(0);
    expect(latest?.status).toBe('idle');
  });
});
