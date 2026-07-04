// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiVoiceInputButton } from './AiVoiceInputButton';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function fakeStream() {
  return {
    getTracks: () => [{ stop: vi.fn() }],
  } as unknown as MediaStream;
}

describe('AiVoiceInputButton', () => {
  let container: HTMLDivElement;
  let root: Root;
  const originalMediaRecorder = globalThis.MediaRecorder;

  beforeAll(() => {
    Object.defineProperty(globalThis, 'MediaRecorder', {
      configurable: true,
      value: FakeMediaRecorder,
    });
  });

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
  });

  afterAll(() => {
    Object.defineProperty(globalThis, 'MediaRecorder', {
      configurable: true,
      value: originalMediaRecorder,
    });
  });

  function renderButton(props: Partial<Parameters<typeof AiVoiceInputButton>[0]> = {}) {
    act(() => {
      root.render(
        <AiVoiceInputButton
          surface="main_ai"
          onTranscript={() => undefined}
          {...props}
        />,
      );
    });
    const button = container.querySelector<HTMLButtonElement>('.ai-voice-input-button');
    expect(button).not.toBeNull();
    return button as HTMLButtonElement;
  }

  it('shows a preparing state as soon as the user presses before the recorder is ready', async () => {
    const media = deferred<MediaStream>();
    const getUserMedia = vi.fn().mockReturnValue(media.promise);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });
    const button = renderButton({ enableHoldToSend: true });

    act(() => {
      button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(button.classList.contains('preparing')).toBe(true);
    expect(button.querySelector('.ai-voice-preparing-ui')?.textContent).toContain('准备听');

    await act(async () => {
      media.resolve(fakeStream());
      await Promise.resolve();
    });
  });

  it('clears the immediate preparing state when microphone permission fails', async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });
    const button = renderButton({ enableHoldToSend: true });

    await act(async () => {
      button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      await Promise.resolve();
    });

    expect(button.classList.contains('preparing')).toBe(false);
    expect(button.title).toBe('麦克风权限没有打开');
  });
});
